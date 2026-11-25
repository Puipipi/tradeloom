package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class Issue24LaunchFailureTest {
    private val execError = "/bin/sh: 1: exec: /usr/local/bin/dsh: Bad address"
    private val reported = listOf(
        "sh: 0: getcwd() failed: Function not implemented",
        execError,
    )

    private fun classify(
        tail: List<String> = reported,
        readyAt: Long? = null,
        exitCode: Int = 126,
        safe: Boolean = false,
    ) = CrashClassifier.classify(exitCode, readyAt, 180_000L, 123L, tail, safe)

    @Test fun preservesTheReportedExecFailureWithoutCallingItAnAndroidKill() {
        val failure = classify()
        assertEquals("launchFailed", failure.kind.wire)
        assertEquals(execError, failure.summary)
        assertNull(failure.upSeconds)
        assertFalse(failure.kind.counts)
        assertEquals("launchFailed", failure.toMap()["kind"])
        assertEquals(failure.kind, FailureKind.parse("launchFailed"))
    }

    @Test fun acceptsOnlyExplicitDshExecErrorsBeforeReady() {
        for (reason in listOf(
            "Bad address", "Exec format error", "Permission denied", "not found",
            "Function not implemented", "Operation not permitted",
        )) {
            assertEquals(reason, "launchFailed", classify(listOf("sh: exec: /usr/local/bin/dsh: $reason")).kind.wire)
        }
        for (tail in listOf(
            listOf("sh: 0: getcwd() failed: Function not implemented"),
            listOf("Error: Bad address"),
            listOf("/bin/sh: 1: exec: /tmp/plugin-script: Bad address"),
            listOf("plugin says: $execError"),
            listOf("/bin/sh: 1: exec: /usr/local/bin/dsh: unexpected plugin output"),
        )) assertEquals(FailureKind.KILLED, classify(tail).kind)
        assertEquals(FailureKind.KILLED, classify(readyAt = 0L).kind)
        assertEquals(FailureKind.KILLED, classify(exitCode = 0).kind)
    }

    @Test fun keepsDiskFullAndDshFatalEvidenceAheadOfExecMessages() {
        val fatal = "dsh: startup failed: required row missing"
        assertEquals(FailureKind.NO_SPACE, classify(reported + "ENOSPC").kind)
        assertEquals(FailureKind.STARTUP_FAILED, classify(reported + fatal).kind)
        assertEquals("startup failed: required row missing", classify(reported + fatal).summary)
    }

    @Test fun doesNotCountOrAutomaticallyRestartAnExecFailure() {
        for (safe in listOf(false, true)) {
            val failure = classify(safe = safe)
            for (state in SafeState.entries) {
                val outcome = SafePolicy.onFailure(state, 1, failure, true)
                assertEquals(state, outcome.state)
                assertEquals(1, outcome.strikes)
                assertFalse(outcome.restartSafe)
            }
            assertNull(SafePolicy.autoRestartDelay(failure.kind, failure.exitCode, null, emptyList(), 180_000L))
            assertNull(SafePolicy.autoRestartDelay(failure.kind, failure.exitCode, 90_000L, emptyList(), 180_000L))
        }
    }

    @Test fun repairBriefingDoesNotTurnRecentPluginChangesIntoLaunchEvidence() {
        val failure = classify().copy(recent = listOf("unrelated-plugin"), requiredRows = listOf("unrelated-row"))
        val briefing = SafeMode.renderBriefing(SafeMode.Briefing(
            failure = failure, reason = SafePolicy.REASON_MANUAL, moved = emptyList(),
            lkgAt = null, lkgBundles = emptyList(), lkgVersions = emptyMap(), failureLog = reported,
        ))
        assertTrue(briefing.contains("本机运行环境未能执行 DSH"))
        assertTrue(briefing.contains(execError))
        assertFalse(briefing.contains("unrelated-plugin"))
        assertFalse(briefing.contains("unrelated-row"))
    }
}
