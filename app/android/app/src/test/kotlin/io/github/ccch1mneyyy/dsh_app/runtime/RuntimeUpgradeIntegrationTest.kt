package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class RuntimeUpgradeIntegrationTest {
    private val base = Files.createTempDirectory("runtime-update-route").toFile()
    private fun write(path: String, value: String) = File(base, path).apply { parentFile!!.mkdirs(); writeText(value) }
    private fun info(version: String, layered: Boolean = true, id: String = "a".repeat(64)) = JSONObject()
        .put("runtimeVersion", version).put("abi", "arm64-v8a").put("ubuntuVersion", "24.04.5")
        .apply {
            if (layered) put("upgrade", JSONObject().put("schema", 1).put("baseId", id)
                .put("ubuntuVersion", "24.04.5").put("paths", JSONArray(ENGINE_PATHS)))
        }
    private val next = info("new")

    @After fun cleanup() { base.deleteRecursively() }

    private fun stage() {
        for (path in ENGINE_PATHS) write("staging/$path" + if (path in setOf("opt/dsh", "opt/node", "opt/dsh-go",
            "etc/dsh-app", "usr/local/lib/node_modules/pnpm")) "/version" else "", "new engine")
        write("staging/etc/dsh-app/runtime.json", next.toString())
        write("staging/etc/os-release", "ID=ubuntu\nVERSION_ID=24.04\n")
        write("staging/opt/python/bin/python3", "python")
        write("staging/usr/bin/gh", "factory gh (must not replace the user copy)")
        write("staging/var/lib/dpkg/status", "factory package database")
    }

    private fun installed(layered: Boolean) {
        write("rootfs/etc/dsh-app/runtime.json", info("old", layered).toString())
        write("rootfs/etc/os-release", "ID=ubuntu\nVERSION_ID=24.04\n")
        write("rootfs/opt/python/bin/python3", "python")
        write("rootfs/opt/python/lib/site-packages/user.py", "user pip package")
        write("rootfs/usr/bin/gh", "user gh")
        write("rootfs/var/lib/dpkg/status", "user package database")
        write("rootfs/usr/local/lib/node_modules/user/index.js", "user npm package")
        write("rootfs/root/workspace/project", "user work")
        write("rootfs.version", "old")
    }

    private fun activate(keep: File? = null, dropKept: Boolean = false) =
        activateRuntimeUpdate(base, "new", "arm64-v8a", next, keep, dropKept, sync = {})

    @Test fun productionRouteKeepsTheEntireUserSystemForLegacyAndLayeredUpgrades() {
        for (layered in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs()
            installed(layered); stage()
            // A legacy swap can be killed during retired-tree cleanup, after its ready marker.
            write("rootfs.old/usr/bin/retired-tool", "retired user tool")
            activate()
            assertEquals("user gh", File(base, "rootfs/usr/bin/gh").readText())
            assertEquals("user package database", File(base, "rootfs/var/lib/dpkg/status").readText())
            assertEquals("user npm package", File(base, "rootfs/usr/local/lib/node_modules/user/index.js").readText())
            assertEquals("user pip package", File(base, "rootfs/opt/python/lib/site-packages/user.py").readText())
            assertEquals("user work", File(base, "rootfs/root/workspace/project").readText())
            assertEquals("new engine", File(base, "rootfs/opt/dsh/version").readText())
            assertEquals("new", File(base, "rootfs.version").readText())
            assertFalse(File(base, "rootfs.old").exists())
            assertFalse(File(base, "staging").exists())
        }
    }

    @Test fun incompleteLegacySwapStillBlocksBeforeChangingAnyTree() {
        for (state in listOf("missing-marker", "empty-marker", "torn-marker", "different-marker", "carry", "missing-root")) {
            base.deleteRecursively(); base.mkdirs()
            installed(false); stage()
            val retired = write("rootfs.old/usr/bin/retired-tool", "retired user tool")
            val marker = File(base, "rootfs.version")
            when (state) {
                "missing-marker" -> assertTrue(marker.delete())
                "empty-marker" -> marker.writeText("")
                "torn-marker" -> marker.writeText("ol")
                "different-marker" -> marker.writeText("older")
                "carry" -> write("home.carry/workspace/project", "carried user work")
                "missing-root" -> assertTrue(File(base, "rootfs").deleteRecursively())
            }
            val before = if (marker.exists()) marker.readText() else null
            val error = assertThrows(RuntimeUpgradeBlocked::class.java) { activate() }
            assertEquals(state, "runtime_upgrade_blocked:legacy_interrupted", error.message)
            assertEquals(state, before, if (marker.exists()) marker.readText() else null)
            assertEquals("retired user tool", retired.readText())
            assertTrue(File(base, "staging/opt/dsh/version").isFile)
            assertFalse(File(base, "engine.upgrade").exists())
            if (state == "missing-root") assertFalse(File(base, "rootfs").exists())
            else assertEquals("user work", File(base, "rootfs/root/workspace/project").readText())
            if (state == "carry") {
                assertEquals("carried user work", File(base, "home.carry/workspace/project").readText())
            }
        }
    }

    @Test fun productionRouteDoesNotReinstallAnIncompatibleOrUnidentifiedExistingSystem() {
        installed(true); stage()
        write("rootfs/etc/dsh-app/runtime.json", info("old", id = "b".repeat(64)).toString())
        assertThrows(RuntimeUpgradeBlocked::class.java) { activate() }
        assertEquals("user gh", File(base, "rootfs/usr/bin/gh").readText())
        assertEquals("old", File(base, "rootfs.version").readText())
        File(base, "rootfs/etc/dsh-app/runtime.json").delete()
        assertThrows(RuntimeUpgradeBlocked::class.java) { activate() }
        assertEquals("user package database", File(base, "rootfs/var/lib/dpkg/status").readText())
    }

    @Test fun onlyFirstInstallActivatesTheBundledSystem() {
        stage(); activate()
        assertEquals("factory gh (must not replace the user copy)", File(base, "rootfs/usr/bin/gh").readText())
        assertEquals("factory package database", File(base, "rootfs/var/lib/dpkg/status").readText())
        assertEquals("new", File(base, "rootfs.version").readText())
    }

    @Test fun anUnmarkedPublishedRootFinishesWithoutAnotherStagingTree() {
        for (layered in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs()
            if (layered) next.put("schema", 2).put("baseCompatibility", layerDescriptor())
            stage()
            write("kept/root/.dsh/dsh-go/ui.json", "saved ui")
            val keep = File(base, "kept")
            val failure = IOException("first install interrupted at data barrier")
            assertSame(failure, assertThrows(IOException::class.java) {
                activateRuntimeUpdate(base, "new", "arm64-v8a", next, keep, sync = { throw failure })
            })
            val marker = File(base, "rootfs.version")
            val root = File(base, "rootfs")
            val engine = File(root, "opt/dsh/version")
            val rootInode = Files.getAttribute(root.toPath(), "unix:ino")
            val engineInode = Files.getAttribute(engine.toPath(), "unix:ino")
            assertFalse(Files.exists(marker.toPath(), NOFOLLOW_LINKS))
            assertFalse(File(base, "staging").exists())
            EngineUpgrade(base, sync = {}).recover()
            var barriers = 0
            assertTrue(resumeRootfsInstall(base, "new", "arm64-v8a", next, keep, sync = {
                barriers++
                assertFalse(Files.exists(marker.toPath(), NOFOLLOW_LINKS))
                assertEquals("saved ui", File(root, "root/.dsh/dsh-go/ui.json").readText())
            }))
            assertEquals(1, barriers)
            assertEquals("new", marker.readText())
            assertEquals(rootInode, Files.getAttribute(root.toPath(), "unix:ino"))
            assertEquals(engineInode, Files.getAttribute(engine.toPath(), "unix:ino"))
            assertEquals("new engine", engine.readText())
            assertFalse(keep.exists())
            assertFalse(File(base, "staging").exists())
        }
    }

    @Test fun resumingAnUnfinishedResetKeepsRestoredItemsAndPropagatesFailures() {
        stage()
        write("staging/root/.agents", "blocked parent")
        write("kept/root/.dsh/dsh-go/ui.json", "saved ui")
        write("kept/root/.agents/skills/mine/SKILL.md", "saved skill")
        val keep = File(base, "kept")
        val marker = File(base, "rootfs.version")
        assertThrows(KeepFailed::class.java) { activate(keep) }
        EngineUpgrade(base, sync = {}).recover()
        assertThrows(KeepFailed::class.java) {
            resumeRootfsInstall(base, "new", "arm64-v8a", next, keep, sync = { fail("data barrier reached") })
        }
        assertFalse(Files.exists(marker.toPath(), NOFOLLOW_LINKS))
        assertEquals("saved ui", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
        assertEquals("saved skill", File(keep, "root/.agents/skills/mine/SKILL.md").readText())
        assertTrue(File(base, "rootfs/root/.agents").delete())
        val failure = IOException("retry data barrier")
        assertSame(failure, assertThrows(IOException::class.java) {
            resumeRootfsInstall(base, "new", "arm64-v8a", next, keep, sync = { throw failure })
        })
        assertFalse(Files.exists(marker.toPath(), NOFOLLOW_LINKS))
        assertTrue(resumeRootfsInstall(base, "new", "arm64-v8a", next, keep, sync = {}))
        assertEquals("saved ui", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
        assertEquals("saved skill", File(base, "rootfs/root/.agents/skills/mine/SKILL.md").readText())
        assertEquals("new", marker.readText())
        assertFalse(keep.exists())
    }

    @Test fun existingMarkersKeepSameVersionRepairsOnTheNormalInstallRoute() {
        stage(); activate()
        val marker = File(base, "rootfs.version")
        // A launch error can require reinstalling this engine even with matching metadata.
        assertTrue(File(base, "rootfs/opt/dsh/version").delete())
        for (record in listOf("new", "", "ne", "old")) {
            marker.writeText(record)
            assertFalse(resumeRootfsInstall(base, "new", "arm64-v8a", next,
                sync = { fail("must keep the normal install route") }))
            assertEquals(record, marker.readText())
            assertFalse(File(base, "rootfs/opt/dsh/version").exists())
        }
    }

    @Test fun anUnmarkedTreeFromAnotherApkIsNotCommittedAsTheCurrentPayload() {
        stage()
        val previous = info("previous")
        write("staging/etc/dsh-app/runtime.json", previous.toString())
        assertThrows(IOException::class.java) {
            activateRuntimeUpdate(base, "previous", "arm64-v8a", previous, sync = { throw IOException("kill") })
        }
        EngineUpgrade(base, sync = {}).recover()
        val before = File(base, "rootfs/etc/dsh-app/runtime.json").readText()
        assertFalse(resumeRootfsInstall(base, "new", "arm64-v8a", next,
            sync = { fail("different payload must still be installed") }))
        assertEquals(before, File(base, "rootfs/etc/dsh-app/runtime.json").readText())
        assertFalse(Files.exists(File(base, "rootfs.version").toPath(), NOFOLLOW_LINKS))
    }

    @Test fun aMatchingPublishedTreeDoesNotBypassAnInterruptedLegacySwap() {
        installed(true); stage()
        assertThrows(IOException::class.java) {
            activateRootfs(base, "new", sync = { throw IOException("kill") })
        }
        EngineUpgrade(base, sync = {}).recover()
        assertFalse(resumeRootfsInstall(base, "new", "arm64-v8a", next,
            sync = { fail("legacy swap must remain blocked") }))
        assertEquals("new", JSONObject(File(base, "rootfs/etc/dsh-app/runtime.json").readText()).getString("runtimeVersion"))
        assertEquals("user gh", File(base, "rootfs.old/usr/bin/gh").readText())
        assertEquals("user work", File(base, "rootfs/root/workspace/project").readText())
        assertFalse(Files.exists(File(base, "rootfs.version").toPath(), NOFOLLOW_LINKS))
    }

    @Test fun unfinishedResetRestoreIsRetriedBeforeCommittingTheReadyMarker() {
        for (layered in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs()
            if (layered) next.put("schema", 2).put("baseCompatibility", layerDescriptor())
            stage()
            write("staging/root/.agents", "blocked parent")
            write("kept/root/.dsh/dsh-go/ui.json", "saved ui")
            write("kept/root/.agents/skills/mine/SKILL.md", "saved skill")
            val keep = File(base, "kept")
            assertThrows(KeepFailed::class.java) { activate(keep) }
            assertFalse(File(base, "rootfs.version").exists())
            assertEquals("saved ui", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())

            // The next install sees rootfs already present, so it takes the engine route.
            stage()
            assertThrows(KeepFailed::class.java) { activate(keep) }
            assertFalse(File(base, "rootfs.version").exists())
            assertFalse(File(base, "engine.upgrade").exists())
            assertEquals("saved skill", File(keep, "root/.agents/skills/mine/SKILL.md").readText())

            assertTrue(File(base, "rootfs/root/.agents").delete())
            activate(keep)
            assertEquals("saved skill", File(base, "rootfs/root/.agents/skills/mine/SKILL.md").readText())
            assertEquals("saved ui", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
            assertFalse(keep.exists())
            assertEquals("new", File(base, "rootfs.version").readText())
        }
    }

    @Test fun unfinishedResetRestoreHonorsExplicitDropOnRetry() {
        stage()
        write("staging/root/.agents", "blocked parent")
        write("kept/root/.agents/skills/mine/SKILL.md", "saved skill")
        val keep = File(base, "kept")
        assertThrows(KeepFailed::class.java) { activate(keep) }
        stage()
        activate(keep, dropKept = true)
        assertFalse(keep.exists())
        assertEquals("blocked parent", File(base, "rootfs/root/.agents").readText())
        assertEquals("new", File(base, "rootfs.version").readText())
    }

    @Test fun staleKeptFilesDoNotOverwriteAPreviouslyReadyUserSystem() {
        installed(true); stage()
        write("kept/root/.dsh/dsh-go/ui.json", "older saved ui")
        write("rootfs/root/.dsh/dsh-go/ui.json", "edited after the system was ready")
        val keep = File(base, "kept")
        activate(keep)
        assertEquals("edited after the system was ready", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
        assertEquals("older saved ui", File(keep, "root/.dsh/dsh-go/ui.json").readText())
        assertEquals("new", File(base, "rootfs.version").readText())
    }

    private fun layerDescriptor() = JSONObject().put("schema", 1)
        .put("osRelease", JSONObject().put("ID", "ubuntu").put("VERSION_ID", "24.04"))
        .put("python3Sha256", MessageDigest.getInstance("SHA-256").digest("python".toByteArray())
            .joinToString("") { "%02x".format(it) })

    @Test fun engineOnlyStagingUsesTheSameTransactionForOldAndNewRuntimeMetadata() {
        for (hasUpgrade in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs()
            installed(hasUpgrade)
            next.put("schema", 2).put("baseCompatibility", layerDescriptor())
            stage()
            for (path in listOf("etc/os-release", "opt/python", "usr/bin/gh", "var/lib/dpkg")) {
                File(base, "staging/$path").deleteRecursively()
            }
            activate()
            assertEquals("new engine", File(base, "rootfs/opt/dsh/version").readText())
            assertEquals("user gh", File(base, "rootfs/usr/bin/gh").readText())
            assertEquals("user package database", File(base, "rootfs/var/lib/dpkg/status").readText())
            assertEquals("user npm package", File(base, "rootfs/usr/local/lib/node_modules/user/index.js").readText())
            assertEquals("user pip package", File(base, "rootfs/opt/python/lib/site-packages/user.py").readText())
            assertEquals("user work", File(base, "rootfs/root/workspace/project").readText())
            assertEquals("new", File(base, "rootfs.version").readText())
            assertFalse(File(base, "staging").exists())
        }
    }

    @Test fun mergedLayersActivateOnlyWhenTheDeclaredBaseMatchesTheirPayload() {
        next.put("schema", 2).put("baseCompatibility", layerDescriptor())
        stage()
        write("staging/opt/python/bin/python3", "mismatched base")
        assertThrows(RuntimeUpgradeBlocked::class.java) { activate() }
        assertFalse(File(base, "rootfs").exists())
        assertFalse(File(base, "rootfs.version").exists())
        write("staging/opt/python/bin/python3", "python")
        activate()
        assertEquals("factory package database", File(base, "rootfs/var/lib/dpkg/status").readText())
        assertEquals("new", File(base, "rootfs.version").readText())
    }
}
