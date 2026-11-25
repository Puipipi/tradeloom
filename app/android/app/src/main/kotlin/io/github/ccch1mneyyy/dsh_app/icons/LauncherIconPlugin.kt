package io.github.ccch1mneyyy.dsh_app.icons

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.github.ccch1mneyyy.dsh_app.MainActivity
import io.github.ccch1mneyyy.dsh_app.launch.LaunchThemeSync
import io.github.ccch1mneyyy.dsh_app.shortcuts.ShortcutsPlugin

/**
 * 桌面图标: MethodChannel `dsh/launcher_icon`. The rules are [LauncherIcons]'s.
 *
 * - `state` → `{current: mist | night | frost | ink, mask: [x0, y0, x1, y1, …]?}`: the icon on the
 *   launcher, and the system's adaptive-icon mask as a closed outline in 0…1 (null if unknown) so
 *   the picker cuts its previews like the launcher does.
 * - `set {id}` → `{current}`: switches the launcher entry (DONT_KILL_APP; new one first), moving
 *   the recent-conversation shortcuts over before the old entry goes off.
 *
 * When the original entry has to wait (a task of ours was opened through it), it is switched off
 * as soon as the app is in the background with nothing of another app on top — or at the next
 * start, if the process ends first. The foreground screen and external pickers are left alone.
 * Old entries also wait if recent-shortcut migration fails; later lifecycle events try again.
 */
class LauncherIconPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {

    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private val main = Handler(Looper.getMainLooper())
    private var callbacks: Application.ActivityLifecycleCallbacks? = null
    private var probe: LauncherIconProbe? = null

    /** Activities of ours that are started (visible); the app is in the background when none. */
    private val started = HashSet<Activity>()

    @Volatile private var visible = false
    @Volatile private var resumedTask: Int? = null
    @Volatile private var lifecycleReady = false

    private val settleInBackground = Runnable {
        ShortcutsPlugin.worker.execute { settle(context, background = true) }
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        val app = context as? Application
        if (app != null) {
            val watcher = Watcher()
            app.registerActivityLifecycleCallbacks(watcher)
            callbacks = watcher
        }
        probe = LauncherIconProbe.register(context, this)
        // Repair a switch left waiting by a process that ended. lifecycleReady protects the
        // first activity while it starts; if Home already ran, do not wait for another Stop.
        ShortcutsPlugin.worker.execute { settle(context, background = true) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        callbacks?.let { (context as? Application)?.unregisterActivityLifecycleCallbacks(it) }
        callbacks = null
        probe?.unregister()
        probe = null
        main.removeCallbacks(settleInBackground)
        started.clear()
        resumedTask = null
        visible = false
        lifecycleReady = false
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "state" -> ShortcutsPlugin.worker.execute {
                val state = try {
                    mapOf("current" to current(context), "mask" to maskOutline())
                } catch (_: Exception) {
                    null
                }
                main.post {
                    if (state != null) result.success(state) else result.error("failed", null, null)
                }
            }
            "set" -> {
                val id = call.argument<String>("id")
                if (id == null || id !in LauncherIcons.variants) {
                    result.error("unknown", null, null)
                    return
                }
                ShortcutsPlugin.worker.execute {
                    val now = try {
                        val icon = switchTo(context, id)
                        // Home can race the worker: onStopped may have run before `waiting`
                        // became true, so every completed switch also checks the background.
                        settle(context, background = true)
                        icon
                    } catch (_: Exception) {
                        null
                    }
                    main.post {
                        // The next launches' splash shows the new icon (Android 13+).
                        MainActivity.current?.get()?.let { LaunchThemeSync.sync(it) }
                        if (now != null) result.success(mapOf("current" to now)) else result.error("failed", null, null)
                    }
                }
            }
            else -> result.notImplemented()
        }
    }

    private inner class Watcher : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            started += activity
            visible = true
            lifecycleReady = true
            main.removeCallbacks(settleInBackground)
        }

        override fun onActivityStopped(activity: Activity) {
            started.remove(activity)
            visible = started.isNotEmpty()
            if (!visible && !activity.isChangingConfigurations && waiting) {
                // Finish pending switches when Home appears. The worker checks visibility/task tops
                // again, so another activity starting first still protects its task.
                main.post(settleInBackground)
            }
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {
            resumedTask = if (activity is MainActivity) activity.taskId else null
            if (waiting) ShortcutsPlugin.worker.execute { settle(context, background = false) }
        }
        override fun onActivityPaused(activity: Activity) {
            if (resumedTask == activity.taskId) resumedTask = null
        }
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {
            started.remove(activity)
            visible = started.isNotEmpty()
            if (!visible && !activity.isChangingConfigurations && waiting) main.post(settleInBackground)
        }
    }

    /**
     * Brings the entries in line with the saved choice: finishes a waiting switch-off, and repairs
     * an interrupted switch or component-state rollback after reboot. [background]: may close our task
     * (it is out of sight), if nothing of another app sits on top of it.
     */
    private fun settle(context: Context, background: Boolean) {
        try {
            val stateOf = stateReader(context)
            val inUse = originalInUse(context, background)
            applyPlan(context, LauncherIcons.settlePlan(stateOf, chosen(context), inUse))
        } catch (_: Exception) {
        }
    }

    private fun originalInUse(context: Context, background: Boolean): Boolean {
        val tasks = tasks(context) ?: return true
        val power = context.getSystemService(PowerManager::class.java)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        return LauncherIcons.keepOriginal(
            tasks,
            ownPackage = context.packageName,
            appVisible = !background || !lifecycleReady || visible || MainActivity.inForeground,
            resumedTask = resumedTask,
            interactive = power?.isInteractive == true,
            locked = keyguard?.isKeyguardLocked != false,
        )
    }

    companion object {
        const val CHANNEL = "dsh/launcher_icon"
        private const val PREFS = "launcher_icon"
        private const val KEY_CHOSEN = "chosen"

        /** Points on the mask outline sent to Dart. */
        private const val MASK_POINTS = 240

        /** AdaptiveIconDrawable's mask space (config_icon_mask is drawn in 100 × 100). */
        private const val MASK_SIZE = 100f

        /** Old entries wait for safe removal or successful recent-shortcut migration. */
        @Volatile private var waiting = false

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        private fun chosen(context: Context): String? = prefs(context).getString(KEY_CHOSEN, null)

        private fun stateReader(context: Context): (String) -> Int {
            val pm = context.packageManager
            return { cls -> pm.getComponentEnabledSetting(ComponentName(context.packageName, cls)) }
        }

        private fun component(context: Context, alias: LauncherIcons.Alias) =
            ComponentName(context.packageName, alias.className)

        fun current(context: Context): String = LauncherIcons.current(stateReader(context), chosen(context))

        /** The launcher alias that is the entry now (what the recent shortcuts belong to). */
        fun entry(context: Context): ComponentName? = try {
            val stateOf = stateReader(context)
            val alias = LauncherIcons.aliasFor(LauncherIcons.current(stateOf, chosen(context)), stateOf)
            if (LauncherIcons.isOn(alias, stateOf(alias.className))) component(context, alias) else null
        } catch (_: Exception) {
            null
        }

        /** On [ShortcutsPlugin.worker]. Returns the icon now on the launcher. */
        private fun switchTo(context: Context, id: String): String {
            val preferences = prefs(context)
            val previous = preferences.getString(KEY_CHOSEN, null)
            if (!preferences.edit().putString(KEY_CHOSEN, id).commit()) {
                // commit changes memory even when the disk write fails.
                preferences.edit().putString(KEY_CHOSEN, previous).apply()
                throw IllegalStateException("could not save launcher icon")
            }
            val stateOf = stateReader(context)
            applyPlan(context, LauncherIcons.plan(id, stateOf, originalInUse(context)))
            return LauncherIcons.current(stateOf, id)
        }

        private fun applyPlan(context: Context, plan: LauncherIcons.Plan) {
            waiting = plan.deferred
            if (plan.isEmpty) return
            val pm = context.packageManager
            for (step in plan.enable) set(pm, context, step)
            // Before the old entry goes off: the system would delete them with it.
            if (!ShortcutsPlugin.rebind(context, component(context, plan.target))) {
                waiting = true
                return
            }
            for (step in plan.disable) set(pm, context, step)
        }

        private fun set(pm: PackageManager, context: Context, step: LauncherIcons.Step) {
            pm.setComponentEnabledSetting(
                ComponentName(context.packageName, step.className),
                step.state,
                PackageManager.DONT_KILL_APP,
            )
        }

        /** A task of ours was opened through the original entry (switching it off would close it). */
        private fun originalInUse(context: Context): Boolean =
            tasks(context)?.let(LauncherIcons::originalInUse) ?: true

        private fun tasks(context: Context): List<LauncherIcons.Task>? = try {
            context.getSystemService(ActivityManager::class.java)?.appTasks?.map { task ->
                val info = task.taskInfo
                @Suppress("DEPRECATION") // RecentTaskInfo.taskId was added only in API 29; minSdk is 26.
                val id = info.id
                LauncherIcons.Task(
                    listOf(info.baseIntent.component?.className, info.origActivity?.className),
                    info.numActivities,
                    id,
                    info.topActivity?.packageName,
                )
            }
        } catch (_: Exception) {
            null
        }

        /** The system's icon mask as a closed outline, x and y in 0…1. */
        private fun maskOutline(): List<Double>? = try {
            val mask: Path = AdaptiveIconDrawable(ColorDrawable(0), ColorDrawable(0)).iconMask
            val measure = PathMeasure(mask, true)
            val length = measure.length
            if (length <= 0f) {
                null
            } else {
                val pos = FloatArray(2)
                val points = ArrayList<Double>(MASK_POINTS * 2)
                for (i in 0 until MASK_POINTS) {
                    measure.getPosTan(length * i / MASK_POINTS, pos, null)
                    points += (pos[0] / MASK_SIZE).toDouble()
                    points += (pos[1] / MASK_SIZE).toDouble()
                }
                points
            }
        } catch (_: Exception) {
            null
        }
    }
}
