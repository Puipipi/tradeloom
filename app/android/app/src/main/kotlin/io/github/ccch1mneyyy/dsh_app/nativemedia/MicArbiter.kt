package io.github.ccch1mneyyy.dsh_app.nativemedia

/**
 * One microphone in the app: the composer's dictation (voice/VoicePlugin) or a plugin's listening
 * ([NativeMediaPlugin]), never both. Dictation wins: starting it makes a listening plugin stop
 * first, and a plugin cannot start while dictation runs. Main thread only.
 */
object MicArbiter {
    /** A plugin's listening; [yieldMic] stops it (synchronously) because dictation starts. */
    fun interface Holder {
        fun yieldMic()
    }

    private var plugin: Holder? = null
    private var dictation = 0
    private val unfinished = HashSet<Int>()

    /** A dictation is running (or still closing). */
    var dictating = false
        private set

    /** Dictation starts; returns its token for [endDictation]. A listening plugin stops first. */
    fun beginDictation(): Int {
        val holder = plugin
        plugin = null
        holder?.yieldMic()
        dictating = true
        return (++dictation).also { unfinished += it }
    }

    /** Each dictation keeps its claim until its own recorder has finished closing. */
    fun endDictation(token: Int) {
        unfinished.remove(token)
        dictating = unfinished.isNotEmpty()
    }

    /** A plugin may listen: false while dictation runs. */
    fun acquire(holder: Holder): Boolean {
        if (dictating) return false
        plugin = holder
        return true
    }

    fun release(holder: Holder) {
        if (plugin === holder) plugin = null
    }

    /** Tests only. */
    internal fun reset() {
        plugin = null
        unfinished.clear()
        dictating = false
    }
}
