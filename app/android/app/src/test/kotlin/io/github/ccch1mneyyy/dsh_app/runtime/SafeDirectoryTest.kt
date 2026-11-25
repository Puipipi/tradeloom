package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Assume.assumeFalse
import org.junit.Test

class SafeDirectoryTest {
    private fun briefing() = SafeMode.Briefing(
        failure = null, reason = SafePolicy.REASON_MANUAL, moved = emptyList(),
        lkgAt = null, lkgBundles = emptyList(), lkgVersions = emptyMap(), failureLog = emptyList(),
    )

    @Test fun prepareDoesNotFollowAnUnremovableManagedDirectoryLink() {
        val root = Files.createTempDirectory("safe-dir-blocked").toFile()
        val dir = SafeMode.guestFile(root, SafeMode.GUEST_DIR)
        val parent = dir.parentFile!!
        val target = File(root, "saved-data").apply { mkdirs() }
        val sentinel = File(target, "keep.txt").apply { writeText("unchanged") }
        try {
            parent.mkdirs()
            Files.createSymbolicLink(dir.toPath(), target.toPath())
            // Test real filesystem permissions; root/unsupported platforms cannot
            // establish this precondition and must not claim a product result.
            val probe = File(parent, "unlink-probe").apply { writeText("probe") }
            parent.setWritable(false, false)
            assumeFalse("filesystem must deny unlink in the parent", probe.delete())
            try {
                SafeMode.prepare(root, briefing())
                fail("an unremovable managed directory link must reject preparation")
            } catch (_: IOException) {
                assertTrue(Files.isSymbolicLink(dir.toPath()))
                assertEquals(target.toPath(), Files.readSymbolicLink(dir.toPath()))
                assertEquals("unchanged", sentinel.readText())
                assertEquals(listOf("keep.txt"), target.list()!!.sorted())
            }
        } finally {
            parent.setWritable(true, true)
            Files.deleteIfExists(dir.toPath())
            root.deleteRecursively()
        }
    }

    @Test fun prepareReplacesARemovableManagedDirectoryLinkWithoutWritingItsTarget() {
        val root = Files.createTempDirectory("safe-dir-replace").toFile()
        val dir = SafeMode.guestFile(root, SafeMode.GUEST_DIR)
        val target = File(root, "saved-data").apply { mkdirs() }
        File(target, "keep.txt").writeText("unchanged")
        try {
            dir.parentFile!!.mkdirs()
            Files.createSymbolicLink(dir.toPath(), target.toPath())
            SafeMode.prepare(root, briefing())
            assertTrue(dir.isDirectory)
            assertFalse(Files.isSymbolicLink(dir.toPath()))
            assertTrue(File(dir, "overlay.patch.yml").isFile)
            assertTrue(File(dir, "agents/AGENTS.md").isFile)
            assertEquals(listOf("keep.txt"), target.list()!!.sorted())
            assertEquals("unchanged", File(target, "keep.txt").readText())
        } finally {
            if (Files.isSymbolicLink(dir.toPath())) Files.deleteIfExists(dir.toPath())
            root.deleteRecursively()
        }
    }
}
