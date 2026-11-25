package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class StartupDeadlineEvidenceTest {
    private fun classified(lines: List<String>, code: Int = 131, safe: Boolean = false, direct: Boolean = false) =
        CrashClassifier.classify(code, null, 180_001L, 1L, lines, safe, direct)

    private fun outcome(f: RunFailure, timedOut: Boolean = true, state: SafeState = SafeState.OFF,
                        strikes: Int = 1, auto: Boolean = true): SafePolicy.Outcome? =
        if (CrashClassifier.classifyAfterTokenTimeout(timedOut, f))
            SafePolicy.onFailure(state, strikes, f, auto) else null

    @Test fun realFatalRetainsExistingSecondStrikePolicyAtDeadline() {
        val f = classified(listOf("dsh: fatal load failure: Error: initialization failed"))
        assertEquals(FailureKind.STARTUP_FAILED, f.kind)
        val result = outcome(f)!!
        assertEquals(2, result.strikes)
        assertTrue(result.restartSafe)
        assertEquals(SafeState.ON, result.state)
        assertEquals("fatal load failure: Error: initialization failed", f.summary)
    }

    @Test fun silentDeadlineAndGenericStartupFailureDoNotGainStrikes() {
        assertNull(outcome(classified(emptyList())))
        assertNull(outcome(classified(listOf("ordinary plugin progress"))))
        assertNull(outcome(classified(listOf("dsh: fatal load failure: Error: failed")), timedOut = false))
    }

    @Test fun heapOomKeepsOriginalNonzeroExitRequirement() {
        val lines = listOf("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
        assertNotNull(outcome(classified(lines)))
        assertNull(outcome(classified(lines, code = 0)))
    }

    @Test fun noSpaceKeepsPrecedenceAndNeverCounts() {
        val f = classified(listOf("dsh: fatal load failure: Error: failed", "ENOSPC: no space"))
        assertEquals(FailureKind.NO_SPACE, f.kind)
        val result = outcome(f)!!
        assertEquals(1, result.strikes)
        assertFalse(result.restartSafe)
    }

    @Test fun knownDirectLaunchFailureStillUsesCompatibleLaunch() {
        val f = classified(listOf("[dsh-app-direct] launch failed: loader unavailable"), direct = true)
        assertTrue(CrashClassifier.classifyAfterTokenTimeout(true, f))
        assertTrue(SafePolicy.directLaunchFailed(f, true))
        assertFalse(f.kind.counts)
    }

    @Test fun safeProbationAndDisabledAutomaticModeKeepExistingRules() {
        val lines = listOf("dsh: fatal uncaught exception: Error: initialization failed")
        assertEquals(1, outcome(classified(lines, safe = true))!!.strikes)
        assertFalse(outcome(classified(lines), auto = false)!!.restartSafe)
        assertTrue(outcome(classified(lines), state = SafeState.PROBATION, strikes = 0, auto = false)!!.restartSafe)
    }
}
