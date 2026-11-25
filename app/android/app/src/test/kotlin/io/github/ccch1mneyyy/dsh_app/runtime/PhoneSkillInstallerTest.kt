package io.github.ccch1mneyyy.dsh_app.runtime

import io.github.ccch1mneyyy.dsh_app.phone.PhoneScreen
import io.github.ccch1mneyyy.dsh_app.phone.PhoneTasks
import io.github.ccch1mneyyy.dsh_app.phone.skills.PhoneSkillDraft
import io.github.ccch1mneyyy.dsh_app.phone.skills.PhoneTaskTrace
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class PhoneSkillInstallerTest {
    private val name = "phone-task-0123456789abcdef0123456789abcdef"
    private fun document(): PhoneSkillDraft.Ready {
        val owner = (PhoneTasks().begin() as PhoneTasks.Begin.Go).owner
        val trace = PhoneTaskTrace()
        trace.start(owner)
        val ticket = trace.beginOpen(owner, PhoneScreen.MAIN)
        trace.finish(ticket, ok = true, staleRejected = false, postObservationAvailable = true)
        trace.complete(owner, eligible = true)
        return PhoneSkillDraft.render(trace.snapshot(owner), name, true) as PhoneSkillDraft.Ready
    }
    private inline fun withRoot(block: (File) -> Unit) {
        val root = Files.createTempDirectory("phone-skill-").toFile()
        File(root, "root/.dsh").mkdirs()
        try { block(root) } finally { root.deleteRecursively() }
    }
    private fun directory(root: File) = File(root, "root/.dsh/skills/$name")
    private fun install(root: File, write: PhoneSkillWrite) = PhoneSkillInstaller.install(
        root, write.document, write::canStage, write::beginCommit,
    ).also(write::finish)

    @Test fun publishesExactRenderedBytesAndRemovesOnlyItsStage() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        val result = install(root, write) as PhoneSkillInstallResult.Saved
        assertEquals(name, result.name)
        assertEquals("skills/$name/SKILL.md", result.relativePath)
        assertArrayEquals(write.document.markdown.toByteArray(Charsets.UTF_8), File(directory(root), "SKILL.md").readBytes())
        assertEquals(listOf("SKILL.md"), directory(root).list()!!.toList())
        assertSame(result, write.result())
        assertFalse(write.cancel())
    }

    @Test fun anExistingUserDirectoryIsNeverOverwrittenOrCleaned() = withRoot { root ->
        val dir = directory(root).apply { mkdirs() }
        File(dir, "SKILL.md").writeText("user-owned")
        File(dir, "notes.txt").writeText("keep")
        assertEquals(PhoneSkillInstallResult.Refused.CONFLICT, install(root, PhoneSkillWrite(document())))
        assertEquals("user-owned", File(dir, "SKILL.md").readText())
        assertEquals("keep", File(dir, "notes.txt").readText())
        assertFalse(File(dir, ".SKILL.tmp").exists())
    }

    @Test fun cancelBeforeStagingCreatesNoSkillParent() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        assertTrue(write.cancel())
        assertEquals(PhoneSkillInstallResult.Refused.STALE, install(root, write))
        assertFalse(File(root, "root/.dsh/skills").exists())
    }

    @Test fun cancellationAfterFileFlushButBeforeCommitRemovesTheUnpublishedDraft() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        val result = PhoneSkillInstaller.install(root, write.document, write::canStage, beginCommit = {
            assertTrue(File(directory(root), ".SKILL.tmp").length() > 0)
            assertFalse(File(directory(root), "SKILL.md").exists())
            assertTrue(write.cancel())
            write.beginCommit()
        })
        assertEquals(PhoneSkillInstallResult.Refused.STALE, result)
        assertFalse(directory(root).exists())
    }

    @Test fun closingAfterCommitPermissionCannotMisreportARealSaveAsStale() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        val result = PhoneSkillInstaller.install(root, write.document, write::canStage, beginCommit = {
            assertTrue(write.beginCommit())
            assertFalse(write.cancel())
            true
        })
        write.finish(result)
        assertTrue(write.result() is PhoneSkillInstallResult.Saved)
        assertTrue(File(directory(root), "SKILL.md").isFile)
    }

    @Test fun aFinalNameCreatedAtPublicationIsNotReplacedByAnAtomicMove() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        val result = PhoneSkillInstaller.install(root, write.document, write::canStage, beginCommit = {
            File(directory(root), "SKILL.md").writeText("another-writer")
            write.beginCommit()
        })
        assertEquals(PhoneSkillInstallResult.Refused.CONFLICT, result)
        assertEquals("another-writer", File(directory(root), "SKILL.md").readText())
        assertFalse(File(directory(root), ".SKILL.tmp").exists())
    }

    @Test fun failedCommitDoesNotRecursivelyRemoveAnUnrelatedFile() = withRoot { root ->
        val write = PhoneSkillWrite(document())
        val result = PhoneSkillInstaller.install(root, write.document, write::canStage, beginCommit = {
            File(directory(root), "notes.txt").writeText("other-file")
            false
        })
        assertEquals(PhoneSkillInstallResult.Refused.STALE, result)
        assertEquals("other-file", File(directory(root), "notes.txt").readText())
        assertFalse(File(directory(root), "SKILL.md").exists())
        assertFalse(File(directory(root), ".SKILL.tmp").exists())
    }

    @Test fun missingHomeCreatesNothing() = withRoot { root ->
        File(root, "root").deleteRecursively()
        assertEquals(PhoneSkillInstallResult.Refused.NO_HOME, install(root, PhoneSkillWrite(document())))
        assertFalse(File(root, "root").exists())
    }

    @Test fun skillsSymlinkCannotRedirectTheWriteOutsideTheRuntime() = withRoot { root ->
        val outside = Files.createTempDirectory("phone-skill-outside-").toFile()
        try {
            Files.createSymbolicLink(File(root, "root/.dsh/skills").toPath(), outside.toPath())
            assertEquals(PhoneSkillInstallResult.Refused.NO_HOME, install(root, PhoneSkillWrite(document())))
            assertEquals(0, outside.list()!!.size)
        } finally { outside.deleteRecursively() }
    }

    @Test fun homeSymlinkCannotRedirectTheWriteOutsideTheRuntime() = withRoot { root ->
        val outside = Files.createTempDirectory("phone-skill-home-").toFile()
        try {
            assertTrue(File(root, "root/.dsh").delete())
            Files.createSymbolicLink(File(root, "root/.dsh").toPath(), outside.toPath())
            assertEquals(PhoneSkillInstallResult.Refused.NO_HOME, install(root, PhoneSkillWrite(document())))
            assertEquals(0, outside.list()!!.size)
        } finally { outside.deleteRecursively() }
    }

    @Test fun concurrentSameNameHasExactlyOnePublisher() = withRoot { root ->
        val ready = CountDownLatch(2)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val doc = document()
            val futures = (1..2).map {
                pool.submit<PhoneSkillInstallResult> {
                    PhoneSkillInstaller.install(root, doc, canStage = {
                        ready.countDown()
                        assertTrue(ready.await(5, TimeUnit.SECONDS))
                        true
                    }, beginCommit = { true })
                }
            }
            val results = futures.map { it.get(5, TimeUnit.SECONDS) }
            assertEquals(1, results.count { it is PhoneSkillInstallResult.Saved })
            assertEquals(1, results.count { it == PhoneSkillInstallResult.Refused.CONFLICT })
            assertArrayEquals(doc.markdown.toByteArray(Charsets.UTF_8), File(directory(root), "SKILL.md").readBytes())
            assertEquals(listOf("SKILL.md"), directory(root).list()!!.toList())
        } finally { pool.shutdownNow() }
    }
}
