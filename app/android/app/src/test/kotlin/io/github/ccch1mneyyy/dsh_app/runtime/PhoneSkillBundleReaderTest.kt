package io.github.ccch1mneyyy.dsh_app.runtime

import io.github.ccch1mneyyy.dsh_app.phone.Json
import io.github.ccch1mneyyy.dsh_app.phone.PhoneScreen
import io.github.ccch1mneyyy.dsh_app.phone.skills.PhoneSkillRoute as R
import java.io.File
import java.math.BigInteger
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class PhoneSkillBundleReaderTest {
    private val name = "phone-task-00000000000000000000000000000001"
    private val revision = "00000000000000000000000000000002"
    private val markdown = "# fixture\n".toByteArray(Charsets.UTF_8)
    private val route = ("""{"schema":1,"skillName":"$name","bundleRevision":"$revision",
        "descriptorSet":"fixture-only","appSlots":[{"key":"app1","kind":"user_selected_app"}],
        "parameters":[],"steps":[{"op":"open_app","appSlot":"app1","screen":"main",
        "post":{"kind":"page_is","pageKey":"home"}}]}""").toByteArray(Charsets.UTF_8)
    private val descriptors = mapOf("fixture-only" to R.Descriptor("fixture-only", setOf("app1"), emptyList(),
        setOf(R.Step(R.Op.OPEN_APP, "app1", PhoneScreen.MAIN, post = R.Post.PageIs("home")))))

    private fun digest(bytes: ByteArray) = BigInteger(1, MessageDigest.getInstance("SHA-256").digest(bytes))
        .toString(16).padStart(64, '0')
    private fun manifest(md: ByteArray = markdown, rt: ByteArray = route, draft: Long = 1L): ByteArray =
        Json.write(linkedMapOf("schema" to 1, "bundleRevision" to revision, "draftRevision" to draft,
            "skillSha256" to digest(md), "routeSha256" to digest(rt))).toByteArray(Charsets.UTF_8)
    private fun validate(md: ByteArray = markdown, rt: ByteArray = route, mf: ByteArray = manifest(md, rt),
        expected: String? = revision) = PhoneSkillBundleReader.validate(name, expected, md, rt, mf, descriptors)
    private fun rejected(reason: PhoneSkillBundleReader.Reason, result: PhoneSkillBundleReader.Read) =
        assertEquals(PhoneSkillBundleReader.Read.Rejected(reason), result)
    private fun accepted(result: PhoneSkillBundleReader.Read): PhoneSkillBundleReader.Read.Accepted {
        assertTrue(result is PhoneSkillBundleReader.Read.Accepted)
        return result as PhoneSkillBundleReader.Read.Accepted
    }
    private inline fun withRoot(block: (File, File) -> Unit) {
        val root = Files.createTempDirectory("phone-skill-bundle-").toFile()
        val dir = File(root, "root/.dsh/skills/$name").apply { mkdirs() }
        try { block(root, dir) } finally { root.deleteRecursively() }
    }
    private fun publish(dir: File, md: ByteArray = markdown, rt: ByteArray = route, mf: ByteArray = manifest(md, rt)) {
        File(dir, "route.json").writeBytes(rt)
        File(dir, "revision.json").writeBytes(mf)
        File(dir, "SKILL.md").writeBytes(md) // This test fixture publishes last, like the specified installer.
    }
    private fun read(root: File, expected: String? = revision) = PhoneSkillBundleReader.read(root, name, expected, descriptors)

    @Test fun publishedBundleAndStagingUseTheSameContentValidation() = withRoot { root, dir ->
        val staged = accepted(validate())
        assertEquals(revision, staged.route.revision)
        assertEquals(1L, staged.draftRevision)
        assertEquals(digest(markdown), staged.skillSha256)
        publish(dir)
        assertEquals(staged, accepted(read(root)))
        assertEquals(staged, accepted(read(root, null))) // Discovery is still not a private prepare grant.
        rejected(PhoneSkillBundleReader.Reason.REVISION, read(root, "0".repeat(32)))
    }

    @Test fun sidecarsWithoutPublicationAndLegacyMarkdownHaveNoReplayResult() = withRoot { root, dir ->
        File(dir, "route.json").writeBytes(route)
        File(dir, "revision.json").writeBytes(manifest())
        rejected(PhoneSkillBundleReader.Reason.UNAVAILABLE, read(root))
        File(dir, "route.json").delete(); File(dir, "revision.json").delete()
        File(dir, "SKILL.md").writeBytes(markdown)
        rejected(PhoneSkillBundleReader.Reason.UNAVAILABLE, read(root))
        assertArrayEquals(markdown, File(dir, "SKILL.md").readBytes()) // Reader never migrates or rewrites a template.
    }

    @Test fun eachContentDigestBindsExactBytesWithoutNormalizingJson() = withRoot { root, dir ->
        publish(dir)
        File(dir, "SKILL.md").appendText("changed")
        rejected(PhoneSkillBundleReader.Reason.INTEGRITY, read(root))
        publish(dir)
        File(dir, "route.json").appendText(" ") // Same JSON meaning, different bundle bytes.
        rejected(PhoneSkillBundleReader.Reason.INTEGRITY, read(root))
        publish(dir)
        File(dir, "revision.json").writeText(String(manifest(), Charsets.UTF_8)
            .replace(digest(route), "0".repeat(64)))
        rejected(PhoneSkillBundleReader.Reason.INTEGRITY, read(root))
    }

    @Test fun manifestRequiresExactLongTokensKeysAndDecodedUniqueness() {
        accepted(validate(mf = manifest(draft = Long.MAX_VALUE)))
        val raw = String(manifest(), Charsets.UTF_8)
        for (value in listOf("0", "-1", "1.0", "1e0", "9223372036854775808", "null")) {
            rejected(PhoneSkillBundleReader.Reason.MANIFEST,
                validate(mf = raw.replace("\"draftRevision\":1", "\"draftRevision\":$value").toByteArray()))
        }
        for (source in listOf(
            raw.replace("\"schema\":1", "\"schema\":1.0"),
            "{\"schem\\u0061\":1," + raw.drop(1),
            raw.replace("\"schema\"", "\"schem\\u+061\""),
            "{\"skillName\":\"$name\"," + raw.drop(1),
            raw.replace(revision, "g".repeat(32)),
            raw.replace(digest(route), "g".repeat(64)),
        )) rejected(PhoneSkillBundleReader.Reason.MANIFEST, validate(mf = source.toByteArray()))
    }

    @Test fun byteLimitsRejectTheFirstExcessByteOnRealFilesAndPureInput() = withRoot { root, dir ->
        val maxMarkdown = ByteArray(32768) { 'a'.code.toByte() }
        publish(dir, md = maxMarkdown)
        accepted(read(root))
        for ((file, limit) in listOf("SKILL.md" to 32768, "route.json" to 16384, "revision.json" to 4096)) {
            publish(dir)
            File(dir, file).writeBytes(ByteArray(limit + 1) { ' '.code.toByte() })
            rejected(PhoneSkillBundleReader.Reason.SIZE, read(root))
        }
        rejected(PhoneSkillBundleReader.Reason.SIZE, validate(md = ByteArray(32769)))
        rejected(PhoneSkillBundleReader.Reason.SIZE, validate(rt = ByteArray(16385)))
        rejected(PhoneSkillBundleReader.Reason.SIZE, validate(mf = ByteArray(4097)))
    }

    @Test fun malformedUtf8IsNotSilentlyReplacedEvenWithMatchingDigests() {
        val broken = byteArrayOf(0xc3.toByte(), 0x28)
        rejected(PhoneSkillBundleReader.Reason.UTF8, validate(md = broken))
        rejected(PhoneSkillBundleReader.Reason.UTF8, validate(mf = broken))
        rejected(PhoneSkillBundleReader.Reason.ROUTE, validate(rt = broken))
        val unsupported = String(route, Charsets.UTF_8).replace("fixture-only", "unregistered").toByteArray()
        rejected(PhoneSkillBundleReader.Reason.ROUTE, validate(rt = unsupported))
    }

    @Test fun fileAndSkillDirectorySymlinksAreNotFollowed() = withRoot { root, dir ->
        val outside = Files.createTempDirectory("phone-skill-bundle-outside-").toFile()
        try {
            publish(dir)
            val foreign = File(outside, "SKILL.md").apply { writeBytes(markdown) }
            assertTrue(File(dir, "SKILL.md").delete())
            Files.createSymbolicLink(File(dir, "SKILL.md").toPath(), foreign.toPath())
            rejected(PhoneSkillBundleReader.Reason.UNAVAILABLE, read(root))
            assertArrayEquals(markdown, foreign.readBytes())
            Files.delete(File(dir, "SKILL.md").toPath())
            dir.deleteRecursively()
            publish(outside)
            Files.createSymbolicLink(dir.toPath(), outside.toPath())
            rejected(PhoneSkillBundleReader.Reason.PATH, read(root))
            Files.delete(dir.toPath())
        } finally { outside.deleteRecursively() }
    }

    @Test fun outsideHomeAndArbitraryNamesCannotSelectAFile() = withRoot { root, _ ->
        rejected(PhoneSkillBundleReader.Reason.NAME,
            PhoneSkillBundleReader.read(root, "../other", null, descriptors))
        val outside = Files.createTempDirectory("phone-skill-home-outside-").toFile()
        try {
            val home = File(root, "root/.dsh")
            home.deleteRecursively()
            Files.createSymbolicLink(home.toPath(), outside.toPath())
            rejected(PhoneSkillBundleReader.Reason.PATH, read(root))
            assertTrue(outside.list()!!.isEmpty())
            Files.delete(home.toPath())
        } finally { outside.deleteRecursively() }
    }

    @Test fun returnedRouteAndDigestsDoNotRetainCallerMutableBytes() {
        val md = markdown.copyOf(); val rt = route.copyOf(); val mf = manifest(md, rt)
        val result = accepted(validate(md, rt, mf))
        md.fill(0); rt.fill(0); mf.fill(0)
        assertEquals(revision, result.route.revision)
        assertEquals(digest(markdown), result.skillSha256)
        assertEquals(R.Post.PageIs("home"), result.route.steps.single().post)
        assertThrows(UnsupportedOperationException::class.java) { (result.route.steps as MutableList<R.Step>).clear() }
    }

    @Test fun selfConsistentRewriteWithSameRevisionDoesNotMatchOriginalSaveReceipt() = withRoot { root, dir ->
        val identity = PhoneSkillBundleInstaller.Identity(name, revision, 1, digest(markdown), digest(route))
        publish(dir)
        assertTrue(PhoneSkillBundleInstaller.matches(identity, accepted(read(root))))
        val changedMarkdown = "# a different confirmed document\n".toByteArray()
        publish(dir, md = changedMarkdown)
        val rewritten = accepted(read(root)) // All three current files are self-consistent.
        assertFalse(PhoneSkillBundleInstaller.matches(identity, rewritten))
        val changedRoute = route + "\n".toByteArray() // Same typed route, distinct exact raw bytes.
        publish(dir, rt = changedRoute)
        assertFalse(PhoneSkillBundleInstaller.matches(identity, accepted(read(root))))
        publish(dir)
        assertFalse(PhoneSkillBundleInstaller.matches(identity.copy(draftRevision = 2), accepted(read(root))))
    }
}
