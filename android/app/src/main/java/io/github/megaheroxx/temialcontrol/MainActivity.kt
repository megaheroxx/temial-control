package io.github.megaheroxx.temialcontrol

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowInsets
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Shows the Temial Control dashboard of the configured server. */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var settings: Settings
    private var loadedUrl: String? = null
    private var askedForSettings = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        val version = packageManager.getPackageInfo(packageName, 0).versionName

        webView = WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Lets the dashboard show app-only controls (settings button).
            settings.userAgentString = "${settings.userAgentString} TemialControlApp/$version"
            webViewClient = DashboardClient()
            webChromeClient = DashboardChromeClient()
        }
        // Since Android 15 apps draw edge to edge; keep the page clear of the system bars.
        webView.setOnApplyWindowInsetsListener { view, insets ->
            val bars = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                    .let { intArrayOf(it.left, it.top, it.right, it.bottom) }
            } else {
                @Suppress("DEPRECATION")
                intArrayOf(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            view.setPadding(bars[0], bars[1], bars[2], bars[3])
            insets
        }
        setContentView(webView)
        requestNotificationPermission()
    }

    override fun onResume() {
        super.onResume()
        if (!settings.isConfigured) {
            // Leaving the settings screen without saving closes the app instead of reopening it.
            if (askedForSettings) finish()
            else startActivity(Intent(this, SettingsActivity::class.java))
            askedForSettings = true
            return
        }
        syncWatchService(this)
        if (loadedUrl != settings.url) {
            loadedUrl = settings.url
            webView.loadUrl(settings.url)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Uses the platform API without AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_REQUEST) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        } else {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST)
        }
    }

    private fun showError(description: String) {
        val html = """
            <!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;color:#1e1e1c;background:#f3f3f1}
              @media (prefers-color-scheme:dark){body{color:#f0f0ee;background:#121312}}
              h1{font-size:1.3rem} p{color:#6e6e69}
              a{display:inline-block;margin:8px;padding:12px 22px;border-radius:999px;border:2px solid #00a046;color:#00a046;text-decoration:none;font-weight:600}
              a.primary{background:#00a046;color:#fff}
            </style></head><body>
            <h1>Temial Control nicht erreichbar</h1>
            <p>${escapeHtml(settings.url)}<br>${escapeHtml(description)}</p>
            <p>Ist das Handy im selben WLAN wie der Server?</p>
            <a class="primary" href="app://retry">Erneut versuchen</a>
            <a href="app://settings">Einstellungen</a>
            </body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private inner class DashboardClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            when {
                uri.scheme == "app" && uri.host == "settings" ->
                    startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
                uri.scheme == "app" && uri.host == "retry" -> view.loadUrl(settings.url)
                uri.toString().startsWith(settings.url) -> return false
                // External links (e.g. the Freemial website) open in the browser.
                else -> startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            val token = settings.token
            if (token.isEmpty() || !url.startsWith(settings.url)) return
            // Hand the token to the dashboard so it does not have to ask for it again.
            val quoted = JSONObject.quote(token)
            view.evaluateJavascript(
                "(function(){try{if(localStorage.getItem('temial-control-token')!==$quoted)" +
                    "{localStorage.setItem('temial-control-token',$quoted);location.reload()}}catch(e){}})()",
                null,
            )
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError(error.description.toString())
        }
    }

    private inner class DashboardChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(params.createIntent(), FILE_REQUEST)
                true
            } catch (e: Exception) {
                fileCallback = null
                false
            }
        }
    }

    companion object {
        private const val FILE_REQUEST = 1
        private const val PERMISSION_REQUEST = 2

        private fun escapeHtml(text: String) =
            text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    }
}
