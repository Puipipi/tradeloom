package io.github.ccch1mneyyy.dsh_app.media

/** Main-thread ownership of saves waiting on one shared storage permission request. */
internal class MediaPermissionQueue {
    var owner: Any = Any()
        private set
    private data class Waiter(val granted: () -> Unit, val denied: () -> Unit)
    private val waiters = mutableListOf<Waiter>()
    val waiting: Boolean get() = waiters.isNotEmpty()
    fun isCurrent(candidate: Any): Boolean = candidate === owner

    /** Returns true only for the caller that must start the system permission request. */
    fun enqueue(candidate: Any, granted: () -> Unit, denied: () -> Unit): Boolean {
        if (!isCurrent(candidate)) { denied(); return false }
        val first = waiters.isEmpty()
        waiters.add(Waiter(granted, denied))
        return first
    }

    fun resolve(granted: Boolean) {
        val batch = waiters.toList()
        waiters.clear()
        for (waiter in batch) if (granted) waiter.granted() else waiter.denied()
    }

    /** Final detach invalidates late workers; configuration rotation does not call this. */
    fun retire() {
        owner = Any()
        resolve(false)
    }
}
