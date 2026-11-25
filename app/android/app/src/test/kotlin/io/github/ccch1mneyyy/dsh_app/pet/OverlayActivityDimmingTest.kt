package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Refs #426. Exercises the production policy with supplied time; no sleeping or Android stubs. */
class OverlayActivityDimmingTest {
    private val t0 = 1_000_000L
    private val dim = OverlayMachine.DIM_AFTER_MS

    private fun push(active: Boolean, state: String = if (active) "working" else "idle") =
        PetPush("whale-girl", state, 1, null, "s1", null, active, "medium")

    private fun ready(always: Boolean = false) = OverlayMachine().apply {
        enabled = true
        canHost = true
        hasPet = true
        alwaysShow = always
        onPush(push(false), t0)
        onForeground(false, t0)
    }

    @Test fun activeWorkAndPendingRequestsStayLitWithoutRepeatedPushes() {
        for (always in listOf(false, true)) {
            for (state in listOf("working", "thinking", "juggling", "notification")) {
                val machine = ready(always)
                machine.onPush(push(true, state), t0)
                machine.decide(t0)
                for (elapsed in listOf(dim, 90_000L, OverlayMachine.IDLE_COLLAPSE_MS + 1)) {
                    val decision = machine.decide(t0 + elapsed)
                    assertEquals("$always/$state/$elapsed", Visibility.SHOWN, decision.visibility)
                    assertFalse("$always/$state/$elapsed", decision.dimmed)
                    assertNull("active state has no idle-dimming deadline", decision.wakeAt)
                }
            }
        }
    }

    @Test fun activeWorkWakesAnAlreadyDimmedIdlePet() {
        val machine = ready(always = true)
        machine.decide(t0)
        assertTrue(machine.decide(t0 + dim).dimmed)
        machine.onPush(push(true), t0 + dim + 1)
        val decision = machine.decide(t0 + dim + 1)
        assertEquals(Visibility.SHOWN, decision.visibility)
        assertFalse(decision.dimmed)
    }

    @Test fun becomingInactiveStartsTenIdleSecondsAndRepeatedIdlePushesDoNotExtendThem() {
        val machine = ready(always = true)
        machine.onPush(push(true), t0)
        machine.decide(t0)
        val endedAt = t0 + 90_000
        machine.onPush(push(false), endedAt)
        assertFalse(machine.decide(endedAt).dimmed)
        assertEquals(endedAt + dim, machine.decide(endedAt).wakeAt)
        machine.onPush(push(false), endedAt + dim - 1)
        assertFalse(machine.decide(endedAt + dim - 1).dimmed)
        assertTrue(machine.decide(endedAt + dim).dimmed)
    }

    @Test fun idleStillDimsAndTouchStillRestartsItsDeadline() {
        val machine = ready(always = true)
        machine.decide(t0)
        assertFalse(machine.decide(t0 + dim - 1).dimmed)
        assertTrue(machine.decide(t0 + dim).dimmed)
        machine.onTouch(t0 + dim + 1)
        assertFalse(machine.decide(t0 + 2 * dim).dimmed)
        assertTrue(machine.decide(t0 + 2 * dim + 1).dimmed)
        assertEquals(0.6f, OverlayMachine.DIM_ALPHA, 0f)
    }

    @Test fun holdingKeepsAnInactivePetLitWithoutOverridingScreenOff() {
        val machine = ready()
        machine.holding = true
        machine.decide(t0)
        assertEquals(Visibility.SHOWN, machine.decide(t0 + 90_000).visibility)
        assertFalse(machine.decide(t0 + 90_000).dimmed)
        machine.interactive = false
        assertEquals(Visibility.PAUSED, machine.decide(t0 + 90_000).visibility)
    }

    @Test fun activeDoesNotOverridePhoneTaskScreenOffForegroundOrSnooze() {
        val machine = ready()
        machine.onPush(push(true), t0)
        machine.decide(t0)
        val later = t0 + 90_000
        machine.phoneTask = true
        assertEquals("phone task", machine.decide(later).why)
        assertEquals(Visibility.HIDDEN, machine.decide(later).visibility)
        machine.phoneTask = false
        machine.interactive = false
        assertEquals(Visibility.PAUSED, machine.decide(later).visibility)
        machine.interactive = true
        machine.onForeground(true, later)
        assertEquals(Visibility.HIDDEN, machine.decide(later).visibility)
        machine.onForeground(false, later)
        machine.snoozedUntil = later + 1_000
        assertEquals("snoozed", machine.decide(later).why)
        assertEquals(Visibility.HIDDEN, machine.decide(later).visibility)
    }
}
