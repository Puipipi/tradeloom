package io.github.ccch1mneyyy.dsh_app.performance

/** Serialized by its owner. All times are monotonic uptime, never wall-clock time. */
class ThermalPolicy(private val recoveryMs: Long = RECOVERY_MS) {
    var status: Int? = null
        private set
    var lightweight: Boolean = false
        private set
    var coolSince: Long? = null
        private set

    val recoveryAt: Long? get() = coolSince?.let { it + recoveryMs }

    /** Returns whether observable state changed. Unknown vendor values are not cooling evidence. */
    fun update(value: Int, now: Long): Boolean {
        if (value !in 0..6) return false
        val before = snapshot()
        status = value
        if (value >= MODERATE) {
            lightweight = true
            coolSince = null
        } else if (lightweight && coolSince == null) {
            coolSince = now
        }
        advance(now)
        return snapshot() != before
    }

    fun advance(now: Long): Boolean {
        val since = coolSince ?: return false
        if (status !in 0 until MODERATE || now < since || now - since < recoveryMs) return false
        lightweight = false
        coolSince = null
        return true
    }

    fun toMap(supported: Boolean, listening: Boolean): Map<String, Any?> = mapOf(
        "supported" to supported,
        "listening" to listening,
        "status" to status,
        "lightweight" to lightweight,
        "coolSinceUptimeMs" to coolSince,
        "recoveryAfterMs" to recoveryMs,
    )

    private fun snapshot() = Triple(status, lightweight, coolSince)

    companion object {
        const val MODERATE = 2
        // Product hysteresis, not a measured cooling time.
        const val RECOVERY_MS = 30_000L
    }
}
