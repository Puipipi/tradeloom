package io.github.ccch1mneyyy.dsh_app.pet

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executor
import kotlin.math.ceil
import kotlin.math.floor

/** A decoded sheet: [perLogical] bitmap pixels per logical pixel (cells are box × perLogical). */
internal class PetSheet(val bitmap: Bitmap, val perLogical: Int)

/**
 * A pet pack's files: `pack.json` and the sheets, from the app's bundled assets
 * (`assets/pets/<id>/`, through [assetPath]) or, for packs added later, `files/pets/<id>/`.
 *
 * Sheets decode one animation at a time, off the main thread, into a small LRU (Deepy decoded
 * whole is ~139 MB). A hi-res sheet is decoded no finer than it is drawn and within [SHEET_BYTES]:
 * rows are read with BitmapRegionDecoder and scaled to a whole number of pixels per logical pixel,
 * so cells and boxes stay exact.
 */
internal class PetSprites(
    private val context: Context,
    private val assetPath: (String) -> String,
) {
    class Loaded(
        val pack: PetPack,
        /** The window's area on the canvas at rest (logical px). */
        val window: PetBox,
        /** Physical pixels per logical pixel. */
        val screenScale: Float,
        private val source: (String) -> InputStream?,
        private val worker: Executor,
    ) {
        /** The window at rest, while held and around each animation, in physical pixels. */
        private val spriteFrames = PetFrames.of(pack, window, screenScale)
        // Main-thread overlay geometry only; portraits keep using the sprite pack.
        var overlayFrames: PetFrames? = null
        val frames: PetFrames get() = overlayFrames ?: spriteFrames

        private val main = Handler(Looper.getMainLooper())
        private val cache = object : LruCache<String, PetSheet>(CACHE_BYTES) {
            override fun sizeOf(key: String, value: PetSheet) = value.bitmap.byteCount
        }

        /** The idle primary stays decoded: it is what shows most of the time. */
        @Volatile private var resident: Pair<String, PetSheet>? = null
        /** Sheets being decoded, with everyone waiting for each. */
        private val pending = HashMap<String, MutableList<() -> Unit>>()

        fun sheet(anim: PetAnimation): PetSheet? =
            resident?.takeIf { it.first == anim.sheet }?.second ?: cache.get(anim.sheet)

        /** Decodes [anim]'s sheet in the background unless cached; [onReady] runs on the main thread. */
        fun request(anim: PetAnimation, onReady: () -> Unit) {
            if (sheet(anim) != null) return
            pending[anim.sheet]?.let { waiting ->
                waiting += onReady
                return
            }
            pending[anim.sheet] = mutableListOf(onReady)
            worker.execute {
                val s = decode(anim)
                main.post {
                    val waiting = pending.remove(anim.sheet).orEmpty()
                    if (s != null) {
                        cache.put(anim.sheet, s)
                        waiting.forEach { it() }
                    }
                }
            }
        }

        /** Decodes the idle primary now (call off the main thread) and keeps it. */
        fun warmResident() {
            val idle = pack.primary(PetPack.IDLE, 0)
            decode(idle)?.let { resident = idle.sheet to it }
        }

        fun release() {
            overlayFrames = null
            cache.evictAll()
        }

        /** Bitmap pixels per logical pixel for [anim]: no finer than drawn, within the per-sheet budget. */
        fun perLogical(anim: PetAnimation): Int = perLogicalFor(pack.scale, screenScale, anim, SHEET_BYTES)

        private fun decode(anim: PetAnimation): PetSheet? = try {
            val r = perLogical(anim)
            val bmp = if (r == pack.scale) {
                source(anim.sheet)?.use { BitmapFactory.decodeStream(it, null, options()) }
            } else {
                source(anim.sheet)?.use { decodeScaled(it, anim, r) }
            }
            bmp?.let { PetSheet(it, r) }
        } catch (e: Throwable) {
            Log.w(TAG, "sheet ${anim.sheet} failed", e)
            null
        }

        /** Row by row, each row scaled to [r] pixels per logical pixel: one row in memory at full size. */
        @Suppress("DEPRECATION")
        private fun decodeScaled(input: InputStream, anim: PetAnimation, r: Int): Bitmap? {
            val decoder = BitmapRegionDecoder.newInstance(input, false) ?: return null
            try {
                val rows = minOf(anim.rows, decoder.height / anim.frameH).coerceAtLeast(1)
                val cellW = (anim.box.w * r).toInt()
                val cellH = (anim.box.h * r).toInt()
                val width = minOf(anim.cols, anim.cells) * cellW
                val out = Bitmap.createBitmap(width, rows * cellH, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(out)
                val paint = Paint(Paint.FILTER_BITMAP_FLAG)
                val opts = options()
                for (row in 0 until rows) {
                    val srcW = minOf(minOf(anim.cols, anim.cells) * anim.frameW, decoder.width)
                    val strip = decoder.decodeRegion(Rect(0, row * anim.frameH, srcW, (row + 1) * anim.frameH), opts) ?: continue
                    canvas.drawBitmap(strip, null, Rect(0, row * cellH, width, (row + 1) * cellH), paint)
                    strip.recycle()
                }
                return out
            } finally {
                decoder.recycle()
            }
        }
    }

    /** Loads [id] for drawing with [scaleFor] physical px per logical px; null when missing or broken. */
    fun load(id: String, worker: Executor, scaleFor: (PetPack) -> Float): Loaded? {
        val source = sourceFor(id) ?: return null
        val pack = try {
            source("pack.json")?.use { it.readBytes().toString(Charsets.UTF_8) }?.let(PetPack::parse)
        } catch (e: Exception) {
            Log.w(TAG, "pack $id unreadable", e)
            null
        } ?: return null
        return Loaded(pack, pack.windowBox(), scaleFor(pack), source, worker)
    }

    /**
     * The first frame [state] plays, trimmed to the drawn pixels and centred in a [px] square:
     * the live activity's picture. Decodes one cell, not the sheet. Null when the pack or the
     * frame is missing. Any thread.
     */
    @Suppress("DEPRECATION")
    fun portrait(id: String, state: String, px: Int): Bitmap? {
        val source = sourceFor(id) ?: return null
        return try {
            val pack = source("pack.json")?.use { it.readBytes().toString(Charsets.UTF_8) }?.let(PetPack::parse) ?: return null
            val anim = pack.primary(state, 0)
            val cell = anim.frames.firstOrNull()?.cell ?: 0
            val col = cell % anim.cols
            val row = cell / anim.cols
            val opts = options().apply {
                inSampleSize = 1
                while (maxOf(anim.frameW, anim.frameH) / (inSampleSize * 2) >= 2 * px) inSampleSize *= 2
            }
            val frame = source(anim.sheet)?.use { input ->
                val decoder = BitmapRegionDecoder.newInstance(input, false) ?: return null
                try {
                    decoder.decodeRegion(Rect(col * anim.frameW, row * anim.frameH, (col + 1) * anim.frameW, (row + 1) * anim.frameH), opts)
                } finally {
                    decoder.recycle()
                }
            } ?: return null
            val drawn = opaqueBounds(frame) ?: run {
                frame.recycle()
                return null
            }
            val fit = px.toFloat() / maxOf(drawn.width(), drawn.height())
            // Pixel art stays crisp: a whole number of pixels per art pixel when it can.
            val k = if (pack.pixelArt && fit >= 1f) floor(fit) else fit
            val w = drawn.width() * k
            val h = drawn.height() * k
            val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
            val left = Math.round((px - w) / 2)
            val top = Math.round((px - h) / 2)
            Canvas(out).drawBitmap(
                frame,
                drawn,
                Rect(left, top, left + Math.round(w), top + Math.round(h)),
                Paint().apply { isFilterBitmap = !pack.pixelArt },
            )
            frame.recycle()
            out
        } catch (e: Throwable) {
            Log.w(TAG, "portrait $id/$state failed", e)
            null
        }
    }

    /** The smallest rectangle holding every pixel that isn't fully transparent; null for an empty frame. */
    private fun opaqueBounds(b: Bitmap): Rect? {
        val w = b.width
        val h = b.height
        val row = IntArray(w)
        var l = w
        var t = h
        var r = -1
        var bottom = -1
        for (y in 0 until h) {
            b.getPixels(row, 0, w, 0, y, w, 1)
            for (x in 0 until w) {
                if (row[x] ushr 24 == 0) continue
                if (x < l) l = x
                if (x > r) r = x
                if (y < t) t = y
                bottom = y
            }
        }
        return if (r < 0) null else Rect(l, t, r + 1, bottom + 1)
    }

    private fun sourceFor(id: String): ((String) -> InputStream?)? {
        val bundled: (String) -> InputStream? = { name ->
            try { context.assets.open(assetPath("assets/pets/$id/$name")) } catch (_: Exception) { null }
        }
        if (bundled("pack.json")?.also { it.close() } != null) return bundled
        val dir = File(context.filesDir, "pets/$id")
        if (File(dir, "pack.json").isFile) {
            return { name -> File(dir, name).takeIf { it.isFile && it.parentFile == dir }?.inputStream() }
        }
        return null
    }

    companion object {
        private const val TAG = "DshPet"
        private const val CACHE_BYTES = 16 * 1024 * 1024

        /** One decoded sheet at most this big (the format's 8 MB cap, with room for the resident idle). */
        const val SHEET_BYTES = 6 * 1024 * 1024

        private fun options() = BitmapFactory.Options().apply {
            inScaled = false
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }

        /**
         * Bitmap pixels per logical pixel: the pack's own when it isn't finer than drawn
         * ([screenScale]) and fits [budget]; else the largest whole number that is and does.
         */
        fun perLogicalFor(packScale: Int, screenScale: Float, anim: PetAnimation, budget: Int): Int {
            var r = minOf(packScale, ceil(screenScale.toDouble()).toInt().coerceAtLeast(1))
            val cellsW = minOf(anim.cols, anim.cells)
            while (r > 1 && 4L * cellsW * anim.box.w * r * anim.rows * anim.box.h * r > budget) r--
            return r
        }
    }
}
