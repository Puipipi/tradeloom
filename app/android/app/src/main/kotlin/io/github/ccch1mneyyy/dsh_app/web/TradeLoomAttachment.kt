package io.github.ccch1mneyyy.dsh_app.web

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.util.Locale

/** Only the registered five desktop delivery formats may reach Downloads. */
internal object TradeLoomAttachment {
    private const val MAX_BYTES = 64L * 1024 * 1024
    private val route = Regex("^/enterprise/deliveries/[0-9a-f]{32}/[0-9a-f]{32}/download$")
    private val disposition = Regex("""(?i)^attachment\s*;\s*filename\s*=\s*"([a-z_.]+)"\s*$""")
    private val mimeTypes = mapOf(
        "catalog.html" to setOf("text/html"),
        "catalog.md" to setOf("text/markdown", "text/plain", "application/octet-stream"),
        "sample_checklist.csv" to setOf("text/csv", "application/vnd.ms-excel"),
        "sample_checklist.json" to setOf("application/json"),
        "quality_report.json" to setOf("application/json"),
    )
    data class Metadata(val filename: String, val mime: String)

    fun target(originUrl: String, documentUrl: String, raw: String): URI? {
        val origin = parse(originUrl) ?: return null
        val document = parse(documentUrl) ?: return null
        val download = parse(raw) ?: return null
        if (origin.rawPath !in setOf("", "/") || origin.rawQuery != null || origin.rawFragment != null ||
            !sameOrigin(origin, document) || !document.rawPath.startsWith("/enterprise/") ||
            !sameOrigin(origin, download) ||
            download.rawQuery != null || download.rawFragment != null || !route.matches(download.rawPath)) return null
        return download
    }

    private fun parse(raw: String): URI? {
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        val host = uri.host?.lowercase(Locale.ROOT) ?: return null
        val loopback = host in setOf("localhost", "127.0.0.1", "[::1]")
        if (uri.userInfo != null || (uri.port != -1 && uri.port !in 1..65535) ||
            (uri.scheme != "https" && !(uri.scheme == "http" && loopback))) return null
        return uri
    }

    private fun sameOrigin(a: URI, b: URI): Boolean =
        a.scheme == b.scheme && a.host.equals(b.host, ignoreCase = true) && port(a) == port(b)

    private fun port(uri: URI): Int = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80

    fun metadata(status: Int, header: String?, contentType: String?, length: Long): Metadata? {
        if (status != 200 || length !in 1..MAX_BYTES) return null
        val name = disposition.matchEntire(header ?: "")?.groupValues?.get(1) ?: return null
        val mime = contentType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT) ?: return null
        if (mimeTypes[name]?.contains(mime) != true) return null
        // Windows can label this CSV as Excel. MediaStore uses the save MIME
        // to pick an extension, which otherwise appends ".xls" to the CSV name.
        val saveMime = if (name == "sample_checklist.csv" && mime == "application/vnd.ms-excel") "text/csv" else mime
        return Metadata(name, saveMime)
    }

    fun fetch(uri: URI, cookie: String, destination: File, cancelled: () -> Boolean): Metadata {
        val connection = uri.toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.useCaches = false
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("Cookie", cookie)
            if (cancelled()) throw IOException("Cancelled")
            val length = connection.contentLengthLong
            val meta = metadata(connection.responseCode, connection.getHeaderField("Content-Disposition"),
                connection.contentType, length) ?: throw IOException("Attachment unavailable")
            connection.inputStream.use { input ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var written = 0L
                    while (true) {
                        if (cancelled()) throw IOException("Cancelled")
                        val count = input.read(buffer)
                        if (count == -1) break
                        written += count
                        if (written > length) throw IOException("Invalid attachment size")
                        output.write(buffer, 0, count)
                    }
                    if (written != length || cancelled()) throw IOException("Incomplete attachment")
                }
            }
            return meta
        } finally {
            connection.disconnect()
        }
    }
}
