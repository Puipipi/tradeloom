package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class DirectAliasMarkerBoundaryTest {
    @Test fun preservingOldConfigReplacesAMarkerSymlinkWithoutWritingItsTarget() {
        val base = Files.createTempDirectory("direct-marker-link").toFile()
        try {
            val root = File(base, "rootfs")
            File(root, "root").mkdirs()
            File(root, "opt/dsh-app/direct").mkdirs()
            File(root, "opt/dsh-app/direct/config.json").writeText("{\"schema\":2}")
            val target = File(base, "untouched").apply { writeText("unrelated bytes\n") }
            val marker = File(root, "root/.dsh-go-direct-path-alias")
            Files.createSymbolicLink(marker.toPath(), target.toPath())
            DirectLaunch.preservePhysicalAlias(root)
            assertFalse(Files.isSymbolicLink(marker.toPath()))
            assertEquals("v1\n${root.canonicalPath}\n", marker.readText())
            assertEquals("unrelated bytes\n", target.readText())
        } finally { base.deleteRecursively() }
    }

    @Test fun oldConfigCannotMakeTheMarkerWriterFollowASymlinkedHome() {
        val base = Files.createTempDirectory("direct-home-link").toFile()
        try {
            val root = File(base, "rootfs")
            File(root, "opt/dsh-app/direct").mkdirs()
            File(root, "opt/dsh-app/direct/config.json").writeText("{\"schema\":2}")
            val unrelated = File(base, "unrelated-home").apply { mkdirs() }
            Files.createSymbolicLink(File(root, "root").toPath(), unrelated.toPath())
            assertThrows(IllegalStateException::class.java) { DirectLaunch.preservePhysicalAlias(root) }
            assertTrue(unrelated.listFiles().orEmpty().isEmpty())
        } finally { base.deleteRecursively() }
    }
}
