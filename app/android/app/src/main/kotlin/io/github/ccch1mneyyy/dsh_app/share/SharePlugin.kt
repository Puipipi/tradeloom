package io.github.ccch1mneyyy.dsh_app.share

import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import io.github.ccch1mneyyy.dsh_app.R
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Text, images and files shared to the app from other apps: MethodChannel `dsh/share`.
 *
 * [ShareActivity] (the share sheet's target) forwards every ACTION_SEND / ACTION_SEND_MULTIPLE
 * to MainActivity as [ACTION_SHARE]; this plugin takes it from the launch intent (cold start) or
 * onNewIntent, copies the shared files into `cache/share/<slot>/` off the main thread (photos
 * scaled to [ShareImages.MAX_SIDE], see there) and pushes one `share` call to Dart:
 *
 * ```
 * {text, subject,
 *  files:   [{path, name, mime, size}],              // readable with dart:io
 *  skipped: [{name, reason: too_large | unreadable | too_many}]}
 * ```
 *
 * Dart calls `ready` once its handler is set; shares that arrive before are held and delivered
 * in order on `ready` (the same contract as links/LinksPlugin).
 *
 * Only `content:` URIs of other apps are read: a `file:` URI or one of this app's own providers
 * would let any app have dsh-go attach its private files to a message.
 */
class SharePlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler, PluginRegistry.NewIntentListener {

    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private var activity: ActivityPluginBinding? = null
    private var ready = false
    private val pending = ArrayList<Map<String, Any?>>()
    private val main = Handler(Looper.getMainLooper())
    private var slotSeq = 0

    /** One share at a time, in arrival order. */
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-share").apply { isDaemon = true } }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        ready = false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "ready" -> {
                ready = true
                val held = ArrayList(pending)
                pending.clear()
                result.success(true)
                for (event in held) methods.invokeMethod("share", event)
            }
            else -> result.notImplemented()
        }
    }

    // ActivityAware

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding
        binding.addOnNewIntentListener(this)
        val launch = binding.activity.intent ?: return
        if (launch.getBooleanExtra(EXTRA_TAKEN, false)) return
        if ((launch.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
        if (take(launch)) launch.putExtra(EXTRA_TAKEN, true)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activity?.removeOnNewIntentListener(this)
        activity = null
    }

    override fun onNewIntent(intent: Intent): Boolean = take(intent)

    /** Starts reading what [intent] shares; false when it isn't a share. */
    private fun take(intent: Intent): Boolean {
        if (intent.action != ACTION_SHARE) return false
        val share = Received(
            text = textOf(intent),
            subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim()?.takeIf { it.isNotEmpty() },
            streams = streamsOf(intent),
            type = intent.type,
        )
        if (share.text == null && share.streams.isEmpty()) return true
        worker.execute {
            val event = try {
                read(share)
            } catch (_: Throwable) {
                mapOf("text" to share.text, "subject" to share.subject, "files" to emptyList<Any>(),
                    "skipped" to share.streams.map { skip(null, "unreadable") })
            }
            main.post { deliver(event) }
        }
        return true
    }

    private class Received(val text: String?, val subject: String?, val streams: List<Uri>, val type: String?)

    // Reading

    private fun read(share: Received): Map<String, Any?> {
        val files = ArrayList<Map<String, Any?>>()
        val skipped = ArrayList<Map<String, Any?>>()
        if (share.streams.isNotEmpty()) {
            val dir = File(context.cacheDir, "share").apply { mkdirs() }
            ShareNames.pruneSlots(dir, KEEP_SLOTS - 1)
            val slot = File(dir, "${System.currentTimeMillis().toString(36)}-${slotSeq++}").apply { mkdirs() }
            var total = 0L
            for ((index, uri) in share.streams.withIndex()) {
                if (index >= MAX_ITEMS) {
                    skipped += skip(null, "too_many")
                    continue
                }
                val item = readOne(uri, slot, if (share.streams.size == 1) share.type else null)
                if (item.file == null) {
                    skipped += skip(item.name, item.problem ?: "unreadable")
                    continue
                }
                val nextTotal = total + item.file.length()
                if (nextTotal > MAX_TOTAL_BYTES) {
                    item.file.delete()
                    skipped += skip(item.name, "too_large")
                    continue
                }
                total = nextTotal
                files += mapOf(
                    "path" to item.file.absolutePath,
                    "name" to item.file.name,
                    "mime" to item.mime,
                    "size" to item.file.length(),
                )
            }
        }
        return mapOf("text" to share.text, "subject" to share.subject, "files" to files, "skipped" to skipped)
    }

    private class Item(val file: File?, val name: String?, val mime: String?, val problem: String? = null)

    private fun readOne(uri: Uri, slot: File, fallbackType: String?): Item {
        if (!readable(uri)) return Item(null, null, null, "unreadable")
        val resolver = context.contentResolver
        var name: String? = null
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst()) {
                    val n = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val s = it.getColumnIndex(OpenableColumns.SIZE)
                    if (n >= 0 && !it.isNull(n)) name = it.getString(n)
                    if (s >= 0 && !it.isNull(s)) size = it.getLong(s)
                }
            }
        } catch (_: Exception) {
            // Some providers answer only openInputStream.
        }
        val mime = (try { resolver.getType(uri) } catch (_: Exception) { null })
            ?: fallbackType?.takeUnless { it.contains('*') }
        val shown = ShareNames.withExtension(
            ShareNames.safeName(name ?: uri.lastPathSegment ?: ShareNames.fallbackName(mime,
                AppStrings.get(context, R.string.share_file), AppStrings.get(context, R.string.share_image),
                AppStrings.get(context, R.string.share_video), AppStrings.get(context, R.string.share_audio),
                AppStrings.get(context, R.string.share_text))),
            extensionOf(mime),
        )
        val target = ShareNames.unique(slot, shown)

        if (ShareImages.scalable(mime)) {
            try {
                ShareImages.prepare(resolver, uri, target)?.let { return Item(it, shown, ShareImages.mimeOf(it), null) }
            } catch (_: Throwable) {
                // Undecodable here: sent as it is.
            }
        }
        if (size > MAX_FILE_BYTES) return Item(null, shown, mime, "too_large")
        val input = try {
            resolver.openInputStream(uri)
        } catch (_: Exception) {
            null
        } ?: return Item(null, shown, mime, "unreadable")
        try {
            input.use { stream ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var copied = 0L
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        copied += read
                        if (copied > MAX_FILE_BYTES) {
                            out.close()
                            target.delete()
                            return Item(null, shown, mime, "too_large")
                        }
                        out.write(buffer, 0, read)
                    }
                }
            }
        } catch (_: IOException) {
            target.delete()
            return Item(null, shown, mime, "unreadable")
        }
        return Item(target, shown, mime)
    }

    private fun extensionOf(mime: String?): String? = when (mime) {
        null -> null
        ShareNames.SHARE_CODE_MIME -> ShareNames.SHARE_CODE_EXTENSION
        else -> MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
    }

    /** Another app's `content:` URI. */
    private fun readable(uri: Uri): Boolean {
        if (uri.scheme?.lowercase() != "content") return false
        val authority = uri.authority ?: return false
        val own = context.packageName
        return authority.split(';').none { it == own || it.startsWith("$own.") }
    }

    private fun skip(name: String?, reason: String): Map<String, Any?> = mapOf("name" to name, "reason" to reason)

    // Delivery

    private fun deliver(event: Map<String, Any?>) {
        if (ready) methods.invokeMethod("share", event) else pending += event
    }

    companion object {
        const val CHANNEL = "dsh/share"
        const val ACTION_SHARE = "io.github.ccch1mneyyy.dsh_app.action.SHARE"

        /** The action the sender used (ACTION_SEND / ACTION_SEND_MULTIPLE). */
        const val EXTRA_SENT_AS = "io.github.ccch1mneyyy.dsh_app.share.SENT_AS"
        private const val EXTRA_TAKEN = "io.github.ccch1mneyyy.dsh_app.share.TAKEN"

        /** The composer's limit (lib/state/attachments.dart `maxAttachments`). */
        const val MAX_ITEMS = 9

        /** `maxFileBytes` there. */
        const val MAX_FILE_BYTES = 200L * 1024 * 1024

        /** All files of one share: the memory budget on the Dart side until sent. */
        const val MAX_TOTAL_BYTES = 400L * 1024 * 1024
        const val MAX_TEXT_CHARS = 200_000
        private const val KEEP_SLOTS = 4

        /** The shared streams: EXTRA_STREAM (one or a list), else the ClipData URIs. */
        @Suppress("DEPRECATION")
        fun streamsOf(intent: Intent): List<Uri> {
            val found = LinkedHashSet<Uri>()
            val extra: Any? = try {
                intent.extras?.get(Intent.EXTRA_STREAM)
            } catch (_: Exception) {
                null
            }
            when (extra) {
                is Uri -> found += extra
                is ArrayList<*> -> for (item in extra) if (item is Uri) found += item
            }
            if (found.isEmpty()) {
                val clip = intent.clipData
                if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { found += it }
            }
            return found.toList()
        }

        /** EXTRA_TEXT (one, or a list for SEND_MULTIPLE), else ClipData text; capped. */
        fun textOf(intent: Intent): String? {
            val parts = ArrayList<String>()
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { parts += it.toString() }
            if (parts.isEmpty()) {
                intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.forEach { parts += it.toString() }
            }
            if (parts.isEmpty()) {
                val clip = intent.clipData
                if (clip != null) {
                    for (i in 0 until clip.itemCount) {
                        val item = clip.getItemAt(i)
                        if (item.uri == null) item.text?.let { parts += it.toString() }
                    }
                }
            }
            val text = parts.map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n\n")
            return text.ifEmpty { null }?.take(MAX_TEXT_CHARS)
        }
    }
}
