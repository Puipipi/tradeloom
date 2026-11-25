package io.github.ccch1mneyyy.dsh_app.shortcuts

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.util.UUID

class ScreenshotEntryTest {
    @get:Rule val temp = TemporaryFolder()
    private fun cache() = File(temp.root, "cache").apply { mkdirs() }
    private fun frame(cache: File): File = File(ScreenshotFiles.createSlot(cache), "screenshot.png").apply { writeBytes(byteArrayOf(1, 2, 3)) }

    @Test fun entryRequiresBothCurrentProcessTokenAndPrivateFrame() {
        val cache = cache()
        val file = frame(cache)
        assertNull(ScreenshotEntry.event(cache, "secret", null, file.path))
        assertNull(ScreenshotEntry.event(cache, "secret", "other-process", file.path))
        assertNull(ScreenshotEntry.event(cache, "secret", "secret", null))
        assertEquals(mapOf("kind" to "screenshot", "path" to file.path),
            ScreenshotEntry.event(cache, "secret", "secret", file.path))
    }

    @Test fun arbitraryFilesAndTraversalCannotBecomeAttachments() {
        val cache = cache()
        val good = frame(cache)
        val outside = File(cache, "passwords.png").apply { writeText("private") }
        assertNull(ScreenshotFiles.validate(cache, outside.path))
        val slot = requireNotNull(good.parentFile)
        assertNull(ScreenshotFiles.validate(cache, slot.path + "/../" + slot.name + "/screenshot.png"))
        assertNull(ScreenshotFiles.validate(cache, "relative/screenshot.png"))
        val wrongName = File(good.parentFile, "anything.png").apply { writeText("private") }
        assertNull(ScreenshotFiles.validate(cache, wrongName.path))
        val malformedSlot = File(cache, "${ScreenshotFiles.DIRECTORY}/not-a-slot/screenshot.png")
        requireNotNull(malformedSlot.parentFile).mkdirs()
        malformedSlot.writeText("private")
        assertNull(ScreenshotFiles.validate(cache, malformedSlot.path))
    }

    @Test fun symlinkedFilesSlotsAndRootsAreRejected() {
        val cache = cache()
        val good = frame(cache)
        val outside = File(temp.root, "outside.png").apply { writeText("private") }
        good.delete()
        Files.createSymbolicLink(good.toPath(), outside.toPath())
        assertNull(ScreenshotFiles.validate(cache, good.path))
        val slot = requireNotNull(good.parentFile)
        val root = requireNotNull(slot.parentFile)
        val linkedSlot = File(root, UUID.randomUUID().toString())
        Files.createSymbolicLink(linkedSlot.toPath(), slot.toPath())
        assertNull(ScreenshotFiles.validate(cache, File(linkedSlot, "screenshot.png").path))
        val otherCache = File(temp.root, "linked-cache").apply { mkdirs() }
        Files.createSymbolicLink(File(otherCache, ScreenshotFiles.DIRECTORY).toPath(), root.toPath())
        assertNull(ScreenshotFiles.validate(otherCache, good.path))
    }

    @Test fun emptyOrOversizedFramesAreRejected() {
        val cache = cache()
        val file = frame(cache)
        file.writeBytes(byteArrayOf())
        assertNull(ScreenshotFiles.validate(cache, file.path))
        RandomAccessFile(file, "rw").use { it.setLength(ScreenshotFiles.MAX_BYTES + 1) }
        assertNull(ScreenshotFiles.validate(cache, file.path))
    }

    @Test fun capturesUseIndependentBoundedSlotsAndCleanExpiredFrames() {
        val cache = cache()
        val first = frame(cache)
        val second = frame(cache)
        assertNotEquals(first.parentFile, second.parentFile)
        requireNotNull(first.parentFile).setLastModified(1)
        ScreenshotFiles.createSlot(cache, now = 4_000_000)
        assertFalse(first.exists())
        assertTrue(second.exists())
        repeat(12) { frame(cache) }
        val root = File(cache, ScreenshotFiles.DIRECTORY)
        assertTrue(root.listFiles()!!.size <= 8)
    }

    @Test fun cleanupNeverFollowsASymlinkToUserContent() {
        val cache = cache()
        val slot = ScreenshotFiles.createSlot(cache)
        val outside = File(temp.root, "keep.png").apply { writeText("keep") }
        Files.createSymbolicLink(File(slot, "screenshot.png").toPath(), outside.toPath())
        ScreenshotFiles.deleteSlot(slot)
        assertEquals("keep", outside.readText())
    }
}
