package io.github.ccch1mneyyy.dsh_app.update.privileged

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class SelfUpdatePolicyTest {
    private val old = SelfUpdateIdentity(SelfUpdatePolicy.PACKAGE, 10, "old", setOf("old"))
    private val newer = old.copy(versionCode = 11, versionName = "new")

    private fun error(code: String, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: SelfUpdateException) { assertEquals(code, error.code) }
    }

    @Test fun fixedArgvHasNoPackageInstallerSpoofingOrSecurityFlags() {
        assertEquals(listOf("/system/bin/cmd", "package", "install", "-r", "--user", "10", "-S", "123", "-"),
            SelfUpdatePolicy.installArgv(10, 123))
        assertEquals("exec:cmd package install -r --user 10 -S 123 -", SelfUpdatePolicy.adbInstallService(10, 123))
        for (bad in listOf(-1, 21475)) error("invalidArguments") { SelfUpdatePolicy.installArgv(bad, 1) }
        for (bad in listOf(0L, -1L, SelfUpdatePolicy.MAX_APK_BYTES + 1))
            error("invalidArguments") { SelfUpdatePolicy.installArgv(0, bad) }
    }

    @Test fun onlyShellUidIsSupportedNeverRootOrAppUid() {
        SelfUpdatePolicy.requireIdentity(2000)
        for (uid in listOf(0, 1000, 10001, 1002000, -1))
            error("unsupportedIdentity") { SelfUpdatePolicy.requireIdentity(uid) }
    }

    @Test fun packageSignerVersionMustAllMatch() {
        SelfUpdatePolicy.validate(newer, old, 11)
        error("packageMismatch") { SelfUpdatePolicy.validate(newer.copy(packageName = "another.app"), old, 11) }
        error("packageMismatch") { SelfUpdatePolicy.validate(newer, old.copy(packageName = "another.app"), 11) }
        error("signatureMismatch") { SelfUpdatePolicy.validate(newer.copy(signers = setOf("attacker")), old, 11) }
        error("signatureMismatch") { SelfUpdatePolicy.validate(newer.copy(signers = emptySet()), old, 11) }
        error("versionMismatch") { SelfUpdatePolicy.validate(newer, old, 12) }
        error("notNewer") { SelfUpdatePolicy.validate(old, old, 10) }
        error("notNewer") { SelfUpdatePolicy.validate(old.copy(versionCode = 9), old, 9) }
    }

    @Test fun historyAloneDoesNotAuthorizeRotationAndMultiSignerSetIsExact() {
        val rotated = newer.copy(signers = setOf("new"), signerHistory = setOf("old", "new"))
        assertFalse(SelfUpdatePolicy.sameSigner(rotated, old))
        error("signatureMismatch") { SelfUpdatePolicy.validate(rotated, old, 11) }
        assertFalse(SelfUpdatePolicy.sameSigner(old, rotated))
        assertFalse(SelfUpdatePolicy.sameSigner(rotated.copy(signers = setOf("new", "other")), old))
        assertFalse(SelfUpdatePolicy.sameSigner(newer, old.copy(signers = setOf("old", "other"))))
    }

    @Test fun digestRequiresExactlySha256Hex() {
        assertEquals("ab".repeat(32), SelfUpdatePolicy.digest("AB".repeat(32)))
        for (text in listOf("", "a".repeat(63), "g".repeat(64), "a".repeat(64) + "\n"))
            error("invalidArguments") { SelfUpdatePolicy.digest(text) }
    }

    @Test fun exactCopyChecksSizeHashAndContentsBeforeUse() {
        val bytes = "a verified APK".toByteArray()
        val hash = SelfUpdatePolicy.hash(ByteArrayInputStream(bytes))
        val output = ByteArrayOutputStream()
        assertEquals(hash, SelfUpdatePolicy.copyVerified(ByteArrayInputStream(bytes), output, bytes.size.toLong(), hash))
        assertArrayEquals(bytes, output.toByteArray())
        error("sizeMismatch") { SelfUpdatePolicy.copyVerified(ByteArrayInputStream(bytes), ByteArrayOutputStream(), bytes.size + 1L, hash) }
        error("sizeMismatch") { SelfUpdatePolicy.copyVerified(ByteArrayInputStream(bytes), ByteArrayOutputStream(), bytes.size - 1L, hash) }
        error("hashMismatch") { SelfUpdatePolicy.copyVerified(ByteArrayInputStream(bytes), ByteArrayOutputStream(), bytes.size.toLong(), "00".repeat(32)) }
    }

    @Test fun canonicalAllowlistRejectsTraversalSiblingAndSymlinkEscape() {
        val temp = Files.createTempDirectory("self-update-policy").toFile()
        try {
            val updates = File(temp, "updates").apply { mkdir() }
            val apk = File(updates, "release.apk").apply { writeText("apk") }
            assertEquals(apk.canonicalFile, SelfUpdatePolicy.inputFile(apk.path, updates))
            val outside = File(temp, "outside.apk").apply { writeText("other") }
            error("invalidPath") { SelfUpdatePolicy.inputFile(File(updates, "../outside.apk").path, updates) }
            val link = File(updates, "link.apk")
            Files.createSymbolicLink(link.toPath(), outside.toPath())
            error("invalidPath") { SelfUpdatePolicy.inputFile(link.path, updates) }
            val nested = File(updates, "nested").apply { mkdir() }
            error("invalidPath") { SelfUpdatePolicy.inputFile(File(nested, "release.apk").path, updates) }
            error("fileMissing") { SelfUpdatePolicy.inputFile(File(updates, "missing.apk").path, updates) }
            val zero = File(updates, "empty.apk").apply { createNewFile() }
            error("sizeMismatch") { SelfUpdatePolicy.inputFile(zero.path, updates) }
        } finally { temp.deleteRecursively() }
    }

    @Test fun onlyCompleteExplicitSystemReceiptIsKnown() {
        assertEquals("success", SelfUpdatePolicy.interpretOutput("Success\n", true, 0).status)
        assertTrue(SelfUpdatePolicy.interpretOutput("Success\n", false).outcomeUnknown)
        assertTrue(SelfUpdatePolicy.interpretOutput("Success\n", true, 1).outcomeUnknown)
        for (text in listOf("", "Failure [INSTALL_FAILED_INVALID_APK", "Success\nextra", "permission denied", "Success-ish"))
            assertTrue(text, SelfUpdatePolicy.interpretOutput(text, true).outcomeUnknown)
        assertEquals("blocked", SelfUpdatePolicy.interpretOutput("Failure [INSTALL_FAILED_USER_RESTRICTED]", true).status)
        assertEquals("blocked", SelfUpdatePolicy.interpretOutput("Failure [INSTALL_FAILED_VERIFICATION_FAILURE]", true).status)
        assertEquals("storage", SelfUpdatePolicy.interpretOutput("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]", true).status)
        assertEquals("incompatible", SelfUpdatePolicy.interpretOutput("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]", true).status)
        assertEquals("failure", SelfUpdatePolicy.interpretOutput("Failure [INSTALL_FAILED_INVALID_APK]", true).status)
    }

    @Test fun unknownIsSubmittedAndContainsNoRawSystemOutput() {
        val result = SelfUpdatePolicy.unknown().toMap()
        assertEquals("unknown", result["status"])
        assertEquals(true, result["submitted"])
        assertEquals(true, result["outcomeUnknown"])
        assertEquals("outcomeUnknown", result["errorCode"])
        assertFalse(result.containsKey("message"))
    }
}
