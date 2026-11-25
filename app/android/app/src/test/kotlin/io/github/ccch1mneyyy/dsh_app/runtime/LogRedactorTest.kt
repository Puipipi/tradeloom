package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LogRedactorTest {
    @Test fun sharedDiagnosticsVectorsAndIdempotence() {
        val fixture = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "tooling/fixtures/diagnostic-redaction.json") }.first { it.isFile }
        val cases = JSONObject(fixture.readText()).getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val inputParts = case.getJSONArray("inputParts")
            val input = (0 until inputParts.length()).joinToString("") { inputParts.getString(it) }
            val expectedParts = case.getJSONArray("expectedParts")
            val expected = (0 until expectedParts.length()).joinToString("") { expectedParts.getString(it) }
            val actual = LogRedactor.redact(input)
            assertEquals(case.getString("name"), expected, actual)
            assertEquals(case.getString("name"), actual, LogRedactor.redact(actual))
        }
    }

    @Test fun longQuotedValuesAreCappedWithoutLeavingTheirSuffixReadable() {
        val input = "{\"password\":\"" + "SYNTHETIC ".repeat(20_000) + "\",\"attempt\":2}"
        assertEquals("{\"password\":\"•••", LogRedactor.redact(input))
        val ordinary = "ordinary".repeat(1000)
        val capped = ordinary.take(2000) + "…"
        assertEquals(capped, LogRedactor.redact(ordinary))
        assertEquals(capped, LogRedactor.redact("\u001B[32m$ordinary\u001B[0m"))
        assertEquals("$capped\nshort\n$capped", LogRedactor.redact("$ordinary\nshort\n$ordinary"))
    }

    @Test fun truncatedQuotedValuesStopAtANewlineAndConsumeADanglingEscape() {
        assertEquals("password=\"•••\nordinary", LogRedactor.redact("password=\"synthetic phrase\\\nordinary"))
        assertEquals("password='•••", LogRedactor.redact("password='synthetic phrase\\"))
    }

    @Test fun streamedPrivateKeysAreMaskedBeforeTheRunTailAndDoNotCrossStreams() {
        val stdout = LogRedactor()
        val stderr = LogRedactor()
        val begin = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
        val end = "-----END " + "OPENSSH PRIVATE KEY-----"
        assertEquals(begin, stdout.line(begin))
        assertEquals("ordinary stderr", stderr.line("ordinary stderr"))
        assertEquals("•••", stdout.line("SYNTHETIC-PRIVATE-MATERIAL"))
        assertEquals("•••", stdout.line(""))
        assertEquals(end + " after", stdout.line(end + " after"))
        assertEquals("next line", stdout.line("next line"))
    }

    @Test fun inlineBlocksAndAnotherUnfinishedBlockOnTheSameLineKeepState() {
        val stream = LogRedactor()
        val begin = "-----BEGIN " + "PRIVATE KEY-----"
        val end = "-----END " + "PRIVATE KEY-----"
        assertEquals("before ••• between $begin", stream.line("before $begin SYNTHETIC $end between $begin"))
        assertEquals("•••", stream.line("SYNTHETIC-TAIL"))
        assertEquals("•••$end after", stream.line("SYNTHETIC $end after"))
        assertEquals("new run", LogRedactor().line("new run"))
    }

    @Test fun unfinishedPrivateKeyStateExpiresAfter128LinesIncludingTheHeader() {
        val stream = LogRedactor()
        val begin = "-----BEGIN " + "PRIVATE KEY-----"
        assertEquals(begin, stream.line(begin))
        repeat(127) { assertEquals("•••", stream.line("SYNTHETIC-PRIVATE-MATERIAL")) }
        val fatal = "dsh: startup failed: readable after an unfinished block"
        assertEquals(fatal, stream.line(fatal))
        assertEquals(FailureKind.STARTUP_FAILED, CrashClassifier.classify(1, null, 1, 1, listOf(fatal), false).kind)
        assertEquals(begin, stream.line(begin))
        assertEquals("•••", stream.line("SYNTHETIC-PRIVATE-MATERIAL"))
    }

    @Test fun failureSummaryMasksProviderKeysAndAssignments() {
        val failure = CrashClassifier.classify(1, null, 1, 1,
            listOf("dsh: startup failed: API_KEY=SYNTHETIC_VALUE password=synthetic"), false)
        assertEquals("startup failed: API_KEY=••• password=•••", failure.summary)
    }
}
