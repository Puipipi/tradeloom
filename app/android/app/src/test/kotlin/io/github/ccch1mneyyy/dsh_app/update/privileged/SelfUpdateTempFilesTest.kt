package io.github.ccch1mneyyy.dsh_app.update.privileged

import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class SelfUpdateTempFilesTest {
    @Test fun removesOnlyOrphanApksAndEmptyStagingDirectories() {
        val root = Files.createTempDirectory("self-update-cleanup-").toFile()
        try {
            val parent = File(root, "tmp").apply { assertTrue(mkdir()) }
            fun staging() = File(parent, "dsh-self-update-" + UUID.randomUUID().toString())
                .apply { assertTrue(mkdir()) }

            val orphan = staging()
            File(orphan, "base.apk").writeText("interrupted copy")
            val empty = staging()
            val withOtherFile = staging()
            val otherApk = File(withOtherFile, "base.apk").apply { writeText("old snapshot") }
            val otherFile = File(withOtherFile, "keep.txt").apply { writeText("keep") }

            val outside = File(root, "outside").apply { assertTrue(mkdir()) }
            val outsideApk = File(outside, "base.apk").apply { writeText("outside") }
            val linkedDirectory = File(parent, "dsh-self-update-" + UUID.randomUUID().toString())
            Files.createSymbolicLink(linkedDirectory.toPath(), outside.toPath())
            val linkedApkDirectory = staging()
            val linkedApk = File(linkedApkDirectory, "base.apk")
            Files.createSymbolicLink(linkedApk.toPath(), outsideApk.toPath())

            val directoryApk = File(staging(), "base.apk").apply { assertTrue(mkdir()) }
            val unrelated = File(parent, "dsh-self-update-not-a-uuid").apply { assertTrue(mkdir()) }
            val unrelatedApk = File(unrelated, "base.apk").apply { writeText("unrelated") }

            cleanupSelfUpdateDirectories(parent)

            assertFalse(orphan.exists())
            assertFalse(empty.exists())
            assertFalse(otherApk.exists())
            assertEquals("keep", otherFile.readText())
            assertTrue(Files.isSymbolicLink(linkedDirectory.toPath()))
            assertTrue(Files.isSymbolicLink(linkedApk.toPath()))
            assertEquals("outside", outsideApk.readText())
            assertTrue(directoryApk.isDirectory)
            assertEquals("unrelated", unrelatedApk.readText())
        } finally {
            Files.walk(root.toPath()).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            }
        }
    }
}
