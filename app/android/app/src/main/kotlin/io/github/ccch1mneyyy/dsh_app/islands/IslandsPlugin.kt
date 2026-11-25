package io.github.ccch1mneyyy.dsh_app.islands

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.webviewflutter.WebViewFlutterAndroidExternalApi

/**
 * Web islands, Android side: MethodChannel `dsh/islands` (lib/ui/plugins/islands/island_platform.dart).
 *
 * - `device` → `{totalMem, availMem, lowRam, webView}` for the island budget.
 * - `attach {id, dark, textZoom}` takes over webview_flutter's WebView `id`
 *   (`AndroidWebViewController.webViewIdentifier`): dark mode, text zoom, renderer-crash guard.
 * - `setDark`, `setTextZoom`, `pause`, `resume`, `destroy` `{id, …}`; `appPss` → kB.
 *
 * Calls back `rendererGone {id, crashed}` and `trimMemory {level}`.
 */
class IslandsPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ComponentCallbacks2 {
    private var binding: FlutterPlugin.FlutterPluginBinding? = null
    private var methods: MethodChannel? = null
    private var context: Context? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        this.binding = binding
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        binding.applicationContext.registerComponentCallbacks(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        binding.applicationContext.unregisterComponentCallbacks(this)
        methods?.setMethodCallHandler(null)
        methods = null
        this.binding = null
        context = null
    }

    private fun webView(call: MethodCall): Pair<Long, WebView>? {
        val id = IslandPolicy.webViewId(call.argument<Any>("id")) ?: return null
        val binding = binding ?: return null
        val view = runCatching { WebViewFlutterAndroidExternalApi.getWebView(binding, id) }.getOrNull() ?: return null
        return id to view
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "device" -> result.success(device())
            "appPss" -> result.success(Debug.getPss().toInt())
            "attach" -> {
                val (id, view) = webView(call) ?: return result.success(false)
                Log.i(TAG, "attach $id textZoom(default)=${view.settings.textZoom}")
                IslandWebViews.setDark(view, call.argument<Boolean>("dark") == true)
                call.argument<Int>("textZoom")?.let { IslandWebViews.setTextZoom(view, it) }
                IslandWebViews.guard(view) { crashed ->
                    Log.w(TAG, "renderer gone (crashed=$crashed) for island $id")
                    main.post { methods?.invokeMethod("rendererGone", mapOf("id" to id, "crashed" to crashed)) }
                }
                result.success(true)
            }
            "setDark" -> {
                webView(call)?.let { (_, view) -> IslandWebViews.setDark(view, call.argument<Boolean>("dark") == true) }
                result.success(null)
            }
            "setTextZoom" -> {
                val zoom = call.argument<Int>("zoom")
                webView(call)?.let { (_, view) -> if (zoom != null) IslandWebViews.setTextZoom(view, zoom) }
                result.success(null)
            }
            "pause" -> {
                webView(call)?.second?.onPause()
                result.success(null)
            }
            "resume" -> {
                webView(call)?.second?.onResume()
                result.success(null)
            }
            "destroy" -> {
                webView(call)?.let { (_, view) -> runCatching { IslandWebViews.destroy(view) } }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun device(): Map<String, Any?> {
        val ctx = context ?: return emptyMap()
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val provider = runCatching { WebViewCompat.getCurrentWebViewPackage(ctx) }.getOrNull()
        return mapOf(
            "totalMem" to info.totalMem,
            "availMem" to info.availMem,
            "lowRam" to am.isLowRamDevice,
            "webView" to provider?.let { "${it.packageName} ${it.versionName}" },
        )
    }

    override fun onTrimMemory(level: Int) {
        if (IslandPolicy.forwardsTrim(level)) methods?.invokeMethod("trimMemory", mapOf("level" to level))
    }

    override fun onConfigurationChanged(newConfig: Configuration) {}

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {
        methods?.invokeMethod("trimMemory", mapOf("level" to IslandPolicy.TRIM_COMPLETE))
    }

    companion object {
        private const val CHANNEL = "dsh/islands"
        private const val TAG = "DshIslands"
    }
}
