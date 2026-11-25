package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class GuestSetupTest {
    private fun mainFile(root: File, safe: Boolean) = File(root,
        if (safe) "var/lib/dsh-app/safe-mode/home/dsh-app/diagnostics.md"
        else "root/.dsh/dsh-app/diagnostics.md",
    )

    @Test fun defaultAndExplicitAutomaticCallsOnlyWriteTheMainSnapshot() {
        for (safe in listOf(false, true)) {
            val root = kotlin.io.path.createTempDirectory("diagnostics-default").toFile()
            try {
                val file = GuestSetup.writeDiagnostics(root, "# automatic first\n", safe)
                assertEquals(mainFile(root, safe).absoluteFile, file.absoluteFile)
                assertEquals("# automatic first\n", file.readText())
                GuestSetup.writeDiagnostics(root, "# automatic next\n", safe = safe, manual = false)
                assertEquals("# automatic next\n", file.readText())
                assertEquals(listOf("diagnostics.md"), file.parentFile!!.list()!!.sorted())
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun automaticUpdatesLeaveTheManualCopyIntactInNormalAndSafeHomes() {
        for (safe in listOf(false, true)) {
            val root = kotlin.io.path.createTempDirectory("diagnostics-manual").toFile()
            try {
                val evidence = "# manual\nSystem IME evidence: requestHide fromUser=null\n"
                val manual = GuestSetup.writeDiagnostics(root, evidence, safe = safe, manual = true)
                val main = mainFile(root, safe)
                assertEquals(File(main.parentFile, "diagnostics-manual.md").absoluteFile, manual.absoluteFile)
                assertFalse("manual publication must not create the main report", main.exists())
                assertEquals(evidence, manual.readText())
                val retained = manual.readBytes()
                val automatic = GuestSetup.writeDiagnostics(root, "# automatic connected\n", safe = safe)
                assertEquals(main.absoluteFile, automatic.absoluteFile)
                assertEquals("# automatic connected\n", main.readText())
                assertArrayEquals(retained, manual.readBytes())
                val previousMain = main.readBytes()
                val next = GuestSetup.writeDiagnostics(root, "# next manual\n", safe = safe, manual = true)
                assertEquals(manual.absoluteFile, next.absoluteFile)
                assertArrayEquals(previousMain, main.readBytes())
                assertEquals("# next manual\n", manual.readText())
                assertEquals(listOf("diagnostics-manual.md", "diagnostics.md"), main.parentFile!!.list()!!.sorted())
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun replacingTheManualCopyDoesNotTruncateAnAlreadyOpenReader() {
        for (safe in listOf(false, true)) {
            val root = kotlin.io.path.createTempDirectory("diagnostics-atomic").toFile()
            try {
                val manual = GuestSetup.writeDiagnostics(root, "# old capture\n", safe = safe, manual = true)
                manual.inputStream().use { reader ->
                    GuestSetup.writeDiagnostics(root, "# new capture\n", safe = safe, manual = true)
                    assertEquals("# old capture\n", reader.bufferedReader().readText())
                }
                assertEquals("# new capture\n", manual.readText())
                assertFalse(mainFile(root, safe).exists())
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun normalAndSafeManualCopiesDoNotOverwriteEachOther() {
        val root = kotlin.io.path.createTempDirectory("diagnostics-homes").toFile()
        try {
            val normal = GuestSetup.writeDiagnostics(root, "# normal automatic\n")
            val safe = GuestSetup.writeDiagnostics(root, "# safe automatic\n", safe = true)
            val normalManual = GuestSetup.writeDiagnostics(root, "# normal manual\n", manual = true)
            val safeManual = GuestSetup.writeDiagnostics(root, "# safe manual\n", safe = true, manual = true)
            assertEquals("# normal automatic\n", normal.readText())
            assertEquals("# safe automatic\n", safe.readText())
            assertEquals("# normal manual\n", normalManual.readText())
            assertEquals("# safe manual\n", safeManual.readText())
            GuestSetup.writeDiagnostics(root, "# next safe manual\n", safe = true, manual = true)
            assertEquals("# normal manual\n", normalManual.readText())
            assertEquals("# safe automatic\n", safe.readText())
            assertEquals("# next safe manual\n", safeManual.readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun aFailedManualWriteThrowsInsteadOfAcknowledgingAnUnpublishedCopy() {
        for (safe in listOf(false, true)) {
            val root = kotlin.io.path.createTempDirectory("diagnostics-write-failed").toFile()
            try {
                val main = GuestSetup.writeDiagnostics(root, "# retained main\n", safe = safe)
                val manual = GuestSetup.writeDiagnostics(root, "# retained manual\n", safe = safe, manual = true)
                val previousMain = main.readBytes()
                val previousManual = manual.readBytes()
                val blockedTemp = File(main.parentFile, ".diagnostics-manual.md.dsh-tmp")
                assertTrue(blockedTemp.mkdir())
                File(blockedTemp, "block").writeText("keep non-empty")
                try {
                    GuestSetup.writeDiagnostics(root, "# not fully published\n", safe = safe, manual = true)
                    fail("a failed manual copy must fail the entire publication")
                } catch (_: IOException) {
                    assertArrayEquals(previousMain, main.readBytes())
                    assertArrayEquals(previousManual, manual.readBytes())
                }
            } finally { root.deleteRecursively() }
        }
    }

    @Test fun aFailedManualRenameThrowsAndLeavesNoPartialCopy() {
        val root = kotlin.io.path.createTempDirectory("diagnostics-rename-failed").toFile()
        try {
            val main = GuestSetup.writeDiagnostics(root, "# initial\n")
            val previousMain = main.readBytes()
            val manual = File(main.parentFile, "diagnostics-manual.md")
            assertTrue(manual.mkdir())
            val existing = File(manual, "block").apply { writeText("untouched") }
            try {
                GuestSetup.writeDiagnostics(root, "# cannot replace directory\n", manual = true)
                fail("failed replacement must not return a success path")
            } catch (_: IOException) {
                assertArrayEquals(previousMain, main.readBytes())
                assertEquals("untouched", existing.readText())
                assertFalse(File(main.parentFile, ".diagnostics-manual.md.dsh-tmp").exists())
            }
        } finally { root.deleteRecursively() }
    }

    @Test fun diagnosticsGuidanceFindsTheManualSiblingWithoutChangingTheMainPath() {
        val root = kotlin.io.path.createTempDirectory("diagnostics-agents").toFile()
        try {
            for (direct in listOf(false, true)) {
                GuestSetup.writeAgentsMd(root, phoneStorage = false, directEngine = direct)
                val text = File(root, "root/.dsh/AGENTS.md").readText()
                val path = if (direct) "${root.canonicalPath}/root/.dsh/dsh-app/diagnostics.md"
                    else "\$DSH_HOME/dsh-app/diagnostics.md"
                assertTrue(text.contains("`$path`"))
                assertTrue(text.contains("同目录的 `diagnostics-manual.md`"))
                assertTrue(text.contains("后续自动快照不会覆盖它"))
                assertTrue(text.contains("清除 App 内存证据不会撤回已发布文件"))
            }
        } finally { root.deleteRecursively() }
    }
}
