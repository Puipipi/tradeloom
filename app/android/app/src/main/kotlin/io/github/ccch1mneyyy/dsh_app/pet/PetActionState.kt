package io.github.ccch1mneyyy.dsh_app.pet

/** One pending answer, retired when its Flutter producer goes away. */
internal class PetAnswerState {
    class Ticket(val bubbleId: String)
    private var pending: Ticket? = null
    val bubbleId: String? get() = pending?.bubbleId

    fun begin(bubbleId: String): Ticket? {
        if (pending != null) return null
        return Ticket(bubbleId).also { pending = it }
    }

    fun finish(ticket: Ticket): Boolean {
        if (pending !== ticket) return false
        pending = null
        return true
    }

    fun reset() { pending = null }
}

/** A draft survives window replacement; an acknowledgement belongs to one edit revision. */
internal class PetAskDraft {
    class Send internal constructor(internal val revision: Long, val text: String)
    data class Completion(val cleared: Boolean)
    private var revision = 0L
    private var pending: Send? = null
    var text: String = ""
        private set
    val sending: Boolean get() = pending != null

    fun edit(value: String) {
        if (value == text) return
        text = value
        revision++
    }

    fun beginSend(text: String): Send? {
        if (pending != null) return null
        return Send(revision, text).also { pending = it }
    }

    /** Null means this callback belonged to a retired producer or older operation. */
    fun finish(send: Send, accepted: Boolean): Completion? {
        if (pending !== send) return null
        pending = null
        val clear = accepted && revision == send.revision
        if (clear) edit("")
        return Completion(clear)
    }

    fun resetProducer() { pending = null }
}
