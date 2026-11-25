package io.github.ccch1mneyyy.dsh_app.media

import java.io.File
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Test

class MediaUniqueTest {
    @Test fun preservesExistingFilesAndDirectoriesWithTheOriginalSuffixRules() = withDirectory { dir ->
        File(dir, "chart.png").writeText("existing")
        assertTrue(File(dir, "chart (2).png").mkdir())
        val saved = MediaPlugin.writeUnique(dir, "chart.png", byteArrayOf(1, 2, 3))
        assertEquals("chart (3).png", saved.name)
        assertArrayEquals(byteArrayOf(1, 2, 3), saved.readBytes())
        assertEquals("existing", File(dir, "chart.png").readText())
        assertTrue(File(dir, "chart (2).png").isDirectory)
        File(dir, ".hidden").writeText("keep")
        assertEquals(".hidden (2)", MediaPlugin.writeUnique(dir, ".hidden", byteArrayOf(4)).name)
        assertEquals("keep", File(dir, ".hidden").readText())
    }

    @Test fun concurrentSavesKeepBothCompleteImagesUnderDifferentNames() = withDirectory { dir ->
        val firstBytes = ByteArray(64 * 1024) { 0x35.toByte() }
        val secondBytes = ByteArray(96 * 1024) { 0x6a.toByte() }
        val start = CountDownLatch(1)
        val workers = Executors.newFixedThreadPool(2)
        try {
            val first = workers.submit(Callable {
                start.await()
                MediaPlugin.writeUnique(dir, "same.png", firstBytes)
            })
            val second = workers.submit(Callable {
                start.await()
                MediaPlugin.writeUnique(dir, "same.png", secondBytes)
            })
            start.countDown()
            // Join both real actions before checking either result, including a failed save.
            val firstResult = runCatching { first.get() }
            val secondResult = runCatching { second.get() }
            val a = firstResult.getOrThrow()
            val b = secondResult.getOrThrow()
            assertNotEquals(a, b)
            assertEquals(setOf("same.png", "same (2).png"), setOf(a.name, b.name))
            assertArrayEquals(firstBytes, a.readBytes())
            assertArrayEquals(secondBytes, b.readBytes())
            assertEquals(2, dir.listFiles()!!.size)
        } finally {
            start.countDown()
            workers.shutdownNow()
        }
    }

    private fun withDirectory(test: (File) -> Unit) {
        val dir = Files.createTempDirectory("media-unique-").toFile()
        try { test(dir) } finally { dir.deleteRecursively() }
    }
}
