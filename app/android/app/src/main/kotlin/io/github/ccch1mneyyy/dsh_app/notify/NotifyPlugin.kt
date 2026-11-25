package io.github.ccch1mneyyy.dsh_app.notify

import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import io.github.ccch1mneyyy.dsh_app.R
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

/**
 * Flutter bridge for chat notifications: MethodChannel `dsh/notify` (status / show / cancel /
 * openSettings / actionResult, and the live activity's live / liveStatus / openLiveSettings),
 * EventChannel `dsh/notify/taps` (a notification was tapped) and `dsh/notify/actions` (an
 * approval button was tapped).
 *
 * Taps reach us as MainActivity's launch intent (cold start) or through onNewIntent (the activity
 * is singleTop). A tap that arrives before Dart listens is held and delivered on listen.
 */
class NotifyPlugin :
    FlutterPlugin,
    ActivityAware,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    PluginRegistry.NewIntentListener {

    private lateinit var appContext: Context
    private lateinit var notifier: ChatNotifier
    private lateinit var methods: MethodChannel
    private lateinit var events: EventChannel
    private lateinit var actions: EventChannel
    private var actionSink: EventChannel.EventSink? = null
    private var activity: ActivityPluginBinding? = null
    private var sink: EventChannel.EventSink? = null
    private var pendingTap: Map<String, Any?>? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        instance = this
        appContext = binding.applicationContext
        notifier = ChatNotifier(appContext)
        // A new process: nothing runs yet, so a live activity an earlier one left goes.
        LiveActivity.refresh(appContext)
        methods = MethodChannel(binding.binaryMessenger, "dsh/notify").also { it.setMethodCallHandler(this) }
        events = EventChannel(binding.binaryMessenger, "dsh/notify/taps").also { it.setStreamHandler(this) }
        actions = EventChannel(binding.binaryMessenger, "dsh/notify/actions").also {
            it.setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink) { actionSink = events }
                override fun onCancel(arguments: Any?) { actionSink = null }
            })
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        actions.setStreamHandler(null)
        actionSink = null
        if (instance === this) instance = null
        sink = null
    }

    // ActivityAware

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding
        binding.addOnNewIntentListener(this)
        notifier.takeTap(binding.activity.intent)?.let(::deliver)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activity?.removeOnNewIntentListener(this)
        activity = null
    }

    override fun onNewIntent(intent: Intent): Boolean {
        val tap = notifier.takeTap(intent) ?: return false
        deliver(tap)
        return true
    }

    private fun deliver(tap: Map<String, Any?>) {
        val s = sink
        if (s != null) s.success(tap) else pendingTap = tap
    }

    // MethodChannel

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "status" -> result.success(notifier.status())
            "show" -> {
                val group = call.argument<String>("group")
                val key = call.argument<String>("key")
                val sessionId = call.argument<String>("sessionId")
                if (group.isNullOrEmpty() || key.isNullOrEmpty() || sessionId.isNullOrEmpty()) {
                    return result.error("bad_args", "group, key and sessionId are required", null)
                }
                notifier.show(
                    ChatNotifier.Post(
                        group = group,
                        key = key,
                        attention = call.argument<Boolean>("attention") == true,
                        title = call.argument<String>("title") ?: AppStrings.APP_NAME,
                        text = call.argument<String>("text") ?: "",
                        publicText = call.argument<String>("publicText") ?: AppStrings.get(appContext, R.string.notify_new_reminder),
                        sessionId = sessionId,
                        host = call.argument<String>("host") ?: "",
                        kind = call.argument<String>("kind") ?: "",
                        eventId = call.argument<String>("eventId"),
                        canApprove = call.argument<Boolean>("canApprove") == true,
                        fullText = call.argument<String>("fullText"),
                    ),
                )
                result.success(null)
            }
            "actionResult" -> {
                val group = call.argument<String>("group")
                val key = call.argument<String>("key")
                if (group != null && key != null) notifier.finishAction(group, key, call.argument<String>("result") ?: "failed")
                result.success(null)
            }
            "cancel" -> {
                val group = call.argument<String>("group")
                val key = call.argument<String>("key")
                if (!group.isNullOrEmpty() && !key.isNullOrEmpty()) notifier.cancel(group, key)
                result.success(null)
            }
            "cancelGroup" -> {
                call.argument<String>("group")?.takeIf { it.isNotEmpty() }?.let(notifier::cancelGroup)
                result.success(null)
            }
            "cancelAll" -> {
                notifier.cancelAll()
                result.success(null)
            }
            "openSettings" -> result.success(openSettings(call.argument<String>("channel")))
            "live" -> {
                LiveActivity.update(
                    appContext,
                    enabled = call.argument<Boolean>("enabled") != false,
                    packId = call.argument<String>("packId"),
                    agent = LiveContent.fromMap(call.argument<Map<*, *>>("activity")),
                )
                result.success(null)
            }
            "liveStatus" -> {
                // HyperOS answers its focus check over a binder call into SystemUI: not on the main thread.
                val main = Handler(Looper.getMainLooper())
                Thread {
                    val status = runCatching { LiveActivity.status(appContext) }.getOrNull()
                    main.post { result.success(status) }
                }.start()
            }
            "openLiveSettings" -> result.success(openLiveSettings())
            else -> result.notImplemented()
        }
    }

    /** Opens the system notification settings (or the app info page on ROMs without one). */
    private fun openSettings(channel: String?): Boolean = start(listOf(notifier.settingsIntent(channel), notifier.detailsIntent()))

    /** This app's 「实时活动」 switch where the system has one, else its notification settings. */
    private fun openLiveSettings(): Boolean =
        start(listOf(LiveActivity.settingsIntent(appContext), notifier.settingsIntent(null), notifier.detailsIntent()))

    private fun start(intents: List<Intent>): Boolean {
        val host = activity?.activity
        for (intent in intents) {
            val started = runCatching {
                if (host != null) host.startActivity(intent)
                else appContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
            if (started) return true
        }
        return false
    }

    // EventChannel

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
        pendingTap?.let {
            pendingTap = null
            events.success(it)
        }
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    companion object {
        @Volatile private var instance: NotifyPlugin? = null

        /** Sends a tapped approval button to Flutter; false when nothing listens (no engine yet). */
        fun dispatchAction(action: Map<String, Any?>): Boolean {
            val target = instance?.actionSink ?: return false
            return runCatching { target.success(action) }.isSuccess
        }
    }
}
