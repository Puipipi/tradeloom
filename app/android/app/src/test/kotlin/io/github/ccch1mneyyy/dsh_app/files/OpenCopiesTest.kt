package io.github.ccch1mneyyy.dsh_app.files

import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class OpenCopiesTest {
    @Test fun differentSourcesWithTheSameNameKeepIndependentContents() = withDirectory { dir ->
        val firstSource = source(dir, "a/report.pdf", "first")
        val secondSource = source(dir, "b/report.pdf", "second")
        val cache = File(dir, "cache")
        val first = FilesPlugin.copyForOpen(firstSource, cache, "report.pdf")
        val second = FilesPlugin.copyForOpen(secondSource, cache, "report.pdf")
        assertNotEquals(first, second)
        assertEquals("report.pdf", first.name)
        assertEquals("report.pdf", second.name)
        // Reopen the first path after B was copied, as FileProvider does for an old URI.
        assertEquals("first", first.readText())
        assertEquals("second", second.readText())
        assertEquals("first", firstSource.readText())
        assertEquals("second", secondSource.readText())
        assertEquals(2, cache.listFiles()!!.size)
    }

    @Test fun openingTheSameSourceAgainReusesItsPathAndPublishesNewContents() = withDirectory { dir ->
        val source = source(dir, "a/report.pdf", "before")
        val cache = File(dir, "cache")
        val first = FilesPlugin.copyForOpen(source, cache, "report.pdf")
        source.writeText("after")
        val second = FilesPlugin.copyForOpen(source, cache, "report.pdf")
        assertEquals(first, second)
        assertEquals("after", first.readText())
        assertEquals(1, cache.listFiles()!!.size)
        assertEquals(1, first.parentFile!!.listFiles()!!.size)
    }

    @Test fun canonicalAliasesShareTheSourceKeyAndNamesRemainSafe() = withDirectory { dir ->
        val source = source(dir, "a/report.pdf", "content")
        val alias = File(dir, "a/../a/report.pdf")
        val cache = File(dir, "cache")
        val first = FilesPlugin.copyForOpen(source, cache, "../report.pdf")
        val second = FilesPlugin.copyForOpen(alias, cache, "report.pdf")
        assertEquals(first, second)
        assertEquals("report.pdf", first.name)
        assertEquals(cache.canonicalFile, first.parentFile!!.parentFile!!.canonicalFile)
        assertEquals("content", second.readText())
        assertEquals(1, cache.listFiles()!!.size)
    }

    @Test fun failedReplacementKeepsPublishedCopyAndRetryUsesTheSamePath() = withDirectory { dir ->
        val source = source(dir, "a/report.pdf", "before")
        val cache = File(dir, "cache")
        val published = FilesPlugin.copyForOpen(source, cache, "report.pdf")
        source.writeText("after: complete new contents")
        val failure = IOException("injected copy failure after a prefix")
        try {
            FilesPlugin.copyForOpen(source, cache, "report.pdf") { from, temporary ->
                from.inputStream().use { input ->
                    temporary.outputStream().use { output -> output.write(input.read()) }
                }
                throw failure
            }
            fail("copy should fail")
        } catch (error: IOException) {
            assertSame(failure, error)
        }
        assertEquals("before", published.readText())
        assertEquals("after: complete new contents", source.readText())
        assertEquals(listOf(published), published.parentFile!!.listFiles()!!.toList())

        val retried = FilesPlugin.copyForOpen(source, cache, "report.pdf")
        assertEquals(published, retried)
        assertEquals("after: complete new contents", published.readText())
        assertEquals(listOf(published), published.parentFile!!.listFiles()!!.toList())
    }

    private fun source(root: File, path: String, value: String): File = File(root, path).apply {
        parentFile!!.mkdirs()
        writeText(value)
    }

    private fun withDirectory(test: (File) -> Unit) {
        val dir = Files.createTempDirectory("open-copies-").toFile()
        try { test(dir) } finally { dir.deleteRecursively() }
    }
}
