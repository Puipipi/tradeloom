package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class RuntimeDurabilityTest {
    private val base = Files.createTempDirectory("rootfs-durable").toFile()
    private val version = File(base, "rootfs.version")
    private val keep = File(base.parentFile, "${base.name}-keep")

    @After fun cleanup() {
        base.deleteRecursively()
        keep.deleteRecursively()
    }

    private fun write(path: String, value: String) {
        File(base, path).apply { parentFile!!.mkdirs(); writeText(value) }
    }

    private fun stage() {
        write("staging/bin/new", "new runtime")
        write("staging/root/skeleton", "fresh home")
    }

    private fun installed() {
        write("rootfs/bin/old", "old runtime")
        write("rootfs/root/workspace/notes", "user notes")
        version.writeText("same-version")
        stage()
    }

    @Test fun theReadyMarkerFollowsRestoredDataAndTheDataBarrierEvenForTheSameVersion() {
        installed()
        File(keep, "root/.dsh/dsh-go/ui.json").apply {
            parentFile!!.mkdirs()
            writeText("kept settings")
        }
        val order = mutableListOf<String>()
        activateRootfs(base, "same-version", keep, sync = {
            assertFalse(version.exists())
            assertEquals("new runtime", File(base, "rootfs/bin/new").readText())
            assertEquals("user notes", File(base, "rootfs/root/workspace/notes").readText())
            assertEquals("kept settings", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
            assertTrue(File(base, "rootfs.old/bin/old").isFile)
            order.add("data")
        }, syncDirectory = { directory ->
            assertEquals(base, directory)
            if (order.isEmpty()) {
                assertFalse(version.exists())
                assertTrue(File(base, "rootfs/bin/old").isFile)
                assertTrue(File(base, "staging/bin/new").isFile)
                order.add("retire")
            } else {
                assertEquals(listOf("retire", "data"), order)
                assertEquals("same-version", version.readText())
                assertFalse(Files.exists(File(base, "rootfs.version.next").toPath(), NOFOLLOW_LINKS))
                assertTrue(File(base, "rootfs.old/bin/old").isFile)
                order.add("publish")
            }
            syncDirectory(directory)
        })
        assertEquals(listOf("retire", "data", "publish"), order)
        assertEquals("same-version", version.readText())
        assertFalse(File(base, "rootfs.old").exists())
    }

    @Test fun aFailedRetirementBarrierLeavesTheActiveTreeAndHomeUntouched() {
        installed()
        val failure = IOException("directory sync failed")
        val actual = assertThrows(IOException::class.java) {
            activateRootfs(base, "same-version", sync = { fail("data barrier reached") },
                syncDirectory = { throw failure })
        }
        assertSame(failure, actual)
        assertEquals("old runtime", File(base, "rootfs/bin/old").readText())
        assertEquals("user notes", File(base, "rootfs/root/workspace/notes").readText())
        assertTrue(File(base, "staging/bin/new").isFile)
        assertFalse(File(base, "home.carry").exists())
        assertFalse(version.exists())
    }

    @Test fun aFailedDataBarrierLeavesNoReadyMarkerAndARealRetryKeepsTheHome() {
        installed()
        val failure = IOException("sync process failed")
        val actual = assertThrows(IOException::class.java) {
            activateRootfs(base, "same-version", sync = { throw failure })
        }
        assertSame(failure, actual)
        assertFalse(version.exists())
        assertTrue(File(base, "rootfs.old/bin/old").isFile)
        assertEquals("user notes", File(base, "rootfs/root/workspace/notes").readText())
        stage()
        activateRootfs(base, "same-version", sync = {})
        assertEquals("same-version", version.readText())
        assertEquals("user notes", File(base, "rootfs/root/workspace/notes").readText())
    }

    @Test fun firstInstallReplacesAnUnpublishedTemporaryBeforeItsPublicationBarrier() {
        stage()
        write("rootfs.version.next", "partial")
        File(keep, "root/.dsh/dsh-go/ui.json").apply {
            parentFile!!.mkdirs()
            writeText("kept settings")
        }
        val order = mutableListOf<String>()
        val failure = IOException("publication directory sync failed")
        val actual = assertThrows(IOException::class.java) {
            activateRootfs(base, "new-version", keep, sync = {
                assertFalse(Files.exists(version.toPath(), NOFOLLOW_LINKS))
                assertEquals("kept settings", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
                order.add("data")
            }, syncDirectory = { directory ->
                assertEquals(base, directory)
                assertEquals(listOf("data"), order)
                assertEquals("new-version", version.readText())
                assertFalse(Files.exists(File(base, "rootfs.version.next").toPath(), NOFOLLOW_LINKS))
                order.add("publish")
                throw failure
            })
        }
        assertSame(failure, actual)
        assertEquals(listOf("data", "publish"), order)
        assertEquals("new-version", version.readText())
        assertEquals("new runtime", File(base, "rootfs/bin/new").readText())
        assertEquals("kept settings", File(base, "rootfs/root/.dsh/dsh-go/ui.json").readText())
    }

    @Test fun aFailedTemporaryRemovalDoesNotPublishTheFirstInstallMarker() {
        stage()
        write("rootfs.version.next/entry", "untouched")
        var synced = false
        assertThrows(IOException::class.java) {
            activateRootfs(base, "new-version", sync = { synced = true },
                syncDirectory = { fail("publication barrier reached") })
        }
        assertTrue(synced)
        assertFalse(Files.exists(version.toPath(), NOFOLLOW_LINKS))
        assertEquals("untouched", File(base, "rootfs.version.next/entry").readText())
        assertEquals("new runtime", File(base, "rootfs/bin/new").readText())
    }
}
