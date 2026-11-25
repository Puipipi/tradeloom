package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test

class DirectLaunchTest {
    private val prefix = "echo \$\$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh "
    private val command = prefix + "web --patch /etc/dsh-app/dsh-web.patch.yml --patch /opt/dsh-app/auth/auth.patch.yml --host 127.0.0.1 --port 3080 --no-open"

    @Test fun webFlagsKeepOverlayOrderAndLiteralArguments() {
        assertEquals(listOf("web", "--patch", "/etc/dsh-app/dsh-web.patch.yml", "--patch", "/opt/dsh-app/auth/auth.patch.yml", "--host", "127.0.0.1", "--port", "3080", "--no-open"), DirectLaunch.webArguments(command))
    }

    @Test fun unknownShellSyntaxAndNetworkExposureFailClosed() {
        for (bad in listOf(command + "; echo bad", command + " \$(id)", command.replace("127.0.0.1", "0.0.0.0"), command.replace("3080", "65536"), command + " --unknown", command.replace("dsh web", "dsh --profile safe"))) {
            assertThrows(IllegalArgumentException::class.java) { DirectLaunch.webArguments(bad) }
        }
    }

    @Test fun shellQuoteRetainsSpacesAndApostropheWithoutExpansion() {
        assertEquals("'a b'\\''c\$d'", DirectLaunch.quote("a b'c\$d"))
        assertThrows(IllegalArgumentException::class.java) { DirectLaunch.quote("line\nbreak") }
    }

    @Test fun prootNodeKeepsItsFlagsAndImportsTheDnsResolver() {
        assertEquals("--dns-result-order=ipv4first --max-old-space-size=1536 --import=/opt/dsh-go/direct/proot-dns.mjs",
            DirectLaunch.prootNodeOptions("--dns-result-order=ipv4first --max-old-space-size=1536"))
        assertEquals("--import=/opt/dsh-go/direct/proot-dns.mjs", DirectLaunch.prootNodeOptions(""))
        assertEquals("--import=/opt/dsh-go/direct/proot-dns.mjs", DirectLaunch.prootNodeOptions(null))
    }

    @Test fun bothAbisUseRootfsLoaders() {
        assertEquals("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", DirectLaunch.loaderPath("x86_64"))
        assertEquals("usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1", DirectLaunch.loaderPath("arm64-v8a"))
        assertThrows(IllegalStateException::class.java) { DirectLaunch.loaderPath("armeabi-v7a") }
    }

    @Test fun nativeLibrarySearchUsesOnlyTheLockedRuntimePackages() {
        val x64 = DirectLaunch.libraryDirectories("x86_64")
        assertEquals(listOf("opt/dsh/node_modules/@img/sharp-libvips-linux-x64/lib", "opt/dsh/node_modules/sherpa-onnx-linux-x64"), x64.takeLast(2))
        val arm64 = DirectLaunch.libraryDirectories("arm64-v8a")
        assertEquals(listOf("opt/dsh/node_modules/@img/sharp-libvips-linux-arm64/lib", "opt/dsh/node_modules/sherpa-onnx-linux-arm64"), arm64.takeLast(2))
        assertTrue((x64 + arm64).none { it.contains("profiles") || it.startsWith('/') })
        assertThrows(IllegalStateException::class.java) { DirectLaunch.libraryDirectories("unknown") }
    }

    @Test fun unchangedRuntimeCannotAccidentallyEnableDirect() {
        val root = kotlin.io.path.createTempDirectory("direct-old").toFile()
        try {
            assertEquals("runtimeUpdateRequired", DirectLaunch.unavailable(root, "x86_64"))
            File(root, "opt/dsh-go/direct").mkdirs()
            File(root, DirectLaunch.PRELOAD).writeText("R1 fixture")
            File(root, "opt/dsh-go/direct/dns.mjs").writeText("R1 fixture")
            assertEquals("runtimeUpdateRequired", DirectLaunch.unavailable(root, "x86_64"))
        }
        finally { root.deleteRecursively() }
    }

    @Test fun compatibleSelectionKeepsPreferenceSeparateFromActualModeAndSafeRecovery() {
        val root = kotlin.io.path.createTempDirectory("direct-selection").toFile()
        try {
            assertTrue(DirectLaunch.select(root, requested = true, safe = false).direct)
            assertFalse(DirectLaunch.select(root, requested = false, safe = false).direct)
            assertFalse(DirectLaunch.select(root, requested = true, safe = true).direct)
            val store = File(root, "root/.l2s").apply { mkdirs() }
            assertTrue(DirectLaunch.select(root, requested = true, safe = false).direct)
            val backing = File(store, ".l2s.file0001.0001").apply { writeText("kept") }
            val selection = DirectLaunch.select(root, requested = true, safe = false)
            assertFalse(selection.direct)
            assertEquals("incompatibleFiles", selection.fallbackReason)
            assertEquals("kept", backing.readText())
            assertNull(DirectLaunch.select(root, requested = true, safe = true).fallbackReason)
        } finally { root.deleteRecursively() }
    }

    @Test fun directIsOffUntilChosenAndNeedsARuntimeThatSupportsIt() {
        fun pref(saved: Boolean?, available: Boolean = true) = DirectLaunch.Preference(saved, available, null, "r1")
        // Never chosen, fresh installs and upgraders alike: off.
        assertFalse(pref(null).enabled)
        assertFalse(pref(null).requested)
        // Turned on: on, where the runtime supports it.
        assertTrue(pref(true).enabled)
        assertFalse(pref(true, available = false).enabled)
        assertFalse(pref(false).enabled)
    }

    @Test fun aFailedDirectLaunchHoldsOnlyForTheRuntimeItFailedWith() {
        val failed = DirectLaunch.Preference(saved = true, available = true, failedRuntime = "r1", runtime = "r1")
        assertTrue(failed.requested)
        assertTrue(failed.failed)
        assertFalse(failed.enabled)
        // A new runtime gets one fresh try; so does an explicit "off" staying off.
        assertTrue(failed.copy(runtime = "r2").enabled)
        assertFalse(failed.copy(saved = false).enabled)
        // An unreadable manifest is not a match.
        assertFalse(failed.copy(runtime = null).failed)
    }

    @Test fun aFailedDirectLaunchSelectsProotWithItsReasonButSafeModeKeepsItsOwn() {
        val root = kotlin.io.path.createTempDirectory("direct-failed").toFile()
        try {
            assertEquals(DirectLaunch.Selection(false, DirectLaunch.FAILED), DirectLaunch.select(root, requested = true, safe = false, failed = true))
            // Safe mode is compatible anyway (DshProcess reports safeRecovery); off is plain off.
            assertEquals(DirectLaunch.Selection(false), DirectLaunch.select(root, requested = true, safe = true, failed = true))
            assertEquals(DirectLaunch.Selection(false), DirectLaunch.select(root, requested = false, safe = false, failed = true))
            assertTrue(DirectLaunch.select(root, requested = true, safe = false, failed = false).direct)
        } finally { root.deleteRecursively() }
    }

    @Test fun symlinkedBackingDirectoryCannotLookEmptyAndEnableDirect() {
        val root = kotlin.io.path.createTempDirectory("direct-selection-link").toFile()
        try {
            File(root, "root").mkdirs()
            val empty = File(root, "empty").apply { mkdirs() }
            java.nio.file.Files.createSymbolicLink(File(root, "root/.l2s").toPath(), empty.toPath())
            assertEquals("incompatibleFiles", DirectLaunch.compatibilityReason(root))
        } finally { root.deleteRecursively() }
    }

    @Test fun bindMappingUsesActualLaunchAndSpecificOverrides() {
        val mounts = DirectLaunch.mounts(listOf("proot", "-b", "/dev", "-b", "/old:/sdcard", "--bind=/storage/emulated/0:/sdcard",
            "--bind", "/sys", "-b", "/runtime/empty:/sys/fs/selinux", "-b", "/runtime:/runtime"), "/runtime")
        assertEquals(listOf(DirectLaunch.Mount("/runtime/empty", "/sys/fs/selinux"), DirectLaunch.Mount("/storage/emulated/0", "/sdcard"),
            DirectLaunch.Mount("/dev", "/dev"), DirectLaunch.Mount("/sys", "/sys")), mounts)
        assertFalse(DirectLaunch.mounts(listOf("proot", "-b", "/dev", "-b", "/proc"), "/runtime").any { it.guest == "/sdcard" })
        assertThrows(IllegalArgumentException::class.java) { DirectLaunch.mounts(listOf("proot", "-b", "/:/"), "/runtime") }
        assertThrows(IllegalStateException::class.java) { DirectLaunch.mounts(listOf("proot", "-b"), "/runtime") }
    }

    @Test fun freshDefaultRemovesOnlyTheExactLegacyAliasBeforeGuestArguments() {
        val root = kotlin.io.path.createTempDirectory("direct-default-alias").toFile()
        try {
            val same = DirectLaunch.samePathBind(root)
            val tail = listOf("/usr/bin/env", "-i", "LITERAL=$same", "/bin/sh", "-c", "echo $same")
            val argv = listOf("proot", "-b", same, "--bind", "{ROOTFS}:{ROOTFS}", "--bind=$same", "-b", "/storage:/sdcard", "-b", "/another:/another") + tail
            assertEquals(listOf("proot", "-b", "/storage:/sdcard", "-b", "/another:/another") + tail,
                DirectLaunch.prootArguments(root, argv, direct = false))
            val direct = DirectLaunch.prootArguments(root, argv, direct = true)
            assertEquals(1, direct.take(direct.indexOf("/usr/bin/env")).count { it == same })
            assertEquals(tail, direct.takeLast(tail.size))
        } finally { root.deleteRecursively() }
    }

    @Test fun priorGeneratedConfigRetainsAliasForDefaultAndIsIdempotent() {
        val root = kotlin.io.path.createTempDirectory("direct-prior-alias").toFile()
        try {
            File(root, "opt/dsh-app/direct").mkdirs()
            File(root, "opt/dsh-app/direct/config.json").writeText("{\"schema\":2}")
            val argv = listOf("proot", "-b", "/dev", "/usr/bin/env", "-i", "/bin/sh", "-c", "exit 0")
            val once = DirectLaunch.prootArguments(root, argv, direct = false)
            assertTrue(once.contains(DirectLaunch.samePathBind(root)))
            assertEquals(once, DirectLaunch.prootArguments(root, once, direct = false))
        } finally { root.deleteRecursively() }
    }

    @Test fun symlinkedGeneratedDirectoryDoesNotEnableAliasForDefault() {
        val root = kotlin.io.path.createTempDirectory("direct-config-parent-alias").toFile()
        try {
            val other = File(root, "elsewhere").apply { mkdirs() }
            File(other, "direct").mkdirs()
            File(other, "direct/config.json").writeText("{\"schema\":2}")
            File(root, "opt").mkdirs()
            java.nio.file.Files.createSymbolicLink(File(root, "opt/dsh-app").toPath(), other.toPath())
            val argv = listOf("proot", "/usr/bin/env", "-i", "/bin/sh", "-c", "exit 0")
            assertEquals(argv, DirectLaunch.prootArguments(root, argv, direct = false))
        } finally { root.deleteRecursively() }
    }

    @Test fun danglingBackingSymlinkIsIncompatibleWithoutFollowingIt() {
        val root = kotlin.io.path.createTempDirectory("direct-selection-dangling").toFile()
        try {
            File(root, "root").mkdirs()
            java.nio.file.Files.createSymbolicLink(File(root, "root/.l2s").toPath(), File(root, "missing").toPath())
            assertEquals("incompatibleFiles", DirectLaunch.compatibilityReason(root))
        } finally { root.deleteRecursively() }
    }

    @Test fun elfAuditDistinguishesStaticPieAndInterpreter() {
        val file = File.createTempFile("direct-elf", ".bin")
        try {
            val data = ByteArray(120)
            data[0] = 0x7f; data[1] = 69; data[2] = 76; data[3] = 70; data[4] = 2; data[5] = 1
            val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
            buffer.putLong(32, 64); buffer.putShort(54, 56); buffer.putShort(56, 1)
            buffer.putInt(64, 1); file.writeBytes(data)
            assertFalse(DirectLaunch.elfHasInterpreter(file))
            buffer.putInt(64, 3); file.writeBytes(data)
            assertTrue(DirectLaunch.elfHasInterpreter(file))
            file.writeText("not ELF")
            assertThrows(Exception::class.java) { DirectLaunch.elfHasInterpreter(file) }
        } finally { file.delete() }
    }

    @Test fun ownershipIncludesOrphansAndDescendantsButExcludesOtherRoots() {
        fun row(pid: Int, parent: Int = 1, argv: List<String> = listOf("sleep", "30"), marker: String? = null, cwd: String? = null) = RuntimeProcessRecord(pid, parent, "100", argv, marker, cwd)
        val rows = listOf(
            row(1, cwd = "/owned/root"), // App PID must always be excluded
            row(10, argv = listOf("/native/libproot.so", "--rootfs=/owned/root")),
            row(11, 10), row(12, 11),
            row(20, marker = "/owned/root"), // detached Node/guest
            row(21, cwd = "/owned/root/root/project"), // env-cleared orphan
            row(30, argv = listOf("/opt/node/bin/node", "dsh web")),
            row(31, marker = "/owned/root-other", cwd = "/owned/root-other/root"),
        )
        assertEquals(listOf(10, 11, 12, 20, 21), RuntimeProcessOwnership.owned(rows, setOf("/owned/root"), 1).map { it.pid })
    }

    @Test fun procStatHandlesSpaceAndRightParenthesesInComm() {
        val fields = MutableList(20) { "0" }.also { it[0] = "S"; it[1] = "321"; it[19] = "987654" }
        assertEquals(321 to "987654", RuntimeProcessOwnership.stat("123 (node ) name) " + fields.joinToString(" ")))
        assertNull(RuntimeProcessOwnership.stat("123 broken"))
    }

    @Test fun aCleanupRescanKeepsKnownOrphansButNeverReusesARecycledPid() {
        val rows = listOf(
            RuntimeProcessRecord(11, 1, "100", listOf("sleep"), null, "/sdcard"),
            RuntimeProcessRecord(12, 11, "101", listOf("sleep"), null, "/sdcard"),
            RuntimeProcessRecord(21, 1, "200", listOf("unrelated"), null, "/sdcard"),
        )
        assertEquals(listOf(11, 12), RuntimeProcessOwnership.owned(rows, setOf("/owned/root"), 1,
            known = mapOf(11 to "100", 21 to "199")).map { it.pid })
    }

    /** PerformancePolicy composes the heap/thread budget into the guest env; direct Node must get the same values. */
    @Test fun composedPerformanceBudgetReachesDirectNode() {
        val root = kotlin.io.path.createTempDirectory("direct-plan").toFile()
        try {
            File(root, "opt/dsh-go/direct").mkdirs()
            for (name in listOf("preload.mjs", "dns.mjs", "modules.mjs", "native-addons.json")) File(root, "opt/dsh-go/direct/$name").writeText("fixture")
            for (path in listOf(DirectLaunch.loaderPath("x86_64"), "opt/node/bin/node")) {
                File(root, path).apply { parentFile.mkdirs(); writeText("fixture"); assertTrue(setExecutable(true, true)) }
            }
            val elf = ByteArray(120)
            elf[0] = 0x7f; elf[1] = 69; elf[2] = 76; elf[3] = 70; elf[4] = 2; elf[5] = 1
            ByteBuffer.wrap(elf).order(ByteOrder.LITTLE_ENDIAN).putLong(32, 64).putShort(54, 56).putShort(56, 1).putInt(64, 1)
            File(root, "opt/dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg").apply { parentFile.mkdirs(); writeBytes(elf) }
            val path = root.canonicalPath
            val argv = listOf("/native/libproot.so", "--rootfs=$path", "-b", "$path:$path", "/usr/bin/env", "-i",
                "HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin", "NODE_OPTIONS=--dns-result-order=ipv4first",
                "NODE_OPTIONS=--dns-result-order=ipv4first --max-old-space-size=1536", "UV_THREADPOOL_SIZE=2",
                "/bin/sh", "-c", command)
            val plan = DirectLaunch.prepare(root, "x86_64", argv, mapOf("PROOT_TMP_DIR" to "/tmp/proot"), hostShell = "/bin/sh")
            assertEquals("--dns-result-order=ipv4first --max-old-space-size=1536", plan.environment["NODE_OPTIONS"])
            assertEquals("2", plan.environment["UV_THREADPOOL_SIZE"])
            assertTrue(plan.argv.contains("--import=$path/${DirectLaunch.PRELOAD}"))
            assertTrue(plan.environment.keys.none { it.startsWith("PROOT_") })
        } finally { root.deleteRecursively() }
    }
}
