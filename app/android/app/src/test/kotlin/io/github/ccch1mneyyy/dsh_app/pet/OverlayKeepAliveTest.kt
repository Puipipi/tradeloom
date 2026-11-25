package io.github.ccch1mneyyy.dsh_app.pet

import io.github.ccch1mneyyy.dsh_app.pet.OverlayKeepAlive.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayKeepAliveTest {
    @Test fun hideBeforePromotionWaitsForTheForegroundHandshake() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        assertFalse(keepAlive.running)
        assertEquals(Action.NONE, keepAlive.setNeeded(false))
        assertEquals(Action.STOP, keepAlive.promoted())
        assertEquals(Action.NONE, keepAlive.destroyed())
        assertFalse(keepAlive.running)
    }

    @Test fun showAgainBeforePromotionDoesNotStartAnotherService() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        assertEquals(Action.NONE, keepAlive.setNeeded(false))
        assertEquals(Action.NONE, keepAlive.setNeeded(true))
        assertEquals(Action.NONE, keepAlive.promoted())
        assertTrue(keepAlive.running)
        assertEquals(Action.STOP, keepAlive.setNeeded(false))
    }

    @Test fun showDuringTeardownStartsOnlyAfterDestruction() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        assertEquals(Action.NONE, keepAlive.promoted())
        assertEquals(Action.STOP, keepAlive.setNeeded(false))
        assertEquals(Action.NONE, keepAlive.setNeeded(true))
        assertEquals(Action.START, keepAlive.destroyed())
        assertEquals(Action.NONE, keepAlive.promoted())
        assertTrue(keepAlive.running)
    }

    @Test fun rejectedStartCanBeRetriedOnTheNextEvaluation() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        keepAlive.requestFailed(Action.START)
        assertFalse(keepAlive.running)
        assertEquals(Action.START, keepAlive.setNeeded(true))
    }

    @Test fun failedPromotionDoesNotRestartInsideOnDestroy() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        keepAlive.promotionFailed()
        assertFalse(keepAlive.running)
        assertEquals(Action.NONE, keepAlive.destroyed())
        assertEquals(Action.START, keepAlive.setNeeded(true))
    }

    @Test fun snoozeOrDisableStopsAnAlreadyForegroundService() {
        val keepAlive = OverlayKeepAlive()
        assertEquals(Action.START, keepAlive.setNeeded(true))
        assertEquals(Action.NONE, keepAlive.promoted())
        assertEquals(Action.STOP, keepAlive.setNeeded(false))
        assertEquals(Action.NONE, keepAlive.setNeeded(false))
        assertEquals(Action.NONE, keepAlive.destroyed())
    }
}
