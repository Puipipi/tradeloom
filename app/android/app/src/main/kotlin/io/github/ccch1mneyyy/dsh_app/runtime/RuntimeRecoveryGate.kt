package io.github.ccch1mneyyy.dsh_app.runtime

/** A recovery write was refused before changing configuration. */
internal class RuntimeNotStoppedException : IllegalStateException("runtime stop or cleanup incomplete")

/**
 * Admission for the existing profile/config recovery writes. Call on the runtime
 * worker, which also owns the actual DshProcess creation and start. A later start
 * may be requested on the main thread, but cannot spawn until this write finishes.
 * The safe-running exception is only for restoring the inactive main profile.
 */
internal object RuntimeRecoveryGate {
    /** Read together under the controller monitor; do not combine two different owners. */
    data class State(
        val phase: RuntimeController.Phase,
        val hasProcess: Boolean,
        val safeRun: Boolean,
        val resetting: Boolean,
    )

    fun check(
        state: State,
        mainProfileOnly: Boolean,
        cleanup: () -> Boolean,
    ) {
        val (phase, hasProcess, safeRun, resetting) = state
        val safeProfile = mainProfileOnly && safeRun && hasProcess &&
            phase == RuntimeController.Phase.RUNNING && !resetting
        if (safeProfile) return
        if (hasProcess || resetting || phase in setOf(
                RuntimeController.Phase.STARTING, RuntimeController.Phase.RUNNING,
                RuntimeController.Phase.STOPPING, RuntimeController.Phase.INSTALLING,
            )) throw RuntimeNotStoppedException()
        // A completed waiter can still have reported an incomplete UID sweep.
        // Neither a missing owner nor a failed /proc observation proves it is safe to write.
        if (!cleanup()) throw RuntimeNotStoppedException()
    }
}
