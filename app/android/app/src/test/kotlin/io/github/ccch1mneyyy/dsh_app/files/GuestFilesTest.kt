package io.github.ccch1mneyyy.dsh_app.files

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class GuestFilesTest {
    @get:Rule val temp = TemporaryFolder()
    private val root: File get() = File(temp.root, "rootfs").apply { mkdirs() }
    private val phone: File get() = File(temp.root, "phone").apply { mkdirs() }
    private val objects: File get() = File(root.parentFile, "tawcroot/link").apply { mkdirs() }

    private fun file(path: String, text: String = "image bytes"): File =
        File(root, path).apply { parentFile.mkdirs(); writeText(text) }

    private fun link(path: String, target: String) {
        val name = File(root, path).apply { parentFile.mkdirs() }
        Files.createSymbolicLink(name.toPath(), Paths.get(target))
    }

    private fun rootAlias(): File = Files.createSymbolicLink(
        File(temp.root, "rootfs-alias").toPath(), root.toPath(),
    ).toFile()

    // Keep Android's Environment stub out of JVM tests, including guest absolute links.
    private fun resolve(path: String, rootfs: File = root): File? =
        GuestFiles.resolve(rootfs, path, phone.absolutePath)

    private fun assertResolved(expected: File, path: String, rootfs: File = root) {
        val actual = resolve(path, rootfs)
        assertNotNull(path, actual)
        actual!!
        assertTrue(path, Files.isRegularFile(actual.toPath(), LinkOption.NOFOLLOW_LINKS))
        assertEquals(path, expected.canonicalFile, actual.canonicalFile)
        assertEquals(path, expected.readText(), actual.readText())
    }

    @Test fun regularGuestFileResolvesWithoutLinks() {
        val image = file("root/workspace/image.png")
        assertResolved(image, "/root/workspace/image.png")
    }

    @Test fun physicalRootfsInputsResolveWithEitherRootSpelling() {
        val image = file("root/workspace/generated/image.png")
        val alias = rootAlias()

        assertResolved(image, image.absolutePath)
        assertResolved(image, image.canonicalPath, alias)
        assertResolved(image, File(alias, "root/workspace/generated/image.png").absolutePath, alias)
        assertNull(resolve(root.absolutePath))
    }

    @Test fun physicalRootfsInputsStillFollowGuestLinksAndTawcTokens() {
        val image = file("root/images/image.png")
        link("root/workspace/images", "/root/images")
        assertResolved(image, File(root, "root/workspace/images/image.png").absolutePath)

        val stored = File(objects, "123").apply { writeText("stored image") }
        link("root/workspace/stored.png", "tawcroot:link:123")
        val path = File(root, "root/workspace/stored.png").absolutePath
        assertResolved(stored, path)
        assertNull(resolve("$path/child"))
    }

    @Test fun twoHostAbsoluteL2sHopsResolveToTheStoredRegularFile() {
        val actual = file("root/.l2s/slot.0002")
        val slot = File(root, "root/.l2s/slot")
        link("root/.l2s/slot", actual.absolutePath)
        link("root/workspace/image.png", slot.absolutePath)

        assertResolved(actual, "/root/workspace/image.png")
    }

    @Test fun canonicalRootfsTargetIsRecognizedWhenRootfsIsASymlinkAlias() {
        val actual = file("root/images/image.png")
        val alias = rootAlias()
        link("root/workspace/image.png", actual.canonicalPath)

        assertResolved(actual, "/root/workspace/image.png", alias)
    }

    @Test fun absoluteRootfsAliasTargetsAreRecognized() {
        val actual = file("root/images/image.png")
        val alias = rootAlias()
        link("root/workspace/image.png", File(alias, "root/images/image.png").absolutePath)

        assertResolved(actual, "/root/workspace/image.png", alias)
    }

    @Test fun ordinaryAbsoluteSymlinksRestartAtTheGuestRoot() {
        val actual = file("root/images/image.png")
        link("root/workspace/image.png", "/root/images/image.png")

        assertResolved(actual, "/root/workspace/image.png")
    }

    @Test fun relativeSymlinksKeepTheirParentAndResolveDotSegments() {
        val actual = file("root/images/image.png")
        link("root/workspace/image.png", "../images/./image.png")
        link("root/workspace/nested/image.png", "../image.png")

        assertResolved(actual, "/root//workspace/./nested/image.png")
    }

    @Test fun hostDirectorySymlinksKeepPendingSegmentsAndContinueGuestResolution() {
        val actual = file("root/images/actual.png")
        link("root/images/preview.png", "/root/images/actual.png")
        link("root/workspace/images", File(root, "root/images").absolutePath)
        link("root/workspace/root-alias", root.absolutePath)

        assertResolved(actual, "/root/workspace/images/preview.png")
        assertResolved(actual, "/root/workspace/root-alias/root/images/preview.png")
    }

    @Test fun rootfsSiblingPrefixesAreNotMistakenForEitherRootfsSpelling() {
        val alias = rootAlias()
        // A loose removePrefix would find this decoy after stripping rootfs.
        file("-sibling/root/image.png", "wrong guest file")
        for ((index, prefix) in listOf(root.canonicalPath, alias.absolutePath).withIndex()) {
            val outside = File("$prefix-sibling/root/image.png").apply {
                parentFile.mkdirs()
                writeText("outside rootfs")
            }
            link("root/workspace/sibling$index.png", outside.absolutePath)
            assertNull(outside.path, resolve("/root/workspace/sibling$index.png", alias))
            assertNull(outside.path, resolve(outside.absolutePath, alias))
        }
    }

    @Test fun loopsAndBrokenLinksAreRejected() {
        link("root/self", "self")
        link("root/cycle-a", File(root, "root/cycle-b").absolutePath)
        link("root/cycle-b", File(root, "root/cycle-a").absolutePath)
        link("root/broken-relative", "missing")
        link("root/broken-guest", "/root/missing")
        link("root/broken-host", File(root, "root/missing").absolutePath)

        for (name in listOf("self", "cycle-a", "broken-relative", "broken-guest", "broken-host")) {
            assertNull(name, resolve("/root/$name"))
        }
    }

    @Test fun sixteenSymlinksAreAllowedButSeventeenAreRejected() {
        val actual = file("root/chain/actual.png")
        for (index in 15 downTo 0) {
            val next = if (index == 15) "actual.png" else "link${index + 1}"
            val target = if (index % 2 == 0) File(root, "root/chain/$next").absolutePath else next
            link("root/chain/link$index", target)
        }
        link("root/chain/too-many", "link0")

        assertResolved(actual, "/root/chain/link0")
        assertNull(resolve("/root/chain/too-many"))
    }

    @Test fun nonAbsoluteInputsMissingFilesAndDirectoriesAreRejected() {
        file("root/workspace/image.png")
        link("root/directory", "workspace")
        for (path in listOf("", "root/workspace/image.png", "./root/workspace/image.png",
            "/", "/root/workspace", "/root/directory", "/root/missing.png")) {
            assertNull(path, resolve(path))
        }
    }

    @Test fun sharedStorageAbsoluteLinksAndSdcardMappingStillResolve() {
        val actual = File(phone, "images/image.png").apply {
            parentFile.mkdirs()
            writeText("phone image")
        }
        link("root/phone-images", actual.parentFile.absolutePath)
        link("root/guest-phone", "/sdcard/images")

        assertResolved(actual, "/sdcard/images/image.png")
        assertResolved(actual, "/root/phone-images/image.png")
        assertResolved(actual, "/root/guest-phone/image.png")
    }

    @Test fun tawcRegularObjectsResolveOnlyAtRootfsLeaves() {
        val alias = rootAlias()
        for (token in listOf("123", "456-2")) {
            val actual = File(objects, token).apply { writeText("stored $token") }
            val path = "/root/workspace/file-$token.json"
            link(path.removePrefix("/"), "tawcroot:link:$token")

            assertResolved(actual, path)
            assertResolved(actual, path, alias)
            assertNull(resolve("$path/child"))
            assertNull(resolve("$path/.."))
        }
    }

    @Test fun tawcStoredSymlinksKeepGuestTargetsAndTheExistingLinkLimit() {
        val actual = file("root/images/image.png")
        for ((token, target) in listOf("10" to "../images/./image.png", "11" to "/root/images/image.png", "12" to "../images")) {
            Files.createSymbolicLink(File(objects, token).toPath(), Paths.get(target))
            link("root/workspace/link$token", "tawcroot:link:$token")
            val suffix = if (token == "12") "/image.png" else ""
            assertResolved(actual, "/root/workspace/link$token$suffix")
        }

        for (index in 15 downTo 0) {
            val next = if (index == 15) "/root/images/image.png" else "link${index + 1}"
            val token = (100 + index).toString()
            Files.createSymbolicLink(File(objects, token).toPath(), Paths.get(next))
            link("root/chain/link$index", "tawcroot:link:$token")
        }
        link("root/chain/too-many", "link0")
        assertResolved(actual, "/root/chain/link0")
        assertNull(resolve("/root/chain/too-many"))

        Files.createSymbolicLink(File(objects, "200").toPath(), Paths.get("loop"))
        link("root/loop", "tawcroot:link:200")
        assertNull(resolve("/root/loop"))
    }

    @Test fun tawcInvalidMissingAndDirectoryObjectsAreRejected() {
        File(objects.parentFile, "outside").writeText("not an object")
        for ((index, token) in listOf("", "../outside", "1/2", "1-2-3", "12x").withIndex()) {
            link("root/invalid$index", "tawcroot:link:$token")
            assertNull(token, resolve("/root/invalid$index"))
        }
        File(objects, "405").mkdir()
        for (token in listOf("404", "405")) {
            link("root/object$token", "tawcroot:link:$token")
            assertNull(token, resolve("/root/object$token"))
        }
    }

    @Test fun tawcTokensFromSharedStorageDoNotResolvePrivateObjects() {
        File(objects, "123").writeText("private object")
        Files.createSymbolicLink(File(phone, "shared").toPath(), Paths.get("tawcroot:link:123"))
        link("root/shared", "/sdcard/shared")

        assertNull(resolve("/sdcard/shared"))
        assertNull(resolve("/root/shared"))
    }
}
