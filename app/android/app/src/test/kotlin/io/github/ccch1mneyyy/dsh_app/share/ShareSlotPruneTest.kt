package io.github.ccch1mneyyy.dsh_app.share

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ShareSlotPruneTest {
    @Test fun pruningIncomingSlotsPreservesExportsAndUnknownEntries() {
        val root = Files.createTempDirectory("share-slots").toFile()
        try {
            val export = File(root, "dsh-go-20261107-120000.png").apply { writeText("export") }
            val unknown = File(root, "other-module").apply { mkdir() }
            File(unknown, "keep.txt").writeText("other")
            val namedFile = File(root, "m00000000-9").apply { writeText("not a directory") }
            assertTrue(export.setLastModified(1000L))
            assertTrue(unknown.setLastModified(2000L))
            assertTrue(namedFile.setLastModified(3000L))
            val slots = (0..3).map { i ->
                File(root, "m0000000$i-$i").apply {
                    assertTrue(mkdir())
                    File(this, "received.txt").writeText("incoming-$i")
                    assertTrue(setLastModified(10000L + i * 1000L))
                }
            }
            ShareNames.pruneSlots(root, 3)
            assertFalse(slots[0].exists())
            slots.drop(1).forEach { assertTrue(File(it, "received.txt").isFile) }
            assertEquals("export", export.readText())
            assertEquals("other", File(unknown, "keep.txt").readText())
            assertEquals("not a directory", namedFile.readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun matchingSymlinkIsNotAnIncomingSlot() {
        val root = Files.createTempDirectory("share-slots-link").toFile()
        val outside = Files.createTempDirectory("share-not-owned").toFile()
        try {
            File(outside, "keep.txt").writeText("outside")
            val link = File(root, "m00000000-0")
            Files.createSymbolicLink(link.toPath(), outside.toPath())
            ShareNames.pruneSlots(root, 0)
            assertTrue(Files.isSymbolicLink(link.toPath()))
            assertEquals("outside", File(outside, "keep.txt").readText())
            Files.delete(link.toPath())
        } finally { root.deleteRecursively(); outside.deleteRecursively() }
    }
}
