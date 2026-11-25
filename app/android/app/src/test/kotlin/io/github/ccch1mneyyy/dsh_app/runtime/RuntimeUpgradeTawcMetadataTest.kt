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

class RuntimeUpgradeTawcMetadataTest {
    private val base = Files.createTempDirectory("upgrade-tawc-metadata-").toFile()
    private val root = File(base, "rootfs")
    private val abi = "arm64-v8a"
    private val metadata = File(root, "etc/dsh-app/runtime.json")
    private val backup = File(root, "root/runtime-info-backup.json")
    private val directories = setOf("opt/dsh", "opt/node", "opt/dsh-go", "etc/dsh-app", "usr/local/lib/node_modules/pnpm")
    private val next = info("new")

    @After fun cleanUp() { base.deleteRecursively() }

    private fun info(version: String) = JSONObject()
        .put("schema", 2).put("runtimeVersion", version).put("abi", abi).put("ubuntuVersion", "24.04.5")
        .put("upgrade", JSONObject().put("schema", 1).put("baseId", "a".repeat(64))
            .put("ubuntuVersion", "24.04.5").put("paths", JSONArray(ENGINE_PATHS)))
        .put("baseCompatibility", JSONObject().put("schema", 1)
            .put("osRelease", JSONObject().put("ID", "ubuntu").put("VERSION_ID", "24.04"))
            .put("python3Sha256", JSONObject.NULL))

    private fun write(path: String, text: String) = File(base, path).apply {
        parentFile!!.mkdirs()
        writeText(text)
    }

    private fun installed() {
        for ((tree, version) in listOf("rootfs" to "old", "staging" to "new")) {
            for (path in ENGINE_PATHS) write("$tree/$path" + if (path in directories) "/version" else "", version)
            write("$tree/etc/dsh-app/runtime.json", info(version).toString())
        }
        write("rootfs/etc/os-release", "ID=ubuntu\nVERSION_ID=\"24.04\"\n")
        write("rootfs/root/user.txt", "keep user data\n")
        write("rootfs.version", "old")
        Files.setPosixFilePermissions(metadata.toPath(), PosixFilePermissions.fromString("rw-r--r--"))
    }

    /** A successful NEW moves the regular object and leaves two opaque names. */
    private fun backUpMetadata(): File {
        val obj = File(base, "tawcroot/link/123").apply { parentFile!!.mkdirs() }
        Files.move(metadata.toPath(), obj.toPath())
        File(obj.parentFile, "123.cnt").writeText("0000000002\n")
        for (name in listOf(metadata, backup)) Files.createSymbolicLink(name.toPath(), Paths.get("tawcroot:link:123"))
        return obj
    }

    private fun activate() = activateRuntimeUpdate(base, "new", abi, next, sync = {})

    private fun rejected(reason: String) {
        val error = assertThrows(RuntimeUpgradeBlocked::class.java) { activate() }
        assertEquals("runtime_upgrade_blocked:$reason", error.message)
        assertEquals("old", File(base, "rootfs.version").readText())
        assertEquals("old", File(root, "opt/dsh/version").readText())
        assertEquals("keep user data\n", File(root, "root/user.txt").readText())
        assertTrue(File(base, "staging/etc/dsh-app/runtime.json").isFile)
        assertFalse(File(base, "engine.upgrade").exists())
        assertEquals("tawcroot:link:123", Files.readSymbolicLink(metadata.toPath()).toString())
    }

    @Test fun validTokenMetadataReachesNormalActivationAndTheBackupKeepsTheOldBytes() {
        installed()
        assertEquals(ENGINE_PATHS, checkEngineCompatibility(base, next, "new", abi).paths)
        val old = metadata.readText()
        val obj = backUpMetadata()
        assertFalse(metadata.isFile)

        activate()

        assertEquals("new", File(base, "rootfs.version").readText())
        assertEquals("new", JSONObject(metadata.readText()).getString("runtimeVersion"))
        assertFalse(Files.isSymbolicLink(metadata.toPath()))
        assertEquals("keep user data\n", File(root, "root/user.txt").readText())
        assertEquals("tawcroot:link:123", Files.readSymbolicLink(backup.toPath()).toString())
        assertEquals(old, obj.readText())
        assertEquals(old, GuestFiles.resolve(root, "/root/runtime-info-backup.json", PhoneStorage.GUEST_PATH)!!.readText())
        assertEquals("0000000002\n", File(obj.parentFile, "123.cnt").readText())
    }

    @Test fun missingOrMalformedTokenObjectsStillBlockBeforeAnyActivation() {
        installed()
        val obj = backUpMetadata()
        obj.writeText("{")
        rejected("manifest")
        assertEquals("{", obj.readText())
        Files.delete(obj.toPath())
        rejected("manifest")
        assertTrue(Files.isSymbolicLink(backup.toPath()))
    }

    @Test fun resolvingTheOldMetadataDoesNotRelaxAbiOrBaseCompatibility() {
        installed()
        val obj = backUpMetadata()
        obj.writeText(info("old").put("abi", "x86_64").toString())
        rejected("base")
        val changedBase = info("old").apply { getJSONObject("upgrade").put("baseId", "b".repeat(64)) }
        obj.writeText(changedBase.toString())
        rejected("base")
        assertEquals(changedBase.toString(), obj.readText())
    }
}
