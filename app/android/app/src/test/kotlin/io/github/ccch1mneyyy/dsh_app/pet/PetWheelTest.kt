package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

class PetWheelTest {
    private val area = SafeArea(412, 900, 0, 24, 0, 24)
    private fun fit(count: Int = 7, side: Side = Side.LEFT, y: Float = 460f, a: SafeArea = area, density: Float = 1f, fontScale: Float = 1f) =
        PetWheelGeometry.fit(count, side, if (side == Side.LEFT) 30f else a.screenW - 30f, y, a, density, fontScale)

    @Test fun everyActionIsReachableAndSidesAreExactMirrors() {
        for (count in 5..7) {
            val left = fit(count)
            val right = fit(count, Side.RIGHT)
            assertFalse(left.list)
            assertFalse(right.list)
            left.centers.forEachIndexed { i, p ->
                val mirrored = right.centers[i]
                assertEquals(area.screenW.toFloat(), p.first + mirrored.first, 0.01f)
                assertEquals(p.second, mirrored.second, 0.01f)
                assertEquals(i, left.hit(p.first, p.second))
                assertEquals(i, right.hit(mirrored.first, mirrored.second))
            }
        }
    }

    @Test fun selectionLiftAndButtonsStayWithinInsetsAtEitherVerticalEdge() {
        for (y in listOf(-100f, 20f, 460f, 900f, 1200f)) for (side in Side.entries) {
            val g = fit(side = side, y = y)
            assertTrue(g.bounds.left >= area.left)
            assertTrue(g.bounds.right <= area.screenW - area.right)
            assertTrue(g.bounds.top >= area.top)
            assertTrue(g.bounds.bottom <= area.screenH - area.bottom)
            for ((x, py) in g.centers) {
                assertTrue(x - g.buttonWidth / 2f - 12 >= g.bounds.left)
                assertTrue(x + g.buttonWidth / 2f + 12 <= g.bounds.right)
                assertTrue(py - g.buttonHeight / 2f - 12 >= g.bounds.top)
                assertTrue(py + g.buttonHeight / 2f + 12 <= g.bounds.bottom)
            }
        }
    }

    @Test fun neighboringButtonsHaveRoomEvenWhenLiftedAndScaled() {
        for (count in 5..7) {
            val g = fit(count)
            for (i in 0 until count - 1) {
                val a = g.centers[i]
                val b = g.centers[i + 1]
                // Round buttons: the chosen one grows to 1.24 and its neighbour to about 1.03.
                assertTrue(kotlin.math.hypot(a.first - b.first, a.second - b.second) > g.buttonWidth * 1.15f)
            }
        }
    }

    @Test fun centerOutsideAndBackHalfNeverSelect() {
        val g = fit()
        assertNull(g.hit(g.centerX, g.centerY))
        assertNull(g.hit(g.centerX + 30, g.centerY))
        assertNull(g.hit(g.centerX + g.radius * 0.43f, g.centerY))
        assertNull(g.hit(g.centerX - 5, g.centerY - 100))
        assertNull(g.hit(1000f, g.centerY))
        assertNull(g.hit(g.centerX + 400, g.centerY))
    }

    @Test fun boundaryHysteresisIsSmallAndDoesNotStickAcrossSectors() {
        val g = fit()
        val boundary = -PI / 2 + 3 * PI / 7
        val x = g.centerX + g.radius * cos(boundary + 0.01).toFloat()
        val y = g.centerY + g.radius * sin(boundary + 0.01).toFloat()
        assertEquals(3, g.hit(x, y))
        assertEquals(2, g.hit(x, y, 2))
        val next = g.centers[4]
        assertEquals(4, g.hit(next.first, next.second, 2))
    }

    @Test fun narrowLandscapeAndLargeFontsUseBoundedScrollableLabels() {
        for (a in listOf(SafeArea(220, 330, 8, 24, 8, 20), SafeArea(780, 340, 40, 0, 30, 24))) {
            val g = fit(a = a)
            assertTrue(g.list)
            assertTrue(g.bounds.width > 0 && g.bounds.height > 0)
            assertTrue(g.bounds.left >= a.left && g.bounds.right <= a.screenW - a.right)
            assertTrue(g.bounds.top >= a.top && g.bounds.bottom <= a.screenH - a.bottom)
        }
        assertTrue(fit(fontScale = 2f).list)
    }

    @Test fun geometryScalesInPhysicalPixels() {
        val normal = fit()
        val doubled = PetWheelGeometry.fit(7, Side.LEFT, 60f, 920f, SafeArea(824, 1800, 0, 48, 0, 48), 2f, 1f)
        assertFalse(doubled.list)
        assertEquals(normal.radius * 2, doubled.radius, 0.01f)
        assertEquals(normal.centerY * 2, doubled.centerY, 0.01f)
    }

    @Test fun returningToOriginOrLeavingWheelClearsPreviouslySelectedAction() {
        val g = fit()
        val gesture = PetWheelGesture(g.centerX, g.centerY, 10f)
        val p = g.centers[2]
        assertEquals(2, gesture.move(p.first, p.second) { g.hit(p.first, p.second) })
        assertNull(gesture.move(g.centerX, g.centerY) { 2 })
        assertNull(gesture.finish(false))
        val outside = PetWheelGesture(g.centerX, g.centerY, 10f)
        outside.move(p.first, p.second) { 2 }
        assertNull(outside.move(-100f, -100f) { g.hit(-100f, -100f) })
        assertNull(outside.finish(false))
    }

    @Test fun originalPointerSelectsExactlyOnceAndCancelNeverExecutes() {
        val gesture = PetWheelGesture(0f, 0f, 10f)
        gesture.move(100f, 0f) { 3 }
        assertEquals(3, gesture.finish(false))
        assertNull(gesture.finish(false))
        assertNull(gesture.move(100f, 0f) { 4 })
        val cancelled = PetWheelGesture(0f, 0f, 10f)
        cancelled.move(100f, 0f) { 3 }
        assertNull(cancelled.finish(true))
        assertNull(PetWheelGesture(0f, 0f, 10f).finish(false))
    }

    @Test fun onlyAStationaryUncancelledReleaseLeavesTheMenuOpenForATap() {
        val stationary = PetWheelGesture(10f, 20f, 10f)
        stationary.move(12f, 21f) { 1 }
        assertTrue(stationary.staysOpen(false))
        assertNull(stationary.finish(false))
        assertFalse(stationary.staysOpen(false))
        val returning = PetWheelGesture(10f, 20f, 10f)
        returning.move(100f, 20f) { 2 }
        returning.move(10f, 20f) { null }
        assertFalse(returning.staysOpen(false))
        assertNull(returning.finish(false))
        val cancelled = PetWheelGesture(10f, 20f, 10f)
        assertFalse(cancelled.staysOpen(true))
        assertNull(cancelled.finish(true))
    }

    @Test fun backNearThePetIsCancelForBothSidesAndEveryMenuSize() {
        for (count in 5..7) for (side in Side.entries) {
            val g = fit(count, side)
            val pointer = PetWheelGesture(g.centerX, g.centerY, 10f)
            val p = g.centers[1]
            assertEquals(1, pointer.move(p.first, p.second) { g.hit(p.first, p.second) })
            val nearX = g.centerX + g.direction * g.dead * 0.9f
            assertNull(pointer.move(nearX, g.centerY) { g.hit(nearX, g.centerY, 1) })
            assertNull(pointer.finish(false))
        }
    }

    @Test fun fallbackRowsTranslateRawScreenCoordinatesIntoTheirClippedWindowSpace() {
        val g = fit(a = SafeArea(320, 400, 8, 24, 8, 20))
        assertTrue(g.list)
        assertTrue(g.bounds.left != 0 && g.bounds.top != 0)
        // getGlobalVisibleRect is clipped in the window/root coordinate space, not screen space.
        assertTrue(g.hitsVisibleRow(g.bounds.left + 30f, g.bounds.top + 40f, 6, 10, 100, 60))
        assertFalse(g.hitsVisibleRow(g.bounds.left + 30f, g.bounds.top + 65f, 6, 10, 100, 60))
        assertFalse(g.hitsVisibleRow(g.bounds.left + 2f, g.bounds.top + 40f, 6, 10, 100, 60))
        assertFalse(g.hitsVisibleRow(g.bounds.left + 30f, g.bounds.top + 5f, 6, 10, 100, 60))
    }

    @Test fun theWindowHoldsEveryLabelAndTheFanIsWithinThumbReach() {
        for (count in 5..7) for (side in Side.entries) {
            val g = fit(count, side)
            assertTrue(g.radius <= 140f) // was 172–220: a stretch for a thumb resting on the pet
            for (i in 0 until count) {
                // The label's far end along the button's own ray, for a 64px label and the chosen button's growth.
                val reach = g.radius + g.orb * 1.24f + 9f + 16f + 64f
                val x = g.centerX + g.direction * reach * cos(g.angle(i)).toFloat()
                val y = g.centerY + reach * sin(g.angle(i)).toFloat()
                assertTrue(x >= g.bounds.left && x <= g.bounds.right && y >= g.bounds.top && y <= g.bounds.bottom)
                assertEquals(i, g.hit(x, y))
            }
        }
    }

    @Test fun aTapOnTheOpenFanOnlyCountsOnAButtonOrItsLabel() {
        for (count in 5..7) for (side in Side.entries) {
            val g = fit(count, side)
            for (i in 0 until count) {
                val ux = g.direction * cos(g.angle(i)).toFloat()
                val uy = sin(g.angle(i)).toFloat()
                fun at(distance: Float) = g.tap(g.centerX + distance * ux, g.centerY + distance * uy, 9f) { 40f }
                assertEquals(i, at(g.radius))                      // the button
                assertEquals(i, at(g.radius + g.orb + 30f))         // its label
                // The mist between the pet and the button, and past the label: a slide still
                // picks the sector there, a tap does not.
                val inner = (g.dead + g.radius - 31f) / 2
                assertEquals(i, g.hit(g.centerX + inner * ux, g.centerY + inner * uy))
                assertNull(at(inner))
                val beyond = g.radius + g.orb + 94f
                assertEquals(i, g.hit(g.centerX + beyond * ux, g.centerY + beyond * uy))
                assertNull(at(beyond))
                // The label is a horizontal box, not a strip along the ray: its far ends count
                // even where the ray is steep, a little past them does not.
                val lead = g.radius + g.orb + 9f + kotlin.math.abs(ux) * 50f + kotlin.math.abs(uy) * 9f * 0.75f
                val lx = g.centerX + lead * ux
                val ly = g.centerY + lead * uy
                for (dx in listOf(-45f, 45f)) assertEquals(i, g.tap(lx + dx, ly, 9f) { 100f })
                assertNull(g.tap(lx, ly + 19f * (if (uy < 0) -1 else 1), 9f) { 100f })
            }
            // Inside the ring between two neighbours, off both buttons.
            val mid = (g.angle(0) + g.angle(1)) / 2
            assertNull(g.tap(g.centerX + g.direction * (g.radius - 40f) * cos(mid).toFloat(), g.centerY + (g.radius - 40f) * sin(mid).toFloat(), 9f) { 40f })
        }
    }

    @Test fun aTapOnALabelRunsThatButtonEvenWhereTheLabelReachesIntoTheNextSector() {
        val g = fit(7, Side.LEFT)
        // The first button's label is a wide horizontal box above it; its right end lies in
        // the second button's sector.
        val lead = g.radius + g.orb + 9f + kotlin.math.abs(cos(g.angle(0)).toFloat()) * 70f + kotlin.math.abs(sin(g.angle(0)).toFloat()) * 11f * 0.75f
        val x = g.centerX + lead * cos(g.angle(0)).toFloat() + 60f
        val y = g.centerY + lead * sin(g.angle(0)).toFloat()
        assertEquals(0, g.tap(x, y, 11f) { 140f })
        assertEquals(1, g.hit(x, y))
        val tap = PetWheelGesture(g.centerX, g.centerY, 10f).apply { pin(0, x, y) }
        assertEquals(0, tap.move(x, y) { g.hit(x, y) })
        assertEquals(0, tap.move(x + 6f, y - 4f) { g.hit(x + 6f, y - 4f) }) // a finger's wobble
        assertEquals(0, tap.finish(false))
        // Sliding off the spot goes back to picking by sector, for good.
        val slide = PetWheelGesture(g.centerX, g.centerY, 10f).apply { pin(0, x, y) }
        val p = g.centers[3]
        assertEquals(3, slide.move(p.first, p.second) { g.hit(p.first, p.second) })
        assertEquals(1, slide.move(x, y) { g.hit(x, y) })
        assertNull(PetWheelGesture(g.centerX, g.centerY, 10f).apply { pin(0, x, y) }.finish(true))
    }

    @Test fun aLongerLabelMovesTheFanInwardOrFallsBackToTheList() {
        val wide = PetWheelGeometry.fit(7, Side.RIGHT, 412f - 30f, 460f, area, 1f, 1f, labelWidth = 140f)
        assertFalse(wide.list)
        val labelEnd = wide.centerX - (wide.radius + wide.orb * 1.24f + 9f + 24f + 140f)
        assertTrue(labelEnd >= area.left)
        // The window and the mist behind it reach past the long label too, so it is not clipped.
        assertTrue(wide.bounds.left <= labelEnd)
        assertTrue(wide.mist >= wide.centerX - labelEnd + 32f)
        // Sliding out to the far end of that label still picks its button.
        assertEquals(3, wide.hit(labelEnd + 4f, wide.centerY))
        assertNull(wide.hit(wide.centerX - wide.limit - 4f, wide.centerY))
        assertTrue(PetWheelGeometry.fit(7, Side.LEFT, 30f, 460f, area, 1f, 1f, labelWidth = 400f).list)
    }

    @Test fun springSettlesOnItsTargetAtAnyFrameLength() {
        for (frame in listOf(0.004f, 0.016f, 0.04f)) {
            val spring = PetSpring(0f, 420f, 30f).apply { target = 1f }
            var peak = 0f
            var steps = 0
            while (spring.step(frame) && steps++ < 400) peak = maxOf(peak, spring.x)
            assertEquals(1f, spring.x, 0f)
            assertEquals(0f, spring.velocity, 0f)
            assertTrue(steps * frame < 0.8f)   // done well inside a second
            assertTrue(peak in 1f..1.12f)       // a small overshoot, never a bounce
        }
        val snapped = PetSpring(0.3f, 420f, 30f).apply { target = 1f }
        assertFalse(snapped.snap())
        assertEquals(1f, snapped.x, 0f)
    }

    @Test fun producerRotationOrLockInvalidationDoesNotReleaseCaptureVisibilityEarly() {
        val state = PetCaptureState()
        val request = state.begin()!!
        assertTrue(state.inFlight)
        assertNull(state.begin())
        state.invalidate()
        assertTrue(state.inFlight) // evaluate must still suppress re-show until the late callback
        assertFalse(state.finish(request))
        assertFalse(state.inFlight)
        assertFalse(state.finish(request))
        val next = state.begin()!!
        assertFalse(state.finish(request))
        assertTrue(state.inFlight)
        assertTrue(state.finish(next))
        assertFalse(state.inFlight)
    }
}
