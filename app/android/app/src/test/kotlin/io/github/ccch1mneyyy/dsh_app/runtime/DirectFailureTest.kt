package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class DirectFailureTest {
    private val marker = "[dsh-app-direct] launch failed: direct DNS: resolv.conf has no nameserver"
    private fun classify(lines: List<String>, ready: Long? = null, code: Int = 1, direct: Boolean = true) =
        CrashClassifier.classify(code, ready, 50_000, 123, lines, false, direct)

    @Test fun directLoaderAndPreloadErrorsAreLaunchFailuresOnlyBeforeReady() {
        val lines = listOf(marker,
            "/data/user/0/app/files/runtime/rootfs/opt/node/bin/node: error while loading shared libraries: libstdc++.so.6: cannot open shared object file: No such file or directory",
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/data/user/0/app/files/runtime/rootfs/opt/dsh-go/direct/preload.mjs' imported from /data/user/0/app/files/",
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/data/user/0/app/files/runtime/rootfs/opt/dsh-go/direct/modules.mjs' imported from /data/user/0/app/files/",
            "DshDirectModuleIdentityError: this file needs compatible launch; stop the engine and turn off Direct engine")
        for (line in lines) {
            val failed = classify(listOf(line))
            assertEquals(FailureKind.LAUNCH_FAILED, failed.kind)
            assertFalse(failed.kind.counts)
            assertEquals(FailureKind.KILLED, classify(listOf(line), ready = 10_000).kind)
            assertEquals(FailureKind.KILLED, classify(listOf(line), code = 0).kind)
            assertEquals(FailureKind.KILLED, classify(listOf(line), direct = false).kind)
        }
    }

    @Test fun onlyADirectRunsLaunchFailureGoesBackToProot() {
        val launch = classify(listOf(marker))
        assertTrue(SafePolicy.directLaunchFailed(launch, direct = true))
        assertFalse(SafePolicy.directLaunchFailed(launch, direct = false))
        // PRoot's own exec failure is a launch failure too, but not Direct's.
        val proot = classify(listOf("sh: exec: /usr/local/bin/dsh: Permission denied"), direct = false)
        assertEquals(FailureKind.LAUNCH_FAILED, proot.kind)
        assertFalse(SafePolicy.directLaunchFailed(proot, direct = false))
        // Normal crashes of a direct run keep today's path (strikes, safe mode, auto restart).
        for (lines in listOf(listOf(marker, "dsh: startup failed: plugin missing"), listOf("Killed"), listOf("ENOSPC: no space"))) {
            assertFalse(SafePolicy.directLaunchFailed(classify(lines), direct = true))
        }
        assertFalse(SafePolicy.directLaunchFailed(classify(listOf(marker), ready = 10_000), direct = true))
        // And the fallback never costs a strike: a launch failure does not count.
        val outcome = SafePolicy.onFailure(SafeState.OFF, 1, launch, true)
        assertEquals(1, outcome.strikes)
        assertFalse(outcome.restartSafe)
    }

    @Test fun aSeccompKillOfDirectBeforeReadyGoesBackToProot() {
        // x86_64 emulator, 0.9.9 RC: SIGSYS for __NR_access, no output, "DSH exited with code 159".
        val killed = classify(emptyList(), code = CrashClassifier.SIGSYS_EXIT)
        assertEquals(159, CrashClassifier.SIGSYS_EXIT)
        assertEquals(FailureKind.LAUNCH_FAILED, killed.kind)
        assertEquals("killed by the system's syscall filter (SIGSYS)", killed.summary)
        assertTrue(SafePolicy.directLaunchFailed(killed, direct = true))
        val outcome = SafePolicy.onFailure(SafeState.OFF, 1, killed, true)
        assertEquals(1, outcome.strikes)
        assertFalse(outcome.restartSafe)
        // Output printed before the kill doesn't change that.
        assertEquals(FailureKind.LAUNCH_FAILED, classify(listOf("[dsh-app] launch method: direct-glibc"), code = 159).kind)
        // After ready, on PRoot, or another signal: today's path.
        assertEquals(FailureKind.KILLED, classify(emptyList(), ready = 10_000, code = 159).kind)
        assertEquals(FailureKind.KILLED, classify(emptyList(), code = 159, direct = false).kind)
        assertEquals(FailureKind.KILLED, classify(emptyList(), code = 137).kind)
        assertEquals(FailureKind.STARTUP_FAILED, classify(listOf("dsh: startup failed: plugin missing"), code = 159).kind)
        assertEquals(FailureKind.NO_SPACE, classify(listOf("ENOSPC: no space"), code = 159).kind)
    }

    @Test fun noSpaceAndDshFatalKeepTheirPriority() {
        assertEquals(FailureKind.NO_SPACE, classify(listOf(marker, "ENOSPC: no space")).kind)
        assertEquals(FailureKind.STARTUP_FAILED, classify(listOf(marker, "dsh: startup failed: plugin missing")).kind)
        assertEquals(FailureKind.KILLED, classify(listOf("plugin: error while loading shared libraries: helper.so")).kind)
    }
}
