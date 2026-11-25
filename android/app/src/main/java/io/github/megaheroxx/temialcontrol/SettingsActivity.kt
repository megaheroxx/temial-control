package io.github.megaheroxx.temialcontrol

import android.app.Activity
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Asks for the server address, the optional API token and whether to show notifications. */
class SettingsActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var notifySwitch: Switch
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
        }

        content.addView(text("Temial Control", 26f, bold = true))
        content.addView(
            text(getString(R.string.settings_intro), 15f, muted = true),
            margins(top = 6, bottom = 28),
        )

        content.addView(label(getString(R.string.settings_server)))
        urlInput = input("http://192.168.1.40:3010", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        urlInput.setText(settings.url)
        content.addView(urlInput, margins(bottom = 18))

        content.addView(label(getString(R.string.settings_token)))
        tokenInput = input(getString(R.string.settings_token_hint), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        tokenInput.setText(settings.token)
        content.addView(tokenInput, margins(bottom = 18))

        notifySwitch = Switch(this).apply {
            text = getString(R.string.settings_notifications)
            textSize = 15f
            setTextColor(getColor(R.color.text))
            isChecked = settings.notifications
        }
        content.addView(notifySwitch, margins(bottom = 28))

        content.addView(Button(this).apply {
            text = getString(R.string.settings_save)
            isAllCaps = false
            textSize = 16f
            setTextColor(0xFFFFFFFF.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(getColor(R.color.accent))
            }
            setOnClickListener { save() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)))

        status = text("", 14f, muted = true).apply { gravity = Gravity.CENTER }
        content.addView(status, margins(top = 16))

        content.addView(Button(this).apply {
            text = getString(R.string.settings_new_temial)
            isAllCaps = false
            textSize = 16f
            setTextColor(getColor(R.color.accent))
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setStroke(dp(2), getColor(R.color.accent))
            }
            setOnClickListener { startActivity(android.content.Intent(this@SettingsActivity, SetupActivity::class.java)) }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(24) })

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

    private fun save() {
        val url = Settings.normalizeUrl(urlInput.text.toString())
        if (url == null) {
            urlInput.error = getString(R.string.settings_invalid_url)
            return
        }
        val token = tokenInput.text.toString().trim()
        status.text = getString(R.string.settings_checking)

        thread {
            val result = checkServer(url, token)
            runOnUiThread {
                if (result == null) {
                    settings.url = url
                    settings.token = token
                    settings.notifications = notifySwitch.isChecked
                    // Restart so a running service picks up the new address and token.
                    stopService(android.content.Intent(this, WatchService::class.java))
                    syncWatchService(this)
                    Toast.makeText(this, getString(R.string.settings_connected, url), Toast.LENGTH_SHORT).show()
                    finish()
                } else {
                    status.text = result
                }
            }
        }
    }

    /** Returns null if the server answers, otherwise a localised error message. */
    private fun checkServer(url: String, token: String): String? = try {
        val connection = URL("$url/api/config").openConnection() as HttpURLConnection
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
        val code = connection.responseCode
        connection.disconnect()
        when (code) {
            200 -> null
            401 -> getString(R.string.settings_token_required)
            else -> getString(R.string.settings_unexpected, code)
        }
    } catch (e: Exception) {
        getString(R.string.settings_unreachable, e.message ?: e.javaClass.simpleName)
    }

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
        setPadding(dp(4), 0, 0, dp(6))
    }

    private fun input(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = type
        isSingleLine = true
        textSize = 16f
        setTextColor(getColor(R.color.text))
        setHintTextColor(getColor(R.color.muted))
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            setColor(getColor(R.color.surface))
            setStroke(dp(1), getColor(R.color.muted) and 0x40FFFFFF)
        }
    }
}
