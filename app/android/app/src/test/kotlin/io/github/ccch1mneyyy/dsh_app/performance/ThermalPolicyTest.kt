package io.github.ccch1mneyyy.dsh_app.performance

import org.junit.Assert.*
import org.junit.Test

class ThermalPolicyTest {
    @Test fun moderateImmediatelyEntersLightweightAndDuplicatesDoNotBounce() {
        val p = ThermalPolicy()
        assertTrue(p.update(2, 100))
        assertTrue(p.lightweight)
        assertFalse(p.update(2, 200))
        assertNull(p.recoveryAt)
    }

    @Test fun normalOrLightDoesNotDegradeADeviceThatHasNotBeenHot() {
        val p = ThermalPolicy()
        p.update(0, 0)
        p.update(1, 100)
        assertFalse(p.lightweight)
        assertNull(p.recoveryAt)
    }

    @Test fun cooldownNeedsThirtyContinuousSecondsAndWorksWithoutAnotherEvent() {
        val p = ThermalPolicy()
        p.update(3, 0)
        p.update(1, 100)
        assertEquals(30_100L, p.recoveryAt)
        assertFalse(p.advance(30_099))
        assertTrue(p.lightweight)
        assertTrue(p.advance(30_100))
        assertFalse(p.lightweight)
        assertNull(p.recoveryAt)
    }

    @Test fun repeatedCoolEventsDoNotDelayRecoveryForever() {
        val p = ThermalPolicy()
        p.update(2, 0)
        p.update(1, 10)
        p.update(0, 10_000)
        p.update(1, 20_000)
        assertEquals(30_010L, p.recoveryAt)
        assertTrue(p.advance(30_010))
    }

    @Test fun renewedHeatCancelsTheOldRecoveryAndRequiresANewCoolPeriod() {
        val p = ThermalPolicy()
        p.update(2, 0)
        p.update(0, 100)
        p.update(2, 30_000)
        assertNull(p.recoveryAt)
        assertFalse(p.advance(31_000))
        p.update(0, 40_000)
        assertFalse(p.advance(69_999))
        assertTrue(p.advance(70_000))
    }

    @Test fun invalidStatusAndAClockMovingBackwardsCannotClearHotState() {
        val p = ThermalPolicy()
        p.update(6, 1_000)
        assertFalse(p.update(-1, 100_000))
        assertFalse(p.update(99, 100_000))
        assertTrue(p.lightweight)
        p.update(0, 200_000)
        assertFalse(p.advance(0))
        assertTrue(p.lightweight)
    }
}
