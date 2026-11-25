package io.github.ccch1mneyyy.dsh_app.diagnostics

import org.junit.Assert.*
import org.junit.Test

class SystemImeEvidenceTest {
    private val at = 1_790_000_020_000L
    private val pkg = SystemImeEvidence.APP_PACKAGE
    private fun line(message: String, tag: String = "ImeTracker", pid: Int = 42, seconds: String = "1790000019.123456") =
        "$seconds  $pid  56 I $tag: $message"
    private fun tracker(reason: String = "SHOW_SOFT_INPUT", suffix: String = " fromUser true") =
        "$pkg:a1b2: onRequestShow at ORIGIN_CLIENT reason $reason$suffix"
    private fun parse(value: String) = SystemImeEvidence.parse(value, 42, at)

    @Test fun epochPaddingDoesNotDiscardAppEvents() {
        val trackerEvent = parse("         " + line(tracker()))!!
        assertEquals("requestShow", trackerEvent.event)
        assertEquals(1_790_000_019_123L, trackerEvent.timestamp)
        val legacy = line("showSoftInput() view=android.view.View{123} flags=0", "InputMethodManager")
        assertEquals("requestShow", parse("         " + legacy)!!.event)
        assertNull(parse("not a timestamp " + line(tracker())))
    }
    @Test fun trackerPackageNameCannotAuthenticateAnotherProcess() {
        assertNull(parse(line(tracker(), pid = 99)))
        assertNull(SystemImeEvidence.parse(line(tracker()), 0, at))
        assertNotNull(parse(line(tracker(), pid = 42)))
    }

    @Test fun trackerReturnsOnlyFixedFields() {
        val event = parse(line(tracker()))!!
        assertEquals(1_790_000_019_123L, event.timestamp)
        assertEquals("requestShow", event.event)
        assertEquals(true, event.fromUser)
        assertEquals("SHOW_SOFT_INPUT", event.reason)
        assertEquals("imeTracker", event.origin)
        assertEquals(setOf("timestamp", "event", "fromUser", "reason", "origin"), event.map().keys)
        assertFalse(event.map().toString().contains(pkg))
    }
    @Test fun trackerAbsentUserFlagIsUnknownNotFalse() {
        assertNull(parse(line(tracker(suffix = "")))!!.fromUser)
        assertEquals(false, parse(line(tracker(suffix = " fromUser false")))!!.fromUser)
    }
    @Test fun trackerOtherPackagesUnknownEventsAndReasonsAreDiscarded() {
        assertNull(parse(line(tracker().replace(pkg, "other.app"))))
        assertNull(parse(line(tracker().replace(pkg, pkg + ".suffix"))))
        assertNull(parse(line(tracker("PRIVATE_INPUT"))))
        assertNull(parse(line(tracker() + " text=secret")))
        assertNull(parse(line("$pkg:123: onShown")))
        assertNull(parse(line("text=" + tracker())))
        assertNull(parse(line(tracker(), tag = "RandomTag")))
    }
    @Test fun epochWindowRejectsOldFutureMalformedAndOversizedLines() {
        assertNotNull(parse(line(tracker(), seconds = "1789999900.000")))
        assertNull(parse(line(tracker(), seconds = "1789999899.999")))
        assertNull(parse(line(tracker(), seconds = "1790000020.001")))
        assertNull(parse("not epoch " + line(tracker())))
        assertNull(parse(line(tracker()) + "x".repeat(2048)))
    }
    @Test fun android12RequestsRequireOwnPidAndAnchoredMessageShape() {
        val message = "showSoftInput() view=FlutterView{abc} flags=0 reason=SHOW_SOFT_INPUT"
        val event = parse(line(message, "InputMethodManager"))!!
        assertEquals("requestShow", event.event)
        assertEquals("inputMethodManager", event.origin)
        assertNull(event.fromUser)
        assertEquals("unknown", event.reason)
        assertNull(parse(line(message, "InputMethodManager", pid = 99)))
        assertNull(parse(line("text=$message", "InputMethodManager")))
        assertNull(parse(line("$pkg $message", "InputMethodManager", pid = 99)))
        assertNull(parse(line("showSoftInput(secret)", "InputMethodManager")))
        assertNotNull(parse(line("hideSoftInputFromWindow() token=android.view.Token@abc flags=0", "InputMethodManager")))
    }
    @Test fun closedConnectionIsExactAndOwnPidOnly() {
        for (tag in listOf("RemoteInputConnectionImpl", "IInputConnectionWrapper")) {
            val event = parse(line("Calling View.onInputConnectionClosed()", tag))!!
            assertEquals("connectionClosed", event.event)
            assertEquals("inputConnection", event.origin)
            assertNull(parse(line("Calling View.onInputConnectionClosed() secret", tag)))
            assertNull(parse(line("Calling View.onInputConnectionClosed()", tag, pid = 99)))
        }
    }
    @Test fun revalidationRejectsUntrustedCoreFields() {
        val event = parse(line(tracker()))!!
        assertTrue(SystemImeEvidence.valid(event, at))
        assertFalse(SystemImeEvidence.valid(event.copy(reason = "private words"), at))
        assertFalse(SystemImeEvidence.valid(event.copy(event = "typed words"), at))
        assertFalse(SystemImeEvidence.valid(event.copy(origin = "arbitrary"), at))
        assertFalse(SystemImeEvidence.valid(event.copy(timestamp = at + 1), at))
    }
    @Test fun oldCoreHasStableDowngradeAndNoRawError() {
        assertEquals("unsupported", SystemImeEvidence.coreCode(false, "invalidArguments"))
        assertEquals("unavailable", SystemImeEvidence.coreCode(false, "private exception text"))
        assertEquals("noEvents", SystemImeEvidence.coreCode(true, "noEvents"))
        assertEquals(emptyList<Any>(), SystemImeEvidence.result("noEvents")["events"])
        assertEquals(true, SystemImeEvidence.result("noEvents")["ok"])
        assertEquals(false, SystemImeEvidence.result("unavailable")["ok"])
    }
    @Test fun queuedRequestsExpireBeforeStartingAnotherRead() {
        assertTrue(SystemImeEvidence.requestFresh(at, at))
        assertTrue(SystemImeEvidence.requestFresh(at - 4000, at))
        assertFalse(SystemImeEvidence.requestFresh(at - 4001, at))
        assertFalse(SystemImeEvidence.requestFresh(at + 1, at))
        assertFalse(SystemImeEvidence.requestFresh(0, at))
    }

    @Test fun consentMustBeFreshAndCannotSurviveCancellationOrBeReused() {
        val first = SystemImeConsent()
        assertFalse(first.allowed())
        first.cancel()
        assertFalse(first.approveAndConsume())
        val next = SystemImeConsent()
        assertFalse(next.allowed())
        assertTrue(next.approveAndConsume())
        assertTrue(next.allowed())
        assertFalse(next.approveAndConsume())
        next.cancel()
        assertFalse(next.allowed())
    }
    @Test fun commandIsFixedReadOnlyAndNarrow() {
        assertEquals(listOf("/system/bin/logcat", "-d", "-v", "epoch", "-t", "1000",
            "ImeTracker:I", "InputMethodManager:D", "RemoteInputConnectionImpl:W",
            "IInputConnectionWrapper:W", "*:S"), SystemImeEvidence.command)
    }
}
