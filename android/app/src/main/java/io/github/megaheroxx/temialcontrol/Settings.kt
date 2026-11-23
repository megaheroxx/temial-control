package io.github.megaheroxx.temialcontrol

import android.content.Context
import android.content.Intent
import android.os.Build

/** Persistent app settings: server address, optional API token, notifications on/off. */
class Settings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var url: String
        get() = prefs.getString("url", "") ?: ""
        set(value) = prefs.edit().putString("url", value).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(value) = prefs.edit().putString("token", value).apply()

    var notifications: Boolean
        get() = prefs.getBoolean("notifications", true)
        set(value) = prefs.edit().putBoolean("notifications", value).apply()

    val isConfigured: Boolean
        get() = url.isNotBlank()

    companion object {
        private val URL_PATTERN = Regex("^https?://[^/\\s]+$")

        /** Normalizes user input like "192.168.1.40:3010/" to "http://192.168.1.40:3010", or returns null. */
        fun normalizeUrl(input: String): String? {
            var url = input.trim().trimEnd('/')
            if (url.isEmpty()) return null
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
            return url.takeIf { URL_PATTERN.matches(it) }
        }
    }
}

/** Starts or stops the background service according to the current settings. */
fun syncWatchService(context: Context) {
    val settings = Settings(context)
    val intent = Intent(context, WatchService::class.java)
    if (settings.isConfigured && settings.notifications) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
    } else {
        context.stopService(intent)
    }
}
