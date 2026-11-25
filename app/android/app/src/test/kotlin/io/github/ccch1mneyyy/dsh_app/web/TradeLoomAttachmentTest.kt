package io.github.ccch1mneyyy.dsh_app.web

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class TradeLoomAttachmentTest {
    private val path = "/enterprise/deliveries/" + "a".repeat(32) + "/" + "b".repeat(32) + "/download"

    @Test fun routeUsesExactOriginAndRegisteredPath() {
        val origin = "https://portal.example"
        val document = "$origin/enterprise/deliveries/"
        assertNotNull(TradeLoomAttachment.target(origin, document, uri(origin)))
        for (invalid in listOf(
            "http://portal.example$path", "https://portal.example:444$path",
            "https://portal.example.evil$path", "https://user@portal.example$path",
            "$origin$path?extra=1", "$origin$path#fragment", "$origin$path/",
            "$origin${path.replace("/download", "/preview")}",
            "$origin${path.replace("/enterprise", "/%65nterprise")}",
        )) assertNull(invalid, TradeLoomAttachment.target(origin, document, invalid))
        assertNull(TradeLoomAttachment.target(origin, "https://other.example/enterprise/", uri(origin)))
        assertNull(TradeLoomAttachment.target(origin, "$origin/accounts/login/", uri(origin)))
    }

    @Test fun metadataKeepsDesktopFilenamesAndRejectsUnsafeResponses() {
        val types = mapOf(
            "catalog.html" to "text/html", "catalog.md" to "text/markdown",
            "sample_checklist.csv" to "text/csv", "sample_checklist.json" to "application/json",
            "quality_report.json" to "application/json",
        )
        for ((filename, type) in types) {
            assertEquals(filename, TradeLoomAttachment.metadata(200, "attachment; filename=\"$filename\"", type, 853)?.filename)
        }
        val csv = "attachment; filename=\"sample_checklist.csv\""
        val windowsCsv = TradeLoomAttachment.metadata(200, csv, "application/vnd.ms-excel", 378)
        assertEquals(TradeLoomAttachment.Metadata("sample_checklist.csv", "text/csv"), windowsCsv)
        assertEquals(windowsCsv, TradeLoomAttachment.metadata(200, csv, "text/csv", 378))
        assertNull(TradeLoomAttachment.metadata(200, csv, "text/x-csv", 378))
        assertNull(TradeLoomAttachment.metadata(200, "attachment; filename=\"quality_report.json\"", "application/vnd.ms-excel", 378))
        val disposition = "attachment; filename=\"quality_report.json\""
        assertNull(TradeLoomAttachment.metadata(302, disposition, "application/json", 853))
        assertNull(TradeLoomAttachment.metadata(200, disposition, "text/html", 853))
        assertNull(TradeLoomAttachment.metadata(200, disposition, "application/json", -1))
        assertNull(TradeLoomAttachment.metadata(200, disposition, "application/json", 65L * 1024 * 1024))
        assertNull(TradeLoomAttachment.metadata(200, "inline; filename=\"quality_report.json\"", "application/json", 853))
        assertNull(TradeLoomAttachment.metadata(200, "attachment; filename=\"../quality_report.json\"", "application/json", 853))
    }

    @Test fun fetchUsesOneAuthorizedGetAndNeverFollowsRedirects() {
        val count = AtomicInteger()
        val redirected = AtomicInteger()
        val fixture = """{"ok":true}""".toByteArray()
        val cookie = "sessionid=synthetic-local-test"
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val returnRedirect = AtomicBoolean()
        server.createContext(path) { request ->
            count.incrementAndGet()
            if (returnRedirect.get()) {
                request.responseHeaders.add("Location", "/unexpected")
                request.sendResponseHeaders(302, -1)
            } else if (request.requestMethod == "GET" && request.requestHeaders.getFirst("Cookie") == cookie) {
                request.responseHeaders.add("Content-Disposition", "attachment; filename=\"quality_report.json\"")
                request.responseHeaders.add("Content-Type", "application/json")
                request.sendResponseHeaders(200, fixture.size.toLong())
                request.responseBody.write(fixture)
            } else {
                request.sendResponseHeaders(403, -1)
            }
            request.close()
        }
        server.createContext("/unexpected") { request ->
            redirected.incrementAndGet()
            request.sendResponseHeaders(200, -1)
            request.close()
        }
        server.start()
        val staging = File.createTempFile("enterprise-delivery-", ".part")
        try {
            val origin = "http://127.0.0.1:${server.address.port}"
            val target = checkNotNull(TradeLoomAttachment.target(origin, "$origin/enterprise/", uri(origin)))
            assertEquals("quality_report.json", TradeLoomAttachment.fetch(target, cookie, staging) { false }.filename)
            assertArrayEquals(fixture, staging.readBytes())
            assertEquals(1, count.get())
            assertTrue(runCatching { TradeLoomAttachment.fetch(target, cookie, staging) { true } }.isFailure)
            assertEquals(1, count.get())
            assertTrue(runCatching { TradeLoomAttachment.fetch(target, "sessionid=invalid", staging) { false } }.isFailure)
            assertEquals(2, count.get())
            returnRedirect.set(true)
            assertTrue(runCatching { TradeLoomAttachment.fetch(target, cookie, staging) { false } }.isFailure)
            assertEquals(3, count.get())
            assertEquals(0, redirected.get())
        } finally {
            staging.delete()
            server.stop(0)
        }
    }

    private fun uri(origin: String) = origin + path
}
