package io.github.ccch1mneyyy.dsh_app.links

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class LinkSurrogateNameTest {
    @Test fun unpairedUnitsAreReplacedBeforeShortNamesReturn() {
        assertEquals("\uFFFD.txt", LinksPlugin.safeName("\uD800.txt"))
        assertEquals("a\uFFFDb\uFFFD", LinksPlugin.safeName("a\uDC00b\uD800"))
        assertEquals("\uFFFD\uFFFD", LinksPlugin.safeName("\uD800\uD800"))
        assertEquals("\uFFFD\uD83D\uDE00", LinksPlugin.safeName("\uD800\uD83D\uDE00"))
    }

    @Test fun replacementBytesAreCountedBeforeTheLengthDecision() {
        val input = "界".repeat(84) + "\uDC00\uD800"
        val name = LinksPlugin.safeName(input)
        assertEquals("界".repeat(84) + "\uFFFD", name)
        assertEquals(255, name.toByteArray(Charsets.UTF_8).size)
        assertEquals("界".repeat(83) + ".dshgo", LinksPlugin.safeName(input + ".dshgo"))
        assertEquals("a".repeat(118) + ".\uFFFD", LinksPlugin.safeName("a".repeat(120) + ".\uD800"))
    }

    @Test fun completePairsAndValidUnicodeKeepTheirExistingShape() {
        val emoji = "\uD83D\uDE00"
        assertEquals("a" + emoji + ".dshgo", LinksPlugin.safeName("a" + emoji + ".dshgo"))
        assertEquals(emoji.repeat(60), LinksPlugin.safeName(emoji.repeat(100)))
        assertEquals("界".repeat(83) + ".dshgo", LinksPlugin.safeName("界".repeat(120) + ".dshgo"))
    }

    @Test fun normalizedReturnedNamesCreateRealFiles() {
        val root = Files.createTempDirectory("link-surrogate-name").toFile()
        try {
            for (input in listOf("x\uD800.txt", "界".repeat(84) + "\uDC00\uD800")) {
                val name = LinksPlugin.safeName(input)
                assertTrue(name.toByteArray(Charsets.UTF_8).size <= 255)
                assertFalse(name.any { Character.isSurrogate(it) })
                val target = File(root, name)
                target.writeBytes(byteArrayOf(1, 2, 3))
                assertTrue(target.isFile)
                assertEquals(3L, target.length())
                assertEquals(name, target.name)
            }
        } finally { root.deleteRecursively() }
    }
}
