package io.github.ccch1mneyyy.dsh_app.diagnostics

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class SystemImeLogcatTest {
    private val at = 1_790_000_020_000L
    private val event = "1790000019.100 42 42 I ImeTracker: " + SystemImeEvidence.APP_PACKAGE +
        ":abc: onRequestShow at ORIGIN_CLIENT reason SHOW_SOFT_INPUT fromUser true\n"
    private open class FakeProcess(data: String, private val status: Int = 0) : Process() {
        var killed = false
        private val input = ByteArrayInputStream(data.toByteArray())
        override fun getInputStream(): InputStream = input
        override fun getOutputStream() = ByteArrayOutputStream()
        override fun getErrorStream(): InputStream = ByteArrayInputStream(byteArrayOf())
        override fun waitFor() = status
        override fun waitFor(timeout: Long, unit: TimeUnit) = true
        override fun exitValue() = status
        override fun destroy() { killed = true }
        override fun destroyForcibly(): Process { destroy(); return this }
    }
    @Test fun returnsOnlyParsedEventsAndKillsProcess() {
        val process = FakeProcess("private unknown text\n" + event)
        val capture = SystemImeLogcat.read(process, 42, at)
        assertEquals("ok", capture.code)
        assertEquals(1, capture.events.size)
        assertFalse(capture.toString().contains("private unknown"))
        assertTrue(process.killed)
    }
    @Test fun eventAndByteLimitsDiscardAllPartialDataAndKill() {
        for (text in listOf(event.repeat(65), "x".repeat(SystemImeEvidence.MAX_BYTES + 1))) {
            val process = FakeProcess(text)
            val capture = SystemImeLogcat.read(process, 42, at)
            assertEquals("limitExceeded", capture.code)
            assertTrue(capture.events.isEmpty())
            assertTrue(process.killed)
        }
    }
    @Test fun oversizedLineAndUnterminatedLineAreNeverParsed() {
        val process = FakeProcess(event.trimEnd() + "x".repeat(2100) + "\n" + event.trimEnd())
        assertEquals("noEvents", SystemImeLogcat.read(process, 42, at).code)
    }
    @Test fun nonzeroExitIsNotNormalEmptyEvidence() {
        assertEquals("unavailable", SystemImeLogcat.read(FakeProcess("permission denied", 1), 42, at).code)
    }
    @Test fun cancellingConsentDoesNotInterruptOrCloseSharedAdbExchange() {
        val consent = SystemImeConsent().apply { assertTrue(approveAndConsume()) }
        val bytes = ByteArrayOutputStream().apply {
            write(io.github.ccch1mneyyy.dsh_app.phone.background.Frames.MAGIC)
            io.github.ccch1mneyyy.dsh_app.phone.background.Frames.write(this, byteArrayOf(1))
            io.github.ccch1mneyyy.dsh_app.phone.background.Frames.write(this, byteArrayOf(2))
        }.toByteArray()
        val ready = CountDownLatch(1)
        val release = CountDownLatch(1)
        val stream = object : ByteArrayInputStream(bytes) {
            override fun read(): Int {
                if (pos == 4) { ready.countDown(); release.await(2, TimeUnit.SECONDS) }
                return super.read()
            }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (pos == 4) { ready.countDown(); release.await(2, TimeUnit.SECONDS) }
                return super.read(buffer, offset, length)
            }
        }
        var closed = false
        val session = io.github.ccch1mneyyy.dsh_app.phone.background.AdbFramedSession(
            stream, ByteArrayOutputStream(), { true }, { closed = true },
        )
        var failure: Throwable? = null
        val worker = Thread {
            try { assertArrayEquals(byteArrayOf(1), session.exchange(byteArrayOf(3))) }
            catch (error: Throwable) { failure = error }
        }
        worker.start()
        assertTrue(ready.await(2, TimeUnit.SECONDS))
        // This is the prompt cancellation primitive. It must not interrupt the transport worker.
        consent.cancel()
        assertFalse(consent.allowed())
        release.countDown()
        worker.join(2000)
        assertFalse(worker.isAlive)
        assertNull(failure)
        assertTrue(session.alive())
        assertFalse(closed)
        assertArrayEquals(byteArrayOf(2), session.exchange(byteArrayOf(4)))
    }

    @Test fun blockedReaderHitsDeadlineAndProcessIsKilled() {
        val stop = CountDownLatch(1)
        val process = object : FakeProcess("") {
            override fun getInputStream() = object : InputStream() {
                override fun read(): Int { stop.await(5, TimeUnit.SECONDS); return -1 }
            }
            override fun destroy() { super.destroy(); stop.countDown() }
        }
        val started = System.nanoTime()
        val capture = SystemImeLogcat.read(process, 42, at)
        assertEquals("timeout", capture.code)
        assertTrue(process.killed)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 4000)
        assertTrue(capture.events.isEmpty())
    }
}
