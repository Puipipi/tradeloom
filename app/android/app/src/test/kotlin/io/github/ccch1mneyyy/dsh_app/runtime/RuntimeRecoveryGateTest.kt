package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class RuntimeRecoveryGateTest {
    private class Probe {
        var cleanupCalls = 0
        var writes = 0

        fun write(
            phase: RuntimeController.Phase = RuntimeController.Phase.INSTALLED,
            owner: Boolean = false,
            safe: Boolean = false,
            resetting: Boolean = false,
            mainProfileOnly: Boolean = false,
            cleanup: () -> Boolean = { true },
        ) {
            val state = RuntimeRecoveryGate.State(phase, owner, safe, resetting)
            RuntimeRecoveryGate.check(state, mainProfileOnly) {
                cleanupCalls++
                cleanup()
            }
            writes++
        }
    }

    @Test fun errorPhaseDoesNotReleaseAnExistingOwner() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(phase = RuntimeController.Phase.ERROR, owner = true)
        }
        assertEquals(0, probe.cleanupCalls)
        assertEquals(0, probe.writes)
    }

    @Test fun queuedStartWithoutAnOwnerCannotAdmitRecovery() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(phase = RuntimeController.Phase.STARTING)
        }
        assertEquals(0, probe.cleanupCalls)
        assertEquals(0, probe.writes)
    }

    @Test fun stoppingNeverUsesTheSavedSafeModeException() {
        for (owner in listOf(false, true)) {
            val probe = Probe()
            assertThrows(RuntimeNotStoppedException::class.java) {
                probe.write(RuntimeController.Phase.STOPPING, owner, safe = true, mainProfileOnly = true)
            }
            assertEquals(0, probe.cleanupCalls)
            assertEquals(0, probe.writes)
        }
    }

    @Test fun installingAndResettingNeverAdmitRecovery() {
        for (phase in listOf(RuntimeController.Phase.INSTALLING, RuntimeController.Phase.INSTALLED)) {
            val probe = Probe()
            assertThrows(RuntimeNotStoppedException::class.java) {
                probe.write(phase = phase, resetting = true)
            }
            assertEquals(0, probe.cleanupCalls)
            assertEquals(0, probe.writes)
        }
        val installing = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            installing.write(phase = RuntimeController.Phase.INSTALLING)
        }
        assertEquals(0, installing.writes)
    }

    @Test fun aRunningSafeOwnerCanRestoreOnlyTheMainProfile() {
        val probe = Probe()
        probe.write(RuntimeController.Phase.RUNNING, owner = true, safe = true, mainProfileOnly = true)
        assertEquals(0, probe.cleanupCalls)
        assertEquals(1, probe.writes)
    }

    @Test fun runningSafeDoesNotPermitHomeFileMoves() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(RuntimeController.Phase.RUNNING, owner = true, safe = true)
        }
        assertEquals(0, probe.cleanupCalls)
        assertEquals(0, probe.writes)
    }

    @Test fun safeLabelWithoutAnActualOwnerDoesNotGrantRunningException() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(RuntimeController.Phase.RUNNING, safe = true, mainProfileOnly = true)
        }
        assertEquals(0, probe.writes)
    }

    @Test fun normalRunningOwnerCannotUseMainProfileException() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(RuntimeController.Phase.RUNNING, owner = true, mainProfileOnly = true)
        }
        assertEquals(0, probe.writes)
    }

    @Test fun idleOwnerlessStatesStillRequireASuccessfulSweep() {
        for (phase in listOf(RuntimeController.Phase.INSTALLED, RuntimeController.Phase.ERROR)) {
            val probe = Probe()
            assertThrows(RuntimeNotStoppedException::class.java) {
                probe.write(phase = phase, safe = true, mainProfileOnly = true, cleanup = { false })
            }
            assertEquals(1, probe.cleanupCalls)
            assertEquals(0, probe.writes)
        }
    }

    @Test fun aSuccessfulStrictSweepAdmitsAnIdleWrite() {
        val probe = Probe()
        probe.write(phase = RuntimeController.Phase.ERROR)
        assertEquals(1, probe.cleanupCalls)
        assertEquals(1, probe.writes)
    }

    @Test fun observationExceptionCannotFallThroughToAWrite() {
        val probe = Probe()
        val error = IOException("controlled unreadable process snapshot")
        assertSame(error, assertThrows(IOException::class.java) { probe.write(cleanup = { throw error }) })
        assertEquals(1, probe.cleanupCalls)
        assertEquals(0, probe.writes)
    }

    @Test fun resettingRetiresEvenTheRunningSafeException() {
        val probe = Probe()
        assertThrows(RuntimeNotStoppedException::class.java) {
            probe.write(RuntimeController.Phase.RUNNING, owner = true, safe = true,
                resetting = true, mainProfileOnly = true)
        }
        assertEquals(0, probe.writes)
    }
}
