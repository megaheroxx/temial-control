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
import android.content.Intent
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureActivity
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
    /** Setup messages in the phone's language. */
    private val texts by lazy { setupTexts(java.util.Locale.getDefault().language) }
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        connectivity = getSystemService(ConnectivityManager::class.java)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(32))
        }

        content.addView(text(getString(R.string.setup_title), 24f, bold = true))
        content.addView(
            text(getString(R.string.setup_intro), 14f, muted = true),
            margins(top = 6, bottom = 20),
        )

        // 1. QR code
        val qrCard = card(content, getString(R.string.setup_step1))
        qrCard.addView(text(getString(R.string.setup_step1_hint), 14f, muted = true), margins(bottom = 10))
        qrCard.addView(button(getString(R.string.setup_scan_qr), primary = true) { scanQr() }, buttonParams())
        qrInput = input(getString(R.string.setup_qr_hint), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        qrInput.addTextChangedListener(afterChange { updateQrInfo() })
        qrCard.addView(qrInput, margins(top = 10))
        qrInfo = text("", 14f, muted = true)
        qrCard.addView(qrInfo, margins(top = 6))

        // 2. Wi-Fi and server
        val wifiCard = card(content, getString(R.string.setup_step2))
        wifiCard.addView(label(getString(R.string.setup_ssid)))
        ssidInput = input(getString(R.string.setup_ssid_hint), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        wifiCard.addView(ssidInput, margins(bottom = 6))
        wifiCard.addView(button(getString(R.string.setup_show_networks), primary = false) {
            run(scanOnly = true, automatic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        }, buttonParams())
        wifiCard.addView(label(getString(R.string.setup_key)), margins(top = 12))
        keyInput = input(getString(R.string.setup_key_hint), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        wifiCard.addView(keyInput, margins(bottom = 12))
        wifiCard.addView(label(getString(R.string.setup_security)))
        securitySpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SetupActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf(getString(R.string.setup_security_auto)) + TemialProtocol.SECURITY_TYPES,
            )
        }
        wifiCard.addView(securitySpinner, margins(bottom = 12))
        wifiCard.addView(label(getString(R.string.setup_base_host)))
        baseHostInput = input("http://192.168.1.40:3010", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        baseHostInput.setText(Settings(this).url)
        wifiCard.addView(baseHostInput)
        wifiCard.addView(text(getString(R.string.setup_base_host_hint), 13f, muted = true), margins(top = 6))

        // 3. Connect
        val runCard = card(content, getString(R.string.setup_step3))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCard.addView(text(getString(R.string.setup_auto_hint), 14f, muted = true), margins(bottom = 10))
            runCard.addView(button(getString(R.string.setup_auto_button), primary = true) { run(scanOnly = false, automatic = true) }, buttonParams())
            runCard.addView(text(getString(R.string.setup_manual_fallback), 14f, muted = true), margins(top = 14, bottom = 10))
        } else {
            runCard.addView(text(getString(R.string.setup_manual_hint), 14f, muted = true), margins(bottom = 10))
        }
        runCard.addView(button(getString(R.string.setup_manual_button), primary = false) { run(scanOnly = false, automatic = false) }, buttonParams())

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

    /** Opens ZXing's in-app scanner directly (IntentIntegrator would pull in androidx.fragment). */
    private fun scanQr() {
        val intent = Intent(this, CaptureActivity::class.java)
            .setAction(Intents.Scan.ACTION)
            .putExtra(Intents.Scan.FORMATS, "QR_CODE")
            .putExtra(Intents.Scan.PROMPT_MESSAGE, getString(R.string.setup_scan_prompt))
            .putExtra(Intents.Scan.BEEP_ENABLED, false)
            .putExtra(Intents.Scan.ORIENTATION_LOCKED, false)
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, SCAN_REQUEST)
        } catch (e: Throwable) {
            showMessage(getString(R.string.setup_scanner_failed, e.javaClass.simpleName), error = true)
        }
    }

    @Deprecated("Uses the platform API without AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == SCAN_REQUEST) {
            if (resultCode == RESULT_OK) data?.getStringExtra(Intents.Scan.RESULT)?.let { qrInput.setText(it) }
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun updateQrInfo() {
        val raw = qrInput.text.toString()
        qrInfo.text = when {
            raw.isBlank() -> ""
            else -> try {
                val qr = TemialQr.parse(raw, texts)
                getString(R.string.setup_qr_info, qr.serialNumber, qr.hotspot)
            } catch (e: SetupException) {
                e.message
            }
        }
    }

    // --- Setup --------------------------------------------------------------

    private fun run(scanOnly: Boolean, automatic: Boolean) {
        val qr = try {
            TemialQr.parse(qrInput.text.toString(), texts)
        } catch (e: SetupException) {
            showMessage(e.message ?: getString(R.string.setup_qr_missing), error = true)
            return
        }
        val ssid = ssidInput.text.toString()
        val key = keyInput.text.toString()
        val baseHost = Settings.normalizeUrl(baseHostInput.text.toString()) ?: baseHostInput.text.toString().trim()
        val security = securitySpinner.selectedItemPosition.let { if (it == 0) null else it - 1 }
        if (!scanOnly) {
            try {
                TemialProtocol.validate(ssid, key, baseHost, texts)
            } catch (e: SetupException) {
                showMessage(e.message ?: getString(R.string.setup_check_input), error = true)
                return
            }
        }

        setRunning(true)
        val onNetwork = { network: Network ->
            thread(name = "temial-setup") {
                try {
                    val socket = network.socketFactory.createSocket()
                    socket.connect(InetSocketAddress(TemialProtocol.HOST, TemialProtocol.PORT), CONNECT_TIMEOUT_MS)
                    step(getString(R.string.setup_connected))
                    TemialLink(socket, qr.pairingCode, texts).use { link ->
                        val flow = TemialSetupFlow(link, qr, texts, ::step)
                        if (scanOnly) {
                            val networks = flow.scan()
                            runOnUiThread { chooseNetwork(networks) }
                        } else {
                            val confirmed = flow.configure(ssid, key, baseHost, security)
                            showMessage(
                                getString(if (confirmed) R.string.setup_done_confirmed else R.string.setup_done_sent) +
                                    getString(R.string.setup_done_next),
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
        step(getString(R.string.setup_connecting_hotspot, qr.hotspot))
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
                step(getString(R.string.setup_hotspot_connected, qr.hotspot))
                onNetwork(network)
            }

            override fun onUnavailable() {
                showMessage(getString(R.string.setup_hotspot_unavailable, qr.hotspot), error = true)
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
            showMessage(getString(R.string.setup_no_wifi, qr.hotspot), error = true)
            setRunning(false)
            return
        }
        step(getString(R.string.setup_using_wifi))
        onNetwork(wifi)
    }

    private fun releaseNetwork() {
        networkCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        networkCallback = null
    }

    private fun chooseNetwork(networks: List<WifiNetwork>) {
        if (networks.isEmpty()) {
            showMessage(getString(R.string.setup_no_networks), error = true)
            return
        }
        val labels = networks.map { getString(R.string.setup_network_label, it.ssid, TemialProtocol.SECURITY_TYPES.getOrElse(it.securityType) { "?" }, it.signalStrength) }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.setup_choose_network))
            .setItems(labels.toTypedArray()) { _, index ->
                ssidInput.setText(networks[index].ssid)
                keyInput.requestFocus()
            }
            .show()
        showMessage(getString(R.string.setup_networks_found, networks.size), error = false)
    }

    private fun explain(e: Exception, qr: TemialQr): String = when (e) {
        is SetupException -> e.message ?: getString(R.string.setup_error_generic)
        is ConnectionClosedException -> getString(R.string.setup_error_closed)
        is SocketTimeoutException -> getString(R.string.setup_error_timeout, qr.hotspot)
        is ConnectException, is NoRouteToHostException -> getString(R.string.setup_error_unreachable, qr.hotspot)
        else -> getString(R.string.setup_error_other, e.message ?: e.javaClass.simpleName)
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
        private const val SCAN_REQUEST = 1
    }
}
