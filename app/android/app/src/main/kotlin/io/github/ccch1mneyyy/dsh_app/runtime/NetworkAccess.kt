package io.github.ccch1mneyyy.dsh_app.runtime

/**
 * This app's own network access as the system reports it, turned into runtime log lines.
 *
 * Android cuts a uid off per firewall chain (Doze, App Standby, Data Saver, the Android 15+
 * background chain, vendor deny chains). The engine inside proot runs as this uid and only sees
 * failed requests and retries; the default network callback's blocked status says the system did
 * it. A running foreground service keeps the uid allowed on stock Android (process state FGS is
 * below TOP_SLEEPING, the background chain's threshold), so a block while DSH runs points at the
 * vendor's battery / background-network policy.
 */
internal class NetworkAccess {
    class Watch

    private var activeWatch: Watch? = null
    private var blocked = false
    private var since: Long? = null

    val isBlocked: Boolean
        @Synchronized get() = blocked

    /** Wall-clock ms of the latest block's start (kept after it lifts: the app asks on its way back). */
    val blockedAt: Long?
        @Synchronized get() = since

    /** Identity is fixed before registration, including callbacks arriving during registration. */
    @Synchronized
    fun startWatch(): Watch = Watch().also {
        activeWatch = it
        blocked = false
    }

    @Synchronized
    fun isCurrent(watch: Watch): Boolean = activeWatch === watch

    /** One `onBlockedStatusChanged`; the line to log when it changes what was known, else null. */
    @Synchronized
    fun onBlocked(watch: Watch, nowBlocked: Boolean, inForeground: Boolean, now: Long = System.currentTimeMillis()): String? {
        if (activeWatch !== watch || nowBlocked == blocked) return null
        blocked = nowBlocked
        if (nowBlocked) since = now
        val where = if (inForeground) "app in foreground" else "app in background"
        return if (nowBlocked) {
            "[dsh-app] the system blocked this app's network ($where); engine requests fail until it is lifted"
        } else {
            "[dsh-app] the system lifted the network block ($where)"
        }
    }

    /** The service stopped watching: nothing is known any more (no log line). */
    @Synchronized
    fun reset(watch: Watch) {
        if (activeWatch !== watch) return
        activeWatch = null
        blocked = false
    }

    companion object {
        // ConnectivityManager.RESTRICT_BACKGROUND_STATUS_*
        private const val DATA_SAVER_OFF = 1
        private const val DATA_SAVER_EXEMPT = 2
        private const val DATA_SAVER_ON = 3

        /** What decides background network access, logged at each engine start. */
        fun policyLine(batteryExempt: Boolean, dataSaverStatus: Int, notifications: Boolean): String {
            val dataSaver = when (dataSaverStatus) {
                DATA_SAVER_OFF -> "off"
                DATA_SAVER_EXEMPT -> "on, app exempt"
                DATA_SAVER_ON -> "on"
                else -> "unknown"
            }
            return "[dsh-app] background policy: battery optimization ${if (batteryExempt) "off" else "on"}, " +
                "data saver $dataSaver, notifications ${if (notifications) "on" else "off"}"
        }
    }
}
