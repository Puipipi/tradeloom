package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.*
import org.junit.Test

class PetTapsTest {
    private val taps = PetTaps(timeoutMs = 300, slop = 100f)

    /** A tap that takes 80 ms from press to release. */
    private fun tap(downMs: Long, x: Float = 50f, y: Float = 50f) = taps.second(downMs, downMs + 80, x, y)

    @Test fun aTapPlaysAndOnlyAQuickNearbySecondOneOpensTheConversation() {
        assertFalse(tap(1_000))
        assertTrue(tap(1_300, x = 120f))
        // The pair is spent: a third tap starts over rather than opening again.
        assertFalse(tap(1_400, x = 120f))
        assertFalse("too late", tap(1_781, x = 120f))
        assertFalse("too far", tap(1_900, x = 120f, y = 151f))
        assertTrue(tap(2_000, x = 120f, y = 151f))
    }

    @Test fun theWaitRunsFromTheFirstReleaseToTheSecondPress() {
        // Released at 1000; pressed again at 1220 and held until 1330, past 300 ms after the release.
        assertFalse(taps.second(900, 1_000, 50f, 50f))
        assertTrue(taps.second(1_220, 1_330, 50f, 50f))
        assertFalse(taps.second(2_000, 2_080, 50f, 50f))
        assertFalse("pressed 301 ms after the release", taps.second(2_381, 2_400, 50f, 50f))
    }

    @Test fun aDragOrCancelledTouchInBetweenStartsOver() {
        assertFalse(tap(1_000))
        taps.clear()
        assertFalse(tap(1_150))
        assertTrue(tap(1_300))
    }
}
