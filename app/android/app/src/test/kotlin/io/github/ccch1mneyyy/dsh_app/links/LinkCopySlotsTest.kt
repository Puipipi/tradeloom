package io.github.ccch1mneyyy.dsh_app.links

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class LinkCopySlotsTest {
    @Test fun aSlowCopySurvivesSevenLaterCopiesAndCanBePrunedAfterCompletion() {
        val root = Files.createTempDirectory("link-copy-test-").toFile()
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val firstSlot = AtomicReference<File>()
        val workers = Executors.newCachedThreadPool()
        try {
            val first = workers.submit<File> {
                LinkCopySlots.withSlot(root) { slot ->
                    firstSlot.set(slot)
                    val target = File(slot, "first.bin")
                    target.outputStream().use { out ->
                        out.write("first-".toByteArray())
                        // Set AFTER target creation: never rely on directory ordering or sleeps.
                        assertTrue(slot.setLastModified(1_000L))
                        entered.countDown()
                        assertTrue(resume.await(5, TimeUnit.SECONDS))
                        out.write("last".toByteArray())
                    }
                    target
                }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            // A separate worker must complete all B copies while A is still gated in its I/O.
            workers.submit {
                for (i in 1..7) shortCopy(root, i)
            }.get(5, TimeUnit.SECONDS)
            assertTrue("prune must not unlink an ongoing copy", firstSlot.get().isDirectory)
            resume.countDown()
            val target = first.get(5, TimeUnit.SECONDS)
            assertEquals("first-last", String(Files.readAllBytes(target.toPath())))
            shortCopy(root, 8)
            assertFalse("completed copies are not retained forever", firstSlot.get().exists())
            assertEquals("unchanged six old slots plus the newest", 7, root.listFiles()!!.size)
        } finally {
            resume.countDown()
            workers.shutdownNow()
            assertTrue(workers.awaitTermination(5, TimeUnit.SECONDS))
            root.deleteRecursively()
        }
    }

    @Test fun failedCopiesReleaseTheirHoldForTheExistingPruner() {
        val root = Files.createTempDirectory("link-copy-failure-").toFile()
        var failed: File? = null
        try {
            assertThrows(IOException::class.java) {
                LinkCopySlots.withSlot(root) { slot ->
                    failed = slot
                    File(slot, "partial.bin").writeText("partial")
                    assertTrue(slot.setLastModified(1_000L))
                    throw IOException("provider read failed")
                }
            }
            for (i in 1..7) shortCopy(root, i)
            assertFalse("finally must retire failed as well as successful copies", failed!!.exists())
        } finally { root.deleteRecursively() }
    }

    private fun shortCopy(root: File, ordinal: Int) {
        LinkCopySlots.withSlot(root) { slot ->
            File(slot, "later.bin").writeText("later-$ordinal")
            assertTrue(slot.setLastModified(10_000L + ordinal * 1_000L))
        }
    }
}
