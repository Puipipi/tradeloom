package io.github.ccch1mneyyy.dsh_app.pet

import java.util.UUID

/** Main-thread ownership, independent of Android's later View attachment notification. */
internal class OverlayWindowOwner(private val nonce: String = UUID.randomUUID().toString()) {
    /** [ASK]: 问一句's input bar, the one window that takes focus (for the keyboard), only while open. */
    enum class Role { PET, TARGET, BUBBLE, MENU, ASK }

    class Ticket internal constructor(val generation: Long, val sequence: Long, val role: Role)

    private class Entry(val ticket: Ticket) {
        var live = true
        var remove: (() -> Boolean)? = null
    }

    private val entries = LinkedHashMap<Role, Entry>()
    private var host: Any? = null
    private var sequence = 0L
    var generation = 0L
        private set
    var lastRemovalFailure: String? = null
        private set

    val pendingRemovals: Int get() = entries.values.count { !it.live }
    val registeredWindows: Int get() = entries.values.count { it.remove != null }

    /** A host is an actual Context instance, not just its application/accessibility type. */
    fun isHost(value: Any) = host === value

    /** Retirement must be confirmed before another generation can reserve any window. */
    fun begin(value: Any): Boolean {
        if (host === value) return true
        if (host != null || entries.isNotEmpty()) return false
        host = value
        generation++
        return true
    }

    fun claim(role: Role): Ticket? {
        if (host == null || entries.containsKey(role)) return null
        val ticket = Ticket(generation, ++sequence, role)
        entries[role] = Entry(ticket)
        return ticket
    }

    /**
     * Remember the exact manager/view cleanup before add: an add which throws may have partially
     * registered its window. A successful add owns the slot even before isAttachedToWindow.
     */
    fun install(ticket: Ticket, remove: () -> Boolean, add: () -> Unit): Boolean {
        val entry = entries[ticket.role]
        check(host != null && entry?.ticket == ticket && entry.live && entry.remove == null)
        entry.remove = remove
        try {
            add()
        } catch (e: Exception) {
            entry.live = false
            reap(entry)
            throw e
        }
        return owns(ticket)
    }

    fun owns(ticket: Ticket?): Boolean {
        if (ticket == null || host == null || ticket.generation != generation) return false
        val entry = entries[ticket.role]
        return entry?.ticket == ticket && entry.live && entry.remove != null
    }

    fun remove(ticket: Ticket?) {
        val entry = ticket?.let { entries[it.role] } ?: return
        if (entry.ticket != ticket) return
        entry.live = false
        reap(entry)
    }

    /** A platform detach can arrive inside WindowManager removal; defer re-entrant cleanup. */
    fun revoke(ticket: Ticket?) {
        val entry = ticket?.let { entries[it.role] } ?: return
        if (entry.ticket == ticket) entry.live = false
    }

    /** Revoke all callbacks first; a failed platform removal remains owned and blocks begin. */
    fun retire() {
        host = null
        entries.values.forEach { it.live = false }
        retryRemovals()
    }

    fun retryRemovals() {
        entries.values.toList().filter { !it.live }.forEach(::reap)
    }

    private fun reap(entry: Entry) {
        if (entries[entry.ticket.role] !== entry) return
        val removed = try {
            entry.remove?.invoke() ?: true
        } catch (e: Exception) {
            lastRemovalFailure = e.javaClass.simpleName
            false
        }
        if (removed && entries[entry.ticket.role] === entry) entries.remove(entry.ticket.role)
    }

    /** Old notification intents also expire across a whole application-process restart. */
    fun openToken(): String? = entries[Role.PET]?.ticket?.takeIf(::owns)?.let { "$nonce:$generation:${it.sequence}" }

    fun acceptsOpen(token: String?) = token != null && token == openToken()
}

/**
 * removeViewImmediate may defer during traversal. A successful request must cross a main-loop
 * boundary and observe detachment before the registration can be forgotten. Exceptions leave
 * the request unconfirmed, so the owner retains it for a later bounded retry.
 */
internal class OverlayRemoval(
    private val request: () -> Unit,
    private val detached: () -> Boolean,
    private val nextTurn: (() -> Unit) -> Unit,
) {
    private var requested = false
    private var canConfirm = false

    fun attempt(): Boolean {
        if (requested && !canConfirm) return false
        if (requested && detached()) return true
        request()
        requested = true
        canConfirm = false
        nextTurn { canConfirm = true }
        return false
    }
}

/** A detached old Flutter binding must never revoke a newer producer. */
internal class OverlayProducerOwner {
    private var next = 0L
    private var current: Long? = null

    fun attach(): Long = (++next).also { current = it }
    fun owns(token: Long) = current == token
    fun detach(token: Long): Boolean {
        if (!owns(token)) return false
        current = null
        return true
    }
}
