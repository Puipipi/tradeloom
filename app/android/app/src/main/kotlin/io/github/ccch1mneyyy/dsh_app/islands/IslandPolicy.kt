package io.github.ccch1mneyyy.dsh_app.islands

/** The plain rules behind [IslandsPlugin] (JVM-tested). */
object IslandPolicy {
    /** `ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW`: from here up the Dart budget drops hidden islands. */
    const val TRIM_LOW = 10

    /** `TRIM_MEMORY_COMPLETE` (deprecated as a constant, still sent): what `onLowMemory` maps to. */
    const val TRIM_COMPLETE = 80

    /** Android's text zoom range for a WebView, percent. */
    fun textZoom(percent: Int): Int = percent.coerceIn(50, 300)

    /** Only levels the budget acts on reach Dart (UI_HIDDEN etc. are the lifecycle's business). */
    fun forwardsTrim(level: Int): Boolean = level >= TRIM_LOW && level != 20

    /** webview_flutter hands identifiers over the channel as Int or Long. */
    fun webViewId(raw: Any?): Long? = when (raw) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> null
    }
}
