package io.github.ccch1mneyyy.dsh_app.files

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class LegacyDownloadsTest {
    @Test fun keepsExistingNamesAndUsesTheSameSuffixConvention() = withDirectory { dir ->
        File(dir, "report.zip").writeText("original")
        File(dir, "report (2).zip").mkdir()
        val saved = ByteArrayInputStream("new".toByteArray()).use {
            LegacyDownloads.copy(it, dir, "report.zip")
        }
        assertEquals("report (3).zip", saved.name)
        assertEquals("new", saved.readText())
        assertEquals("original", File(dir, "report.zip").readText())
        assertTrue(File(dir, "report (2).zip").isDirectory)
        File(dir, ".hidden").writeText("hidden")
        assertEquals(".hidden (2)", ByteArrayInputStream(byteArrayOf(1)).use {
            LegacyDownloads.copy(it, dir, ".hidden")
        }.name)
    }

    @Test fun aSecondCopyWhileTheFirstIsWritingOwnsAnotherTarget() = withDirectory { dir ->
        var peer: File? = null
        val first = object : ByteArrayInputStream("first".toByteArray()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (peer == null) {
                    // The production copy has opened its target before reading.
                    assertTrue(File(dir, "same.zip").isFile)
                    peer = ByteArrayInputStream("second".toByteArray()).use {
                        LegacyDownloads.copy(it, dir, "same.zip")
                    }
                }
                return super.read(buffer, offset, length)
            }
        }.use { LegacyDownloads.copy(it, dir, "same.zip") }
        assertEquals("same.zip", first.name)
        assertEquals("same (2).zip", peer!!.name)
        assertEquals("first", first.readText())
        assertEquals("second", peer!!.readText())
    }

    @Test fun readFailureRemovesOnlyItsPartialAndKeepsTheCompletedPeer() = withDirectory { dir ->
        File(dir, "same.zip").writeText("existing")
        val failure = IOException("source interrupted")
        var reads = 0
        var peer: File? = null
        val source = object : InputStream() {
            override fun read(): Int = throw AssertionError("bulk copy expected")
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (reads++ == 0) {
                    buffer[offset] = 42
                    return 1
                }
                assertEquals(listOf<Byte>(42), File(dir, "same (2).zip").readBytes().toList())
                peer = ByteArrayInputStream("peer".toByteArray()).use {
                    LegacyDownloads.copy(it, dir, "same.zip")
                }
                throw failure
            }
        }
        try {
            source.use { LegacyDownloads.copy(it, dir, "same.zip") }
            fail("copy should propagate the source failure")
        } catch (error: IOException) {
            assertSame(failure, error)
        }
        assertFalse(File(dir, "same (2).zip").exists())
        assertEquals("existing", File(dir, "same.zip").readText())
        assertEquals("same (3).zip", peer!!.name)
        assertEquals("peer", peer!!.readText())
    }

    @Test fun failureBeforeExclusiveOpenDoesNotRemoveExistingObjects() = withDirectory { dir ->
        val notDirectory = File(dir, "occupied").apply { writeText("keep") }
        try {
            ByteArrayInputStream(byteArrayOf(1)).use {
                LegacyDownloads.copy(it, notDirectory, "out.zip")
            }
            fail("a regular file cannot contain a target")
        } catch (_: IOException) {
            assertEquals("keep", notDirectory.readText())
        }
    }

    @Test fun longCollisionKeepsItsExtensionAndSkipsAnotherReservedName() = withDirectory { dir ->
        val name = "a".repeat(251) + ".txt"
        val original = File(dir, name).apply { writeText("original") }
        val occupied = File(dir, "a".repeat(247) + " (2).txt").apply { writeText("peer") }
        val saved = ByteArrayInputStream("new".toByteArray()).use {
            LegacyDownloads.copy(it, dir, name)
        }
        assertEquals("a".repeat(247) + " (3).txt", saved.name)
        assertEquals(255, saved.name.toByteArray(Charsets.UTF_8).size)
        assertEquals("new", saved.readText())
        assertEquals("original", original.readText())
        assertEquals("peer", occupied.readText())
    }

    @Test fun longCollisionNamesKeepWholeUtf8CodePoints() {
        val rocket = "\uD83D\uDE80"
        val cases = listOf(
            ("界".repeat(82) + "a" + rocket + ".txt") to ("界".repeat(82) + "a (2).txt"),
            ("界".repeat(81) + rocket + "bcde.txt") to ("界".repeat(81) + rocket + " (2).txt"),
            "界".repeat(85) to ("界".repeat(83) + " (2)")
        )
        for ((name, expected) in cases) withDirectory { dir ->
            assertEquals(255, name.toByteArray(Charsets.UTF_8).size)
            File(dir, name).writeText("original")
            val saved = ByteArrayInputStream(byteArrayOf(42)).use {
                LegacyDownloads.copy(it, dir, name)
            }
            assertEquals(expected, saved.name)
            assertTrue(saved.name.toByteArray(Charsets.UTF_8).size <= 255)
            assertEquals(saved.name, saved.name.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8))
            assertArrayEquals(byteArrayOf(42), saved.readBytes())
            assertEquals("original", File(dir, name).readText())
        }
    }

    @Test fun aFittingHugeExtensionSurvivesEvenWhenNoStemCodePointFits() = withDirectory { dir ->
        val rocket = "\uD83D\uDE80"
        val name = rocket + "." + "x".repeat(250)
        assertEquals(255, name.toByteArray(Charsets.UTF_8).size)
        File(dir, name).writeText("original")
        val saved = ByteArrayInputStream(byteArrayOf(7)).use {
            LegacyDownloads.copy(it, dir, name)
        }
        assertEquals(" (2)." + "x".repeat(250), saved.name)
        assertEquals(255, saved.name.toByteArray(Charsets.UTF_8).size)
        assertArrayEquals(byteArrayOf(7), saved.readBytes())
        assertEquals("original", File(dir, name).readText())
    }

    @Test fun growingCollisionNumbersRecomputeTheNameBudget() = withDirectory { dir ->
        val name = "a".repeat(251) + ".txt"
        for (number in 1..10) {
            val saved = ByteArrayInputStream(byteArrayOf(number.toByte())).use {
                LegacyDownloads.copy(it, dir, name)
            }
            val expected = when (number) {
                1 -> name
                10 -> "a".repeat(246) + " (10).txt"
                else -> "a".repeat(247) + " ($number).txt"
            }
            assertEquals(expected, saved.name)
            assertEquals(255, saved.name.toByteArray(Charsets.UTF_8).size)
            assertArrayEquals(byteArrayOf(number.toByte()), saved.readBytes())
        }
        assertEquals(10, dir.listFiles()!!.size)
        assertArrayEquals(byteArrayOf(1), File(dir, name).readBytes())
    }

    @Test fun firstOpenBoundsLongChineseAndEmojiNamesWithoutSplittingCodePoints() {
        val rocket = "\uD83D\uDE80"
        val cases = listOf(
            ("界".repeat(100) + ".txt") to ("界".repeat(83) + ".txt"),
            (rocket.repeat(64) + ".zip") to (rocket.repeat(62) + ".zip"),
            rocket.repeat(64) to rocket.repeat(63)
        )
        for ((name, expected) in cases) withDirectory { dir ->
            val saved = ByteArrayInputStream(byteArrayOf(42)).use { LegacyDownloads.copy(it, dir, name) }
            assertEquals(expected, saved.name)
            assertTrue(saved.name.toByteArray(Charsets.UTF_8).size <= 255)
            assertEquals(saved.name, saved.name.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8))
            assertArrayEquals(byteArrayOf(42), saved.readBytes())
        }
    }

    @Test fun collisionRetriesUseTheAlreadyBoundedInitialName() = withDirectory { dir ->
        val rocket = "\uD83D\uDE80"
        val name = rocket.repeat(64) + ".zip"
        val first = File(dir, rocket.repeat(62) + ".zip").apply { writeText("original") }
        val second = File(dir, rocket.repeat(61) + " (2).zip").apply { writeText("peer") }
        val saved = ByteArrayInputStream(byteArrayOf(7)).use { LegacyDownloads.copy(it, dir, name) }
        assertEquals(rocket.repeat(61) + " (3).zip", saved.name)
        assertArrayEquals(byteArrayOf(7), saved.readBytes())
        assertEquals("original", first.readText())
        assertEquals("peer", second.readText())
    }

    @Test fun aStemCodePointTooWideForTheRemainingBytesDoesNotDiscardTheExtension() = withDirectory { dir ->
        val name = "\uD83D\uDE80." + "x".repeat(248)
        File(dir, name).writeText("original")
        val saved = ByteArrayInputStream(byteArrayOf(8)).use { LegacyDownloads.copy(it, dir, name) }
        assertEquals(" (2)." + "x".repeat(248), saved.name)
        assertTrue(saved.name.toByteArray(Charsets.UTF_8).size <= 255)
        assertArrayEquals(byteArrayOf(8), saved.readBytes())
        assertEquals("original", File(dir, name).readText())
    }

    @Test fun anExtensionTooLargeForTheNumberStillUsesTheBoundedFallback() = withDirectory { dir ->
        val rocket = "\uD83D\uDE80"
        val name = rocket + "." + "x".repeat(250)
        File(dir, name).writeText("original")
        for (number in 2..9) File(dir, " ($number)." + "x".repeat(250)).writeText("peer")
        val saved = ByteArrayInputStream(byteArrayOf(9)).use { LegacyDownloads.copy(it, dir, name) }
        assertEquals(rocket + "." + "x".repeat(245) + " (10)", saved.name)
        assertEquals(255, saved.name.toByteArray(Charsets.UTF_8).size)
        assertArrayEquals(byteArrayOf(9), saved.readBytes())
        assertEquals("original", File(dir, name).readText())
        for (number in 2..9) assertEquals("peer", File(dir, " ($number)." + "x".repeat(250)).readText())
    }

    private fun withDirectory(block: (File) -> Unit) {
        val dir = Files.createTempDirectory("legacy-downloads-").toFile()
        try { block(dir) } finally { dir.deleteRecursively() }
    }
}
