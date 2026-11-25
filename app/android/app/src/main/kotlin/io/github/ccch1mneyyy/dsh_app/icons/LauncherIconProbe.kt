package io.github.ccch1mneyyy.dsh_app.icons

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.os.Build
import android.util.Log
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.github.ccch1mneyyy.dsh_app.MainActivity
import io.github.ccch1mneyyy.dsh_app.shortcuts.ShortcutsPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Emulator probe, registered only in debuggable builds and requiring the shell's DUMP permission.
 * `ICON_PROBE --es cmd set --es id night --es seq first` calls the same handler as the icon picker.
 * Other commands: state, hold/release (force Home to beat the worker), picker, finish.
 * Logs `DshIconProbe` JSON with component states, task roots and the Activity/engine identities.
 */
internal class LauncherIconProbe private constructor(
    private val context: Context,
    private val plugin: LauncherIconPlugin,
) {
    private var gate: CountDownLatch? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val cmd = intent.getStringExtra("cmd") ?: "state"
            val seq = intent.getStringExtra("seq") ?: cmd
            when (cmd) {
                "set", "state" -> {
                    // Return the broadcast immediately so the shell can press Home while the
                    // real set is queued behind the gate. Completion is the later status=ok.
                    log(seq, "queued")
                    plugin.onMethodCall(
                        MethodCall(cmd, mapOf("id" to intent.getStringExtra("id"))),
                        object : MethodChannel.Result {
                            override fun success(result: Any?) {
                                log(seq, "ok", (result as? Map<*, *>)?.get("current"))
                            }
                            override fun error(code: String, message: String?, details: Any?) {
                                log(seq, "error:$code", message)
                            }
                            override fun notImplemented() {
                                log(seq, "notImplemented")
                            }
                        },
                    )
                }
                "hold" -> {
                    gate?.countDown()
                    val next = CountDownLatch(1)
                    gate = next
                    ShortcutsPlugin.worker.execute {
                        log(seq, "held")
                        next.await(8, TimeUnit.SECONDS)
                    }
                }
                "release" -> { gate?.countDown(); gate = null; log(seq, "released") }
                "picker" -> {
                    val activity = MainActivity.current?.get()
                    try {
                        check(activity != null && !activity.isDestroyed)
                        activity.startActivity(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            type = "image/*"
                            addCategory(Intent.CATEGORY_OPENABLE)
                        })
                        log(seq, "opened")
                    } catch (e: Exception) {
                        log(seq, "error:${e.javaClass.simpleName}")
                    }
                }
                "finish" -> { MainActivity.current?.get()?.finish(); log(seq, "finishing") }
                else -> log(seq, "unknown")
            }
        }
    }

    fun unregister() {
        gate?.countDown()
        gate = null
        context.unregisterReceiver(receiver)
    }

    private fun log(seq: String, status: String, result: Any? = null) {
        val activity = MainActivity.current?.get()
        val states = JSONObject()
        val enabled = JSONArray()
        for (alias in LauncherIcons.aliases) {
            val value = context.packageManager.getComponentEnabledSetting(ComponentName(context.packageName, alias.className))
            states.put(alias.toString(), value)
            if (LauncherIcons.isOn(alias, value)) enabled.put(alias.toString())
        }
        val tasks = JSONArray()
        context.getSystemService(ActivityManager::class.java)?.appTasks?.forEach { task ->
            val info = try { task.taskInfo } catch (_: Exception) { null }
            if (info == null) {
                tasks.put(JSONObject().put("unavailable", true))
                return@forEach
            }
            @Suppress("DEPRECATION")
            val id = info.id
            tasks.put(JSONObject().put("id", id).put("count", info.numActivities)
                .put("base", info.baseIntent.component?.flattenToShortString())
                .put("orig", info.origActivity?.flattenToShortString())
                .put("top", info.topActivity?.flattenToShortString()))
        }
        Log.i("DshIconProbe", JSONObject().put("seq", seq).put("status", status)
            .put("result", result?.toString()).put("current", LauncherIconPlugin.current(context))
            .put("enabled", enabled).put("states", states).put("tasks", tasks)
            .put("foreground", MainActivity.inForeground).put("activity", System.identityHashCode(activity))
            .put("destroyed", activity?.isDestroyed).put("task", activity?.taskId)
            .put("engine", System.identityHashCode(FlutterEngineCache.getInstance().get("dsh-main")))
            .toString())
    }

    companion object {
        private const val ACTION = "io.github.ccch1mneyyy.dsh_app.ICON_PROBE"

        fun register(context: Context, plugin: LauncherIconPlugin): LauncherIconProbe? {
            if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
            return LauncherIconProbe(context, plugin).also { probe ->
                val filter = IntentFilter(ACTION)
                if (Build.VERSION.SDK_INT >= 33) {
                    context.registerReceiver(probe.receiver, filter, "android.permission.DUMP", null, Context.RECEIVER_EXPORTED)
                } else {
                    context.registerReceiver(probe.receiver, filter, "android.permission.DUMP", null)
                }
            }
        }
    }
}
