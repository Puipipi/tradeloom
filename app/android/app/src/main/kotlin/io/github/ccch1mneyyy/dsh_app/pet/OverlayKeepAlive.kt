package io.github.ccch1mneyyy.dsh_app.pet

/** Main-thread lifecycle of the overlay foreground-service request. */
internal class OverlayKeepAlive {
    enum class Action { NONE, START, STOP }
    private enum class Phase { STOPPED, STARTING, FOREGROUND, STOPPING, FAILED }

    @Volatile private var phase = Phase.STOPPED
    private var needed = false
    val running get() = phase == Phase.FOREGROUND

    fun setNeeded(on: Boolean): Action {
        needed = on
        return reconcile()
    }

    fun promoted(): Action {
        phase = Phase.FOREGROUND
        return reconcile()
    }

    fun promotionFailed() {
        phase = Phase.FAILED
    }

    fun destroyed(): Action {
        val wasForeground = phase == Phase.FOREGROUND || phase == Phase.STOPPING
        phase = Phase.STOPPED
        // Unexpected destruction while starting leaves the next evaluation to retry.
        return if (wasForeground) reconcile() else Action.NONE
    }

    fun requestFailed(action: Action) {
        phase = when (action) {
            Action.START -> Phase.STOPPED
            Action.STOP -> Phase.FOREGROUND
            Action.NONE -> phase
        }
    }

    private fun reconcile(): Action = when {
        needed && phase == Phase.STOPPED -> {
            phase = Phase.STARTING
            Action.START
        }
        !needed && phase == Phase.FOREGROUND -> {
            phase = Phase.STOPPING
            Action.STOP
        }
        // Android expects startForeground even if visibility changes during startup.
        else -> Action.NONE
    }
}
