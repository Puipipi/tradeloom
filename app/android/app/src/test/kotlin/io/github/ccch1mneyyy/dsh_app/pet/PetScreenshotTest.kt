package io.github.ccch1mneyyy.dsh_app.pet

import android.accessibilityservice.AccessibilityService
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

class PetScreenshotTest {
    @Test fun errorsHaveStableUserFacingCategories() {
        assertEquals(PetScreenshot.Error.ACCESSIBILITY_REQUIRED,
            PetScreenshotPolicy.error(AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS))
        assertEquals(PetScreenshot.Error.BUSY,
            PetScreenshotPolicy.error(AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT))
        assertEquals(PetScreenshot.Error.UNSUPPORTED,
            PetScreenshotPolicy.error(AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY))
        assertEquals(PetScreenshot.Error.SECURE,
            PetScreenshotPolicy.error(AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW))
        assertEquals(PetScreenshot.Error.FAILED,
            PetScreenshotPolicy.error(AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR))
        assertEquals(PetScreenshot.Error.FAILED, PetScreenshotPolicy.error(-1))
    }

    @Test fun textFramesStayClearWithoutUpscalingOrUnboundedPixels() {
        assertEquals(1080 to 1920, PetScreenshotPolicy.size(1080, 1920))
        assertEquals(2048 to 1152, PetScreenshotPolicy.size(3840, 2160))
        assertEquals(1152 to 2048, PetScreenshotPolicy.size(2160, 3840))
        assertEquals(1 to 2048, PetScreenshotPolicy.size(1, 10000))
    }

    @Test fun timeoutMakesLateSuccessTerminalAndOnlyOneCompletionWins() {
        val completion = PetScreenshotCompletion()
        assertFalse(completion.finished)
        assertTrue(completion.tryFinish()) // timeout
        assertTrue(completion.finished)
        assertFalse(completion.tryFinish()) // late screenshot callback
    }

    @Test fun simultaneousTerminalCallbacksCannotDeliverTwice() {
        val completion = PetScreenshotCompletion()
        val start = CountDownLatch(1)
        val winners = AtomicInteger()
        val threads = List(12) {
            Thread { start.await(); if (completion.tryFinish()) winners.incrementAndGet() }.apply { start() }
        }
        start.countDown()
        threads.forEach { it.join() }
        assertEquals(1, winners.get())
        assertTrue(completion.finished)
    }
}
