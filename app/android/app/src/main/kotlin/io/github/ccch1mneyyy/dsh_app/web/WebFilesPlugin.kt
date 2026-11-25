package io.github.ccch1mneyyy.dsh_app.web

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.WebView
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import io.flutter.plugins.webviewflutter.WebViewFlutterAndroidExternalApi
import io.github.ccch1mneyyy.dsh_app.MainActivity
import io.github.ccch1mneyyy.dsh_app.files.FilesPlugin
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Foreground web file selection and scoped TradeLoom attachment saving. */
class WebFilesPlugin(private val files: FilesPlugin) : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler,
    PluginRegistry.ActivityResultListener {
    private data class Pending(
        val owner: String, val view: WebView, val url: String,
        val multiple: Boolean, val result: MethodChannel.Result,
    )
    private data class Download(
        val owner: String, val view: WebView, val document: String,
        val cancelled: AtomicBoolean = AtomicBoolean(),
    )
    private val main = Handler(Looper.getMainLooper())
    private var download: Download? = null
    private var engine: FlutterPlugin.FlutterPluginBinding? = null
    private var activity: ActivityPluginBinding? = null
    private var channel: MethodChannel? = null
    private var pending: Pending? = null
    // Cancelling the owner does not dismiss the system picker. Do not let a
    // late result satisfy a new request with the same Activity request code.
    private var waiting = false

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        engine = binding
        channel = MethodChannel(binding.binaryMessenger, "dsh/web-files").also { it.setMethodCallHandler(this) }
    }
    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cancel()
        download?.cancelled?.set(true)
        channel?.setMethodCallHandler(null)
        channel = null
        engine = null
    }
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding
        binding.addActivityResultListener(this)
    }
    override fun onDetachedFromActivityForConfigChanges() {
        cancel()
        download?.cancelled?.set(true)
        activity?.removeActivityResultListener(this)
        activity = null
    }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    override fun onDetachedFromActivity() {
        onDetachedFromActivityForConfigChanges()
        waiting = false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "pick" -> pick(call, result)
            "downloadTradeLoom" -> downloadTradeLoom(call, result)
            "cancelTradeLoomDownload" -> {
                val owner = call.argument<String>("owner")
                download?.takeIf { it.owner == owner }?.cancelled?.set(true)
                result.success(null)
            }
            "cancel" -> {
                if (call.argument<String>("owner") == pending?.owner) cancel()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun downloadTradeLoom(call: MethodCall, result: MethodChannel.Result) {
        val binding = engine
        val id = (call.argument<Any>("webViewId") as? Number)?.toLong()
        val view = if (binding != null && id != null)
            runCatching { WebViewFlutterAndroidExternalApi.getWebView(binding, id) }.getOrNull() else null
        val document = view?.url
        val owner = call.argument<String>("owner")
        val target = if (document != null) TradeLoomAttachment.target(
            call.argument<String>("origin") ?: "", document, call.argument<String>("url") ?: "",
        ) else null
        if (binding == null || view == null || document == null || owner.isNullOrBlank() ||
            target == null || activity == null || !MainActivity.inForeground || !view.isShown ||
            !view.isAttachedToWindow || download != null) {
            return result.error("attachment_unavailable", null, null)
        }

        val targetUrl = target.toString()
        val cookies = CookieManager.getInstance()
        val cookie = cookies.getCookie(targetUrl)
        if (cookie.isNullOrBlank()) return result.error("attachment_unavailable", null, null)

        val job = Download(owner, view, document)
        download = job
        thread(name = "tradeloom-attachment", isDaemon = true) {
            var staging: File? = null
            val metadata = runCatching {
                val file = File.createTempFile("delivery-", ".part", binding.applicationContext.cacheDir)
                staging = file
                TradeLoomAttachment.fetch(target, cookie, file, job.cancelled::get)
            }.getOrNull()
            main.post {
                val file = staging
                val current = !job.cancelled.get() && job.view.url == job.document &&
                    job.view.isAttachedToWindow && job.view.isShown && MainActivity.inForeground &&
                    cookies.getCookie(targetUrl) == cookie
                if (!current || file == null || metadata == null) {
                    file?.delete()
                    download = null
                    if (current) result.error("attachment_unavailable", null, null) else result.success(null)
                    return@post
                }
                files.saveWebAttachment(file, metadata.filename, metadata.mime, job.cancelled::get, object : MethodChannel.Result {
                    override fun success(value: Any?) {
                        file.delete()
                        download = null
                        result.success(value)
                    }
                    override fun error(code: String, message: String?, details: Any?) {
                        file.delete()
                        download = null
                        result.error("attachment_unavailable", null, null)
                    }
                    override fun notImplemented() = error("attachment_unavailable", null, null)
                })
            }
        }
    }

    private fun pick(call: MethodCall, result: MethodChannel.Result) {
        val binding = engine
        val activity = activity?.activity
        val id = (call.argument<Any>("webViewId") as? Number)?.toLong()
        val view = if (binding != null && id != null)
            runCatching { WebViewFlutterAndroidExternalApi.getWebView(binding, id) }.getOrNull() else null
        val owner = call.argument<String>("owner")
        val url = call.argument<String>("url")
        if (waiting || pending != null || activity == null || !MainActivity.inForeground ||
            view == null || !view.isShown || owner.isNullOrEmpty() || url.isNullOrEmpty() || view.url != url) {
            result.success(emptyList<String>()); return
        }
        val types = WebFilePolicy.acceptTypes(call.argument<List<String>>("acceptTypes") ?: emptyList()) {
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(it)
        }
        val multiple = call.argument<Boolean>("multiple") == true
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = types.singleOrNull() ?: "*/*"
            if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        pending = Pending(owner, view, url, multiple, result)
        waiting = true
        try {
            activity.startActivityForResult(intent, REQUEST)
        } catch (_: Exception) {
            waiting = false
            cancel()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST) return false
        waiting = false
        val request = pending ?: return true
        pending = null
        val context = engine?.applicationContext
        if (resultCode != Activity.RESULT_OK || data == null || context == null ||
            request.view.url != request.url || !request.view.isAttachedToWindow) {
            request.result.success(emptyList<String>()); return true
        }
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } }
            ?: listOfNotNull(data.data)
        val allowed = uris.isNotEmpty() && (request.multiple || uris.size == 1) && uris.all { uri ->
            uri != null && WebFilePolicy.isExternalContent(uri.toString(), context.packageName) &&
                context.packageManager.resolveContentProvider(uri.authority ?: "", 0)?.applicationInfo?.uid != Process.myUid() &&
                context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                    PackageManager.PERMISSION_GRANTED
        }
        request.result.success(if (allowed) uris.map { it.toString() }.distinct() else emptyList<String>())
        return true
    }

    private fun cancel() {
        val request = pending
        pending = null
        request?.result?.success(emptyList<String>())
    }

    companion object { private const val REQUEST = 0x6D57 }
}
