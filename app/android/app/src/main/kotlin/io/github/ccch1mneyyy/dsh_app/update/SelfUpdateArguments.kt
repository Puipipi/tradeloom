package io.github.ccch1mneyyy.dsh_app.update

/** A self-update request has no command, target package, install flags or source identity. */
internal data class SelfUpdateArguments(
    val path: String,
    val sha256: String,
    val versionCode: Long,
    val backend: String,
    val port: Int?,
) {
    companion object {
        fun parse(value: Any?): SelfUpdateArguments? {
            val map = value as? Map<*, *> ?: return null
            if (map.keys.any { it !in setOf("path", "sha256", "versionCode", "backend", "port") }) return null
            val path = map["path"] as? String ?: return null
            if (path.isEmpty() || path.length > 4096 || path.any { it.isISOControl() }) return null
            val hash = map["sha256"] as? String ?: return null
            if (!hash.matches(Regex("[a-fA-F0-9]{64}"))) return null
            val version = integer(map["versionCode"])?.takeIf { it > 0 } ?: return null
            val backend = map["backend"] as? String ?: return null
            if (backend != "shizuku" && backend != "adb") return null
            val rawPort = map["port"]
            val port = if (rawPort == null) null else {
                if (backend != "adb") return null
                integer(rawPort)?.takeIf { it in 1L..65535L }?.toInt() ?: return null
            }
            return SelfUpdateArguments(path, hash.lowercase(java.util.Locale.ROOT), version, backend, port)
        }

        private fun integer(value: Any?): Long? = when (value) {
            is Int -> value.toLong()
            is Long -> value
            else -> null
        }
    }
}
