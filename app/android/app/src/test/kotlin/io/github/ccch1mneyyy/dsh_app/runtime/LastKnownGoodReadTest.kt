package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class LastKnownGoodReadTest {
    private val base = kotlin.io.path.createTempDirectory("lkg-read").toFile()
    private val root = File(base, "rootfs").apply { mkdirs() }
    private val dir = LastKnownGood.webDir(root).apply { mkdirs() }
    private val pluginName = "@sample/plugin"
    private val config = File(dir, "package.json").apply {
        writeText("""{"dependencies":{"$pluginName":"*"},"dsh":{"profile":{"bundles":["core","$pluginName"]}}}""")
    }
    private val pkg = File(dir, "node_modules/$pluginName/package.json").apply { parentFile.mkdirs() }
    private val store = TawcrootLinks.storeOf(root)

    @After fun cleanUp() { base.deleteRecursively() }

    @Test fun ordinaryFilesAndRelativeSymlinksKeepTheirVersions() {
        val text = """{"version":"1.0.0"}"""
        pkg.writeText(text)
        File(dir, "cordis.patch.yml").writeText("setting: kept\n")
        val expected = ProfileSnapshot(listOf("core", pluginName), setOf(pluginName), mapOf(pluginName to "1.0.0"), "setting: kept\n")
        assertEquals(expected, LastKnownGood.read(root))

        val manifest = File(pkg.parentFile, "manifest.json")
        Files.move(pkg.toPath(), manifest.toPath())
        Files.createSymbolicLink(pkg.toPath(), Paths.get("manifest.json"))
        assertEquals(expected, LastKnownGood.read(root))
        assertEquals("manifest.json", Files.readSymbolicLink(pkg.toPath()).toString())
        assertEquals(text, manifest.readText())
        assertFalse(store.exists())
    }

    @Test fun opaquePackageVersionsReachThePlanWithoutConvertingFiles() {
        pkg.writeText("""{"version":"1.0.0"}""")
        val good = LastKnownGood.read(root)!!
        val beforeConfig = config.readText()
        val obj = File(store, "link/123-4").apply {
            parentFile.mkdirs()
            writeText("""{"version":"2.0.0"}""")
        }
        val count = File(store, "link/123-4.cnt").apply { writeText("0000000002\n") }
        Files.delete(pkg.toPath())
        val target = TawcrootLinks.PREFIX + "123-4"
        Files.createSymbolicLink(pkg.toPath(), Paths.get(target))

        val current = LastKnownGood.read(root)!!
        assertEquals(mapOf(pluginName to "2.0.0"), current.versions)
        assertEquals(good.bundles, current.bundles)
        assertEquals(good.deps, current.deps)
        val plan = LkgPlan.of(good, current)
        assertEquals(listOf(pluginName), plan.changed)
        assertEquals(listOf(pluginName), plan.disable)
        assertEquals(listOf("core"), plan.target)
        assertFalse(plan.isEmpty)
        assertEquals(target, Files.readSymbolicLink(pkg.toPath()).toString())
        assertEquals("""{"version":"2.0.0"}""", obj.readText())
        assertEquals("0000000002\n", count.readText())
        assertEquals(beforeConfig, config.readText())
    }

    @Test fun unavailableOpaqueVersionsKeepTheExistingUnknownPolicy() {
        val json = JSONObject(config.readText())
        json.getJSONObject("dependencies").put("unchanged", "*")
        config.writeText(json.toString())
        File(dir, "node_modules/unchanged/package.json").apply {
            parentFile.mkdirs()
            writeText("""{"version":"9.0.0"}""")
        }
        pkg.writeText("""{"version":"1.0.0"}""")
        val good = LastKnownGood.read(root)!!
        Files.delete(pkg.toPath())
        File(store, "link").mkdirs()
        File(store, "outside").writeText("""{"version":"2.0.0"}""")
        File(store, "link/2").writeText("{")
        File(store, "link/3").mkdir()
        Files.createSymbolicLink(File(store, "link/4").toPath(), Paths.get("../outside"))

        val guestTarget = File(pkg.parentFile.parentFile, "outside")
        assertFalse(guestTarget.exists())

        // Resolve ../outside from package.json's guest parent, not from store/link.
        // The guest target is missing here even though store/outside exists.
        for (token in listOf("1", "2", "3", "4", "../outside")) {
            val target = TawcrootLinks.PREFIX + token
            Files.createSymbolicLink(pkg.toPath(), Paths.get(target))
            val current = LastKnownGood.read(root)!!
            assertEquals(token, mapOf("unchanged" to "9.0.0"), current.versions)
            assertEquals(good.bundles, current.bundles)
            assertEquals(good.deps, current.deps)
            assertTrue(token, LkgPlan.of(good, current).isEmpty)
            assertEquals(target, Files.readSymbolicLink(pkg.toPath()).toString())
            Files.delete(pkg.toPath())
        }
        guestTarget.writeText("""{"version":"3.0.0"}""")
        val linkedTarget = TawcrootLinks.PREFIX + "4"
        Files.createSymbolicLink(pkg.toPath(), Paths.get(linkedTarget))
        val current = LastKnownGood.read(root)!!
        assertEquals(mapOf(pluginName to "3.0.0", "unchanged" to "9.0.0"), current.versions)
        assertEquals(good.bundles, current.bundles)
        assertEquals(good.deps, current.deps)
        val plan = LkgPlan.of(good, current)
        assertEquals(listOf(pluginName), plan.changed)
        assertEquals(listOf(pluginName), plan.disable)
        assertEquals(listOf("core"), plan.target)
        assertFalse(plan.isEmpty)
        assertEquals(linkedTarget, Files.readSymbolicLink(pkg.toPath()).toString())
        assertEquals("../outside", Files.readSymbolicLink(File(store, "link/4").toPath()).toString())
        assertEquals("""{"version":"3.0.0"}""", guestTarget.readText())
        assertEquals("""{"version":"2.0.0"}""", File(store, "outside").readText())
    }
}
