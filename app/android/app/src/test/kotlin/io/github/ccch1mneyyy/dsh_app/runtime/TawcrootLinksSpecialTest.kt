package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class TawcrootLinksSpecialTest {
    private val base = kotlin.io.path.createTempDirectory("tawc-special").toFile()
    private val root = File(base, "rootfs").apply { mkdirs() }.canonicalFile
    private val store = File(base, "tawcroot")
    private var flushes = 0

    @Before fun linuxFifoFixture() {
        assumeTrue("the FIFO fixture uses Linux mkfifo", System.getProperty("os.name") == "Linux")
    }

    @After fun cleanUp() { base.deleteRecursively() }

    private fun name(path: String, token: String): File = File(root, path).apply {
        parentFile.mkdirs()
        Files.createSymbolicLink(toPath(), Paths.get(TawcrootLinks.PREFIX + token))
    }

    private fun regular(path: String): File {
        File(store, "link/1").apply {
            parentFile.mkdirs()
            writeText("ordinary content")
        }
        File(store, "link/1.cnt").writeText("0000000001\n")
        return name(path, "1")
    }

    /** The consumed format-1 layout after mkfifo p; ln p p2, without opening a writer. */
    private fun fifoNames(directory: String): List<File> {
        val fifo = File(store, "link/2").apply { parentFile.mkdirs() }
        val maker = ProcessBuilder("mkfifo", "--", fifo.path).inheritIO().start()
        try {
            assertTrue("mkfifo timed out", maker.waitFor(5, TimeUnit.SECONDS))
            assertEquals("mkfifo exit code", 0, maker.exitValue())
        } finally {
            if (maker.isAlive) {
                maker.destroyForcibly()
                check(maker.waitFor(5, TimeUnit.SECONDS)) { "mkfifo did not exit" }
            }
        }
        File(store, "link/2.cnt").writeText("0000000002\n")
        return listOf(name("$directory/p", "2"), name("$directory/p2", "2"))
    }

    private fun assertFifoKept(names: List<File>) {
        for (file in names) assertEquals(TawcrootLinks.PREFIX + "2", Files.readSymbolicLink(file.toPath()).toString())
        val mode = Files.getAttribute(File(store, "link/2").toPath(), "unix:mode") as Int
        assertEquals("store object must remain a FIFO", 0x1000, mode and 0xf000)
        assertEquals("0000000002\n", File(store, "link/2.cnt").readText())
    }

    private fun assertRejectedWithoutConversion(normal: File, pipes: List<File>, within: List<String>? = null) {
        // With no space, the old code returns NotEnoughSpace instead of opening the FIFO.
        // This exercises the real migration without leaving a blocked native reader in CI.
        assertThrows(IOException::class.java) {
            TawcrootLinks(root, { flushes++ }, { 0L }, within).run()
        }
        assertEquals(TawcrootLinks.PREFIX + "1", Files.readSymbolicLink(normal.toPath()).toString())
        assertEquals("ordinary content", File(store, "link/1").readText())
        assertEquals("0000000001\n", File(store, "link/1.cnt").readText())
        assertFifoKept(pipes)
        assertEquals(0, flushes)
        assertTrue(root.walkTopDown().none { TawcrootLinks.TEMP.matches(it.name) })
    }

    @Test fun fullConversionRejectsALinkedFifoAndKeepsBothNames() {
        val normal = regular("root/a.txt")
        val pipes = fifoNames("root/.agents/skills/pipe")
        assertRejectedWithoutConversion(normal, pipes)
    }

    @Test fun keepConversionRejectsALinkedFifoWithoutChangingKeptFiles() {
        val normal = regular("root/.agents/skills/a/SKILL.md")
        val pipes = fifoNames("root/.agents/skills/pipe")
        assertRejectedWithoutConversion(normal, pipes, listOf("root/.agents/skills"))
    }

    @Test fun aFifoOutsideTheKeptPathsDoesNotBlockTheirConversion() {
        val normal = regular("root/.agents/skills/a/SKILL.md")
        val pipes = fifoNames("root/workspace")
        val result = TawcrootLinks(root, { flushes++ }, { Long.MAX_VALUE }, listOf("root/.agents/skills")).run()
        assertEquals(TawcrootLinks.Result.Done(1, false), result)
        assertEquals("ordinary content", normal.readText())
        assertFalse(Files.isSymbolicLink(normal.toPath()))
        assertFifoKept(pipes)
        assertTrue(flushes > 0)
    }
}
