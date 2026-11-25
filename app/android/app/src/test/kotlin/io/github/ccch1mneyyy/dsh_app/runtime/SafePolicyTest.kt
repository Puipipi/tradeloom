package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class SafePolicyTest {
    private fun failure(kind: FailureKind = FailureKind.STARTUP_FAILED, safe: Boolean = false) = RunFailure(
        kind, 1, 1L, safe, null, emptyList(), emptyList(), diagnostics = null, upSeconds = null,
    )

    @Test fun startRequestModes() {
        assertEquals(SafeState.ON, SafePolicy.onStartRequest(SafeState.OFF, "safe"))
        assertEquals(SafeState.PROBATION, SafePolicy.onStartRequest(SafeState.ON, "normal"))
        assertEquals(SafeState.OFF, SafePolicy.onStartRequest(SafeState.OFF, "normal"))
        for (state in SafeState.entries) assertEquals(state, SafePolicy.onStartRequest(state, null))
    }

    @Test fun safeAndUncountedFailuresKeepPolicy() {
        for (state in SafeState.entries) {
            for (failure in listOf(failure(safe = true), failure(FailureKind.KILLED), failure(FailureKind.NO_SPACE))) {
                val result = SafePolicy.onFailure(state, 1, failure, true)
                assertEquals(state, result.state)
                assertEquals(1, result.strikes)
                assertFalse(result.restartSafe)
            }
        }
    }

    @Test fun failedProbationReturnsToSafeEvenWhenAutomaticModeIsOff() {
        val result = SafePolicy.onFailure(SafeState.PROBATION, 0, failure(), false)
        assertEquals(SafeState.ON, result.state)
        assertTrue(result.restartSafe)
        assertEquals(SafePolicy.REASON_PROBATION, result.reason)
    }

    @Test fun secondStrikeEntersSafeOnlyWhenAutomaticModeIsOn() {
        // Same threshold as Dart safe_mode_logic_test's shouldAutoStart(strikes: 2).
        val first = SafePolicy.onFailure(SafeState.OFF, 0, failure(), true)
        assertEquals(1, first.strikes)
        assertEquals(SafeState.OFF, first.state)
        val second = SafePolicy.onFailure(first.state, first.strikes, failure(), true)
        assertEquals(2, second.strikes)
        assertEquals(SafeState.ON, second.state)
        assertTrue(second.restartSafe)
        assertFalse(SafePolicy.onFailure(SafeState.OFF, 1, failure(), false).restartSafe)
    }

    private fun briefing() = SafeMode.Briefing(
        failure = null, reason = SafePolicy.REASON_MANUAL, moved = emptyList(),
        lkgAt = null, lkgBundles = emptyList(), lkgVersions = emptyMap(), failureLog = emptyList(),
    )

    @Test fun safeEnvironmentSeparatesRuntimeHomeFromTheOriginalRepairTarget() {
        assertEquals(mapOf(
            "DSH_HOME" to "/var/lib/dsh-app/safe-mode/home",
            "DSH_APP_ORIGINAL_HOME" to "/root/.dsh",
            "DSH_AGENTS_HOME" to "/var/lib/dsh-app/safe-mode/agents",
            "DSH_APP_SAFE_MODE" to "1",
        ), SafeMode.GUEST_ENV)
    }

    @Test fun prepareCreatesAnIndependentHomeAndKeepsItsExistingDataOnRestart() {
        val root = kotlin.io.path.createTempDirectory("safe-home-prepare").toFile()
        try {
            SafeMode.prepare(root, briefing())
            val home = File(root, "var/lib/dsh-app/safe-mode/home")
            assertTrue(home.isDirectory)
            assertFalse(Files.isSymbolicLink(home.toPath()))
            assertFalse(File(root, "root/.dsh").exists())
            val saved = File(home, "sessions/previous-rescue.jsonl")
            saved.parentFile!!.mkdirs()
            val bytes = "existing rescue data\n".toByteArray()
            saved.writeBytes(bytes)
            SafeMode.prepare(root, briefing())
            assertArrayEquals(bytes, saved.readBytes())
            assertFalse(File(root, "root/.dsh").exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun prepareDoesNotRequireTheOriginalHomeToBeADirectory() {
        val root = kotlin.io.path.createTempDirectory("safe-home-original").toFile()
        try {
            val original = File(root, "root/.dsh")
            original.parentFile!!.mkdirs()
            val bytes = "original home is damaged\n".toByteArray()
            original.writeBytes(bytes)
            SafeMode.prepare(root, briefing())
            assertArrayEquals(bytes, original.readBytes())
            assertTrue(File(root, "var/lib/dsh-app/safe-mode/home").isDirectory)
            assertTrue(File(root, "var/lib/dsh-app/safe-mode/agents/AGENTS.md").isFile)
        } finally { root.deleteRecursively() }
    }

    @Test fun prepareRejectsAFileAtRescueHomeWithoutReplacingIt() {
        val root = kotlin.io.path.createTempDirectory("safe-home-file").toFile()
        try {
            val home = File(root, "var/lib/dsh-app/safe-mode/home")
            home.parentFile!!.mkdirs()
            val bytes = "do not overwrite this rescue home path\n".toByteArray()
            home.writeBytes(bytes)
            try {
                SafeMode.prepare(root, briefing())
                fail("a file at rescue home must be rejected")
            } catch (_: IOException) {
                assertArrayEquals(bytes, home.readBytes())
            }
            assertFalse(File(home.parentFile, "agents").exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun prepareRejectsALinkToTheOriginalHomeWithoutChangingTheLinkOrTarget() {
        val root = kotlin.io.path.createTempDirectory("safe-home-link").toFile()
        val home = File(root, "var/lib/dsh-app/safe-mode/home")
        try {
            val original = File(root, "root/.dsh")
            original.mkdirs()
            val sentinel = File(original, "keep.txt")
            val bytes = "original data stays original\n".toByteArray()
            sentinel.writeBytes(bytes)
            home.parentFile!!.mkdirs()
            Files.createSymbolicLink(home.toPath(), original.toPath())
            val target = Files.readSymbolicLink(home.toPath())
            try {
                SafeMode.prepare(root, briefing())
                fail("a symlink at rescue home must be rejected")
            } catch (_: IOException) {
                assertTrue(Files.isSymbolicLink(home.toPath()))
                assertEquals(target, Files.readSymbolicLink(home.toPath()))
                assertArrayEquals(bytes, sentinel.readBytes())
                assertEquals(listOf("keep.txt"), original.list()!!.sorted())
            }
            assertFalse(File(home.parentFile, "agents").exists())
        } finally {
            Files.deleteIfExists(home.toPath())
            root.deleteRecursively()
        }
    }
}
