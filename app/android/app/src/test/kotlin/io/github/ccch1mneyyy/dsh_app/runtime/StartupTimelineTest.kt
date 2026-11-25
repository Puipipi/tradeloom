package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StartupTimelineTest {
    @Test fun launchStartIncludesTheAppPart() {
        val t = StartupTimeline(processStart = 1_000)
        t.requested(now = 1_640)
        t.spawned(now = 1_760)
        assertEquals("[dsh-app] startup: app 640 ms, prepare 120 ms, dsh 2300 ms", t.ready(now = 4_060))
    }

    @Test fun laterStartsLeaveTheAppPartOut() {
        assertEquals(
            "[dsh-app] startup: prepare 80 ms, dsh 1900 ms",
            StartupTimeline.line(processStart = 1_000, requested = 600_000, spawned = 600_080, ready = 601_980),
        )
        assertEquals(
            "[dsh-app] startup: prepare 80 ms, dsh 1900 ms",
            StartupTimeline.line(processStart = null, requested = 5_000, spawned = 5_080, ready = 6_980),
        )
    }

    @Test fun nothingWithoutTheEarlierMarks() {
        val t = StartupTimeline(processStart = 1_000)
        assertNull(t.ready(now = 2_000))
        t.requested(now = 1_500)
        assertNull("not spawned yet", t.ready(now = 2_000))
        t.spawned(now = 1_600)
        t.requested(now = 3_000)
        assertNull("a new start clears the old spawn", t.ready(now = 3_500))
    }
}
