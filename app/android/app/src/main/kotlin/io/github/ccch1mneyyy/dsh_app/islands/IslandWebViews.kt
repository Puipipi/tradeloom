package io.github.ccch1mneyyy.dsh_app.islands

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Message
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * What the islands need from a WebView that webview_flutter doesn't do: `prefers-color-scheme`
 * that follows the app, text zoom from the app's text scale, and surviving a renderer crash.
 */
object IslandWebViews {
    /**
     * The page reports `prefers-color-scheme` as the app's mode and draws its own dark theme;
     * nothing is darkened by the WebView itself. The app targets SDK 28, where force dark is the
     * switch for that media query (algorithmic darkening is the API 33+ one).
     */
    @Suppress("DEPRECATION")
    fun setDark(webView: WebView, dark: Boolean) {
        val settings = webView.settings
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY)) {
            WebSettingsCompat.setForceDarkStrategy(settings, WebSettingsCompat.DARK_STRATEGY_WEB_THEME_DARKENING_ONLY)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(
                settings,
                if (dark) WebSettingsCompat.FORCE_DARK_ON else WebSettingsCompat.FORCE_DARK_OFF,
            )
        }
    }

    fun setTextZoom(webView: WebView, percent: Int) {
        webView.settings.textZoom = IslandPolicy.textZoom(percent)
    }

    /** Wraps the WebView's client (webview_flutter's) so a dead renderer is reported, not fatal. */
    fun guard(webView: WebView, onGone: (crashed: Boolean) -> Unit) {
        val current = webView.webViewClient
        if (current is GuardedWebViewClient) return
        webView.webViewClient = GuardedWebViewClient(current, onGone)
    }

    /** Detaches (if a platform view still holds it) and destroys. */
    fun destroy(webView: WebView) {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        webView.destroy()
    }
}

/**
 * Forwards everything to webview_flutter's client and handles [onRenderProcessGone]: by default a
 * renderer that crashed or was killed for memory takes the whole app with it. Every WebView of the
 * app shares one renderer, so the Dart side closes every island when this fires.
 */
@Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
internal class GuardedWebViewClient(
    private val inner: WebViewClient,
    private val onGone: (crashed: Boolean) -> Unit,
) : WebViewClient() {
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onGone(detail.didCrash())
        return true
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        inner.shouldOverrideUrlLoading(view, request)

    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = inner.shouldOverrideUrlLoading(view, url)

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) = inner.onPageStarted(view, url, favicon)

    override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)

    override fun onLoadResource(view: WebView, url: String) = inner.onLoadResource(view, url)

    override fun onPageCommitVisible(view: WebView, url: String) = inner.onPageCommitVisible(view, url)

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        inner.shouldInterceptRequest(view, request)

    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
        inner.shouldInterceptRequest(view, url)

    override fun onTooManyRedirects(view: WebView, cancelMsg: Message, continueMsg: Message) =
        inner.onTooManyRedirects(view, cancelMsg, continueMsg)

    override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) =
        inner.onReceivedError(view, errorCode, description, failingUrl)

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
        inner.onReceivedError(view, request, error)

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) =
        inner.onReceivedHttpError(view, request, errorResponse)

    override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
        inner.onFormResubmission(view, dontResend, resend)

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
        inner.doUpdateVisitedHistory(view, url, isReload)

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
        inner.onReceivedSslError(view, handler, error)

    override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
        inner.onReceivedClientCertRequest(view, request)

    override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) =
        inner.onReceivedHttpAuthRequest(view, handler, host, realm)

    override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean = inner.shouldOverrideKeyEvent(view, event)

    override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

    override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) = inner.onScaleChanged(view, oldScale, newScale)

    override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) =
        inner.onReceivedLoginRequest(view, realm, account, args)

    @RequiresApi(Build.VERSION_CODES.O_MR1)
    override fun onSafeBrowsingHit(view: WebView, request: WebResourceRequest, threatType: Int, callback: SafeBrowsingResponse) =
        inner.onSafeBrowsingHit(view, request, threatType, callback)
}
