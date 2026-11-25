package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Actual rootfs activation, including the retry states; no copied swap algorithm. */
class DirectUpgradeAliasTest {
    private val base = Files.createTempDirectory("direct-upgrade").toFile()
    private val root = File(base, "rootfs")
    private val args = listOf("proot", "/usr/bin/env", "-i", "/bin/sh", "-c", "exit 0")
    private val markerName = ".dsh-go-direct-path-alias"

    @After fun cleanup() { base.deleteRecursively() }

    private fun installed(direct: Boolean = true) {
        File(root, "root/workspace").mkdirs()
        File(root, "root/workspace/keep.txt").writeText("user bytes\n")
        if (direct) {
            File(root, "opt/dsh-app/direct").mkdirs()
            File(root, "opt/dsh-app/direct/config.json").writeText("{\"schema\":2}")
        }
    }

    private fun stageAndActivate(version: String = "r4") {
        File(base, "staging/root").mkdirs()
        File(base, "staging/etc").mkdirs()
        File(base, "staging/etc/version").writeText(version)
        activateRootfs(base, version, sync = {})
        assertEquals("user bytes\n", File(root, "root/workspace/keep.txt").readText())
        assertFalse(File(root, "opt/dsh-app/direct/config.json").exists())
    }

    private fun hasAlias() = DirectLaunch.prootArguments(root, args, direct = false).contains(DirectLaunch.samePathBind(root))

    @Test fun oldR3ConfigKeepsPhysicalAliasesAcrossActualUpgrade() {
        installed()
        assertTrue(hasAlias())
        stageAndActivate()
        assertTrue("upgrade lost a previously available physical session path", hasAlias())
    }

    @Test fun neverDirectDefaultUpgradeDoesNotAddAnAliasOrMarker() {
        installed(direct = false)
        stageAndActivate()
        assertFalse(hasAlias())
        assertFalse(File(root, "root/$markerName").exists())
    }

    @Test fun alreadyCarriedHomeStillGetsLegacyConfigEvidenceBeforeSwap() {
        installed()
        assertTrue(File(root, "root").renameTo(File(base, "home.carry")))
        stageAndActivate()
        assertTrue("carry retry lost the old direct configuration", hasAlias())
    }

    @Test fun alreadyRetiredRootAndCarriedHomeStillRetainTheOriginalRuntimeIdentity() {
        installed()
        assertTrue(File(root, "root").renameTo(File(base, "home.carry")))
        assertTrue(root.renameTo(File(base, "rootfs.old")))
        stageAndActivate()
        assertTrue("retired-root retry lost the old direct configuration", hasAlias())
    }

    @Test fun aSecondUpgradeRetainsTheMarkerWithoutTheOldGeneratedConfig() {
        installed()
        stageAndActivate()
        stageAndActivate("r5")
        assertTrue("a later archive replacement forgot the previous direct use", hasAlias())
    }

    @Test fun aSymlinkConfigDoesNotCreateAnUpgradeMarker() {
        installed(direct = false)
        val config = File(root, "opt/dsh-app/direct/config.json")
        config.parentFile.mkdirs()
        val unrelated = File(base, "unrelated.json").apply { writeText("{}") }
        Files.createSymbolicLink(config.toPath(), unrelated.toPath())
        stageAndActivate()
        assertFalse(hasAlias())
        assertFalse(File(root, "root/$markerName").exists())
        assertEquals("{}", unrelated.readText())
    }

    @Test fun aMarkerForADifferentRootDoesNotEnableThePhysicalAlias() {
        installed(direct = false)
        File(root, "root/$markerName").writeText("v1\n/another/rootfs\n")
        assertFalse(hasAlias())
        stageAndActivate()
        assertFalse(hasAlias())
    }
}
