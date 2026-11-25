package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.assertEquals
import org.junit.Test

class LaunchStartTest {
    private val installed = RuntimeController.Phase.INSTALLED.wire

    @Test fun startsAnInstalledIdleRuntimeWhenTheSettingIsOn() {
        assertEquals(true, LaunchStart.shouldStart(true, installed, SafeState.OFF.wire, autoSafe = true, strikes = 0))
        // Safe mode and its trial start too: start() keeps the current mode.
        assertEquals(true, LaunchStart.shouldStart(true, installed, SafeState.ON.wire, autoSafe = false, strikes = 3))
        assertEquals(true, LaunchStart.shouldStart(true, installed, SafeState.PROBATION.wire, autoSafe = false, strikes = 2))
    }

    @Test fun leavesItWhenTheSettingIsOff() {
        assertEquals(false, LaunchStart.shouldStart(false, installed, SafeState.OFF.wire, autoSafe = true, strikes = 0))
    }

    @Test fun onlyFromTheInstalledPhase() {
        for (phase in RuntimeController.Phase.entries) {
            if (phase == RuntimeController.Phase.INSTALLED) continue
            assertEquals(phase.wire, false, LaunchStart.shouldStart(true, phase.wire, SafeState.OFF.wire, autoSafe = true, strikes = 0))
        }
        assertEquals(false, LaunchStart.shouldStart(true, null, SafeState.OFF.wire, autoSafe = true, strikes = 0))
    }

    /** EngineControl.shouldAutoStart: after two failures with automatic safe mode off, the card waits. */
    @Test fun failureCardWaitsForTheUser() {
        assertEquals(false, LaunchStart.shouldStart(true, installed, SafeState.OFF.wire, autoSafe = false, strikes = 2))
        assertEquals(true, LaunchStart.shouldStart(true, installed, SafeState.OFF.wire, autoSafe = false, strikes = 1))
        assertEquals(true, LaunchStart.shouldStart(true, installed, SafeState.OFF.wire, autoSafe = true, strikes = 5))
    }
}
