package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResultSilenceTest {
    @Test fun resultsGoQuietOnlyWhileThePetSpeaks() {
        val speaks = ResultSilence.petSpeaks(Visibility.SHOWN, attached = true, systemShown = true, quiet = false)
        assertTrue(speaks)
        // 做完了 / 出错了: silent.
        assertTrue(ResultSilence.silenced(attention = false, petSpeaks = speaks))
        // 等你确认 / 回答: always alert.
        assertFalse(ResultSilence.silenced(attention = true, petSpeaks = speaks))
    }

    @Test fun anythingElseAlertsAsUsual() {
        for ((v, attached, shown, quiet) in listOf(
            Quad(Visibility.SHOWN, true, true, true), // 安静模式: no bubble said it
            Quad(Visibility.PAUSED, true, true, false), // screen off
            Quad(Visibility.HIDDEN, false, true, false), // not out (app on screen, collapsed, off, no permission)
            Quad(Visibility.SHOWN, false, true, false), // window not added
            Quad(Visibility.SHOWN, true, false, false), // hidden by another app's setHideOverlayWindows
        )) {
            val speaks = ResultSilence.petSpeaks(v, attached, shown, quiet)
            assertFalse("$v $attached $shown $quiet", speaks)
            assertFalse(ResultSilence.silenced(attention = false, petSpeaks = speaks))
        }
    }

    private data class Quad(val v: Visibility, val attached: Boolean, val shown: Boolean, val quiet: Boolean)
}
