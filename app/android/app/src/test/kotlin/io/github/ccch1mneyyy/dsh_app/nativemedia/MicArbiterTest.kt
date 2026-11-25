package io.github.ccch1mneyyy.dsh_app.nativemedia

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MicArbiterTest {
    @After fun tearDown() = MicArbiter.reset()

    @Test fun dictationStopsAListeningPluginFirst() {
        var yielded = 0
        val plugin = MicArbiter.Holder { yielded++ }
        assertTrue(MicArbiter.acquire(plugin))
        val token = MicArbiter.beginDictation()
        assertEquals(1, yielded)
        assertFalse("no plugin while dictating", MicArbiter.acquire(plugin))
        MicArbiter.endDictation(token)
        assertTrue(MicArbiter.acquire(plugin))
        MicArbiter.release(plugin)
        MicArbiter.beginDictation()
        assertEquals("a released plugin is not asked again", 1, yielded)
    }

    @Test fun anOldDictationsLateEndDoesNotFreeANewOne() {
        val first = MicArbiter.beginDictation()
        MicArbiter.beginDictation()
        MicArbiter.endDictation(first) // the old recorder finished closing on its thread
        assertTrue(MicArbiter.dictating)
        assertFalse(MicArbiter.acquire { })
    }

    @Test fun newerDictationEndingDoesNotFreeAnOlderRecorderStillClosing() {
        val olderClosing = MicArbiter.beginDictation()
        val newer = MicArbiter.beginDictation()
        MicArbiter.endDictation(newer)
        assertTrue("the older recorder still owns its close", MicArbiter.dictating)
        assertFalse(MicArbiter.acquire { })
        MicArbiter.endDictation(olderClosing)
        assertFalse(MicArbiter.dictating)
        assertTrue(MicArbiter.acquire { })
    }

    @Test fun duplicateOrUnknownEndCannotReleaseAnotherDictationsClose() {
        val olderClosing = MicArbiter.beginDictation()
        val newer = MicArbiter.beginDictation()
        MicArbiter.endDictation(newer)
        MicArbiter.endDictation(newer)
        MicArbiter.endDictation(newer + 1) // never issued
        assertTrue(MicArbiter.dictating)
        assertFalse(MicArbiter.acquire { })
        MicArbiter.endDictation(olderClosing)
        assertFalse(MicArbiter.dictating)
    }

}
