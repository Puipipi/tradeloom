package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

/** #75's explicit V8 heap failure, not a generic Android low-memory kill. */
class Issue75HeapOomTest {
    private val oom = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
    private fun failure(ready: Long? = null, now: Long = 180_000L, code: Int = 134,
                        lines: List<String> = listOf(oom), safe: Boolean = false) =
        CrashClassifier.classify(code, ready, now, 123L, lines, safe)

    @Test fun explicitHeapFailureBeforeReadyUsesExistingStartupFailure() {
        val f = failure()
        assertEquals(FailureKind.STARTUP_FAILED, f.kind)
        assertEquals(oom, f.summary)
        assertTrue(f.kind.counts)
        assertNull(f.upSeconds)
        assertTrue(f.suspects.isEmpty()) // The marker proves no particular plugin's identity.
    }

    @Test fun onlyTheTwoKnownV8HeapFatalFormsAreAccepted() {
        val other = "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"
        for (line in listOf(oom, other)) {
            assertEquals(FailureKind.STARTUP_FAILED, failure(lines = listOf(line)).kind)
            assertEquals(line, failure(lines = listOf(line)).summary)
        }
        for (line in listOf("[stderr] $oom", "[123ms] $oom", "$oom (sample text)",
            "FATAL ERROR: arbitrary wording Allocation failed - JavaScript heap out of memory")) {
            assertEquals(FailureKind.KILLED, failure(lines = listOf(line)).kind)
        }
    }

    @Test fun earlyWindowIncludesBoundaryButKeepsLateRestartPolicy() {
        for (elapsed in listOf(0L, 119_999L, 120_000L)) {
            val f = failure(ready = 10L, now = 10L + elapsed)
            assertEquals(FailureKind.CRASHED_EARLY, f.kind)
            assertTrue(f.kind.counts)
            assertNull(SafePolicy.autoRestartDelay(f.kind, f.exitCode, elapsed, emptyList(), 180_000L))
        }
        val late = failure(ready = 10L, now = 120_011L)
        assertEquals(FailureKind.KILLED, late.kind)
        assertFalse(late.kind.counts)
        assertEquals(5_000L, SafePolicy.autoRestartDelay(late.kind, late.exitCode, 120_001L, emptyList(), 180_000L))
    }

    @Test fun normalExitAndGenericMemoryMessagesNeverGainAStrike() {
        val ignored = listOf("Killed", "Out of memory", "java.lang.OutOfMemoryError: heap space",
            "JavaScript heap out of memory", "FATAL ERROR: unrelated failure", "plugin says: $oom")
        for (line in ignored) {
            val f = failure(lines = listOf(line))
            assertEquals(line, FailureKind.KILLED, f.kind)
            assertFalse(f.kind.counts)
        }
        assertEquals(FailureKind.KILLED, failure(code = 0).kind)
        assertFalse(failure(code = 0).kind.counts)
        assertEquals(FailureKind.KILLED, failure(code = 137, lines = emptyList()).kind)
    }

    @Test fun noSpaceAndOriginalFatalMarkersKeepTheirPriority() {
        assertEquals(FailureKind.NO_SPACE, failure(lines = listOf(oom, "ENOSPC")).kind)
        val dsh = "dsh: startup failed: required row missing"
        val f = failure(lines = listOf(oom, dsh))
        assertEquals("startup failed: required row missing", f.summary)
        assertEquals(FailureKind.CRASHED_LATE, failure(ready = 1L, lines = listOf(oom, dsh)).kind)
    }

    @Test fun twoClassifiedHeapFailuresUseTheExistingSafeThreshold() {
        val f = failure()
        val first = SafePolicy.onFailure(SafeState.OFF, 0, f, true)
        assertEquals(1, first.strikes)
        assertFalse(first.restartSafe)
        val second = SafePolicy.onFailure(first.state, first.strikes, f, true)
        assertEquals(2, second.strikes)
        assertEquals(SafeState.ON, second.state)
        assertTrue(second.restartSafe)
        assertEquals(SafePolicy.REASON_AUTO, second.reason)
    }

    @Test fun safeRunsAndAutomaticModeChoiceRetainExistingPolicy() {
        val safe = SafePolicy.onFailure(SafeState.ON, 1, failure(safe = true), true)
        assertEquals(1, safe.strikes)
        assertFalse(safe.restartSafe)
        val disabled = SafePolicy.onFailure(SafeState.OFF, 1, failure(), false)
        assertEquals(2, disabled.strikes)
        assertFalse(disabled.restartSafe)
        val probation = SafePolicy.onFailure(SafeState.PROBATION, 0, failure(), false)
        assertTrue(probation.restartSafe)
        assertEquals(SafePolicy.REASON_PROBATION, probation.reason)
    }
}
