package io.github.ccch1mneyyy.dsh_app.performance

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The caller supplies a worker thread: sysfs and preference reads never belong in a frame. */
object DevicePerformance {
    @Volatile private var memory: DeviceProfile? = null

    @Synchronized fun read(context: Context): DeviceProfile {
        memory?.let { return it }
        val prefs = context.getSharedPreferences("dsh_performance_device", Context.MODE_PRIVATE)
        val key = PerformanceRules.cacheKey(Build.VERSION.SDK_INT, Build.FINGERPRINT)
        val stored = runCatching {
            if (prefs.getString("key", null) == key) prefs.getString("facts", null)?.let(::decode) else null
        }.getOrNull()
        val profile = stored?.copy(cached = true, availableProcessors = available()) ?: collect(context)
        if (stored == null) runCatching {
            prefs.edit().putString("key", key).putString("facts", encode(profile)).apply()
        }
        memory = profile
        return profile
    }

    private fun available(): Int? = runCatching { Runtime.getRuntime().availableProcessors().takeIf { it > 0 } }.getOrNull()

    private fun collect(context: Context): DeviceProfile {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val lowRam = runCatching { manager?.isLowRamDevice }.getOrNull()
        val bytes = runCatching {
            if (manager == null) null else ActivityManager.MemoryInfo().also(manager::getMemoryInfo).totalMem.takeIf { it > 0 }
        }.getOrNull()
        val available = available()
        val cpus = runCatching {
            File("/sys/devices/system/cpu").listFiles()?.mapNotNull { f ->
                if (CPU_NAME.matches(f.name)) f.name.removePrefix("cpu").toIntOrNull() else null
            }?.sorted()?.take(PerformanceRules.MAX_CPUS)?.takeIf { it.isNotEmpty() }
        }.getOrNull()
        val frequencies = cpus.orEmpty().map { cpu ->
            runCatching {
                File("/sys/devices/system/cpu/cpu$cpu/cpufreq/cpuinfo_max_freq").bufferedReader().use {
                    val chars = CharArray(64)
                    val n = it.read(chars)
                    if (n <= 0) null else String(chars, 0, n).trim().toLongOrNull()?.takeIf { value -> value > 0 }
                }
            }.getOrNull()
        }
        return DeviceProfile(
            lowRam = lowRam,
            totalMemoryBytes = bytes,
            cpuCores = cpus?.size ?: available,
            availableProcessors = available,
            cpuMaxKhz = frequencies,
            sdkInt = Build.VERSION.SDK_INT,
            mediaPerformanceClass = if (Build.VERSION.SDK_INT >= 31) Build.VERSION.MEDIA_PERFORMANCE_CLASS else null,
            measuredAtMs = System.currentTimeMillis(),
        )
    }

    private fun encode(p: DeviceProfile): String = JSONObject().apply {
        p.toMap().forEach { (key, value) -> put(key, if (value is List<*>) JSONArray(value) else value ?: JSONObject.NULL) }
    }.toString()

    private fun decode(raw: String): DeviceProfile? = runCatching {
        val json = JSONObject(raw)
        val values = json.keys().asSequence().associateWith { key ->
            val value = json.opt(key)
            if (value is JSONArray) (0 until minOf(value.length(), PerformanceRules.MAX_CPUS)).map(value::opt) else value
        }
        PerformanceRules.cachedProfile(values, Build.VERSION.SDK_INT)
    }.getOrNull()

    private val CPU_NAME = Regex("cpu[0-9]+")
}
