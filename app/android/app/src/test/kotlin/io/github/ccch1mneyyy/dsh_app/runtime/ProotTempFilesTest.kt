package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProotTempFilesTest {
    @get:Rule val fixture = TemporaryFolder()

    private fun directory(path: Path): Path = Files.createDirectories(path)
    private fun file(path: Path): Path = path.also { it.toFile().writeText("keep") }
    private fun exists(path: Path) = Files.exists(path, NOFOLLOW_LINKS)
    private fun store(): Path = directory(fixture.root.toPath().resolve("cache/proot-tmp"))

    @Test fun removesOnlyStrictlyNamedDirectoriesWhosePidIsConfirmedGone() {
        val root = store()
        val stale = directory(root.resolve("proot-42-AbC123/a/b"))
        file(stale.resolve("placeholder"))
        val kept = listOf("unrelated", "proot-0-abcdef", "proot-042-abcdef", "proot-2147483648-abcdef",
            "proot-43-short", "proot-tmpfs--44-abcdef", "proot-45-abcdef-extra")
            .map { directory(root.resolve(it)) }
        val regular = file(root.resolve("proot-46-abcdef"))
        val backing = file(directory(fixture.root.toPath().resolve("root/.l2s")).resolve("persistent"))
        val probed = mutableListOf<Int>()
        val result = ProotTempFiles.prune(root.toFile()) { probed += it; it == 42 }
        assertEquals(ProotTempFiles.Result(1, false), result)
        assertEquals(listOf(42), probed)
        assertFalse(exists(root.resolve("proot-42-AbC123")))
        assertTrue(kept.all(::exists))
        assertTrue(exists(regular) && exists(backing))
    }

    @Test fun liveReusedAndUnreadablePidsAreRetained() {
        val root = store()
        val live = directory(root.resolve("proot-42-abcdef"))
        val unknown = directory(root.resolve("proot-43-abcdef"))
        val result = ProotTempFiles.prune(root.toFile()) {
            if (it == 43) throw IOException("controlled /proc denial")
            false // An existing PID is retained even if it now belongs to someone else.
        }
        assertEquals(0, result.removed)
        assertTrue(exists(live) && exists(unknown))
    }

    @Test fun usesRealProcAbsenceRatherThanAnUnreadableStatFile() {
        val root = store()
        val livePid = File("/proc/self").canonicalFile.name.toInt()
        val live = directory(root.resolve("proot-$livePid-abcdef"))
        val dead = directory(root.resolve("proot-2147483647-abcdef"))
        val result = ProotTempFiles.prune(root.toFile()) { pid ->
            try {
                Files.readAttributes(Path.of("/proc/$pid"), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
                false
            } catch (_: java.nio.file.NoSuchFileException) { true }
        }
        assertEquals(1, result.removed)
        assertTrue(exists(live))
        assertFalse(exists(dead))
    }

    @Test fun doesNotFollowCandidateOrNestedSymlinks() {
        val root = store()
        val outside = directory(fixture.root.toPath().resolve("outside"))
        val sentinel = file(outside.resolve("sentinel"))
        val linked = Files.createSymbolicLink(root.resolve("proot-41-abcdef"), outside)
        val stale = directory(root.resolve("proot-42-abcdef"))
        Files.createSymbolicLink(stale.resolve("external"), outside)
        Files.createSymbolicLink(stale.resolve("external-file"), sentinel)
        Files.createSymbolicLink(stale.resolve("dangling"), outside.resolve("missing"))
        assertEquals(ProotTempFiles.Result(1, false), ProotTempFiles.prune(root.toFile()) { true })
        assertTrue(exists(linked))
        assertEquals("keep", sentinel.toFile().readText())
        assertFalse(exists(stale))
    }

    @Test fun refusesASymlinkedStoreOrCacheParent() {
        val outside = directory(fixture.root.toPath().resolve("outside/proot-tmp/proot-42-abcdef"))
        val sentinel = file(outside.resolve("sentinel"))
        val cache = directory(fixture.root.toPath().resolve("cache"))
        val storeLink = Files.createSymbolicLink(cache.resolve("proot-tmp"), outside.parent)
        assertEquals(0, ProotTempFiles.prune(storeLink.toFile()) { true }.removed)
        val parentLink = Files.createSymbolicLink(fixture.root.toPath().resolve("cache-link"), outside.parent.parent)
        assertEquals(0, ProotTempFiles.prune(parentLink.resolve("proot-tmp").toFile()) { true }.removed)
        assertEquals("keep", sentinel.toFile().readText())
    }

    @Test fun aCandidateReplacedByASymlinkDuringThePidCheckCannotEscape() {
        val root = store()
        val stale = directory(root.resolve("proot-42-abcdef"))
        val outside = directory(fixture.root.toPath().resolve("outside"))
        val sentinel = file(outside.resolve("sentinel"))
        val result = ProotTempFiles.prune(root.toFile()) {
            Files.move(stale, root.resolve("moved"))
            Files.createSymbolicLink(stale, outside)
            true
        }
        assertEquals(0, result.removed)
        assertTrue(Files.isSymbolicLink(stale))
        assertEquals("keep", sentinel.toFile().readText())
    }

    @Test fun replacingTheStorePathDoesNotRedirectAnAlreadyOpenedDirectory() {
        val root = store()
        directory(root.resolve("proot-42-abcdef"))
        val outside = directory(fixture.root.toPath().resolve("outside/proot-42-abcdef"))
        val sentinel = file(outside.resolve("sentinel"))
        val moved = root.resolveSibling("old-temp")
        val result = ProotTempFiles.prune(root.toFile()) {
            Files.move(root, moved)
            Files.createSymbolicLink(root, outside.parent)
            true
        }
        assertEquals(ProotTempFiles.Result(1, false), result)
        assertFalse(exists(moved.resolve("proot-42-abcdef")))
        assertEquals("keep", sentinel.toFile().readText())
    }

    @Test fun aDisappearingCandidateAndMissingStoreAreHarmless() {
        val root = store()
        val stale = directory(root.resolve("proot-42-abcdef"))
        val result = ProotTempFiles.prune(root.toFile()) { Files.delete(stale); true }
        assertEquals(ProotTempFiles.Result(0, false), result)
        assertEquals(ProotTempFiles.Result(0, false), ProotTempFiles.prune(root.resolve("missing").toFile()) { true })
    }
}
