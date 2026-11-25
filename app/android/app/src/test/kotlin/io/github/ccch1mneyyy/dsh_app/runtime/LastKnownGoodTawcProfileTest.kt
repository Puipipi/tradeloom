package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import org.json.JSONException
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class LastKnownGoodTawcProfileTest {
    private val base = Files.createTempDirectory("lkg-tawc-profile-").toFile()
    private val root = File(base, "rootfs").apply { mkdirs() }
    private val dir = LastKnownGood.webDir(root).apply { mkdirs() }
    private val config = File(dir, "package.json").apply {
        writeText("""{"dependencies":{},"dsh":{"profile":{"bundles":["core"]}}}""")
    }
    private val goodPatch = "- id: fixture\n  config:\n    value: kept\n"
    private val patch = File(dir, "cordis.patch.yml").apply { writeText(goodPatch) }
    private val lkg = File(base, "lkg/lkg.json")

    @After fun cleanUp() { base.deleteRecursively() }

    /** Disk layout after tawc successfully handles the first hard-link backup. */
    private fun opaque(file: File, token: String): File {
        val obj = File(base, "tawcroot/link/$token").apply {
            parentFile!!.mkdirs()
            writeBytes(file.readBytes())
        }
        File(obj.parentFile, "$token.cnt").writeText("0000000002\n")
        Files.delete(file.toPath())
        val target = Paths.get("tawcroot:link:$token")
        Files.createSymbolicLink(file.toPath(), target)
        Files.createSymbolicLink(File(root, "root/backup-$token").toPath(), target)
        return obj
    }

    @Test fun captureBeforeProotMaterializationDoesNotEraseTheHealthySettingsLayer() {
        LastKnownGood.save(lkg, LastKnownGood.read(root)!!, 1)
        opaque(patch, "1")
        assertFalse(patch.isFile)

        // RuntimeController captures before DshProcess.start performs this conversion.
        val atLaunch = LastKnownGood.read(root)!!
        assertEquals(goodPatch, atLaunch.patch)
        assertEquals(TawcrootLinks.Result.Done(2, true),
            TawcrootLinks(root, flush = {}, freeBytes = { Long.MAX_VALUE }).run())
        var readsAtReady = 0
        val booted = LastKnownGood.bootedAtReady(atLaunch) {
            readsAtReady++
            LastKnownGood.read(root)
        }
        assertEquals(0, readsAtReady)
        assertTrue(LastKnownGood.pinBooted(booted) { LastKnownGood.save(lkg, it, 2) })

        val saved = LastKnownGood.load(lkg)!!
        assertEquals(2L, saved.at)
        assertEquals(goodPatch, saved.snapshot.patch)
        assertTrue(LkgPlan.of(saved.snapshot, LastKnownGood.read(root)!!).isEmpty)
        assertEquals(goodPatch, File(root, "root/backup-1").readText())
    }

    @Test fun profileManifestAndSettingsTokensAreReadWithoutChangingTheirNamesOrObjects() {
        val expected = LastKnownGood.read(root)
        val manifestText = config.readText()
        val manifestObject = opaque(config, "2")
        val patchObject = opaque(patch, "3-1")

        assertEquals(expected, LastKnownGood.read(root))
        assertEquals("tawcroot:link:2", Files.readSymbolicLink(config.toPath()).toString())
        assertEquals("tawcroot:link:3-1", Files.readSymbolicLink(patch.toPath()).toString())
        assertEquals(manifestText, manifestObject.readText())
        assertEquals(goodPatch, patchObject.readText())
        assertEquals("0000000002\n", File(patchObject.parentFile, "3-1.cnt").readText())
    }

    @Test fun aLaterAtomicSettingsEditDoesNotReplaceTheBootedTokenContentsInThePin() {
        val obj = opaque(patch, "4")
        val booted = LastKnownGood.bootedAtReady(LastKnownGood.read(root)) { LastKnownGood.read(root) }
        val changed = "- id: fixture\n  config:\n    value: changed\n"
        SafeMode.writeAtomic(patch, changed)

        assertTrue(LastKnownGood.pinBooted(booted) { LastKnownGood.save(lkg, it, 3) })
        val saved = LastKnownGood.load(lkg)!!
        val current = LastKnownGood.read(root)!!
        assertEquals(goodPatch, saved.snapshot.patch)
        assertEquals(changed, current.patch)
        assertTrue(LkgPlan.of(saved.snapshot, current).patchChanged)
        assertEquals(goodPatch, obj.readText())
        assertEquals("tawcroot:link:4", Files.readSymbolicLink(File(root, "root/backup-4").toPath()).toString())
    }

    @Test fun ordinaryRelativeLinksAndUnreadableManifestKeepTheExistingCaptureContract() {
        val expected = LastKnownGood.read(root)!!
        val manifest = File(dir, "manifest.json")
        Files.move(config.toPath(), manifest.toPath())
        Files.createSymbolicLink(config.toPath(), Paths.get("manifest.json"))
        assertEquals(expected, LastKnownGood.read(root))
        assertEquals("manifest.json", Files.readSymbolicLink(config.toPath()).toString())

        LastKnownGood.save(lkg, expected, 4)
        manifest.writeText("{")
        assertThrows(JSONException::class.java) { LastKnownGood.read(root) }
        val unreadable = LastKnownGood.bootedAtReady(null) { LastKnownGood.read(root) }
        assertNull(unreadable)
        assertFalse(LastKnownGood.pinBooted(unreadable) { fail("must keep the existing pin") })

        Files.delete(config.toPath())
        Files.createSymbolicLink(config.toPath(), Paths.get("tawcroot:link:404"))
        assertNull(LastKnownGood.read(root))
        assertEquals(expected, LastKnownGood.load(lkg)!!.snapshot)
    }
}
