package io.github.ccch1mneyyy.dsh_app.phone

import org.junit.Assert.*
import org.junit.Test

class DiagnosticsToolTest {
    private val caller = PhoneCaller("session", "run", "call", 1)
    private val at = "2026-11-14T08:00:00.000Z"
    private fun data(out: ToolOutput) = Json.parse(out.text) as Map<*, *>
    private fun code(out: ToolOutput): Any? { assertTrue(out.isError); return data(out)["code"] }
    private fun cached(tool: DiagnosticsTool, section: String = "summary") =
        tool.call(mapOf("refresh" to false, "section" to section), caller)

    @Test fun defaultCallRefreshesAndReturnsOneFixedSection() {
        lateinit var tool: DiagnosticsTool
        var calls = 0
        tool = DiagnosticsTool {
            calls++
            tool.published(at, mapOf("summary" to "fresh", "engine" to "other"))
            true
        }
        tool.published("older", mapOf("summary" to "old"))
        val out = tool.call(emptyMap(), caller)
        assertFalse(out.isError)
        assertEquals(1, calls)
        assertEquals(mapOf("code" to "ok", "collectedAt" to at, "section" to "summary",
            "text" to "fresh", "reportPath" to DiagnosticsTool.REPORT_PATH, "refreshed" to true), data(out))
        assertFalse(out.text.contains("other"))
        assertEquals("other", data(cached(tool, "engine"))["text"])
        assertEquals(1, calls)
    }

    @Test fun rejectsPathsUnknownSectionsWrongTypesAndMissingCallerBeforeCollection() {
        var calls = 0
        val tool = DiagnosticsTool { calls++; true }
        val invalid = listOf<Map<String, Any?>>(
            mapOf("path" to "/etc/passwd"), mapOf("export" to true), mapOf("url" to "https://example.com"),
            mapOf("includeSystemIme" to true), mapOf("caller" to caller), mapOf("section" to "../diagnostics-manual.md"),
            mapOf("section" to "ime"), mapOf("section" to null), mapOf("section" to 1),
            mapOf("refresh" to null), mapOf("refresh" to "true"), mapOf("refresh" to 1),
        )
        for (args in invalid) assertEquals("invalid_arguments", code(tool.call(args, caller)))
        assertEquals("diagnostics_caller_required", code(tool.call(emptyMap(), null)))
        assertEquals(0, calls)
    }

    @Test fun manualReportsNeverBecomeVisibleOrSatisfyARefresh() {
        lateinit var tool: DiagnosticsTool
        tool = DiagnosticsTool {
            tool.published(at, mapOf("summary" to "manual IME"), manual = true)
            true
        }
        tool.published(at, mapOf("summary" to "manual IME"), manual = true)
        assertEquals("diagnostics_unavailable", code(cached(tool)))
        tool.published("ordinary", mapOf("summary" to "ordinary"))
        assertEquals("diagnostics_unavailable", code(tool.call(emptyMap(), caller)))
        assertEquals("ordinary", data(cached(tool))["text"])
        assertEquals("ordinary", data(cached(tool))["collectedAt"])
    }

    @Test fun successfulCallbackWithoutNewPublicationIsNotFreshEvidence() {
        val tool = DiagnosticsTool { true }
        tool.published(at, mapOf("summary" to "old"))
        assertEquals("diagnostics_unavailable", code(tool.call(emptyMap(), caller)))
        assertEquals("old", data(cached(tool))["text"])
    }

    @Test fun failedRefreshDoesNotFallBackToAStoredReport() {
        val tool = DiagnosticsTool { false }
        tool.published(at, mapOf("summary" to "old"))
        assertEquals("diagnostics_unavailable", code(tool.call(emptyMap(), caller)))
        assertEquals("old", data(cached(tool))["text"])
    }

    @Test fun boundsAreUtf8BytesAndNeverCutJson() {
        val tool = DiagnosticsTool { false }
        val json = Json.write(mapOf("truncated" to true, "entries" to listOf("a".repeat(8000))))
        tool.published(at, mapOf("evidence" to json))
        assertEquals(json, data(cached(tool, "evidence"))["text"])
        assertEquals(true, (Json.parse(data(cached(tool, "evidence"))["text"] as String) as Map<*, *>)["truncated"])
        val exact = "a".repeat(DiagnosticsTool.MAX_SECTION_BYTES)
        tool.published(at, mapOf("summary" to exact))
        assertEquals(exact, data(cached(tool))["text"])
        tool.published(at, mapOf("summary" to "a".repeat(DiagnosticsTool.MAX_SECTION_BYTES + 1)))
        assertEquals("diagnostics_limit", code(cached(tool)))
        tool.published(at, mapOf("summary" to "\u4e2d".repeat(6000)))
        assertEquals("diagnostics_limit", code(cached(tool)))
    }

    @Test fun invalidAndLegacyPublicationsCannotExposeUnknownOrStaleSections() {
        val tool = DiagnosticsTool { false }
        tool.published(at, mapOf("summary" to "old"))
        tool.published(at, mapOf("summary" to "new", "ime" to "private"))
        assertEquals("diagnostics_unavailable", code(cached(tool)))
        tool.published(at, mapOf("summary" to "new"))
        assertEquals("diagnostics_section_unavailable", code(cached(tool, "voice")))
        tool.published(null, null)
        assertEquals("diagnostics_unavailable", code(cached(tool)))
        tool.published(at, mapOf("summary" to 3))
        assertEquals("diagnostics_unavailable", code(cached(tool)))
    }

    @Test fun concurrentRefreshIsBusyButCachedReadsStayAvailableAndGateRecovers() {
        lateinit var tool: DiagnosticsTool
        tool = DiagnosticsTool {
            assertEquals("diagnostics_busy", code(tool.call(emptyMap(), caller)))
            assertEquals("old", data(cached(tool))["text"])
            tool.published(at, mapOf("summary" to "old"))
            true
        }
        tool.published(at, mapOf("summary" to "old"))
        assertFalse(tool.call(emptyMap(), caller).isError)
        assertFalse(tool.call(emptyMap(), caller).isError)
    }

    @Test fun failuresDoNotLeakExceptionDetailsOrPermanentlyBlockRefresh() {
        var fail = true
        lateinit var tool: DiagnosticsTool
        tool = DiagnosticsTool {
            if (fail) throw IllegalStateException("secret-token-and-private-path")
            tool.published(at, mapOf("summary" to "recovered"))
            true
        }
        val out = tool.call(emptyMap(), caller)
        assertEquals("diagnostics_failed", code(out))
        assertFalse(out.text.contains("secret"))
        fail = false
        assertFalse(tool.call(emptyMap(), caller).isError)
        val timeout = DiagnosticsTool { throw DiagnosticsTool.Failure("diagnostics_timeout") }
        assertEquals("diagnostics_timeout", code(timeout.call(emptyMap(), caller)))
    }

    @Test fun mcpRoutingKeepsDiagnosticsOutsideControlHandlerAndRetainsLegacyTools() {
        val tool = DiagnosticsTool { error("cached call must not collect") }
        tool.published(at, mapOf("summary" to "local"))
        val server = McpServer(PhoneToolCatalog.listJson(), { _, _, _ -> ToolOutput("legacy") }, diagnostics = tool::call)
        val meta = mapOf(PhoneCaller.META_KEY to mapOf("v" to 1, "sessionId" to caller.sessionId,
            "runId" to caller.runId, "callId" to caller.callId, "runLifecycle" to 1))
        fun request(name: String, args: Any?, metadata: Any? = meta) = Json.write(mapOf(
            "jsonrpc" to "2.0", "id" to 1, "method" to "tools/call",
            "params" to mapOf("name" to name, "arguments" to args, "_meta" to metadata)))
        val call = server.dispatch(request("diagnostics", mapOf("refresh" to false))) as McpServer.Dispatch.Call
        val result = Json.parse(call.run { _, _, _ -> error("control permission/task handler must not run") }) as Map<*, *>
        val content = ((result["result"] as Map<*, *>)["content"] as List<*>).single() as Map<*, *>
        assertEquals("local", (Json.parse(content["text"] as String) as Map<*, *>)["text"])
        assertTrue(checkNotNull(server.handle(request("apps", emptyMap<String, Any?>(), null))).contains("legacy"))
        assertTrue(checkNotNull(server.handle(request("diagnostics", emptyMap<String, Any?>(), null))).contains("diagnostics_caller_required"))
        for (invalid in listOf(null, true, emptyList<String>())) {
            val reply = Json.parse(checkNotNull(server.handle(request("diagnostics", invalid)))) as Map<*, *>
            assertEquals(-32602L, (reply["error"] as Map<*, *>)["code"])
        }
        val badMeta = mapOf(PhoneCaller.META_KEY to mapOf("v" to 2))
        val invalidMeta = Json.parse(checkNotNull(server.handle(request("diagnostics", emptyMap<String, Any?>(), badMeta)))) as Map<*, *>
        assertEquals(-32602L, (invalidMeta["error"] as Map<*, *>)["code"])
    }

    @Test fun schemaOnlyOffersWhitelistedReadOptions() {
        val tool = PhoneToolCatalog.tools.single { it.name == DiagnosticsTool.NAME }
        assertEquals(listOf("section", "refresh"), tool.properties.keys.toList())
        assertTrue(tool.required.isEmpty())
        assertEquals(DiagnosticsTool.SECTIONS, (tool.properties["section"] as Map<*, *>)["enum"])
        assertFalse(PhoneToolCatalog.SCREEN_TOOLS.contains(DiagnosticsTool.NAME))
    }
}
