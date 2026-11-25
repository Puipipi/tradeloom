package io.github.ccch1mneyyy.dsh_app.performance

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Facts are read on one worker; thermal state and channel delivery are serialized on main. */
class PerformancePlugin : FlutterPlugin, EventChannel.StreamHandler {
    private val main = Handler(Looper.getMainLooper())
    private var methods: MethodChannel? = null
    private var events: EventChannel? = null
    private var sink: EventChannel.EventSink? = null
    private var power: PowerManager? = null
    private var listener: PowerManager.OnThermalStatusChangedListener? = null
    private var listenerError: String? = null
    private var attached = false
    private var generation = 0L
    private var profile: DeviceProfile? = null
    private var sequence = 0L
    private var thermal = ThermalPolicy()
    private val pending = ArrayList<MethodChannel.Result>()
    private var worker: ExecutorService? = null
    private val recovery = Runnable {
        if (attached && thermal.advance(SystemClock.uptimeMillis())) publish()
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        attached = true
        val currentGeneration = ++generation
        profile = null
        thermal = ThermalPolicy()
        listenerError = null
        val app = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "dsh/performance").also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (!attached || generation != currentGeneration) result.error("detached", "Performance channel detached", null)
                else if (call.method != "snapshot") result.notImplemented()
                else if (profile != null) result.success(snapshot()) else pending.add(result)
            }
        }
        events = EventChannel(binding.binaryMessenger, "dsh/performance/events").also { it.setStreamHandler(this) }
        if (Build.VERSION.SDK_INT >= 29) {
            power = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val callback = PowerManager.OnThermalStatusChangedListener { status ->
                if (attached && generation == currentGeneration && thermal.update(status, SystemClock.uptimeMillis())) {
                    scheduleRecovery()
                    publish()
                }
            }
            runCatching {
                power?.let {
                    it.addThermalStatusListener({ command -> main.post(command) }, callback)
                    listener = callback
                    runCatching { thermal.update(it.currentThermalStatus, SystemClock.uptimeMillis()) }
                        .onFailure { error -> listenerError = error.javaClass.simpleName }
                    scheduleRecovery()
                } ?: run { listenerError = "power_manager_unavailable" }
            }.onFailure { listenerError = it.javaClass.simpleName }
        }
        ThermalRuntime.lightweight = if (listener != null) thermal.lightweight else null
        worker = Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-performance").apply { isDaemon = true } }
        worker!!.execute {
            val facts = runCatching { DevicePerformance.read(app) }.getOrElse { DeviceProfile(sdkInt = Build.VERSION.SDK_INT) }
            main.post {
                if (!attached || generation != currentGeneration) return@post
                profile = facts
                publish()
                pending.toList().also { pending.clear() }.forEach { it.success(snapshot()) }
            }
        }
    }

    private fun scheduleRecovery() {
        main.removeCallbacks(recovery)
        thermal.recoveryAt?.let { main.postDelayed(recovery, (it - SystemClock.uptimeMillis()).coerceAtLeast(0)) }
    }

    private fun snapshot(): Map<String, Any?> = mapOf(
        "sequence" to sequence,
        "device" to profile?.toMap(),
        "thermal" to (thermal.toMap(Build.VERSION.SDK_INT >= 29, listener != null) + ("listenerError" to listenerError)),
    )

    private fun publish() {
        ThermalRuntime.lightweight = if (listener != null) thermal.lightweight else null
        sequence++
        sink?.success(snapshot())
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        sink = events
        if (profile != null) events?.success(snapshot())
    }

    override fun onCancel(arguments: Any?) { sink = null }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        attached = false
        generation++
        main.removeCallbacks(recovery)
        if (Build.VERSION.SDK_INT >= 29) listener?.let { runCatching { power?.removeThermalStatusListener(it) } }
        listener = null
        power = null
        ThermalRuntime.lightweight = null
        methods?.setMethodCallHandler(null)
        events?.setStreamHandler(null)
        methods = null
        events = null
        sink = null
        pending.forEach { it.error("detached", "Performance channel detached", null) }
        pending.clear()
        worker?.shutdownNow()
        worker = null
    }
}
