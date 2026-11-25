package io.github.ccch1mneyyy.dsh_app.runtime

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RuntimeManifestTest {
    private fun metadata() = JSONObject().put("runtimeVersion", "new").put("abi", "arm64-v8a")
        .put("launch", JSONObject().put("argv", org.json.JSONArray(listOf("proot", "-r", "{rootfs}")))
            .put("env", JSONObject().put("HOME", "/root")))

    private fun layer(name: String, bytes: Long, unpacked: Long) = JSONObject()
        .put("asset", "$name-arm64-v8a.tar.xz").put("bytes", bytes)
        .put("sha256", "a".repeat(64)).put("uncompressedBytes", unpacked)
        .put("tarBytes", unpacked + 1024).put("tarSha256", "b".repeat(64))

    private fun layered() = metadata().put("schema", 2).put("layers", JSONObject()
        .put("base", layer("base", 100, 1000)).put("engine", layer("engine", 20, 200)))

    @Test fun legacyManifestKeepsOneArchiveAndOptionalDigest() {
        val manifest = RuntimeManifest.fromJson(metadata().put("rootfs", "rootfs.tar.gz"))
        assertEquals(listOf("rootfs.tar.gz"), manifest.archives.map { it.asset })
        assertNull(manifest.archives.single().sha256)
        assertEquals(-1L, manifest.archives.single().bytes)
        assertEquals(manifest.archives, manifest.archivesForInstall(true))
        assertEquals(listOf("proot", "-r", "{rootfs}"), manifest.launchArgv)
        assertEquals(mapOf("HOME" to "/root"), manifest.launchEnv)
    }

    @Test fun layeredManifestSelectsBaseAndEngineForFirstInstallButOnlyEngineForUpgrade() {
        val manifest = RuntimeManifest.fromJson(layered())
        assertEquals(listOf("base-arm64-v8a.tar.xz", "engine-arm64-v8a.tar.xz"),
            manifest.archivesForInstall(false).map { it.asset })
        assertEquals(listOf("engine-arm64-v8a.tar.xz"), manifest.archivesForInstall(true).map { it.asset })
        assertEquals(1380L, requiredRuntimeInstallSpace(manifest.archivesForInstall(false)))
        assertEquals(230L, requiredRuntimeInstallSpace(manifest.archivesForInstall(true)))
    }

    @Test fun incompleteLayeredManifestsCannotFallBackToLegacyExtraction() {
        val missing = layered()
        missing.getJSONObject("layers").remove("base")
        blocked(missing)
        val badDigest = layered()
        badDigest.getJSONObject("layers").getJSONObject("engine").put("sha256", "")
        blocked(badDigest)
        val unknown = metadata().put("schema", 99).put("rootfs", "rootfs.tar.gz")
        blocked(unknown)
    }

    private fun blocked(json: JSONObject) {
        val error = assertThrows(RuntimeUpgradeBlocked::class.java) { RuntimeManifest.fromJson(json) }
        assertEquals("runtime_upgrade_blocked:manifest", error.message)
    }

    @Test fun mixedFormatsWrongAbiNamesAndMissingTarEvidenceAreRejected() {
        blocked(layered().put("rootfs", "rootfs.tar.gz"))
        blocked(layered().put("schema", 1).put("rootfs", "rootfs.tar.gz"))
        val wrongAbi = layered()
        wrongAbi.getJSONObject("layers").getJSONObject("base").put("asset", "base-x86_64.tar.xz")
        blocked(wrongAbi)
        val missingTarDigest = layered()
        missingTarDigest.getJSONObject("layers").getJSONObject("engine").remove("tarSha256")
        blocked(missingTarDigest)
    }

    @Test fun legacyUnknownUnpackedSizeKeepsTheExistingSpaceEstimate() {
        val manifest = RuntimeManifest.fromJson(metadata().put("rootfs", "rootfs.tar.gz"))
        assertEquals(600L * 1024 * 1024 * 115 / 100, requiredRuntimeInstallSpace(manifest.archives))
    }
}
