package io.github.ccch1mneyyy.dsh_app.runtime

import io.github.ccch1mneyyy.dsh_app.files.GuestFiles
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.attribute.PosixFilePermissions
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class RuntimeUpgradeTawcOsReleaseTest {
    private val base = Files.createTempDirectory("upgrade-tawc-os-release-").toFile()
    private val root = File(base, "rootfs")
    private val abi = "arm64-v8a"
    private val release = "ID=ubuntu\nVERSION_ID=\"24.04\"\n"
    private val alias = File(root, "etc/os-release")
    private val source = File(root, "usr/lib/os-release")
    private val backup = File(root, "root/os-release-backup")
    private val directories = setOf("opt/dsh", "opt/node", "opt/dsh-go", "etc/dsh-app", "usr/local/lib/node_modules/pnpm")

    @After fun cleanUp() { base.deleteRecursively() }

    private fun info(version: String, layered: Boolean) = JSONObject()
        .put("runtimeVersion", version).put("abi", abi).put("ubuntuVersion", "24.04.5")
        .put("upgrade", JSONObject().put("schema", 1).put("baseId", "a".repeat(64))
            .put("ubuntuVersion", "24.04.5").put("paths", JSONArray(ENGINE_PATHS)))
        .apply {
            if (layered) put("schema", 2).put("baseCompatibility", JSONObject().put("schema", 1)
                .put("osRelease", JSONObject().put("ID", "ubuntu").put("VERSION_ID", "24.04"))
                .put("python3Sha256", JSONObject.NULL))
        }

    private fun write(path: String, text: String) = File(base, path).apply {
        parentFile!!.mkdirs()
        writeText(text)
    }

    private fun installed(layered: Boolean): JSONObject {
        val next = info("new", layered)
        for ((tree, version) in listOf("rootfs" to "old", "staging" to "new")) {
            for (path in ENGINE_PATHS) write("$tree/$path" + if (path in directories) "/version" else "", version)
            write("$tree/etc/dsh-app/runtime.json", info(version, layered).toString())
        }
        write("rootfs/usr/lib/os-release", release)
        Files.setPosixFilePermissions(source.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
        Files.createSymbolicLink(alias.toPath(), Paths.get("../usr/lib/os-release"))
        if (!layered) {
            write("staging/usr/lib/os-release", release)
            Files.createSymbolicLink(File(base, "staging/etc/os-release").toPath(), Paths.get("../usr/lib/os-release"))
        }
        write("rootfs/root/user.txt", "keep user data\n")
        write("rootfs.version", "old")
        return next
    }

    /** Successful NEW: move the inode into the store and leave two opaque names. */
    private fun backUp(file: File, copy: File, token: String): File {
        val obj = File(base, "tawcroot/link/$token").apply { parentFile!!.mkdirs() }
        Files.move(file.toPath(), obj.toPath())
        File(obj.parentFile, "$token.cnt").writeText("0000000002\n")
        for (name in listOf(file, copy)) Files.createSymbolicLink(name.toPath(), Paths.get(TawcrootLinks.PREFIX + token))
        return obj
    }

    private fun activate(next: JSONObject) = activateRuntimeUpdate(base, "new", abi, next, sync = {})

    private fun rejected(next: JSONObject) {
        val error = assertThrows(RuntimeUpgradeBlocked::class.java) { activate(next) }
        assertEquals("runtime_upgrade_blocked:base", error.message)
        assertEquals("old", File(base, "rootfs.version").readText())
        assertEquals("old", File(root, "opt/dsh/version").readText())
        assertEquals("keep user data\n", File(root, "root/user.txt").readText())
        assertTrue(File(base, "staging/etc/dsh-app/runtime.json").isFile)
        assertFalse(File(base, "engine.upgrade").exists())
    }

    @Test fun anUnchangedTokenBackedTargetAllowsFullAndLayeredEngineUpgrades() {
        for (layered in listOf(false, true)) {
            base.deleteRecursively(); base.mkdirs()
            val next = installed(layered)
            assertEquals(ENGINE_PATHS, checkEngineCompatibility(base, next, "new", abi).paths)
            val obj = backUp(source, backup, "123")
            assertFalse(alias.isFile)

            activate(next)

            assertEquals("new", File(base, "rootfs.version").readText())
            assertEquals("new", File(root, "opt/dsh/version").readText())
            assertEquals("keep user data\n", File(root, "root/user.txt").readText())
            assertEquals("../usr/lib/os-release", Files.readSymbolicLink(alias.toPath()).toString())
            for (name in listOf(source, backup)) {
                assertEquals(TawcrootLinks.PREFIX + "123", Files.readSymbolicLink(name.toPath()).toString())
            }
            assertEquals(release, obj.readText())
            assertEquals(release, GuestFiles.resolve(root, "/etc/os-release", PhoneStorage.GUEST_PATH)!!.readText())
            assertEquals("0000000002\n", File(obj.parentFile, "123.cnt").readText())
        }
    }

    @Test fun aTokenBackedOsReleaseSymlinkStillResolvesFromItsOriginalParent() {
        val next = installed(layered = true)
        val copy = File(root, "etc/os-release.backup")
        val obj = backUp(alias, copy, "456")
        assertFalse(alias.isFile)

        activate(next)

        assertEquals("new", File(base, "rootfs.version").readText())
        assertEquals("../usr/lib/os-release", Files.readSymbolicLink(obj.toPath()).toString())
        for (name in listOf(alias, copy)) {
            assertEquals(TawcrootLinks.PREFIX + "456", Files.readSymbolicLink(name.toPath()).toString())
        }
        assertEquals(release, source.readText())
        assertEquals(release, GuestFiles.resolve(root, "/etc/os-release.backup", PhoneStorage.GUEST_PATH)!!.readText())
    }

    @Test fun changedMalformedOrMissingTokenIdentityStillBlocksBeforeActivation() {
        val next = installed(layered = true)
        val obj = backUp(source, backup, "123")
        for (text in listOf("ID=ubuntu\nVERSION_ID=26.04\n", "ID=debian\nVERSION_ID=24.04\n",
            "ID=ubuntu\nID=ubuntu\nVERSION_ID=24.04\n")) {
            obj.writeText(text)
            rejected(next)
            assertEquals(text, obj.readText())
        }
        Files.delete(obj.toPath())
        rejected(next)
        assertEquals("../usr/lib/os-release", Files.readSymbolicLink(alias.toPath()).toString())
        assertEquals(TawcrootLinks.PREFIX + "123", Files.readSymbolicLink(backup.toPath()).toString())
    }
}
