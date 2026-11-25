package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class RuntimeHomeSwapTest {
    private fun layout(vararg paths: String): File {
        val base = Files.createTempDirectory("rootfs-swap").toFile()
        for (path in paths) File(base, path).apply { parentFile!!.mkdirs() }.writeText(path.substringAfterLast('/'))
        return base
    }

    /** What install() has extracted when it calls [activateRootfs]. */
    private fun extract(base: File) {
        for (path in listOf("staging/bin/new", "staging/root/skeleton")) {
            File(base, path).apply { parentFile!!.mkdirs() }.writeText("shipped")
        }
    }

    private fun assertActivated(base: File) {
        assertEquals("notes", File(base, "rootfs/root/workspace/notes").readText())
        assertTrue(File(base, "rootfs/bin/new").isFile)
        assertFalse(File(base, "rootfs/bin/old").exists())
        assertFalse(File(base, "rootfs/root/skeleton").exists())
        assertEquals("r2", File(base, "rootfs.version").readText())
        for (gone in listOf("staging", "home.carry", "rootfs.old")) assertFalse(gone, File(base, gone).exists())
    }

    @Test fun upgradeCarriesTheUserHomeOver() {
        val base = layout("rootfs/bin/old", "rootfs/root/workspace/notes")
        try {
            extract(base)
            activateRootfs(base, "r2", sync = {})
            assertActivated(base)
        } finally {
            base.deleteRecursively()
        }
    }

    @Test fun anUpgradeKilledAtAnyStepKeepsTheHomeOnTheNextInstall() {
        // What a kill after each step leaves on disk; the next install extracts staging again.
        val interrupted = listOf(
            arrayOf("rootfs/bin/old", "home.carry/workspace/notes"),
            arrayOf("rootfs.old/bin/old", "home.carry/workspace/notes"),
            arrayOf("rootfs.old/bin/old", "rootfs/bin/new", "rootfs/root/skeleton", "home.carry/workspace/notes"),
            arrayOf("rootfs.old/bin/old", "rootfs/bin/new", "rootfs/root/workspace/notes"),
        )
        for (paths in interrupted) {
            val base = layout(*paths)
            try {
                extract(base)
                activateRootfs(base, "r2", sync = {})
                assertActivated(base)
            } finally {
                base.deleteRecursively()
            }
        }
    }
}
