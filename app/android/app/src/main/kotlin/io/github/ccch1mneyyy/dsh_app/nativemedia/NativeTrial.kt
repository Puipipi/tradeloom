package io.github.ccch1mneyyy.dsh_app.nativemedia

import android.content.SharedPreferences

/**
 * Native code that crashes takes the app with it; nothing in Kotlin catches a
 * SIGILL. The first time a native library runs on this phone (per [key], its
 * version), a mark is written down first and cleared once it has answered. A
 * mark still there at the next try means the app died in there: that version
 * is left alone on this phone from then on ([blocked]); a newer one is tried.
 */
class NativeTrial(private val marks: Marks, private val key: String) {
    interface Marks {
        fun has(name: String): Boolean

        /** On disk before it returns: the next line may never run. */
        fun set(name: String, on: Boolean)
    }

    /** It died here before, or the last try never came back. */
    fun blocked(): Boolean {
        if (marks.has("$key.bad")) return true
        if (!marks.has("$key.trying")) return false
        marks.set("$key.bad", true)
        marks.set("$key.trying", false)
        return true
    }

    /** It has run here before: no mark needed. */
    val proven: Boolean get() = marks.has("$key.ok")

    fun begin() = marks.set("$key.trying", true)

    fun passed() {
        marks.set("$key.ok", true)
        marks.set("$key.trying", false)
    }

    /** It ended without a verdict (an exception, which Kotlin did catch): try again next time. */
    fun dropped() = marks.set("$key.trying", false)

    companion object {
        fun marks(prefs: SharedPreferences) = object : Marks {
            override fun has(name: String) = prefs.getBoolean(name, false)

            override fun set(name: String, on: Boolean) {
                prefs.edit().putBoolean(name, on).commit()
            }
        }
    }
}
