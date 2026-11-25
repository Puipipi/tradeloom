package io.github.ccch1mneyyy.dsh_app.icons

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.github.ccch1mneyyy.dsh_app.shortcuts.EntryActivity
import io.github.ccch1mneyyy.dsh_app.shortcuts.ShortcutsPlugin

/**
 * 图片快捷方式: MethodChannel `dsh/picture_shortcut`. Android has no way for an app to make its
 * launcher icon an arbitrary picture (the 桌面图标 aliases are fixed resources); a pinned
 * shortcut with the user's picture that opens the app is the honest stand-in.
 *
 * - `pin {label, png}` → `{supported, requested}`: asks the launcher (its own confirmation
 *   dialog). `png` is the full 108 dp adaptive layer; the launcher masks the middle.
 * Some makers (vivo, Xiaomi) keep a "home screen shortcuts" permission that is off until
 * granted; the Dart side opens their page for it through dsh/runtime `openVendorSettings`.
 * - native → Dart `pinned`: the launcher reported the shortcut added (not every launcher does).
 */
class PictureShortcutPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private val main = Handler(Looper.getMainLooper())
    private var receiver: BroadcastReceiver? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                main.post { methods.invokeMethod("pinned", null) }
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(r, IntentFilter(ACTION_PINNED), Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(r, IntentFilter(ACTION_PINNED))
            }
            receiver = r
        } catch (_: Exception) {
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "pin" -> {
                val label = PictureShortcuts.label(call.argument<String>("label"))
                val png = call.argument<ByteArray>("png")
                if (png == null || png.isEmpty() || png.size > PictureShortcuts.MAX_PNG_BYTES) {
                    result.error("invalid", "no picture", null)
                    return
                }
                ShortcutsPlugin.worker.execute {
                    val answer = pin(label, png)
                    main.post { result.success(answer) }
                }
            }
            else -> result.notImplemented()
        }
    }

    private fun pin(label: String, png: ByteArray): Map<String, Boolean> {
        val manager = context.getSystemService(ShortcutManager::class.java)
        if (manager == null || !manager.isRequestPinShortcutSupported) {
            return mapOf("supported" to false, "requested" to false)
        }
        return try {
            val bitmap = BitmapFactory.decodeByteArray(png, 0, png.size)
                ?: return mapOf("supported" to true, "requested" to false)
            val info = ShortcutInfo.Builder(context, PictureShortcuts.id(System.currentTimeMillis()))
                .setShortLabel(label)
                .setLongLabel(label)
                .setIcon(Icon.createWithAdaptiveBitmap(bitmap))
                .setIntent(EntryActivity.openApp(context))
                .build()
            val callback = PendingIntent.getBroadcast(
                context,
                REQUEST,
                Intent(ACTION_PINNED).setPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            mapOf("supported" to true, "requested" to manager.requestPinShortcut(info, callback.intentSender))
        } catch (_: Exception) {
            mapOf("supported" to true, "requested" to false)
        }
    }

    companion object {
        const val CHANNEL = "dsh/picture_shortcut"
        private const val ACTION_PINNED = "io.github.ccch1mneyyy.dsh_app.action.PICTURE_SHORTCUT_PINNED"
        private const val REQUEST = 0x5049
    }
}

/** Pure parts of [PictureShortcutPlugin], unit-tested on the JVM. */
internal object PictureShortcuts {
    /** A 432 px PNG is well under this; anything near it is not one of ours. */
    const val MAX_PNG_BYTES = 2 * 1024 * 1024

    /** Launchers cut long labels anyway; the short label's own cap is 10 to 12 characters. */
    private const val MAX_LABEL = 24

    const val PREFIX = "picture:"

    /** Each picture is its own shortcut (pinning another doesn't replace the first). */
    fun id(now: Long) = "$PREFIX$now"

    fun label(raw: String?): String {
        val clean = raw.orEmpty().replace(Regex("\\s+"), " ").trim()
        if (clean.isEmpty()) return "DSH Go"
        return if (clean.codePointCount(0, clean.length) <= MAX_LABEL) clean
        else clean.substring(0, clean.offsetByCodePoints(0, MAX_LABEL))
    }
}
