package io.github.ccch1mneyyy.dsh_app.islands

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IslandPolicyTest {
    @Test
    fun textZoomStaysInAndroidsRange() {
        assertEquals(50, IslandPolicy.textZoom(10))
        assertEquals(115, IslandPolicy.textZoom(115))
        assertEquals(300, IslandPolicy.textZoom(900))
    }

    @Test
    fun onlyLowMemoryLevelsReachDart() {
        assertFalse(IslandPolicy.forwardsTrim(5)) // RUNNING_MODERATE
        assertTrue(IslandPolicy.forwardsTrim(10)) // RUNNING_LOW
        assertTrue(IslandPolicy.forwardsTrim(15)) // RUNNING_CRITICAL
        assertFalse(IslandPolicy.forwardsTrim(20)) // UI_HIDDEN: the app lifecycle handles it
        assertTrue(IslandPolicy.forwardsTrim(40)) // BACKGROUND
        assertTrue(IslandPolicy.forwardsTrim(80)) // COMPLETE
    }

    @Test
    fun webViewIdsComeAsIntOrLong() {
        assertEquals(7L, IslandPolicy.webViewId(7))
        assertEquals(1L shl 40, IslandPolicy.webViewId(1L shl 40))
        assertNull(IslandPolicy.webViewId("7"))
        assertNull(IslandPolicy.webViewId(null))
    }
}
