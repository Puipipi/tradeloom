package io.github.ccch1mneyyy.dsh_app.performance

/** Device facts, not benchmark results. Missing measurements stay null. */
data class DeviceProfile(
    val lowRam: Boolean? = null,
    val totalMemoryBytes: Long? = null,
    val cpuCores: Int? = null,
    val availableProcessors: Int? = null,
    val cpuMaxKhz: List<Long?> = emptyList(),
    val sdkInt: Int = 0,
    val mediaPerformanceClass: Int? = null,
    val cached: Boolean = false,
    val measuredAtMs: Long? = null,
) {
    val tier: DeviceTier get() = PerformanceRules.classify(this)

    fun toMap(): Map<String, Any?> = mapOf(
        "policyVersion" to PerformanceRules.VERSION,
        "tier" to tier.wire,
        "reasons" to PerformanceRules.reasons(this),
        "lowRam" to lowRam,
        "totalMemoryBytes" to totalMemoryBytes,
        "cpuCores" to cpuCores,
        "availableProcessors" to availableProcessors,
        "cpuMaxKhz" to cpuMaxKhz,
        "sdkInt" to sdkInt,
        "mediaPerformanceClass" to mediaPerformanceClass,
        "cached" to cached,
        "measuredAtMs" to measuredAtMs,
    )
}

enum class DeviceTier(val wire: String) { LOW("low"), MEDIUM("medium"), HIGH("high") }

/** Default budgets only. Explicit preferences are never written or replaced here. */
object PerformanceRules {
    const val VERSION = 1
    const val MIB = 1024L * 1024
    // Keep the existing onboarding cutoff in LocalFootprint.lowMemoryMb.
    const val LOW_MEMORY_BYTES = 5L * 1024 * MIB
    const val MAX_CPUS = 128

    fun cacheKey(sdkInt: Int, fingerprint: String): String = "$VERSION|$sdkInt|$fingerprint"

    /** Revalidate facts, never trust a cached tier or reasons from an older policy. */
    fun cachedProfile(raw: Map<String, Any?>, sdkInt: Int): DeviceProfile? {
        if ((raw["policyVersion"] as? Number)?.toInt() != VERSION ||
            (raw["sdkInt"] as? Number)?.toInt() != sdkInt) return null
        fun whole(key: String): Long? = (raw[key] as? Number)?.toLong()?.takeIf { it > 0 }
        return DeviceProfile(
            lowRam = raw["lowRam"] as? Boolean,
            totalMemoryBytes = whole("totalMemoryBytes"),
            cpuCores = whole("cpuCores")?.takeIf { it <= MAX_CPUS }?.toInt(),
            cpuMaxKhz = (raw["cpuMaxKhz"] as? List<*>)?.take(MAX_CPUS)?.map {
                (it as? Number)?.toLong()?.takeIf { n -> n > 0 }
            }.orEmpty(),
            sdkInt = sdkInt,
            mediaPerformanceClass = (raw["mediaPerformanceClass"] as? Number)?.toInt()?.takeIf { it >= 0 },
            measuredAtMs = whole("measuredAtMs"),
        )
    }

    fun classify(p: DeviceProfile): DeviceTier = when {
        p.lowRam == true -> DeviceTier.LOW
        p.totalMemoryBytes != null && p.totalMemoryBytes in 1 until LOW_MEMORY_BYTES -> DeviceTier.LOW
        p.cpuCores != null && p.cpuCores in 1..2 -> DeviceTier.LOW
        (p.totalMemoryBytes ?: 0) >= LOW_MEMORY_BYTES && (p.cpuCores ?: 0) >= 4 &&
            p.sdkInt >= 31 && (p.mediaPerformanceClass ?: 0) >= 31 -> DeviceTier.HIGH
        else -> DeviceTier.MEDIUM
    }

    fun reasons(p: DeviceProfile): List<String> = buildList {
        if (p.lowRam == true) add("android_low_ram")
        if (p.totalMemoryBytes != null && p.totalMemoryBytes in 1 until LOW_MEMORY_BYTES) add("memory_below_5_gib")
        if (p.cpuCores != null && p.cpuCores in 1..2) add("at_most_two_cores")
        if (isEmpty()) add(if (classify(p) == DeviceTier.HIGH) "declared_mpc_with_capacity" else "no_low_tier_evidence")
    }

    fun lightweight(tier: DeviceTier, mode: String?, thermal: Boolean = false): Boolean = thermal || when (mode) {
        "full" -> false
        "light" -> true
        else -> tier == DeviceTier.LOW
    }

    fun autoStart(tier: DeviceTier, mode: String?, explicit: Boolean?, thermal: Boolean = false): Boolean =
        explicit ?: !lightweight(tier, mode, thermal)

    /** 7b can consume this recommendation without coupling its lifecycle to this feature. */
    fun keepEngineInBackground(tier: DeviceTier): Boolean = when (tier) {
        DeviceTier.LOW, DeviceTier.MEDIUM, DeviceTier.HIGH -> false
    }

    /** Old-space budget, not RSS: reserve most physical RAM for Android, Flutter and tools. */
    fun oldSpaceMiB(memoryBytes: Long?): Int {
        if (memoryBytes == null || memoryBytes <= 0) return 512
        val quarter = memoryBytes / MIB / 4
        return (quarter / 128 * 128).coerceIn(512, 2048).toInt()
    }

    /** Keep libuv's default ceiling of four; a light profile allows at most two workers. */
    fun threadPool(availableProcessors: Int?, light: Boolean): Int =
        (availableProcessors?.takeIf { it > 0 } ?: 4).coerceIn(1, if (light) 2 else 4)

    /** Extract only env assignments before the guest command, without parsing shell text. */
    fun manifestEnvironment(argv: List<String>, hostEnv: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap(hostEnv)
        val start = argv.indexOf("/usr/bin/env")
        if (start < 0) return out
        for (arg in argv.drop(start + 1)) {
            if (arg == "{GUEST_ENV}") break
            if (arg == "-i" || arg == "--ignore-environment") continue
            val split = arg.indexOf('=')
            if (split <= 0 || !ENV_NAME.matches(arg.substring(0, split))) break
            out[arg.substring(0, split)] = arg.substring(split + 1)
        }
        return out
    }

    /** Same result for proot and direct launch; caller-provided entries win, including empty ones. */
    fun engineEnvironment(
        p: DeviceProfile,
        light: Boolean,
        explicit: Map<String, String>,
        manifestDefaults: Map<String, String>,
    ): Map<String, String> = LinkedHashMap(explicit).apply {
        if (!containsKey("NODE_OPTIONS")) {
            val original = manifestDefaults["NODE_OPTIONS"].orEmpty()
            put("NODE_OPTIONS", if (HEAP_LIMIT.containsMatchIn(original)) original else {
                listOf(original.trim(), "--max-old-space-size=${oldSpaceMiB(p.totalMemoryBytes)}")
                    .filter { it.isNotEmpty() }.joinToString(" ")
            })
        }
        if (!containsKey("UV_THREADPOOL_SIZE")) {
            put("UV_THREADPOOL_SIZE", manifestDefaults["UV_THREADPOOL_SIZE"] ?: threadPool(p.availableProcessors, light).toString())
        }
    }

    private val ENV_NAME = Regex("[A-Za-z_][A-Za-z0-9_]*")
    private val HEAP_LIMIT = Regex("(?:^|[\\s\"'])--(?:max[-_]old[-_]space[-_]size(?:[-_]percentage)?|max[-_]heap[-_]size)(?:[=\\s\"']|$)")
}
