package io.github.ccch1mneyyy.dsh_app.mlkit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MlKitInitializationTest {
    @Test fun scannerAndOcrShareOneInitializationInEitherOrder() {
        for (first in listOf("scanner", "ocr")) {
            val initialization = MlKitInitialization()
            val calls = ArrayList<String>()
            initialization.ensureInitialized { calls.add(first) }
            initialization.ensureInitialized { calls.add(if (first == "scanner") "ocr" else "scanner") }
            initialization.ensureInitialized { calls.add("scanner reopened") }
            assertEquals(listOf(first), calls)
        }
    }

    @Test fun aPartiallyFailedInitializationIsNotRetriedByTheOtherFeature() {
        val initialization = MlKitInitialization()
        val failure = IllegalStateException("SDK initialization failed")
        var calls = 0
        assertSame(failure, assertThrows(IllegalStateException::class.java) {
            initialization.ensureInitialized { calls++; throw failure }
        })
        val unavailable = assertThrows(IllegalStateException::class.java) {
            initialization.ensureInitialized { calls++ }
        }
        assertEquals("ML Kit initialization unavailable", unavailable.message)
        assertEquals(1, calls)
    }

    @Test fun concurrentFeaturesWaitForTheSameInitialization() {
        val initialization = MlKitInitialization()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        val calls = AtomicInteger()
        val scanner = FutureTask<Unit> {
            initialization.ensureInitialized {
                calls.incrementAndGet()
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
        }
        val ocr = FutureTask<Unit> {
            secondStarted.countDown()
            initialization.ensureInitialized { calls.incrementAndGet() }
        }
        val scannerThread = Thread(scanner, "scanner-init-test")
        val ocrThread = Thread(ocr, "ocr-init-test")
        scannerThread.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            ocrThread.start()
            assertTrue(secondStarted.await(5, TimeUnit.SECONDS))
            assertFalse(ocr.isDone)
            release.countDown()
            scanner.get(5, TimeUnit.SECONDS)
            ocr.get(5, TimeUnit.SECONDS)
            assertEquals(1, calls.get())
        } finally {
            release.countDown()
            scannerThread.interrupt()
            ocrThread.interrupt()
            scannerThread.join(5000)
            ocrThread.join(5000)
        }
    }
}
