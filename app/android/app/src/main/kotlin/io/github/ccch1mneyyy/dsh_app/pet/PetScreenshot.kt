package io.github.ccch1mneyyy.dsh_app.pet

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import io.github.ccch1mneyyy.dsh_app.phone.a11y.PhoneA11yService
import io.github.ccch1mneyyy.dsh_app.shortcuts.ScreenshotFiles
import java.io.File
import java.io.FilterOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt

/** User-initiated, unmarked capture. Nothing is uploaded or written to shared storage here. */
internal object PetScreenshot {
    enum class Error { UNSUPPORTED, ACCESSIBILITY_REQUIRED, SECURE, BUSY, FAILED, TIMEOUT }
    data class Result(val path: String? = null, val error: Error? = null)

    private const val TIMEOUT_MS = 8_000L
    private const val SETTLE_MS = 120L
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val worker by lazy {
        Executors.newSingleThreadExecutor { r -> Thread(r, "dsh-pet-shot").apply { isDaemon = true } }
    }
    private var active: Capture? = null // main thread only

    private class Capture(val context: Context, val service: PhoneA11yService, val callback: (Result) -> Unit) {
        val completion = PetScreenshotCompletion()
        lateinit var timeout: Runnable
    }

    /** The caller hides its pet windows first. Results are delivered once, on the main thread. */
    fun capture(context: Context, callback: (Result) -> Unit) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post { capture(context.applicationContext, callback) }
            return
        }
        if (Build.VERSION.SDK_INT < 30) { callback(Result(error = Error.UNSUPPORTED)); return }
        if (active != null) { callback(Result(error = Error.BUSY)); return }
        val service = PhoneA11yService.instance
        if (service == null) { callback(Result(error = Error.ACCESSIBILITY_REQUIRED)); return }
        val capture = Capture(context.applicationContext, service, callback)
        active = capture
        capture.timeout = Runnable { finish(capture, Result(error = Error.TIMEOUT)) }
        main.postDelayed(capture.timeout, TIMEOUT_MS)
        try {
            service.hideControlOverlayForPetScreenshot(true)
            // Also lets WindowManager commit removal of the pet/wheel windows before capture.
            main.postDelayed({ start(capture) }, SETTLE_MS)
        } catch (_: Exception) { finish(capture, Result(error = Error.FAILED)) }
    }

    /** Drop a completed frame when its pet generation/gesture is no longer current. */
    fun discard(context: Context, path: String) {
        val cache = context.applicationContext.cacheDir
        worker.execute {
            runCatching { ScreenshotFiles.validate(cache, path)?.parentFile?.let(ScreenshotFiles::deleteSlot) }
        }
    }

    private fun start(capture: Capture) {
        if (capture.completion.finished) return
        if (PhoneA11yService.instance !== capture.service) {
            finish(capture, Result(error = Error.ACCESSIBILITY_REQUIRED))
            return
        }
        try {
            capture.service.takeScreenshot(Display.DEFAULT_DISPLAY, worker, object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                    var bitmap: Bitmap? = null
                    val result = try {
                        val buffer = screenshot.hardwareBuffer
                        try {
                            if (!capture.completion.finished) {
                                val hardware = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                                    ?: throw IOException("No screenshot bitmap")
                                try {
                                    val (width, height) = PetScreenshotPolicy.size(hardware.width, hardware.height)
                                    val scaled = if (width != hardware.width || height != hardware.height)
                                        Bitmap.createScaledBitmap(hardware, width, height, true) else hardware
                                    try { bitmap = scaled.copy(Bitmap.Config.ARGB_8888, false) }
                                    finally { if (scaled !== hardware) scaled.recycle() }
                                } finally { hardware.recycle() }
                            }
                        } finally { buffer.close() }
                        if (capture.completion.finished) return
                        save(capture, bitmap ?: throw IOException("Cannot copy screenshot"))
                    } catch (_: Exception) { Result(error = Error.FAILED) }
                    catch (_: OutOfMemoryError) { Result(error = Error.FAILED) }
                    finally { bitmap?.recycle() }
                    main.post {
                        if (!finish(capture, result)) result.path?.let { path ->
                            worker.execute { runCatching { ScreenshotFiles.deleteSlot(File(path).parentFile!!) } }
                        }
                    }
                }

                override fun onFailure(errorCode: Int) {
                    main.post { finish(capture, Result(error = PetScreenshotPolicy.error(errorCode))) }
                }
            })
        } catch (_: SecurityException) { finish(capture, Result(error = Error.ACCESSIBILITY_REQUIRED)) }
        catch (_: Exception) { finish(capture, Result(error = Error.FAILED)) }
    }

    private fun finish(capture: Capture, result: Result): Boolean {
        if (!capture.completion.tryFinish()) return false
        main.removeCallbacks(capture.timeout)
        if (active === capture) active = null
        runCatching { capture.service.hideControlOverlayForPetScreenshot(false) }
        capture.callback(result)
        return true
    }

    private fun save(capture: Capture, bitmap: Bitmap): Result {
        // Older Android versions may blank FLAG_SECURE instead of returning the secure error.
        if (looksProtected(bitmap)) return Result(error = Error.SECURE)
        if (capture.completion.finished) return Result(error = Error.TIMEOUT)
        val slot = ScreenshotFiles.createSlot(capture.context.cacheDir)
        var keep = false
        try {
            var file = File(slot, "screenshot.png")
            try { compress(bitmap, Bitmap.CompressFormat.PNG, 100, file) }
            catch (_: SizeLimitExceeded) {
                file.delete()
                file = File(slot, "screenshot.jpg")
                compress(bitmap, Bitmap.CompressFormat.JPEG, 92, file)
            }
            if (capture.completion.finished) return Result(error = Error.TIMEOUT)
            val path = ScreenshotFiles.validate(capture.context.cacheDir, file.canonicalPath)?.path
                ?: return Result(error = Error.FAILED)
            keep = true
            return Result(path = path)
        } finally { if (!keep) ScreenshotFiles.deleteSlot(slot) }
    }

    private fun compress(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int, file: File) {
        file.outputStream().buffered().use { out ->
            val limited = LimitedOutput(out)
            val encoded = bitmap.compress(format, quality, limited)
            // Some Android encoders return false instead of propagating a stream exception.
            if (limited.exceeded) throw SizeLimitExceeded()
            if (!encoded) throw IOException("Cannot encode screenshot")
        }
    }

    private class SizeLimitExceeded : IOException()
    private class LimitedOutput(out: OutputStream) : FilterOutputStream(out) {
        private var written = 0L
        var exceeded = false
            private set
        override fun write(value: Int) { reserve(1); out.write(value) }
        override fun write(bytes: ByteArray, offset: Int, length: Int) { reserve(length); out.write(bytes, offset, length) }
        private fun reserve(count: Int) {
            if (written + count > ScreenshotFiles.MAX_BYTES) { exceeded = true; throw SizeLimitExceeded() }
            written += count
        }
    }

    private fun looksProtected(bitmap: Bitmap): Boolean {
        var dark = 0
        val count = 32
        for (x in 0 until count) for (y in 0 until count) {
            val pixel = bitmap.getPixel((bitmap.width - 1) * x / (count - 1), (bitmap.height - 1) * y / (count - 1))
            if (max(Color.red(pixel), max(Color.green(pixel), Color.blue(pixel))) < 12) dark++
        }
        return dark >= count * count * 97 / 100
    }
}

/** Kept independent of Android callbacks so timeout/late completion races can be unit-tested. */
internal class PetScreenshotCompletion {
    private val done = AtomicBoolean(false)
    val finished: Boolean get() = done.get()
    fun tryFinish(): Boolean = done.compareAndSet(false, true)
}

internal object PetScreenshotPolicy {
    fun size(width: Int, height: Int): Pair<Int, Int> {
        require(width > 0 && height > 0)
        val scale = minOf(1.0, 2048.0 / max(width, height))
        return (width * scale).roundToInt().coerceAtLeast(1) to (height * scale).roundToInt().coerceAtLeast(1)
    }

    fun error(code: Int): PetScreenshot.Error = when (code) {
        AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> PetScreenshot.Error.ACCESSIBILITY_REQUIRED
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> PetScreenshot.Error.BUSY
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> PetScreenshot.Error.UNSUPPORTED
        AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> PetScreenshot.Error.SECURE
        else -> PetScreenshot.Error.FAILED
    }
}
