package io.github.ccch1mneyyy.dsh_app.phone

import java.util.concurrent.atomic.AtomicBoolean

/** App-owned report sections only: no filesystem, shell, screen or permission APIs. */
class DiagnosticsTool(private val refresh: () -> Boolean) {
    private class Report(val generation: Long, val collectedAt: String, val sections: Map<String, String>)
    private class Publication(val report: Report?, val error: String = "diagnostics_unavailable")
    class Failure(val code: String) : Exception()

    @Volatile private var latest = Publication(null)
    private var generation = 0L
    private val refreshing = AtomicBoolean(false)

    /** A manual/IME report must never replace the ordinary tool-visible publication. */
    @Synchronized fun published(collectedAt: Any?, sections: Any?, manual: Boolean = false) {
        if (manual) return
        val at = (collectedAt as? String)?.takeIf { it.length in 1..64 && it.none { c -> c < ' ' } }
        val raw = sections as? Map<*, *>
        if (at == null || raw == null || raw.isEmpty() || raw.keys.any { it !is String || it !in SECTIONS } || raw.values.any { it !is String }) {
            latest = Publication(null)
            return
        }
        if (raw.values.any { (it as String).toByteArray(Charsets.UTF_8).size > MAX_SECTION_BYTES }) {
            latest = Publication(null, "diagnostics_limit")
            return
        }
        val bounded = linkedMapOf<String, String>()
        for (section in SECTIONS) (raw[section] as? String)?.let { bounded[section] = it }
        latest = Publication(Report(++generation, at, bounded))
    }

    fun call(args: Map<String, Any?>, caller: PhoneCaller?): ToolOutput {
        if (caller == null) return failure("diagnostics_caller_required")
        if (args.keys.any { it !in setOf("section", "refresh") }) return failure("invalid_arguments")
        val section = if (args.containsKey("section")) args["section"] as? String else "summary"
        val shouldRefresh = if (args.containsKey("refresh")) args["refresh"] as? Boolean else true
        if (section == null || section !in SECTIONS || shouldRefresh == null) return failure("invalid_arguments")
        if (shouldRefresh && !refreshing.compareAndSet(false, true)) return failure("diagnostics_busy")
        try {
            val before = latest.report?.generation
            if (shouldRefresh && !refresh()) return failure("diagnostics_unavailable")
            val publication = latest
            val report = publication.report ?: return failure(publication.error)
            if (shouldRefresh && report.generation == before) return failure("diagnostics_unavailable")
            val text = report.sections[section] ?: return failure("diagnostics_section_unavailable")
            return ToolOutput(Json.write(linkedMapOf(
                "code" to "ok", "collectedAt" to report.collectedAt, "section" to section,
                "text" to text, "reportPath" to REPORT_PATH, "refreshed" to shouldRefresh,
            )))
        } catch (e: Failure) {
            return failure(e.code)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return failure("diagnostics_interrupted")
        } catch (_: Exception) {
            return failure("diagnostics_failed")
        } finally {
            if (shouldRefresh) refreshing.set(false)
        }
    }

    companion object {
        const val NAME = "diagnostics"
        const val REPORT_PATH = "/root/.dsh/dsh-app/diagnostics.md"
        const val MAX_SECTION_BYTES = 16 * 1024
        val SECTIONS = listOf("summary", "evidence", "appErrors", "engine", "failure", "voice")
        fun failure(code: String) = ToolOutput(Json.write(mapOf("code" to code)), isError = true)
    }
}
