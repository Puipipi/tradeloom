package io.github.ccch1mneyyy.dsh_app.diagnostics

import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Content-free records only. Both disk reads and retained JSON have hard byte limits. */
internal class EvidenceStore(private val directory: File) {
    @Synchronized
    fun read(kind: String): List<Map<String, Any?>> {
        val file = file(kind)
        if (!file.exists()) return emptyList()
        val bytes = RandomAccessFile(file, "r").use { input ->
            val size = input.length()
            check(size <= MAX_FILE_BYTES) { "evidence_oversized" }
            ByteArray(size.toInt()).also { input.readFully(it) }
        }
        val array = JSONArray(String(bytes, Charsets.UTF_8))
        return (maxOf(0, array.length() - MAX_ENTRIES) until array.length()).mapNotNull { i ->
            val row = array.optJSONObject(i) ?: return@mapNotNull null
            val fields = row.keys().asSequence().associateWith { row.opt(it) }
            sanitize(kind, fields, (fields["at"] as? Number)?.toLong() ?: return@mapNotNull null)
        }
    }

    @Synchronized
    fun append(kind: String, fields: Map<*, *>, at: Long = System.currentTimeMillis()) {
        val record = requireNotNull(sanitize(kind, fields, at)) { "invalid_evidence" }
        // A corrupt old file is replaced by the next valid event, not an unbounded retry.
        val records = (runCatching { read(kind) }.getOrDefault(emptyList()).takeLast(MAX_ENTRIES - 1) + record).toMutableList()
        var bytes = JSONArray(records).toString().toByteArray(Charsets.UTF_8)
        while (bytes.size > MAX_FILE_BYTES && records.size > 1) {
            records.removeAt(0)
            bytes = JSONArray(records).toString().toByteArray(Charsets.UTF_8)
        }
        check(bytes.size <= MAX_FILE_BYTES)
        check(directory.isDirectory || directory.mkdirs())
        val target = file(kind)
        val temporary = File(directory, "$kind.tmp")
        FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    private fun file(kind: String): File {
        require(kind == "appErrors" || kind == "voiceStages")
        return File(directory, "$kind.json")
    }

    companion object {
        const val MAX_ENTRIES = 40
        const val MAX_FILE_BYTES = 24 * 1024
        const val MAX_BYTES = 64 * 1024
        val STAGES = setOf(
            "preparing", "listening", "stopping", "transcribing", "completed", "cancelled", "error",
            "call_started", "capture_started", "utterance_ready", "recognizing", "recognized",
            "reply_received", "synthesis_requested", "playback_opening", "playback_started", "interrupted", "call_ended", "failed",
        )
        val BACKENDS = setOf("deepseek", "cloud", "system", "local", "unknown")
        val ERROR_TYPES = setOf(
            "StateError", "ArgumentError", "RangeError", "TypeError", "FormatException", "TimeoutException",
            "PlatformException", "MissingPluginException", "FlutterError", "AssertionError", "SocketException",
            "HttpException", "FileSystemException", "UnsupportedError", "OtherError",
        )
        private val location = Regex("package:(?:dsh_app|flutter)/[A-Za-z0-9_/.-]{1,120}\\.dart:[0-9]{1,7}:[0-9]{1,7}")

        fun sanitize(kind: String, fields: Map<*, *>, at: Long): Map<String, Any?>? {
            if (at < 0) return null
            return when (kind) {
                "appErrors" -> {
                    val source = (fields["source"] as? String)?.takeIf { it.length <= 16 }
                    if (source !in setOf("flutter", "platform", "session")) return null
                    val stack = (fields["stack"] as? String)?.takeIf { it.length <= 2048 }.orEmpty()
                    mapOf(
                        "at" to at, "source" to source,
                        "errorType" to (fields["errorType"] as? String)?.takeIf { it.length <= 32 && it in ERROR_TYPES }.orEmpty().ifEmpty { "OtherError" },
                        "stack" to stack.lineSequence().filter { it.length <= 160 && location.matches(it) }.take(6).joinToString("\n"),
                    )
                }
                "voiceStages" -> {
                    val stage = (fields["stage"] as? String)?.takeIf { it.length <= 32 }
                    val backend = fields["backend"] ?: "unknown"
                    if (backend !is String || backend.length > 16) return null
                    if (stage !in STAGES || backend !in BACKENDS) return null
                    buildMap {
                        put("at", at); put("stage", stage); put("backend", backend)
                        (fields["code"] as? Int)?.let { put("code", it) }
                    }
                }
                else -> null
            }
        }
    }
}
