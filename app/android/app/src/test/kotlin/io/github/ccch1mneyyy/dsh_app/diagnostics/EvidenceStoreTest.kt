package io.github.ccch1mneyyy.dsh_app.diagnostics

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class EvidenceStoreTest {
    @get:Rule
    val dir = TemporaryFolder()

    @Test
    fun recordsSurviveStoreRecreationAndRemainBounded() {
        val store = EvidenceStore(dir.root)
        repeat(70) { i ->
            store.append("voiceStages", mapOf("stage" to "recognizing", "backend" to "local", "audio" to "PRIVATE_AUDIO"), i.toLong())
        }
        val rows = EvidenceStore(dir.root).read("voiceStages")
        assertEquals(40, rows.size)
        assertEquals(30L, rows.first()["at"])
        assertEquals(69L, rows.last()["at"])
        assertFalse(File(dir.root, "voiceStages.json").readText().contains("PRIVATE_AUDIO"))
        assertTrue(File(dir.root, "voiceStages.json").length() <= EvidenceStore.MAX_FILE_BYTES)
    }

    @Test
    fun exceptionBodiesAndArbitraryStackLinesNeverPersist() {
        val store = EvidenceStore(dir.root)
        store.append("appErrors", mapOf(
            "source" to "flutter", "errorType" to "PRIVATE_TOKEN",
            "message" to "PRIVATE_CHAT", "token" to "PRIVATE_TOKEN",
            "stack" to "PRIVATE_CHAT\npackage:dsh_app/main.dart:12:3\n/home/private.dart:1:2",
        ), 1)
        val row = EvidenceStore(dir.root).read("appErrors").single()
        assertEquals("OtherError", row["errorType"])
        assertEquals("package:dsh_app/main.dart:12:3", row["stack"])
        val text = File(dir.root, "appErrors.json").readText()
        assertFalse(text.contains("PRIVATE_"))
        assertFalse(text.contains("/home/"))
    }

    @Test
    fun unknownStagesAndBackendsAreRejected() {
        assertNull(EvidenceStore.sanitize("voiceStages", mapOf("stage" to "PRIVATE_CHAT"), 1))
        assertNull(EvidenceStore.sanitize("voiceStages", mapOf("stage" to "failed", "backend" to "https://private"), 1))
        assertNotNull(EvidenceStore.sanitize("voiceStages", mapOf("stage" to "failed", "backend" to "deepseek", "code" to 5), 1))
    }

    @Test
    fun byteBudgetEvictsOldRecordsBeforeCountLimit() {
        val store = EvidenceStore(dir.root)
        val location = "package:dsh_app/" + "a".repeat(110) + ".dart:1234567:1234567"
        repeat(50) { i ->
            store.append("appErrors", mapOf("source" to "platform", "stack" to List(6) { location }.joinToString("\n")), i.toLong())
        }
        val rows = store.read("appErrors")
        assertTrue(rows.size < 40)
        assertEquals(49L, rows.last()["at"])
        assertTrue(File(dir.root, "appErrors.json").length() <= EvidenceStore.MAX_FILE_BYTES)
    }

    @Test
    fun unreadableOversizedEvidenceIsNotReportedAsEmpty() {
        File(dir.root, "appErrors.json").writeText("x".repeat(EvidenceStore.MAX_FILE_BYTES + 1))
        assertThrows(IllegalStateException::class.java) { EvidenceStore(dir.root).read("appErrors") }
        val store = EvidenceStore(dir.root)
        store.append("appErrors", mapOf("source" to "flutter"), 2)
        assertEquals(1, store.read("appErrors").size)
        assertEquals(emptyList<Map<String, Any?>>(), store.read("voiceStages"))
    }
}
