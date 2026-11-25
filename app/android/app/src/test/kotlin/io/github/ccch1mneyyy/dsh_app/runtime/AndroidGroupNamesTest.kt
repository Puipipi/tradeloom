package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Assume.assumeNoException
import org.junit.Test

class AndroidGroupNamesTest {
    private fun fixture(block: (File, File) -> Unit) {
        val root = Files.createTempDirectory("android-group-names").toFile()
        try {
            val etc = File(root, "etc").apply { mkdir() }
            File(etc, "nsswitch.conf").writeText(
                "passwd: files\ngroup: files # default\ngshadow: files\n"
            )
            val group = File(etc, "group").apply { writeText("root:x:0:\n") }
            block(root, group)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun whitespaceNamesSkipWithoutTouchingGroupOrShadowBytes() {
        for (prefix in listOf(" ", "\t")) {
            fixture { root, group ->
                val shadow = File(root, "etc/gshadow")
                val original = "root:x:0:\n".toByteArray()
                val originalShadow = "${prefix}android_gid_3003:hash:admin:member\n".toByteArray()
                group.writeBytes(original)
                shadow.writeBytes(originalShadow)
                val result = appendAndroidGroupNames(root, "Groups: 3003\n")
                assertNotNull(result.skipped)
                assertEquals(0, result.added)
                assertArrayEquals(original, group.readBytes())
                assertArrayEquals(originalShadow, shadow.readBytes())
            }
            fixture { root, group ->
                val shadow = File(root, "etc/gshadow")
                val original = "root:x:0:\n${prefix}android_gid_3003:x:7:alice\n".toByteArray()
                val originalShadow = "root:!:admin:member\n".toByteArray()
                group.writeBytes(original)
                shadow.writeBytes(originalShadow)
                val result = appendAndroidGroupNames(root, "Groups: 3003\n")
                assertNotNull(result.skipped)
                assertEquals(0, result.added)
                assertArrayEquals(original, group.readBytes())
                assertArrayEquals(originalShadow, shadow.readBytes())
            }
        }
    }

    @Test fun appendsLockedEmptyMembersAndPreservesEveryOriginalByte() = fixture { root, group ->
        val original = "# original\nroot:x:0:\nexisting:x:7:alice,bob".toByteArray()
        group.writeBytes(original)
        val result = appendAndroidGroupNames(root, "Name:\tapp\nGroups:\t0 3003 3003 9997 \n")
        assertNull(result.skipped)
        assertEquals(2, result.added)
        assertArrayEquals(original + "\nandroid_gid_3003:!:3003:\nandroid_gid_9997:!:9997:\n".toByteArray(), group.readBytes())
        assertFalse(File(root, "etc/gshadow").exists())
    }

    @Test fun preservesExistingGidsNamesAndShadowNames() = fixture { root, group ->
        val original = "root:x:0:\nnetwork:x:3003:alice\nandroid_gid_9997:x:8:bob\n".toByteArray()
        val shadow = File(root, "etc/gshadow")
        val originalShadow = "android_gid_1079:hash:admin:member\n".toByteArray()
        group.writeBytes(original)
        shadow.writeBytes(originalShadow)
        val result = appendAndroidGroupNames(root, "Groups: 3003 9997 1079 50388\n")
        assertEquals(1, result.added)
        assertArrayEquals(original + "android_gid_50388:!:50388:\n".toByteArray(), group.readBytes())
        assertArrayEquals(originalShadow, shadow.readBytes())
    }

    @Test fun repeatedPreparationDoesNotDuplicateEntries() = fixture { root, group ->
        assertEquals(1, appendAndroidGroupNames(root, "Groups: 3003\n").added)
        val first = group.readBytes()
        assertEquals(0, appendAndroidGroupNames(root, "Groups: 3003\n").added)
        assertArrayEquals(first, group.readBytes())
    }

    @Test fun unsupportedProcessGroupsSkipBeforeWriting() = fixture { root, group ->
        val original = group.readBytes()
        for (status in listOf(null, "Name: app\n", "Groups: 3003 -2\n", "Groups: 2147483648\n",
            "Groups: 3003 bad\n", "Groups: 3003\nGroups: 7\n")) {
            assertNotNull(appendAndroidGroupNames(root, status).skipped)
            assertArrayEquals(original, group.readBytes())
        }
    }

    @Test fun customNameServiceAndMalformedDatabasesSkipBeforeWriting() = fixture { root, group ->
        val nss = File(root, "etc/nsswitch.conf")
        val shadow = File(root, "etc/gshadow")
        val original = group.readBytes()
        val originalShadow = "root:!:admin:member\n".toByteArray()
        shadow.writeBytes(originalShadow)

        for (unsupported in listOf(
            "group: files ldap\ngshadow: files\n",
            "group: files\ngshadow: files ldap\n",
            "group: files\n",
            "group: files\ngshadow: files\ngshadow: files\n",
            "gshadow: files\n",
            "group: files\ngroup: files\ngshadow: files\n"
        )) {
            nss.writeText(unsupported)
            val result = appendAndroidGroupNames(root, "Groups: 3003\n")
            assertNotNull(result.skipped)
            assertEquals(0, result.added)
            assertArrayEquals(original, group.readBytes())
            assertArrayEquals(originalShadow, shadow.readBytes())
        }

        nss.writeText("group: files\ngshadow: files\n")
        group.writeText("bad:record\n")
        val malformed = group.readBytes()
        val malformedGroupResult = appendAndroidGroupNames(root, "Groups: 3003\n")
        assertNotNull(malformedGroupResult.skipped)
        assertEquals(0, malformedGroupResult.added)
        assertArrayEquals(malformed, group.readBytes())
        assertArrayEquals(originalShadow, shadow.readBytes())

        group.writeBytes(original)
        shadow.writeText("bad:record\n")
        val malformedShadow = shadow.readBytes()
        val malformedShadowResult = appendAndroidGroupNames(root, "Groups: 3003\n")
        assertNotNull(malformedShadowResult.skipped)
        assertEquals(0, malformedShadowResult.added)
        assertArrayEquals(original, group.readBytes())
        assertArrayEquals(malformedShadow, shadow.readBytes())
    }

    @Test fun invalidUtf8AndShadowDirectoryAreNotTreatedAsMissing() = fixture { root, group ->
        val invalid = byteArrayOf(0xc3.toByte(), 0x28)
        group.writeBytes(invalid)
        assertNotNull(appendAndroidGroupNames(root, "Groups: 3003\n").skipped)
        assertArrayEquals(invalid, group.readBytes())
        group.writeText("root:x:0:\n")
        val original = group.readBytes()
        File(root, "etc/gshadow").mkdir()
        assertNotNull(appendAndroidGroupNames(root, "Groups: 3003\n").skipped)
        assertArrayEquals(original, group.readBytes())
    }

    @Test fun symbolicGroupFileIsNotFollowed() = fixture { root, group ->
        val target = File(root, "group-target").apply { writeText("root:x:0:\n") }
        group.delete()
        try {
            Files.createSymbolicLink(group.toPath(), target.toPath())
        } catch (e: UnsupportedOperationException) {
            assumeNoException(e)
        } catch (e: java.io.IOException) {
            assumeNoException(e)
        }
        val original = target.readBytes()
        assertNotNull(appendAndroidGroupNames(root, "Groups: 3003\n").skipped)
        assertArrayEquals(original, target.readBytes())
    }
}
