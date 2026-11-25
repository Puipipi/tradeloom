package io.github.ccch1mneyyy.dsh_app.links

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class LinkDirectoryNameTest {
    @Test fun directoryOnlyProviderNamesUseTheExistingFallback() {
        for (value in listOf(".", "..", "folder/.", "folder/..", "  .  ", " .. ")) {
            assertEquals(value, "shared", LinksPlugin.safeName(value))
        }
    }

    @Test fun fallbackCreatesAFileInsideItsCopySlot() {
        val slot = Files.createTempDirectory("link-directory-name").toFile()
        try {
            for (value in listOf(".", "..")) {
                val target = File(slot, LinksPlugin.safeName(value))
                assertEquals(slot.canonicalFile, target.canonicalFile.parentFile)
                target.writeBytes(byteArrayOf(1, 2, 3))
                assertTrue(target.isFile)
                assertEquals(3L, target.length())
            }
        } finally { slot.deleteRecursively() }
    }

    @Test fun ordinaryDotsAndExtensionRoutingKeepTheirNames() {
        for (value in listOf(".hidden", "...", "file.", "a..b", "profile.dshgo", ".dshgo")) {
            assertEquals(value, LinksPlugin.safeName(value))
        }
    }
}
