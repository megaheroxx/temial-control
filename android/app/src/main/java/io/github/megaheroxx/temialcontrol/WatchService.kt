package io.github.megaheroxx.temialcontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Keeps the event stream of the server open and turns device changes into notifications:
 * a status notification (with brew progress) and alerts for finished tea or missing water.
 */
class WatchService : Service() {
    private lateinit var notifications: NotificationManager
    private lateinit var settings: Settings
    private var worker: Thread? = null
    @Volatile private var running = false
    @Volatile private var connection: HttpURLConnection? = null

    /** Last known raw state and derived snapshot per serial number. */
    private val devices = mutableMapOf<String, JSONObject>()
    private val snapshots = mutableMapOf<String, Snapshot>()

    private data class Snapshot(
        val connected: Boolean,
        val brewing: Boolean,
        val tea: String,
        val remaining: Int,
        val total: Int,
        val problem: String?,
        /** Infusion number and total while a multi-infusion brew is running, otherwise null. */
        val infusion: Pair<Int, Int>?,
        /** Name and start time (epoch ms) of a brew planned with a timer. */
        val scheduled: Pair<String, Long>?,
    )

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
        notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, getString(R.string.channel_status), NotificationManager.IMPORTANCE_LOW)
                .apply { setShowBadge(false) },
        )
        notifications.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = statusNotification(getString(R.string.status_connecting), null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ID_STATUS, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ID_STATUS, notification)
        }
        if (!settings.isConfigured || !settings.notifications) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (worker == null) {
            running = true
            worker = thread(name = "temial-events") { listenForever() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        connection?.disconnect()
        worker?.interrupt()
        worker = null
        super.onDestroy()
    }

    // --- Event stream -------------------------------------------------------

    private fun listenForever() {
        var delay = 5_000L
        while (running) {
            try {
                listenOnce()
                delay = 5_000L
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                if (!running) return
                showStatus(getString(R.string.status_retry, (delay / 1000).toInt()), null)
            }
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                return
            }
            delay = (delay * 2).coerceAtMost(300_000L)
        }
    }

    private fun listenOnce() {
        val conn = URL("${settings.url}/api/events").openConnection() as HttpURLConnection
        connection = conn
        conn.connectTimeout = 15_000
        // The server sends a keepalive every 25 s; a longer silence means the connection is dead.
        conn.readTimeout = 90_000
        conn.setRequestProperty("Accept", "text/event-stream")
        if (settings.token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer ${settings.token}")
        try {
            if (conn.responseCode == 401) {
                showStatus(getString(R.string.status_token_rejected), null)
                throw IllegalStateException("unauthorized")
            }
            BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
                var event: String? = null
                val data = StringBuilder()
                while (running) {
                    val line = reader.readLine() ?: break
                    when {
                        line.isEmpty() -> {
                            if (event != null && data.isNotEmpty()) handleEvent(event, JSONObject(data.toString()))
                            event = null
                            data.setLength(0)
                        }
                        line.startsWith(":") -> Unit
                        line.startsWith("event:") -> event = line.substring(6).trim()
                        line.startsWith("data:") -> data.append(line.substring(5).trim())
                    }
                    // Keepalives arrive regularly, so stale brews are detected without extra timers.
                    refreshAll(notify = true)
                }
            }
        } finally {
            conn.disconnect()
            connection = null
        }
    }

    private fun handleEvent(event: String, payload: JSONObject) {
        when (event) {
            "snapshot" -> {
                val list = payload.optJSONArray("devices") ?: return
                for (i in 0 until list.length()) update(list.getJSONObject(i), notify = false)
            }
            "device" -> update(payload, notify = true)
        }
        showDeviceStatus()
    }

    // --- State and notifications --------------------------------------------

    private fun update(device: JSONObject, notify: Boolean) {
        val serial = device.optString("serialNumber").ifEmpty { return }
        devices[serial] = device
        refresh(serial, notify)
    }

    private fun refreshAll(notify: Boolean) {
        var changed = false
        for (serial in devices.keys.toList()) changed = refresh(serial, notify) || changed
        if (changed) showDeviceStatus()
    }

    /** Recomputes the snapshot of one device and sends alerts for relevant changes. Returns true if it changed. */
    private fun refresh(serial: String, notify: Boolean): Boolean {
        val device = devices[serial] ?: return false
        val now = snapshot(device)
        val previous = snapshots.put(serial, now)
        if (previous == null || !notify) return previous != now

        if (previous.brewing && !now.brewing && now.connected) {
            val infusion = previous.infusion
            when {
                infusion == null -> alert(ID_TEA, getString(R.string.alert_tea_ready), getString(R.string.alert_tea_ready_text, previous.tea))
                infusion.first < infusion.second -> alert(
                    ID_TEA,
                    getString(R.string.alert_infusion_done, infusion.first, infusion.second),
                    getString(R.string.alert_infusion_next, previous.tea),
                )
                else -> alert(ID_TEA, getString(R.string.alert_all_infusions, infusion.second), getString(R.string.alert_all_infusions_text, previous.tea))
            }
        }
        if (now.problem != null && now.problem != previous.problem && now.connected) {
            alert(ID_PROBLEM, now.problem, getString(R.string.alert_fix_at_temial))
        }
        return previous != now
    }

    private fun snapshot(device: JSONObject): Snapshot {
        val status = device.optJSONObject("deviceStatus")
        val brew = device.optJSONObject("brewStatus")
        val remaining = brew?.optInt("remainingTotalTime") ?: 0
        val brewAgeMs = System.currentTimeMillis() - device.optLong("brewStatusAt", 0L)
        val total = if (brew == null) 0 else
            brew.optInt("estimatedTimePrewash") + brew.optInt("estimatedTimeHeating") + brew.optInt("estimatedTimeBrewing")
        val problem = status?.let {
            when {
                !it.optBoolean("enoughFreshWater", true) -> getString(R.string.problem_water)
                it.optBoolean("wasteWaterTankFull", false) -> getString(R.string.problem_waste_full)
                !it.optBoolean("wasteWaterTankPresent", true) -> getString(R.string.problem_waste_missing)
                !it.optBoolean("chamberPresent", true) -> getString(R.string.problem_chamber)
                else -> null
            }
        }
        return Snapshot(
            connected = device.optBoolean("connected"),
            brewing = remaining > 0 && brewAgeMs < BREW_STALE_MS,
            tea = device.optJSONObject("lastBrew")?.optString("name")?.ifEmpty { null } ?: getString(R.string.default_tea),
            remaining = remaining,
            total = total,
            problem = problem,
            infusion = device.optJSONObject("session")?.let { it.optInt("index") + 1 to it.optInt("total") },
            scheduled = device.optJSONObject("scheduled")
                ?.let { it.optString("name") to it.optLong("startsAt") }
                ?.takeIf { it.second > System.currentTimeMillis() },
        )
    }

    private fun showDeviceStatus() {
        val all = snapshots.values
        val brewing = all.firstOrNull { it.brewing }
        when {
            brewing != null -> showStatus(
                getString(R.string.status_brewing, brewing.tea, formatDuration(brewing.remaining)),
                if (brewing.total > 0) brewing.total to (brewing.total - brewing.remaining).coerceAtLeast(0) else null,
            )
            all.any { it.connected && it.scheduled != null } -> {
                val (name, startsAt) = all.first { it.connected && it.scheduled != null }.scheduled!!
                showStatus(getString(R.string.status_scheduled, name, formatClock(startsAt)), null)
            }
            all.any { it.connected && it.problem != null } ->
                showStatus(all.first { it.connected && it.problem != null }.problem!!, null)
            all.any { it.connected } -> showStatus(getString(R.string.status_ready), null)
            all.isNotEmpty() -> showStatus(getString(R.string.status_offline), null)
            else -> showStatus(getString(R.string.status_no_device), null)
        }
    }

    private fun showStatus(text: String, progress: Pair<Int, Int>?) {
        notifications.notify(ID_STATUS, statusNotification(text, progress))
    }

    private fun statusNotification(text: String, progress: Pair<Int, Int>?): Notification =
        Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.accent))
            .setContentTitle("Temial Control")
            .setContentText(text)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .apply { if (progress != null) setProgress(progress.first, progress.second, false) }
            .build()

    private fun alert(id: Int, title: String, text: String) {
        notifications.notify(
            id,
            Notification.Builder(this, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(getColor(R.color.accent))
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .build(),
        )
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    companion object {
        private const val CHANNEL_STATUS = "status"
        private const val CHANNEL_ALERTS = "alerts"
        private const val ID_STATUS = 1
        private const val ID_TEA = 2
        private const val ID_PROBLEM = 3
        private const val BREW_STALE_MS = 60_000L

        private fun formatClock(epochMs: Long): String =
            java.text.SimpleDateFormat("HH:mm", java.util.Locale.GERMANY).format(java.util.Date(epochMs))

        private fun formatDuration(seconds: Int): String {
            val s = seconds.coerceAtLeast(0)
            return "%d:%02d".format(s / 60, s % 60)
        }
    }
}
