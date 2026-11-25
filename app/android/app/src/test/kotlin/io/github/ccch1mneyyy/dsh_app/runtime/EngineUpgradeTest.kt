package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class EngineUpgradeTest {
    private val base = Files.createTempDirectory("engine-upgrade").toFile()
    private val spec = EngineUpgradeSpec("a".repeat(64), "24.04.5", ENGINE_PATHS)
    private val directories = setOf("opt/dsh", "opt/node", "opt/dsh-go", "etc/dsh-app", "usr/local/lib/node_modules/pnpm")
    private val users = listOf("usr/bin/gh", "usr/local/bin/custom", "var/lib/dpkg/status", "etc/apt/sources.list",
        "usr/local/lib/node_modules/custom/index.js", "opt/python/lib/site-packages/custom.py", "root/.config/gh/config.yml")

    @After fun cleanup() { base.deleteRecursively() }

    private fun write(path: String, text: String = path): File = File(base, path).apply {
        parentFile!!.mkdirs(); writeText(text)
    }

    private fun entry(tree: String, path: String): File = File(base, "$tree/$path" + if (path in directories) "/version" else "")

    private fun stage() {
        for (path in ENGINE_PATHS) entry("staging", path).apply { parentFile!!.mkdirs(); writeText("new") }
    }

    private fun installed() {
        for (path in ENGINE_PATHS) entry("rootfs", path).apply { parentFile!!.mkdirs(); writeText("old") }
        for (path in users) write("rootfs/$path", "user:$path")
        write("rootfs.version", "old")
        stage()
    }

    private fun assertUsers() {
        for (path in users) assertEquals(path, "user:$path", File(base, "rootfs/$path").readText())
    }

    private fun assertCurrent() {
        assertUsers()
        assertEquals("new", File(base, "rootfs.version").readText())
        for (path in ENGINE_PATHS) assertEquals(path, "new", entry("rootfs", path).readText())
        assertFalse(File(base, "engine.upgrade").exists())
    }

    @Test fun upgradesOnlyAppOwnedPathsAndKeepsPackageDatabasesToolsAndModes() {
        installed()
        val gh = File(base, "rootfs/usr/bin/gh")
        gh.setExecutable(true)
        val inode = Files.getAttribute(gh.toPath(), "unix:ino")
        val link = File(base, "rootfs/usr/local/bin/gh")
        Files.createSymbolicLink(link.toPath(), java.nio.file.Path.of("../../bin/gh"))
        EngineUpgrade(base, sync = {}).activate("new", spec)
        assertCurrent()
        assertTrue(gh.canExecute())
        assertEquals(inode, Files.getAttribute(gh.toPath(), "unix:ino"))
        assertEquals("../../bin/gh", Files.readSymbolicLink(link.toPath()).toString())
    }

    @Test fun publishedTransactionsResumeAtEveryMutationAndBeforeAndAfterTheReadyMarker() {
        val steps = listOf("journal", "retired", "data", "marker", "committed") +
            ENGINE_PATHS.flatMap { listOf("backup:$it", "activate:$it") }
        for (step in steps) {
            base.deleteRecursively(); base.mkdirs(); installed()
            var hit = false
            val transaction = EngineUpgrade(base, sync = {}, afterStep = {
                if (!hit && it == step) { hit = true; throw IOException("simulated kill") }
            })
            assertThrows(IOException::class.java) { transaction.activate("new", spec) }
            assertTrue("step not exercised: $step", hit)
            // install() discards staging on every retry. The durable payload must
            // be sufficient without either the old APK asset or staging.
            File(base, "staging").deleteRecursively()
            EngineUpgrade(base, sync = {}).recover()
            assertCurrent()
        }
    }

    @Test fun unpublishedPreparationCanBeDiscardedWithoutTouchingTheInstalledSystem() {
        installed()
        assertThrows(IOException::class.java) {
            EngineUpgrade(base, sync = {}, afterStep = { if (it == "prepared") throw IOException("kill") })
                .activate("new", spec)
        }
        EngineUpgrade(base, sync = {}).recover()
        assertEquals("old", File(base, "rootfs.version").readText())
        for (path in ENGINE_PATHS) assertEquals("old", entry("rootfs", path).readText())
        assertUsers()
        stage()
        EngineUpgrade(base, sync = {}).activate("new", spec)
        assertCurrent()
    }

    @Test fun committedCleanupRemovesInterruptedOldPayloadWithoutFollowingLinks() {
        for (partial in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs(); installed()
            assertThrows(IOException::class.java) {
                EngineUpgrade(base, sync = {}, afterStep = { if (it == "committed") throw IOException("kill") })
                    .activate("new", spec)
            }
            assertCurrent()
            val done = File(base, "engine.done")
            for (path in ENGINE_PATHS) assertEquals("old", entry("engine.done/old", path).readText())
            if (partial) assertTrue(File(done, "old/opt/node").deleteRecursively())
            val user = File(base, "rootfs/usr/bin/gh")
            Files.createSymbolicLink(File(done, "old/user-link").toPath(), user.toPath())
            val transaction = EngineUpgrade(base, sync = {})
            assertFalse(transaction.isPending())
            transaction.cleanupCommitted()
            assertFalse(done.exists())
            assertCurrent()
            transaction.cleanupCommitted()
            assertCurrent()
        }
    }

    @Test fun committedCleanupLeavesUnfinishedTransactionsForTheInstaller() {
        for (step in listOf("prepared", "journal", "marker")) {
            base.deleteRecursively(); base.mkdirs(); installed()
            assertThrows(IOException::class.java) {
                EngineUpgrade(base, sync = {}, afterStep = { if (it == step) throw IOException("kill") })
                    .activate("new", spec)
            }
            val transaction = File(base, if (step == "prepared") "engine.prepare" else "engine.upgrade")
            val version = File(base, "rootfs.version").readText()
            val original = File(transaction, "original").readText()
            val payload = entry(if (step == "marker") "rootfs" else "${transaction.name}/new", "opt/dsh")
            EngineUpgrade(base, sync = {}).cleanupCommitted()
            assertTrue(transaction.isDirectory)
            assertEquals(version, File(base, "rootfs.version").readText())
            assertEquals(original, File(transaction, "original").readText())
            assertEquals("new", payload.readText())
            assertUsers()
        }
    }

    @Test fun failedDataSyncLeavesNoReadyMarkerAndTheRetryFinishes() {
        installed()
        var barriers = 0
        assertThrows(IOException::class.java) {
            EngineUpgrade(base, sync = { if (++barriers == 2) throw IOException("data sync") }).activate("new", spec)
        }
        assertFalse(File(base, "rootfs.version").exists())
        assertUsers()
        EngineUpgrade(base, sync = {}).recover()
        assertCurrent()
    }

    @Test fun missingPayloadIsRejectedBeforeRetiringTheInstalledVersion() {
        installed()
        entry("staging", "usr/local/bin/dsh").delete()
        assertThrows(RuntimeUpgradeBlocked::class.java) { EngineUpgrade(base, sync = {}).activate("new", spec) }
        assertEquals("old", File(base, "rootfs.version").readText())
        for (path in ENGINE_PATHS) assertEquals("old", entry("rootfs", path).readText())
        assertUsers()
    }

    @Test fun symlinkedParentsCannotRedirectAnUpgradeAndLeafLinksAreNotFollowed() {
        installed()
        val outside = File(base, "outside").apply { mkdirs() }
        File(base, "rootfs/etc").deleteRecursively()
        Files.createSymbolicLink(File(base, "rootfs/etc").toPath(), outside.toPath())
        assertThrows(RuntimeUpgradeBlocked::class.java) { EngineUpgrade(base, sync = {}).activate("new", spec) }
        assertTrue(outside.list()!!.isEmpty())
        assertEquals("old", File(base, "rootfs.version").readText())
    }

    @Test fun missingOldAliasesCanBeAddedWithoutDroppingOtherGlobalPackages() {
        installed()
        entry("rootfs", "usr/local/bin/pnx").delete()
        val dsh = entry("staging", "usr/local/bin/dsh")
        dsh.delete()
        Files.createSymbolicLink(dsh.toPath(), java.nio.file.Path.of("../../../opt/dsh/cli"))
        EngineUpgrade(base, sync = {}).activate("new", spec)
        assertUsers()
        assertEquals("../../../opt/dsh/cli", Files.readSymbolicLink(entry("rootfs", "usr/local/bin/dsh").toPath()).toString())
        assertEquals("new", entry("rootfs", "usr/local/bin/pnx").readText())
    }

    @Test fun everyDirectorySyncFailureCanBeRetriedWithoutLosingEitherSystemOrPayload() {
        installed()
        var calls = 0
        EngineUpgrade(base, sync = {}, syncDirectory = { calls++ }).activate("new", spec)
        for (failureAt in 1..calls) {
            base.deleteRecursively(); base.mkdirs(); installed()
            var observed = 0
            assertThrows(IOException::class.java) {
                EngineUpgrade(base, sync = {}, syncDirectory = {
                    if (++observed == failureAt) throw IOException("directory sync")
                }).activate("new", spec)
            }
            assertUsers()
            EngineUpgrade(base, sync = {}).recover()
            if (File(base, "rootfs.version").readText() == "old") {
                stage()
                EngineUpgrade(base, sync = {}).activate("new", spec)
            }
            assertCurrent()
        }
    }

    @Test fun missingPayloadCannotMakeAnOldEntryLookLikeACompletedUpgrade() {
        installed()
        assertThrows(IOException::class.java) {
            EngineUpgrade(base, sync = {}, afterStep = { if (it == "journal") throw IOException("kill") })
                .activate("new", spec)
        }
        File(base, "engine.upgrade/new/usr/local/bin/dsh").delete()
        assertThrows(RuntimeUpgradeBlocked::class.java) { EngineUpgrade(base, sync = {}).recover() }
        assertFalse(File(base, "rootfs.version").exists())
        assertEquals("old", entry("rootfs", "usr/local/bin/dsh").readText())
        assertUsers()
    }

    @Test fun unknownOrOverbroadManifestsCannotTakeOwnershipOfUserFiles() {
        installed()
        for (paths in listOf(listOf("usr"), ENGINE_PATHS + "root", ENGINE_PATHS + "../outside")) {
            assertThrows(RuntimeUpgradeBlocked::class.java) {
                EngineUpgrade(base, sync = {}).activate("new", spec.copy(paths = paths))
            }
        }
        assertUsers()
        assertEquals("old", File(base, "rootfs.version").readText())
    }
}
