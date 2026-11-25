package io.github.ccch1mneyyy.dsh_app.nativemedia

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClipPathTest {
    private val cache: File = Files.createTempDirectory("clip-path").toFile()
    private val owner = "0123456789abcdef0123456789abcdef"

    @After fun tearDown() {
        cache.deleteRecursively()
    }

    private fun clip(owner: String = this.owner, bytes: Int = 4): File =
        File(File(File(cache, ClipPath.DIR), owner).apply { mkdirs() }, "clip").apply { writeBytes(ByteArray(bytes)) }

    @Test fun onlyTheOwnersOwnClip() {
        val file = clip()
        assertEquals(file.canonicalFile, ClipPath.allowed(cache, owner, file.path, "audio/mpeg"))
        // Another owner's clip, another name, a relative path, a URL.
        val other = clip(owner = "fedcba9876543210fedcba9876543210")
        assertNull(ClipPath.allowed(cache, owner, other.path, "audio/mpeg"))
        assertNull(ClipPath.allowed(cache, owner, File(file.parentFile, "clip2").apply { writeBytes(ByteArray(4)) }.path, "audio/mpeg"))
        assertNull(ClipPath.allowed(cache, owner, "native-media/$owner/clip", "audio/mpeg"))
        assertNull(ClipPath.allowed(cache, owner, "https://example.com/clip", "audio/mpeg"))
    }

    @Test fun typeSizeAndOwnerShape() {
        val file = clip()
        assertNull(ClipPath.allowed(cache, owner, file.path, "text/html"))
        assertNull(ClipPath.allowed(cache, "../x", file.path, "audio/mpeg"))
        val empty = clip(owner = "00000000000000000000000000000000", bytes = 0)
        assertNull(ClipPath.allowed(cache, "00000000000000000000000000000000", empty.path, "audio/wav"))
    }

    @Test fun noSymlinkOut() {
        val outside = File(cache, "secret").apply { writeBytes(ByteArray(8)) }
        val dir = File(File(cache, ClipPath.DIR), owner).apply { mkdirs() }
        val link = File(dir, "clip")
        Files.createSymbolicLink(link.toPath(), outside.toPath())
        assertNull(ClipPath.allowed(cache, owner, link.path, "audio/mpeg"))
    }
}
