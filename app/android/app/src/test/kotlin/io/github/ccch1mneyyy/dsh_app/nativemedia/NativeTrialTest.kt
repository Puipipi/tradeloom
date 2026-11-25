package io.github.ccch1mneyyy.dsh_app.nativemedia

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeTrialTest {
    private class Marks : NativeTrial.Marks {
        val on = mutableSetOf<String>()
        override fun has(name: String) = name in on
        override fun set(name: String, on: Boolean) {
            if (on) this.on += name else this.on -= name
        }
    }

    @Test fun aTrialThatAnsweredIsProvenAndNeverMarkedAgain() {
        val marks = Marks()
        val trial = NativeTrial(marks, "ort-1.27.0")
        assertFalse(trial.blocked())
        assertFalse(trial.proven)
        trial.begin()
        trial.passed()
        assertTrue(trial.proven)
        assertFalse(NativeTrial(marks, "ort-1.27.0").blocked())
    }

    @Test fun aMarkLeftBehindBlocksThatVersionForGoodButNotTheNext() {
        val marks = Marks()
        NativeTrial(marks, "ort-1.23.2").begin()
        // The app died there; the next call finds the mark.
        assertTrue(NativeTrial(marks, "ort-1.23.2").blocked())
        assertTrue(NativeTrial(marks, "ort-1.23.2").blocked())
        assertFalse(NativeTrial(marks, "ort-1.27.0").blocked())
    }

    @Test fun anExceptionIsNoVerdict() {
        val marks = Marks()
        val trial = NativeTrial(marks, "ort-1.27.0")
        trial.begin()
        trial.dropped()
        assertFalse(NativeTrial(marks, "ort-1.27.0").blocked())
        assertFalse(trial.proven)
    }
}
