package io.github.ccch1mneyyy.dsh_app.performance

import android.content.Context
import android.os.Build
import android.os.PowerManager

/** Launch-side adapter shared by the activity shortcut and every engine launch mode. */
object PerformancePolicy {
    private const val PREFS = "FlutterSharedPreferences"
    private const val MODE = "flutter.performance.mode"
    private const val AUTO_START = "flutter.auto_start_local"

    /** Facts were read on a worker. Re-read preferences at the decision, never store a derived default. */
    fun autoStart(context: Context, profile: DeviceProfile): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.contains(AUTO_START)) return prefs.getBoolean(AUTO_START, true)
        return PerformanceRules.autoStart(profile.tier, prefs.getString(MODE, null), null, hot(context))
    }

    /** Mutates only the two budget entries; manifest flags and explicit launch values remain intact. */
    fun applyEngineEnvironment(context: Context, env: MutableMap<String, String>, argv: List<String>, launchEnv: Map<String, String>) {
        val p = DevicePerformance.read(context)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val light = PerformanceRules.lightweight(p.tier, prefs.getString(MODE, null), hot(context))
        env.putAll(PerformanceRules.engineEnvironment(p, light, env, PerformanceRules.manifestEnvironment(argv, launchEnv)))
    }

    private fun hot(context: Context): Boolean = ThermalRuntime.lightweight ?: if (Build.VERSION.SDK_INT < 29) false else runCatching {
        val manager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        (manager?.currentThermalStatus ?: 0) >= ThermalPolicy.MODERATE
    }.getOrDefault(false)
}

/** Shared only within this process. The listener's recovery hysteresis applies to later launches too. */
internal object ThermalRuntime {
    @Volatile var lightweight: Boolean? = null
}
