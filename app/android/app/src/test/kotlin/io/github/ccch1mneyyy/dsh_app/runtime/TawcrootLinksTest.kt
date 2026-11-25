package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths
import java.nio.file.attribute.FileTime
import java.nio.file.attribute.PosixFilePermissions
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Fixtures follow tawc's link store format 1 (tawcroot/include/linkstore.h at the pinned commit). */
class TawcrootLinksTest {
    private val files = kotlin.io.path.createTempDirectory("tawc-links").toFile()
    private val base = File(files, "runtime")
    private val root = File(base, "rootfs").apply { mkdirs() }.canonicalFile
    private val store = File(base, "tawcroot")
    private var flushes = 0

    @After fun cleanUp() { files.deleteRecursively() }

    private fun obj(token: String, text: String, mode: String = "rwxr-x---"): File =
        File(store, "link/$token").apply {
            parentFile.mkdirs()
            writeText(text)
            Files.setPosixFilePermissions(toPath(), PosixFilePermissions.fromString(mode))
            Files.setLastModifiedTime(toPath(), FileTime.fromMillis(1_700_000_000_000))
            File(store, "link/$token.cnt").writeText("%010d\n".format(2))
        }

    private fun name(path: String, token: String) = File(root, path).apply {
        parentFile.mkdirs()
        Files.createSymbolicLink(toPath(), Paths.get(TawcrootLinks.PREFIX + token))
    }

    private fun migration(free: Long = Long.MAX_VALUE, within: List<String>? = null) =
        TawcrootLinks(root, { flushes++ }, { free }, within)

    private fun intent(token: String, source: File, destination: File? = null, op: Int = 3, count: Long = -1): ByteArray {
        val fields = listOf(token, source.path, destination?.path.orEmpty()).map { it.toByteArray(Charsets.UTF_8) }
        // C intent_hdr is 32 bytes on both shipped LP64 ABIs, including its four trailing padding bytes.
        val header = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(0x494c5754).putInt(op).putLong(count)
            .putInt(fields[0].size).putInt(fields[1].size).putInt(fields[2].size)
        return (header.array() + fields[0] + fields[1] + fields[2]).also { File(store, "intent").writeBytes(it) }
    }

    /** The real NEW order, stopped after publishing dst, optionally after moving src to the object.
     * No recovery model here: every assertion below calls the production TawcrootLinks. */
    private fun interruptedNew(
        token: String = "81",
        sourcePath: String = "root/source.txt",
        destinationPath: String = "root/backup/copy.txt",
        movedSource: Boolean = true,
    ): Pair<File, File> {
        val source = File(root, sourcePath).apply { parentFile.mkdirs(); writeText("original content") }
        val destination = File(root, destinationPath).apply { parentFile.mkdirs() }
        File(store, "link").mkdirs()
        val work = File(store, "work").apply { mkdirs() }
        File(store, "version").writeText("1\n")
        File(store, "lock").writeText("")
        intent(token, source, destination)
        val target = Paths.get(TawcrootLinks.PREFIX + token)
        val stagedSource = File(work, "$token.src").toPath()
        val stagedDestination = File(work, "$token.dst").toPath()
        Files.createSymbolicLink(stagedDestination, target)
        Files.createSymbolicLink(stagedSource, target)
        Files.move(stagedDestination, destination.toPath())
        if (movedSource) {
            File(store, "link/$token.cnt").writeText("0000000002\n")
            Files.move(source.toPath(), File(store, "link/$token").toPath())
        }
        return source to destination
    }

    /** Given an external-path NEW record, stop after staging and before an EXDEV rollback.
     * This fixture exercises host recovery, not the C front end's bind routing. */
    private fun externalNewIntent(source: File, destination: File): ByteArray {
        File(store, "link").mkdirs()
        val work = File(store, "work").apply { mkdirs() }
        File(store, "version").writeText("1\n")
        File(store, "lock").writeText("")
        val journal = intent("83", source, destination)
        for (suffix in listOf("dst", "src")) {
            Files.createSymbolicLink(File(work, "83.$suffix").toPath(), Paths.get(TawcrootLinks.PREFIX + "83"))
        }
        return journal
    }

    @Test fun nothingToDoWithoutAStore() {
        assertFalse(TawcrootLinks.pending(root))
        assertEquals(TawcrootLinks.Result.Done(0, false), migration().run())
    }

    @Test fun everyNameBecomesItsOwnFileAndTheStoreGoes() {
        obj("1234", "shared content")
        val a = name("root/a/pkg.js", "1234")
        val b = name("root/.local/share/pnpm/store/x", "1234")
        File(root, "root/plain.txt").writeText("untouched")
        Files.createSymbolicLink(File(root, "root/rel").toPath(), Paths.get("plain.txt"))
        assertTrue(TawcrootLinks.pending(root))

        assertEquals(TawcrootLinks.Result.Done(2, true), migration().run())
        for (file in listOf(a, b)) {
            assertFalse(Files.isSymbolicLink(file.toPath()))
            assertEquals("shared content", file.readText())
            assertEquals("rwxr-x---", PosixFilePermissions.toString(Files.getPosixFilePermissions(file.toPath())))
            assertEquals(1_700_000_000_000, Files.getLastModifiedTime(file.toPath()).toMillis())
        }
        assertEquals("plain.txt", Files.readSymbolicLink(File(root, "root/rel").toPath()).toString())
        assertFalse(store.exists())
        assertFalse(TawcrootLinks.pending(root))
        assertTrue(flushes > 0)
    }

    @Test fun unreadableBindMountPointsDoNotKeepTheStore() {
        obj("4", "x")
        name("root/n", "4")
        val system = File(root, "system").apply { mkdirs() }
        Files.setPosixFilePermissions(system.toPath(), PosixFilePermissions.fromString("---------"))
        try {
            assertEquals(TawcrootLinks.Result.Done(1, true), migration().run())
        } finally {
            Files.setPosixFilePermissions(system.toPath(), PosixFilePermissions.fromString("rwx------"))
        }
    }

    @Test fun anUnreadableOrdinaryDirectoryKeepsTheStore() {
        obj("6", "x")
        name("root/n", "6")
        val home = File(root, "home").apply { mkdirs() }
        Files.setPosixFilePermissions(home.toPath(), PosixFilePermissions.fromString("---------"))
        try {
            val result = migration().run() as TawcrootLinks.Result.Done
            // Running as root (some CI containers) reads it anyway.
            if (home.canRead()) return
            assertTrue(result.unseen)
            assertFalse(result.storeRemoved)
            assertTrue(store.exists())
        } finally {
            Files.setPosixFilePermissions(home.toPath(), PosixFilePermissions.fromString("rwx------"))
        }
    }

    @Test fun aLinkedSymlinkStaysASymlink() {
        File(store, "link").mkdirs()
        Files.createSymbolicLink(File(store, "link/77").toPath(), Paths.get("../lib/libz.so.1"))
        val name = name("usr/lib/libz.so", "77")
        migration().run()
        assertEquals("../lib/libz.so.1", Files.readSymbolicLink(name.toPath()).toString())
    }

    @Test fun notEnoughSpaceChangesNothing() {
        obj("5", "x".repeat(10_000))
        val a = name("root/a", "5")
        val result = migration(free = 1L shl 20).run()
        assertTrue(result is TawcrootLinks.Result.NotEnoughSpace)
        assertTrue(Files.isSymbolicLink(a.toPath()))
        assertTrue(store.exists())
    }

    @Test fun aMissingObjectKeepsTheStore() {
        obj("1", "one")
        val good = name("root/good", "1")
        val dangling = name("root/dangling", "2")
        assertEquals(TawcrootLinks.Result.Done(1, false, unseen = true), migration().run())
        assertEquals("one", good.readText())
        assertTrue(Files.isSymbolicLink(dangling.toPath()))
        assertTrue(store.exists())
    }

    @Test fun aResetOnlyConvertsWhatItKeeps() {
        obj("9", "kept")
        val kept = name("root/workspace/a", "9")
        val other = name("usr/share/b", "9")
        assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = listOf("root/workspace")).run())
        assertEquals("kept", kept.readText())
        assertTrue(Files.isSymbolicLink(other.toPath()))
    }

    @Test fun leftoverCopiesFromAKilledRunAreRemoved() {
        obj("3", "data")
        name("root/n", "3")
        val stale = File(root, "root/.dsh-go-tawc-0123456789abcdef.tmp").apply { writeText("partial") }
        migration().run()
        assertFalse(Files.exists(stale.toPath(), LinkOption.NOFOLLOW_LINKS))
    }

    @Test fun interruptedNewRestoresTheMissingSourceBeforeConverting() {
        val (source, destination) = interruptedNew()
        assertFalse(Files.exists(source.toPath(), LinkOption.NOFOLLOW_LINKS))

        assertEquals(TawcrootLinks.Result.Done(2, true), migration().run())
        for (file in listOf(source, destination)) {
            assertFalse(Files.isSymbolicLink(file.toPath()))
            assertEquals("original content", file.readText())
        }
        assertFalse(store.exists())
    }

    @Test fun resetKeepsAnInterruptedNewSourceWhoseOtherNameIsOutsideKeep() {
        val skill = "root/.dsh/skills/mine/SKILL.md"
        val (source, _) = interruptedNew(sourcePath = skill)
        val journal = File(store, "intent").readBytes()
        val counts = File(store, "link/81.cnt").readBytes()
        val paths = ResetKeep.UI_AND_SKILLS.paths

        assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = paths).run())
        assertEquals("original content", source.readText())
        assertArrayEquals(journal, File(store, "intent").readBytes())
        assertArrayEquals(counts, File(store, "link/81.cnt").readBytes())
        val retired = File(files, "runtime.reset")
        val kept = File(files, "runtime-keep")
        retireRuntime(base, retired, kept, paths)

        assertEquals("original content", File(kept, skill).readText())
        assertFalse(Files.isSymbolicLink(File(kept, skill).toPath()))
        assertFalse(base.exists())
        assertFalse(retired.exists())
    }

    @Test fun firstNewBeforeTheObjectMoveIsRolledBackEvenWhenLinkDirectoryIsEmpty() {
        val (source, destination) = interruptedNew(movedSource = false)
        assertFalse(Files.newDirectoryStream(File(store, "link").toPath()).use { it.iterator().hasNext() })
        assertTrue(TawcrootLinks.pending(root))

        assertEquals(TawcrootLinks.Result.Done(0, true), migration().run())
        assertEquals("original content", source.readText())
        assertFalse(Files.exists(destination.toPath(), LinkOption.NOFOLLOW_LINKS))
        assertFalse(store.exists())
    }

    @Test fun newRecoveryDoesNotOverwriteOrDeleteALaterOccupant() {
        val (source, destination) = interruptedNew()
        source.writeText("later source")
        assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = listOf("root")).run())
        assertEquals("later source", source.readText())
        assertEquals("original content", destination.readText())
        assertTrue(Files.isSymbolicLink(File(store, "work/81.src").toPath()))
        migration().run()

        val (unmoved, replaced) = interruptedNew("82", "root/second.txt", "root/backup/second.txt", movedSource = false)
        Files.delete(replaced.toPath())
        replaced.writeText("later destination")
        migration().run()
        assertEquals("original content", unmoved.readText())
        assertEquals("later destination", replaced.readText())
    }

    @Test fun recoveryAndConversionCanResumeWithoutRecreatingAConsumedStage() {
        val (source, destination) = interruptedNew()
        val journal = File(store, "intent").readBytes()
        try {
            TawcrootLinks(root, { throw IOException("copy flush failed") }, { Long.MAX_VALUE }).run()
            fail("expected the injected flush failure")
        } catch (error: IOException) {
            assertEquals("copy flush failed", error.message)
        }
        assertArrayEquals(journal, File(store, "intent").readBytes())
        assertEquals("original content", File(store, "link/81").readText())
        assertEquals(TawcrootLinks.PREFIX + "81", Files.readSymbolicLink(source.toPath()).toString())
        assertFalse(Files.exists(File(store, "work/81.src").toPath(), LinkOption.NOFOLLOW_LINKS))

        assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = listOf("root/source.txt")).run())
        source.writeText("edited after the interrupted switch")
        assertEquals(TawcrootLinks.Result.Done(1, true), migration().run())
        assertEquals("edited after the interrupted switch", source.readText())
        assertEquals("original content", destination.readText())
    }

    @Test fun aPartialConversionLeavesAddAndDelJournalsAndCountsForTawc() {
        for (op in listOf(1, 2)) {
            val token = (90 + op).toString()
            obj(token, "kept content")
            val count = if (op == 1) 1L else 2L
            File(store, "link/$token.cnt").writeText("%010d\n".format(count))
            val kept = name("root/kept-$op", token)
            val other = File(root, "root/other-$op")
            val work = File(store, "work").apply { mkdirs() }
            val stage = File(work, "$token.${if (op == 1) "add" else "del"}")
            Files.createSymbolicLink(stage.toPath(), Paths.get(TawcrootLinks.PREFIX + token))
            val journal = intent(token, other, op = op, count = count)
            val counts = File(store, "link/$token.cnt").readBytes()

            assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = listOf("root/kept-$op")).run())
            assertEquals("kept content", kept.readText())
            assertArrayEquals(journal, File(store, "intent").readBytes())
            assertArrayEquals(counts, File(store, "link/$token.cnt").readBytes())
            assertEquals(TawcrootLinks.PREFIX + token, Files.readSymbolicLink(stage.toPath()).toString())
            store.deleteRecursively() // independent ADD and DEL interruption fixtures
        }
    }

    @Test fun anExternalNewIntentDoesNotBlockKeptResetOrTouchPhoneStorage() {
        val phone = File(files, "phone-storage").apply { mkdirs() }
        val source = File(phone, "source.txt").apply { writeText("phone original") }
        val destination = File(phone, "copy.txt")
        val journal = externalNewIntent(source, destination)
        // A later external entry is not ours to clean up, even if its token matches.
        Files.createSymbolicLink(destination.toPath(), Paths.get(TawcrootLinks.PREFIX + "83"))
        val skill = "root/.dsh/skills/mine/SKILL.md"
        obj("9", "kept skill")
        name(skill, "9")
        val paths = ResetKeep.UI_AND_SKILLS.paths

        assertEquals(TawcrootLinks.Result.Done(1, false), migration(within = paths).run())
        assertEquals(TawcrootLinks.Result.Done(0, false), migration(within = paths).run())
        assertArrayEquals(journal, File(store, "intent").readBytes())
        for (suffix in listOf("src", "dst")) {
            assertFalse(Files.exists(File(store, "work/83.$suffix").toPath(), LinkOption.NOFOLLOW_LINKS))
        }
        val retired = File(files, "runtime.reset")
        val kept = File(files, "runtime-keep")
        retireRuntime(base, retired, kept, paths)

        assertEquals("kept skill", File(kept, skill).readText())
        assertEquals("phone original", source.readText())
        assertEquals(TawcrootLinks.PREFIX + "83", Files.readSymbolicLink(destination.toPath()).toString())
        assertFalse(retired.exists())
    }

    @Test fun anExternalIntentParentDoesNotBlockFullConversionOrTouchItsTarget() {
        val phone = File(files, "phone-storage").apply { mkdirs() }
        val source = File(phone, "source.txt").apply { writeText("phone original") }
        val destination = File(phone, "copy.txt")
        val alias = File(root, "root/phone").apply { parentFile.mkdirs() }
        Files.createSymbolicLink(alias.toPath(), phone.toPath())
        externalNewIntent(File(alias, "source.txt"), File(alias, "copy.txt"))
        Files.createSymbolicLink(destination.toPath(), Paths.get(TawcrootLinks.PREFIX + "83"))
        obj("9", "local content")
        val local = name("root/workspace/local.txt", "9")

        assertEquals(TawcrootLinks.Result.Done(1, true), migration().run())
        assertEquals(TawcrootLinks.Result.Done(0, false), migration().run())
        assertEquals("local content", local.readText())
        assertEquals("phone original", source.readText())
        assertEquals(TawcrootLinks.PREFIX + "83", Files.readSymbolicLink(destination.toPath()).toString())
        assertEquals(phone.toPath(), Files.readSymbolicLink(alias.toPath()))
        assertFalse(store.exists())
    }
}
