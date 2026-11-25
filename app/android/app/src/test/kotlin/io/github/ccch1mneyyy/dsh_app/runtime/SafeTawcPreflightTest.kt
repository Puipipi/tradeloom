package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Paths
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class SafeTawcPreflightTest {
    private val base = Files.createTempDirectory("safe-tawc-preflight-").toFile()
    private val root = File(base, "rootfs").apply { File(this, "root/.dsh").mkdirs() }

    @After fun cleanUp() { base.deleteRecursively() }

    /** A completed tawc NEW leaves both original and backup as opaque names. */
    private fun linked(path: String, text: String, token: String): File {
        val obj = File(base, "tawcroot/link/$token").apply { parentFile!!.mkdirs(); writeText(text) }
        File(obj.parentFile, "$token.cnt").writeText("0000000002\n")
        val target = Paths.get("tawcroot:link:$token")
        Files.createSymbolicLink(SafeMode.guestFile(root, path).toPath(), target)
        Files.createSymbolicLink(File(root, "root/backup-$token").toPath(), target)
        return obj
    }

    @Test fun cwdEnvIsReportedAndConfirmedMoveKeepsBothCopiesBeforeMaterialization() {
        val path = "/root/.env"
        val original = "NODE_OPTIONS=--trace-warnings\n"
        val obj = linked(path, original, "123")
        val file = SafeMode.guestFile(root, path)
        val backup = File(root, "root/backup-123")
        assertFalse(file.isFile)

        val hazards = SafeMode.preflight(root)
        assertEquals(listOf(path), hazards.map { it.path })
        assertEquals("cwdEnv", hazards.single().kind)
        assertTrue(hazards.single().detail.contains("NODE_OPTIONS"))
        assertEquals("tawcroot:link:123", Files.readSymbolicLink(file.toPath()).toString())
        assertEquals(original, obj.readText())
        assertTrue(SafeMode.moveAside(root, emptyList(), "test").moved.isEmpty())
        assertTrue(Files.isSymbolicLink(file.toPath())) // Discovery alone is not permission to move.

        val moved = SafeMode.moveAside(root, hazards.map { it.path }, "test")
        assertNull(moved.failure)
        assertEquals(listOf(path to "$path.off-test"), moved.moved)
        val off = SafeMode.guestFile(root, moved.moved.single().second)
        assertFalse(Files.exists(file.toPath(), NOFOLLOW_LINKS))
        assertEquals("tawcroot:link:123", Files.readSymbolicLink(off.toPath()).toString())
        assertEquals("tawcroot:link:123", Files.readSymbolicLink(backup.toPath()).toString())
        assertEquals(original, obj.readText())

        // The same production conversion used before PRoot startup preserves the renamed bytes.
        assertEquals(TawcrootLinks.Result.Done(2, true),
            TawcrootLinks(root, flush = {}, freeBytes = { Long.MAX_VALUE }).run())
        assertEquals(original, off.readText())
        assertEquals(original, backup.readText())
        assertFalse(Files.exists(file.toPath(), NOFOLLOW_LINKS))
        assertTrue(SafeMode.preflight(root).isEmpty())
    }

    @Test fun tokenContentsKeepTheExistingHomeProxyAndTrivialPatchRules() {
        val patch = linked("/root/.dsh/cordis.patch.yml", "# unchanged\n[]\n", "1")
        val homeEnv = linked("/root/.dsh/.env", "HTTP_PROXY=http://proxy.invalid\n", "2")
        linked("/root/.env", "HTTP_PROXY=http://proxy.invalid\n", "3-1")
        assertEquals(listOf("/root/.env"), SafeMode.preflight(root).map { it.path })

        patch.writeText("[{ id: fixture, disabled: true }]\n")
        homeEnv.appendText("PATH=/fixture-only\n")
        val hazards = SafeMode.preflight(root)
        assertEquals(SafeMode.MOVABLE, hazards.map { it.path })
        assertEquals(listOf("homePatch", "homeEnv", "cwdEnv"), hazards.map { it.kind })
        for (path in SafeMode.MOVABLE) assertTrue(Files.isSymbolicLink(SafeMode.guestFile(root, path).toPath()))
    }

    @Test fun missingObjectsAndUnselectedPathsAreNotMoved() {
        val missing = SafeMode.guestFile(root, "/root/.env")
        Files.createSymbolicLink(missing.toPath(), Paths.get("tawcroot:link:404"))
        val foreignPath = "/root/not-selected"
        val obj = linked(foreignPath, "unselected\n", "123")
        assertTrue(SafeMode.preflight(root).isEmpty())
        val moved = SafeMode.moveAside(root, listOf("/root/.env", foreignPath), "test")
        assertNull(moved.failure)
        assertTrue(moved.moved.isEmpty())
        assertEquals("tawcroot:link:404", Files.readSymbolicLink(missing.toPath()).toString())
        assertTrue(Files.isSymbolicLink(SafeMode.guestFile(root, foreignPath).toPath()))
        assertEquals("unselected\n", obj.readText())
    }
}
