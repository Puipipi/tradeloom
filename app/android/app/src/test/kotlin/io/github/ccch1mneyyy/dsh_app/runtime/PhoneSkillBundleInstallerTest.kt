package io.github.ccch1mneyyy.dsh_app.runtime

import io.github.ccch1mneyyy.dsh_app.phone.PhoneScreen
import io.github.ccch1mneyyy.dsh_app.phone.skills.PhoneSkillRoute as R
import io.github.ccch1mneyyy.dsh_app.runtime.PhoneSkillBundleInstaller as I
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class PhoneSkillBundleInstallerTest {
    private val name = "phone-task-00000000000000000000000000000001"
    private val revision = "00000000000000000000000000000002"
    private val markdown = "# fixture\n".toByteArray()
    private val route = """{"schema":1,"skillName":"$name","bundleRevision":"$revision",
        "descriptorSet":"fixture-only","appSlots":[{"key":"app1","kind":"user_selected_app"}],
        "parameters":[],"steps":[{"op":"open_app","appSlot":"app1","screen":"main",
        "post":{"kind":"page_is","pageKey":"home"}}]}""".toByteArray()
    private val descriptors = mapOf("fixture-only" to R.Descriptor("fixture-only", setOf("app1"), emptyList(),
        setOf(R.Step(R.Op.OPEN_APP, "app1", PhoneScreen.MAIN, post = R.Post.PageIs("home")))))
    private fun document(): I.Document = (I.freeze(name, revision, 1, markdown, route, descriptors) as I.Frozen.Ready).document
    private inline fun withRoot(block: (File, File) -> Unit) {
        val root = Files.createTempDirectory("phone-bundle-install-").toFile()
        File(root, "root/.dsh").mkdirs()
        try { block(root, File(root, "root/.dsh/skills/$name")) } finally { root.deleteRecursively() }
    }

    @Test fun publishesSidecarsBeforePermissionAndSkillLastThenReadsTheRealGroup() = withRoot { root, dir ->
        val doc = document()
        var commits = 0
        val result = I.install(root, doc, { true }, {
            commits++
            assertTrue(File(dir, "route.json").isFile)
            assertTrue(File(dir, "revision.json").isFile)
            assertFalse(File(dir, "SKILL.md").exists())
            assertEquals(PhoneSkillBundleReader.Read.Rejected(PhoneSkillBundleReader.Reason.UNAVAILABLE),
                PhoneSkillBundleReader.read(root, name, revision, descriptors))
            true
        })
        assertEquals(I.Result.Saved(doc.identity), result)
        assertEquals(1, commits)
        assertArrayEquals(markdown, File(dir, "SKILL.md").readBytes())
        val read = PhoneSkillBundleReader.read(root, name, revision, descriptors) as PhoneSkillBundleReader.Read.Accepted
        assertEquals(doc.identity.skillSha256, read.skillSha256)
        assertEquals(doc.identity.routeSha256, read.routeSha256)
        assertEquals(setOf("SKILL.md", "route.json", "revision.json"), dir.list()!!.toSet())
    }

    @Test fun frozenInputsAndExposedCopiesCannotChangePublication() = withRoot { root, dir ->
        val md = markdown.copyOf(); val rt = route.copyOf(); val map = descriptors.toMutableMap()
        val doc = (I.freeze(name, revision, 1, md, rt, map) as I.Frozen.Ready).document
        md.fill(0); rt.fill(0); map.clear(); doc.bytes().forEach { it.fill(0) }
        assertEquals(I.Result.Saved(doc.identity), I.install(root, doc, { true }, { true }))
        assertArrayEquals(markdown, File(dir, "SKILL.md").readBytes())
        assertArrayEquals(route, File(dir, "route.json").readBytes())
    }

    @Test fun cancelledBeforeCommitLeavesNoPublishedSkillAndDoesNotDeleteSidecars() = withRoot { root, dir ->
        assertEquals(I.Result.Refused.STALE, I.install(root, document(), { true }, { false }))
        assertFalse(File(dir, "SKILL.md").exists())
        assertEquals(setOf("route.json", "revision.json"), dir.list()!!.toSet())
        assertTrue(PhoneSkillBundleReader.read(root, name, revision, descriptors) is PhoneSkillBundleReader.Read.Rejected)
    }

    @Test fun cancellationAfterPermissionDoesNotUndoPublication() = withRoot { root, dir ->
        var current = true
        val doc = document()
        val result = I.install(root, doc, { current }, { current = false; true })
        assertFalse(current)
        assertEquals(I.Result.Saved(doc.identity), result)
        assertTrue(File(dir, "SKILL.md").isFile)
    }

    @Test fun existingDirectoryAndPublicationConflictNeverOverwriteOrRemoveOtherContent() = withRoot { root, dir ->
        dir.mkdirs(); File(dir, "sentinel").writeText("keep")
        assertEquals(I.Result.Refused.CONFLICT, I.install(root, document(), { true }, { fail("no permit"); false }))
        assertEquals("keep", File(dir, "sentinel").readText())
        assertEquals(setOf("sentinel"), dir.list()!!.toSet())
        File(dir, "sentinel").delete(); dir.delete()
        assertEquals(I.Result.Refused.CONFLICT, I.install(root, document(), { true }, {
            File(dir, "SKILL.md").writeText("other writer")
            true
        }))
        assertEquals("other writer", File(dir, "SKILL.md").readText())
    }

    @Test fun publishedButTamperedSidecarIsUnverifiedAndNotRemovedOrReinstalled() = withRoot { root, dir ->
        val doc = document()
        val result = I.install(root, doc, { true }, {
            File(dir, "route.json").appendText(" ") // Semantically equal JSON still has different raw bytes.
            true
        })
        assertEquals(I.Result.Unverified(doc.identity, I.Publication.PUBLISHED, I.Verification.BUNDLE_INVALID), result)
        assertTrue(File(dir, "SKILL.md").isFile)
        val before = File(dir, "route.json").readBytes()
        assertEquals(I.Result.Refused.CONFLICT, I.install(root, doc, { true }, { fail("must not install again"); false }))
        assertArrayEquals(before, File(dir, "route.json").readBytes())
    }

    @Test fun committedButMissingSidecarDoesNotBecomeDefinitelyUnwritten() = withRoot { root, dir ->
        val doc = document()
        assertEquals(I.Result.Unverified(doc.identity, I.Publication.PUBLISHED, I.Verification.BUNDLE_INVALID),
            I.install(root, doc, { true }, { File(dir, "revision.json").delete(); true }))
        assertTrue(File(dir, "SKILL.md").isFile)
    }

    @Test fun selfConsistentReadbackCannotChangeTheFrozenDraftRevision() = withRoot { root, dir ->
        val doc = document()
        val result = I.install(root, doc, { true }, {
            val manifest = File(dir, "revision.json")
            manifest.writeText(manifest.readText().replace("\"draftRevision\":1", "\"draftRevision\":2"))
            true
        })
        assertEquals(I.Result.Unverified(doc.identity, I.Publication.PUBLISHED, I.Verification.BUNDLE_INVALID), result)
        val read = PhoneSkillBundleReader.read(root, name, revision, descriptors) as PhoneSkillBundleReader.Read.Accepted
        assertEquals(2L, read.draftRevision) // Valid current bundle is not the original confirmed bundle.
        assertTrue(File(dir, "SKILL.md").isFile)
    }

    @Test fun invalidInputsAreRejectedByTheSharedValidatorBeforeAnyIo() {
        for ((n, rev, draft) in listOf(Triple("../escape", revision, 1L), Triple(name, "bad", 1L), Triple(name, revision, 0L))) {
            assertTrue(I.freeze(n, rev, draft, markdown, route, descriptors) is I.Frozen.Refused)
        }
        for ((md, rt) in listOf(ByteArray(32769) to route, markdown to ByteArray(16385),
            byteArrayOf(0xc3.toByte(), 0x28) to route, markdown to "{}".toByteArray())) {
            assertTrue(I.freeze(name, revision, 1, md, rt, descriptors) is I.Frozen.Refused)
        }
    }

    @Test fun noHomeSymlinkAndStageRefusalDoNotAcquirePermission() = withRoot { root, dir ->
        assertEquals(I.Result.Refused.STALE, I.install(root, document(), { false }, { fail("no permit"); false }))
        assertFalse(dir.exists())
        val home = File(root, "root/.dsh"); home.delete()
        val target = File(root, "other").apply { mkdirs() }
        Files.createSymbolicLink(home.toPath(), target.toPath())
        assertEquals(I.Result.Refused.NO_HOME, I.install(root, document(), { true }, { fail("no permit"); false }))
        assertEquals(emptySet<String>(), target.list()!!.toSet())
    }
}
