package io.github.megaheroxx.temialcontrol

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.View
import android.view.WindowInsets
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import kotlin.concurrent.thread

/**
 * Sets up a Temial directly from the phone: the phone joins the device hotspot (automatically or by hand)
 * and sends the home Wi-Fi credentials plus the address of the Temial Control server.
 */
class SetupActivity : Activity() {
    private lateinit var connectivity: ConnectivityManager
    private lateinit var qrInput: EditText
    private lateinit var qrInfo: TextView
    private lateinit var ssidInput: EditText
    private lateinit var keyInput: EditText
    private lateinit var securitySpinner: Spinner
    private lateinit var baseHostInput: EditText
    private lateinit var steps: TextView
    private lateinit var message: TextView
    private val buttons = mutableListOf<Button>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        connectivity = getSystemService(ConnectivityManager::class.java)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
        }

        content.addView(text("Neue Temial einrichten", 24f, bold = true))
        content.addView(
            text("Das Handy verbindet sich kurz mit dem WLAN der Temial und überträgt dein Heim-WLAN und die Adresse deines Servers.", 14f, muted = true),
            margins(top = 6, bottom = 20),
        )

        // 1. QR code
        val qrCard = card(content, "1  QR-Code der Temial")
        qrCard.addView(text("Auf der Temial oben auf die graue Leiste tippen und „Verbinden“ wählen.", 14f, muted = true), margins(bottom = 10))
        qrCard.addView(button("QR-Code scannen", primary = true) { scanQr() }, buttonParams())
        qrInput = input("oder Inhalt des QR-Codes einfügen", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        qrInput.addTextChangedListener(afterChange { updateQrInfo() })
        qrCard.addView(qrInput, margins(top = 10))
        qrInfo = text("", 14f, muted = true)
        qrCard.addView(qrInfo, margins(top = 6))

        // 2. Wi-Fi and server
        val wifiCard = card(content, "2  Heim-WLAN und Server")
        wifiCard.addView(label("WLAN-Name"))
        ssidInput = input("Name deines WLANs", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        wifiCard.addView(ssidInput, margins(bottom = 6))
        wifiCard.addView(button("WLANs der Temial anzeigen", primary = false) {
            run(scanOnly = true, automatic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        }, buttonParams())
        wifiCard.addView(label("WLAN-Passwort"), margins(top = 12))
        keyInput = input("Passwort", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        wifiCard.addView(keyInput, margins(bottom = 12))
        wifiCard.addView(label("Sicherheitstyp"))
        securitySpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SetupActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("automatisch (wie von der Temial erkannt)") + TemialProtocol.SECURITY_TYPES,
            )
        }
        wifiCard.addView(securitySpinner, margins(bottom = 12))
        wifiCard.addView(label("Server-Adresse für die Temial"))
        baseHostInput = input("http://192.168.1.40:3010", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        baseHostInput.setText(Settings(this).url)
        wifiCard.addView(baseHostInput)
        wifiCard.addView(text("Unter dieser Adresse erreicht die Temial deinen Server im Heimnetz.", 13f, muted = true), margins(top = 6))

        // 3. Connect
        val runCard = card(content, "3  Einrichten")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCard.addView(text("Die App fragt Android, ob sie sich mit dem WLAN der Temial verbinden darf.", 14f, muted = true), margins(bottom = 10))
            runCard.addView(button("Automatisch verbinden und einrichten", primary = true) { run(scanOnly = false, automatic = true) }, buttonParams())
            runCard.addView(text("Klappt das nicht: Handy in den WLAN-Einstellungen selbst mit „Temial-xxxxx“ verbinden, zurück in die App und:", 14f, muted = true), margins(top = 14, bottom = 10))
        } else {
            runCard.addView(text("Handy in den WLAN-Einstellungen mit „Temial-xxxxx“ verbinden, zurück in die App und:", 14f, muted = true), margins(bottom = 10))
        }
        runCard.addView(button("Ich bin im Temial-WLAN – einrichten", primary = false) { run(scanOnly = false, automatic = false) }, buttonParams())

        steps = text("", 14f)
        content.addView(steps, margins(top = 16))
        message = text("", 15f, bold = true)
        content.addView(message, margins(top = 8))

        val scroll = ScrollView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            addView(content)
        }
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            }
            insets
        }
        setContentView(scroll)
    }

    override fun onDestroy() {
        releaseNetwork()
        super.onDestroy()
    }

    // --- QR code ------------------------------------------------------------

    private fun scanQr() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let { qrInput.setText(it) } }
            .addOnFailureListener { showMessage("QR-Scanner nicht verfügbar: ${it.message}. Inhalt bitte von Hand einfügen.", error = true) }
    }

    private fun updateQrInfo() {
        val raw = qrInput.text.toString()
        qrInfo.text = when {
            raw.isBlank() -> ""
            else -> try {
                val qr = TemialQr.parse(raw)
                "Seriennummer ${qr.serialNumber} · WLAN der Temial: ${qr.hotspot}"
            } catch (e: SetupException) {
                e.message
            }
        }
    }

    // --- Setup --------------------------------------------------------------

    private fun run(scanOnly: Boolean, automatic: Boolean) {
        val qr = try {
            TemialQr.parse(qrInput.text.toString())
        } catch (e: SetupException) {
            showMessage(e.message ?: "QR-Code fehlt", error = true)
            return
        }
        val ssid = ssidInput.text.toString()
        val key = keyInput.text.toString()
        val baseHost = Settings.normalizeUrl(baseHostInput.text.toString()) ?: baseHostInput.text.toString().trim()
        val security = securitySpinner.selectedItemPosition.let { if (it == 0) null else it - 1 }
        if (!scanOnly) {
            try {
                TemialProtocol.validate(ssid, key, baseHost)
            } catch (e: SetupException) {
                showMessage(e.message ?: "Eingaben prüfen", error = true)
                return
            }
        }

        setRunning(true)
        val onNetwork = { network: Network ->
            thread(name = "temial-setup") {
                try {
                    val socket = network.socketFactory.createSocket()
                    socket.connect(InetSocketAddress(TemialProtocol.HOST, TemialProtocol.PORT), CONNECT_TIMEOUT_MS)
                    step("Verbunden mit der Temial")
                    TemialLink(socket, qr.pairingCode).use { link ->
                        val flow = TemialSetupFlow(link, qr, ::step)
                        if (scanOnly) {
                            val networks = flow.scan()
                            runOnUiThread { chooseNetwork(networks) }
                        } else {
                            val confirmed = flow.configure(ssid, key, baseHost, security)
                            showMessage(
                                (if (confirmed) "Fertig! Die Temial hat die Einstellungen bestätigt. " else "Einstellungen wurden gesendet. ") +
                                    "Sie verbindet sich jetzt mit deinem WLAN und erscheint in Kürze im Dashboard.",
                                error = false,
                            )
                        }
                    }
                } catch (e: Exception) {
                    showMessage(explain(e, qr), error = true)
                } finally {
                    releaseNetwork()
                    runOnUiThread { setRunning(false) }
                }
            }
            Unit
        }

        if (automatic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) requestHotspot(qr, onNetwork)
        else useCurrentWifi(qr, onNetwork)
    }

    /** Android 10+: ask the system to join the device hotspot just for this app. */
    private fun requestHotspot(qr: TemialQr, onNetwork: (Network) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        step("Verbinde mit ${qr.hotspot} …")
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(WifiNetworkSpecifier.Builder().setSsid(qr.hotspot).build())
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var started = false

            override fun onAvailable(network: Network) {
                if (started) return
                started = true
                step("Mit ${qr.hotspot} verbunden")
                onNetwork(network)
            }

            override fun onUnavailable() {
                showMessage("${qr.hotspot} wurde nicht gefunden oder die Verbindung abgelehnt. Zeigt die Temial noch den QR-Code?", error = true)
                networkCallback = null
                runOnUiThread { setRunning(false) }
            }
        }
        networkCallback = callback
        connectivity.requestNetwork(request, callback, HOTSPOT_TIMEOUT_MS)
    }

    /** Manual mode: the user already joined the hotspot; bind to that Wi-Fi even if Android prefers mobile data. */
    private fun useCurrentWifi(qr: TemialQr, onNetwork: (Network) -> Unit) {
        @Suppress("DEPRECATION")
        val wifi = connectivity.allNetworks.firstOrNull {
            connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
        if (wifi == null) {
            showMessage("Das Handy ist mit keinem WLAN verbunden. Bitte zuerst mit „${qr.hotspot}“ verbinden.", error = true)
            setRunning(false)
            return
        }
        step("Nutze das aktuelle WLAN")
        onNetwork(wifi)
    }

    private fun releaseNetwork() {
        networkCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        networkCallback = null
    }

    private fun chooseNetwork(networks: List<WifiNetwork>) {
        if (networks.isEmpty()) {
            showMessage("Die Temial hat keine WLANs gefunden.", error = true)
            return
        }
        val labels = networks.map { "${it.ssid}  (${TemialProtocol.SECURITY_TYPES.getOrElse(it.securityType) { "?" }}, Signal ${it.signalStrength})" }
        AlertDialog.Builder(this)
            .setTitle("WLAN für die Temial")
            .setItems(labels.toTypedArray()) { _, index ->
                ssidInput.setText(networks[index].ssid)
                keyInput.requestFocus()
            }
            .show()
        showMessage("${networks.size} WLAN(s) gefunden. Wähle eins aus, trag das Passwort ein und richte die Temial ein.", error = false)
    }

    private fun explain(e: Exception, qr: TemialQr): String = when (e) {
        is SetupException -> e.message ?: "Fehler bei der Einrichtung"
        is ConnectionClosedException -> "Die Temial hat die Verbindung beendet. Meist passt der QR-Code nicht mehr – bitte neu anzeigen lassen."
        is SocketTimeoutException -> "Keine Antwort der Temial (Zeitüberschreitung). Ist das Handy mit „${qr.hotspot}“ verbunden?"
        is ConnectException, is NoRouteToHostException -> "Temial nicht erreichbar. Ist das Handy mit „${qr.hotspot}“ verbunden?"
        else -> "Fehler: ${e.message ?: e.javaClass.simpleName}"
    }

    // --- UI helpers ---------------------------------------------------------

    private fun step(text: String) = runOnUiThread {
        steps.append(if (steps.text.isEmpty()) "• $text" else "\n• $text")
    }

    private fun showMessage(text: String, error: Boolean) = runOnUiThread {
        message.text = text
        message.setTextColor(if (error) 0xFFD6001C.toInt() else getColor(R.color.accent))
    }

    private fun setRunning(running: Boolean) {
        buttons.forEach { it.isEnabled = !running; it.alpha = if (running) 0.5f else 1f }
        if (running) {
            steps.text = ""
            message.text = ""
        }
    }

    private fun card(parent: LinearLayout, title: String): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(getColor(R.color.surface))
            }
        }
        card.addView(text(title, 17f, bold = true), margins(bottom = 8))
        parent.addView(card, margins(bottom = 14))
        return card
    }

    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 15f
        setTextColor(if (primary) 0xFFFFFFFF.toInt() else getColor(R.color.accent))
        background = GradientDrawable().apply {
            cornerRadius = dp(26).toFloat()
            if (primary) setColor(getColor(R.color.accent)) else setStroke(dp(2), getColor(R.color.accent))
        }
        setOnClickListener { onClick() }
        buttons += this
    }

    private fun buttonParams() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(50))

    private fun dp(value: Int) =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun margins(top: Int = 0, bottom: Int = 0) =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { setMargins(0, dp(top), 0, dp(bottom)) }

    private fun text(value: String, size: Float, bold: Boolean = false, muted: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(getColor(if (muted) R.color.muted else R.color.text))
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun label(value: String): View = text(value, 13f, bold = true, muted = true).apply {
        setPadding(dp(2), 0, 0, dp(6))
    }

    private fun input(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = type
        isSingleLine = true
        textSize = 15f
        setTextColor(getColor(R.color.text))
        setHintTextColor(getColor(R.color.muted))
        setPadding(dp(14), dp(12), dp(14), dp(12))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(getColor(R.color.background))
        }
    }

    private fun afterChange(action: () -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(s: Editable?) = action()
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val HOTSPOT_TIMEOUT_MS = 60_000
    }
}
