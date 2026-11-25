package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

/** Pure preference publication tests; no Android process or SharedPreferences implementation. */
class WorkspaceRecoveryModeTest {
    @Test fun savedInitialModeIsKeptUntilACommitSucceeds() {
        assertFalse(WorkspaceRecoveryMode(false).enabled)
        assertTrue(WorkspaceRecoveryMode(true).enabled)
    }

    @Test fun successfulSavePublishesOnlyAfterCommitReturns() {
        val mode = WorkspaceRecoveryMode(false)
        val writes = mutableListOf<Boolean>()
        mode.set(true) { next ->
            assertFalse(mode.enabled)
            writes += next
            true
        }
        assertEquals(listOf(true), writes)
        assertTrue(mode.enabled)
    }

    @Test fun failedCommitDoesNotPublishItsInMemoryPreferenceAndRollsItBack() {
        val mode = WorkspaceRecoveryMode(false)
        var preferenceMemory = false
        val writes = mutableListOf<Boolean>()
        assertThrows(WorkspaceRecoverySaveException::class.java) {
            mode.set(true) { next ->
                preferenceMemory = next
                writes += next
                writes.size > 1
            }
        }
        assertEquals(listOf(true, false), writes)
        assertFalse(preferenceMemory)
        assertFalse(mode.enabled)
    }

    @Test fun failedDisableKeepsThePreviouslyConfirmedMode() {
        val mode = WorkspaceRecoveryMode(true)
        val writes = mutableListOf<Boolean>()
        assertThrows(WorkspaceRecoverySaveException::class.java) {
            mode.set(false) { next -> writes += next; writes.size > 1 }
        }
        assertEquals(listOf(false, true), writes)
        assertTrue(mode.enabled)
    }

    @Test fun saveExceptionIsReportedAndDoesNotPublishTheNewMode() {
        val mode = WorkspaceRecoveryMode(false)
        val failure = IOException("controlled preference write failure")
        val writes = mutableListOf<Boolean>()
        val error = assertThrows(WorkspaceRecoverySaveException::class.java) {
            mode.set(true) { next ->
                writes += next
                if (next) throw failure
                true
            }
        }
        assertSame(failure, error.cause)
        assertEquals(listOf(true, false), writes)
        assertFalse(mode.enabled)
    }

    @Test fun rollbackFailureStillCannotPublishTheUnconfirmedMode() {
        val mode = WorkspaceRecoveryMode(false)
        var calls = 0
        assertThrows(WorkspaceRecoverySaveException::class.java) {
            mode.set(true) {
                calls++
                if (calls == 1) false else throw IOException("controlled rollback failure")
            }
        }
        assertEquals(2, calls)
        assertFalse(mode.enabled)
    }

    @Test fun aSameValueRequestStillRequiresASuccessfulCommit() {
        val mode = WorkspaceRecoveryMode(true)
        assertThrows(WorkspaceRecoverySaveException::class.java) { mode.set(true) { false } }
        assertTrue(mode.enabled)
    }

    @Test fun aLaterSuccessfulRetryCanPublishAfterARejectedSave() {
        val mode = WorkspaceRecoveryMode(false)
        assertThrows(WorkspaceRecoverySaveException::class.java) { mode.set(true) { false } }
        mode.set(true) { true }
        assertTrue(mode.enabled)
        mode.set(false) { true }
        assertFalse(mode.enabled)
    }

    @Test fun disabledModeOverwritesAnInheritedEnabledEnvironmentValue() {
        val environment = linkedMapOf("DSH_APP_WORKSPACE_RECOVERY" to "1", "UNCHANGED" to "value")
        WorkspaceRecoveryMode(false).applyEnvironment(environment)
        assertEquals(mapOf("DSH_APP_WORKSPACE_RECOVERY" to "0", "UNCHANGED" to "value"), environment)
    }

    @Test fun enabledModeOverwritesAnInheritedDisabledEnvironmentValue() {
        val environment = linkedMapOf("DSH_APP_WORKSPACE_RECOVERY" to "0", "UNCHANGED" to "value")
        WorkspaceRecoveryMode(true).applyEnvironment(environment)
        assertEquals(mapOf("DSH_APP_WORKSPACE_RECOVERY" to "1", "UNCHANGED" to "value"), environment)
    }

    @Test fun everyLaunchExplicitlySetsBothEnabledAndDisabledModes() {
        val mode = WorkspaceRecoveryMode(true)
        val first = linkedMapOf<String, String>()
        mode.applyEnvironment(first)
        assertEquals("1", first["DSH_APP_WORKSPACE_RECOVERY"])
        mode.set(false) { true }
        val second = linkedMapOf<String, String>()
        mode.applyEnvironment(second)
        assertEquals("0", second["DSH_APP_WORKSPACE_RECOVERY"])
    }

    @Test fun anUnconfirmedEnableCannotChangeTheNextLaunchEnvironment() {
        val mode = WorkspaceRecoveryMode(false)
        assertThrows(WorkspaceRecoverySaveException::class.java) { mode.set(true) { false } }
        val environment = linkedMapOf("DSH_APP_WORKSPACE_RECOVERY" to "1")
        mode.applyEnvironment(environment)
        assertEquals("0", environment["DSH_APP_WORKSPACE_RECOVERY"])
    }
}
