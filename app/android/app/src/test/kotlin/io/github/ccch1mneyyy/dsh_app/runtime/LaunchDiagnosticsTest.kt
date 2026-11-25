package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class LaunchDiagnosticsTest {
    @Test fun selectionIsNotRunningUntilSpawnedAndAlive() {
        val run = LaunchDiagnostics()
        assertNull(run.currentMode(true))
        run.selected("direct", null)
        assertNull(run.currentMode(true))
        run.failed("startFailed")
        assertEquals("direct", run.selectedMode)
        assertFalse(run.spawned)
        assertNull(run.currentMode(false))
        assertEquals("startFailed", run.failureReason)
    }

    @Test fun exitRetainsAttemptButNeverReportsRunning() {
        val run = LaunchDiagnostics()
        run.selected("direct", null)
        run.spawned()
        assertEquals("direct", run.currentMode(true))
        run.failed("exit:1")
        assertNull(run.currentMode(false))
        assertTrue(run.spawned)
        assertEquals("exit:1", run.failureReason)
    }

    @Test fun newAttemptCannotInheritPreviousFailureOrFallback() {
        val previous = LaunchDiagnostics()
        previous.selected("proot", "incompatibleFiles")
        previous.failed("startFailed")
        val next = LaunchDiagnostics()
        next.selected("direct", null)
        next.spawned()
        assertNull(next.fallbackReason)
        assertNull(next.failureReason)
        assertEquals("direct", next.currentMode(true))
    }

    @Test fun compatibleSelectionIsIndependentOfSavedDirectPreference() {
        for (reason in listOf("incompatibleFiles", "safeRecovery")) {
            val run = LaunchDiagnostics()
            run.selected("proot", reason)
            run.spawned()
            assertEquals("proot", run.currentMode(true))
            assertEquals(reason, run.fallbackReason)
        }
    }
}
