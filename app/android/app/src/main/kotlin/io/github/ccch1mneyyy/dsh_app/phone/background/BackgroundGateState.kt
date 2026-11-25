package io.github.ccch1mneyyy.dsh_app.phone.background

/** The last failed connection attempt, shown on the settings page while no channel is live. */
internal class BackgroundGateState {
    data class Snapshot(val connectionError: Int? = null)

    @Volatile var snapshot = Snapshot()
        private set

    @Synchronized fun reset() { snapshot = Snapshot() }

    /** A connect that failed. Cleared by the next connection, or a reset. */
    @Synchronized fun connectionFailed(reason: Int, mayApply: () -> Boolean) {
        if (mayApply()) snapshot = Snapshot(reason)
    }

    /** A connection can replace only the failure observed before that attempt started. */
    @Synchronized fun connected(observed: Snapshot) {
        if (snapshot === observed && snapshot.connectionError != null) snapshot = Snapshot()
    }
}
