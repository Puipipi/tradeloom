package io.github.ccch1mneyyy.dsh_app.shortcuts

/** Launcher labels for a conversation title (pure: unit-tested on the JVM). */
internal object ShortcutLabels {
    /** ShortcutInfo's recommended limits: pinned icons use the short one, menus the long one. */
    const val SHORT = 10
    const val LONG = 25

    fun short(title: String): String = clip(title, SHORT)

    fun long(title: String): String = clip(title, LONG)

    /** At most [max] characters (code points, so an emoji is never cut in half), "…" included. */
    fun clip(title: String, max: Int): String {
        val text = title.replace(Regex("\\s+"), " ").trim()
        val count = text.codePointCount(0, text.length)
        if (count <= max) return text
        val end = text.offsetByCodePoints(0, max - 1)
        return text.substring(0, end).trimEnd() + "…"
    }
}
