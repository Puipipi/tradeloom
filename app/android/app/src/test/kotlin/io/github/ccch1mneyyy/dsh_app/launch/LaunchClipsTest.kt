package io.github.ccch1mneyyy.dsh_app.launch

import org.junit.Assert.assertEquals
import org.junit.Test

class LaunchClipsTest {
    @Test fun aQuarterTurnSwapsTheFrame() {
        assertEquals(1080 to 1920, LaunchClips.shown(1080, 1920, 0))
        assertEquals(1080 to 1920, LaunchClips.shown(1920, 1080, 90))
        assertEquals(1080 to 1920, LaunchClips.shown(1920, 1080, 270))
        assertEquals(1920 to 1080, LaunchClips.shown(1920, 1080, 180))
        assertEquals(1080 to 1920, LaunchClips.shown(1920, 1080, -90))
    }

    @Test fun posterIsAtMostAScreenLong() {
        assertEquals(810 to 1440, LaunchClips.posterSize(1080, 1920))
        assertEquals(1440 to 810, LaunchClips.posterSize(3840, 2160))
        assertEquals(720 to 1280, LaunchClips.posterSize(720, 1280))
    }
}
