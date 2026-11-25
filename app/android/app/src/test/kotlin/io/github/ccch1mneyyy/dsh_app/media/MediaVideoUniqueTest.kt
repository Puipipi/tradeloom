package io.github.ccch1mneyyy.dsh_app.media

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Test

class MediaVideoUniqueTest {
    @Test fun concurrentStreamingSavesNeverReplaceAnotherVideo() = withDirectory { root ->
        val album = File(root, "album").apply { mkdir() }
        val original = File(album, "same.mp4").apply { writeText("user video") }
        val first = File(root, "one.mp4").apply { writeBytes(ByteArray(64 * 1024) { 0x35.toByte() }) }
        val second = File(root, "two.mp4").apply { writeBytes(ByteArray(96 * 1024) { 0x6a.toByte() }) }
        val start = CountDownLatch(1)
        val workers = Executors.newFixedThreadPool(2)
        try {
            fun save(source: File) = workers.submit(Callable {
                start.await()
                MediaPlugin.writeUnique(album, "same.mp4") { output -> source.inputStream().use { it.copyTo(output) } }
            })
            val a = save(first)
            val b = save(second)
            start.countDown()
            val aResult = runCatching { a.get() }
            val bResult = runCatching { b.get() }
            val aFile = aResult.getOrThrow()
            val bFile = bResult.getOrThrow()
            assertNotEquals(aFile, bFile)
            assertEquals(setOf("same (2).mp4", "same (3).mp4"), setOf(aFile.name, bFile.name))
            assertArrayEquals(first.readBytes(), aFile.readBytes())
            assertArrayEquals(second.readBytes(), bFile.readBytes())
            assertEquals("user video", original.readText())
            assertEquals(3, album.listFiles()!!.size)
        } finally {
            start.countDown()
            workers.shutdownNow()
        }
    }

    @Test fun failedStreamDeletesOnlyItsOwnedPartialFile() = withDirectory { dir ->
        val original = File(dir, "same.mp4").apply { writeText("keep") }
        val error = runCatching {
            MediaPlugin.writeUnique(dir, "same.mp4") { output ->
                output.write(byteArrayOf(1, 2, 3))
                throw IOException("interrupted source")
            }
        }.exceptionOrNull()
        assertTrue(error is IOException)
        assertEquals("keep", original.readText())
        assertEquals(listOf("same.mp4"), dir.list()!!.toList())
        val retried = MediaPlugin.writeUnique(dir, "same.mp4") { it.write(4) }
        assertEquals("same (2).mp4", retried.name)
        assertArrayEquals(byteArrayOf(4), retried.readBytes())
    }

    private fun withDirectory(test: (File) -> Unit) {
        val dir = Files.createTempDirectory("media-video-unique-").toFile()
        try { test(dir) } finally { dir.deleteRecursively() }
    }
}
