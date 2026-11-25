package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

/**
 * Pure product state selection only. These tests do not run the Android Handler,
 * Process waiter, stop signals, controller ownership, or the 180-second deadline.
 */
class StartupFailureStateTest {
    private val noToken = "no startup token received within 180s"
    private val noPort = "token seen but port 3080 never accepted connections"

    @Test fun ordinaryStopsAndCrashesAreNotConvertedToLocalStartupFailures() {
        for (complete in listOf(false, true)) {
            for (resetting in listOf(false, true)) {
                assertNull(StartupFailureState.of(null, complete, resetting))
            }
        }
    }

    @Test fun noTokenFailureIsVisibleWhileCleanupStillOwnsTheProcess() {
        val state = StartupFailureState.of(noToken, ownerReleased = false, resetting = false)!!
        assertEquals(RuntimeController.Phase.STOPPING, state.phase)
        assertEquals("start failed: no startup token received within 180s", state.error)
    }

    @Test fun aTokenWithoutAListeningPortUsesTheSameBusyFailureState() {
        val state = StartupFailureState.of(noPort, ownerReleased = false, resetting = false)!!
        assertEquals(RuntimeController.Phase.STOPPING, state.phase)
        assertEquals("start failed: token seen but port 3080 never accepted connections", state.error)
    }

    @Test fun releasedOwnerAllowsTheAcceptedFailureToBecomeError() {
        val state = StartupFailureState.of(noToken, ownerReleased = true, resetting = false)!!
        assertEquals(RuntimeController.Phase.ERROR, state.phase)
        assertEquals("start failed: no startup token received within 180s", state.error)
    }

    @Test fun aResetStillOwnsTheDiskAfterTheProcessHasExited() {
        val state = StartupFailureState.of(noToken, ownerReleased = true, resetting = true)!!
        assertEquals(RuntimeController.Phase.STOPPING, state.phase)
        assertEquals("start failed: no startup token received within 180s", state.error)
    }

    @Test fun resetDoesNotTurnIncompleteCleanupIntoAnIdleFailure() {
        val state = StartupFailureState.of(noPort, ownerReleased = false, resetting = true)!!
        assertEquals(RuntimeController.Phase.STOPPING, state.phase)
        assertEquals("start failed: token seen but port 3080 never accepted connections", state.error)
    }

    @Test fun theCauseSurvivesBothCleanupAndALaterResetWait() {
        val cleaning = StartupFailureState.of(noToken, ownerReleased = false, resetting = false)!!
        val resetWait = StartupFailureState.of(noToken, ownerReleased = true, resetting = true)!!
        val exited = StartupFailureState.of(noToken, ownerReleased = true, resetting = false)!!
        assertEquals(cleaning.error, resetWait.error)
        assertEquals(cleaning.error, exited.error)
        assertEquals(listOf(RuntimeController.Phase.STOPPING, RuntimeController.Phase.STOPPING,
            RuntimeController.Phase.ERROR), listOf(cleaning.phase, resetWait.phase, exited.phase))
    }

    @Test fun aSynchronousLaunchExceptionUsesTheExistingErrorWirePrefix() {
        val state = StartupFailureState.of("controlled launch failure", ownerReleased = true, resetting = false)!!
        assertEquals("start failed: controlled launch failure", state.error)
        assertEquals(RuntimeController.Phase.ERROR, state.phase)
    }
}
