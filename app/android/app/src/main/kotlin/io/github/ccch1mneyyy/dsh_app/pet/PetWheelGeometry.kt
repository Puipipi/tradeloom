package io.github.ccch1mneyyy.dsh_app.pet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Screen-space geometry shared by drawing and the original pet window's pointer stream: a fan of
 * round buttons on a half circle around the pet, each with its label on the outer side.
 */
internal class PetWheelGeometry private constructor(
    /** The window: the fan, its labels and the mist behind them, clipped to the safe area. */
    val bounds: ScreenRect,
    val side: Side,
    val centerX: Float,
    val centerY: Float,
    val radius: Float,
    val buttonWidth: Int,
    val buttonHeight: Int,
    val centers: List<Pair<Float, Float>>,
    val density: Float,
    /** A scrollable, full-label click alternative when a readable fan cannot fit. */
    val list: Boolean,
    /** How far from the centre the mist behind the fan reaches before it has faded out. */
    val mist: Float = 0f,
) {
    val direction: Float get() = if (side == Side.LEFT) 1f else -1f
    val orb: Float get() = buttonWidth / 2f
    val step: Double get() = PI / centers.size.coerceAtLeast(1)

    /** Nearer the pet than this is "back on the pet": nothing is chosen, releasing cancels. */
    val dead: Float get() = maxOf(52f * density, radius * 0.5f)

    /** Past the longest label the finger has left the wheel. */
    val limit: Float get() = maxOf(radius + orb + 96f * density, mist - 24f * density)

    fun angle(index: Int): Double = -PI / 2 + (index + 0.5) * step

    fun hitsVisibleRow(x: Float, y: Float, left: Int, top: Int, right: Int, bottom: Int): Boolean =
        x - bounds.left >= left && x - bounds.left < right && y - bounds.top >= top && y - bounds.top < bottom

    fun hit(x: Float, y: Float, previous: Int? = null): Int? {
        if (list || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
        val dx = (x - centerX) * direction
        val dy = y - centerY
        val distance = hypot(dx, dy)
        if (dx < 0 || distance < dead || distance > limit) return null
        val theta = atan2(dy, dx).toDouble()
        // A little angular hysteresis keeps a held boundary from flickering between two actions.
        if (previous != null && previous in centers.indices && abs(theta - angle(previous)) < step / 2 + PI / 60) return previous
        return ((theta + PI / 2) / step).toInt().coerceIn(0, centers.lastIndex)
    }

    /**
     * A tap on the fan left open: only a button or its label counts, not the whole sector a slide
     * may pick from, so a touch on the empty mist closes the menu instead of running something.
     * The label is the horizontal box PetMenuView draws at rest: [labelWidth] wide, [labelHalf]
     * high either side of its centre.
     */
    fun tap(x: Float, y: Float, labelHalf: Float, labelWidth: (Int) -> Float): Int? {
        if (list || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
        var onLabel: Int? = null
        for ((i, c) in centers.withIndex()) {
            // Half the arc one button owns: neighbours' targets touch but never overlap.
            if (hypot(x - c.first, y - c.second) <= 31f * density) return i
            if (onLabel != null) continue
            val ux = direction * cos(angle(i)).toFloat()
            val uy = sin(angle(i)).toFloat()
            val width = labelWidth(i)
            val lead = radius + orb + 9f * density + abs(ux) * width / 2 + abs(uy) * labelHalf * 0.75f
            if (abs(x - centerX - lead * ux) <= width / 2 + 8f * density && abs(y - centerY - lead * uy) <= labelHalf + 6f * density) onLabel = i
        }
        return onLabel
    }

    companion object {
        /** [labelWidth]: the widest short label as drawn, in pixels. */
        fun fit(
            count: Int, side: Side, anchorX: Float, anchorY: Float, area: SafeArea, density: Float, fontScale: Float,
            labelWidth: Float = 64f * density.coerceAtLeast(0.1f),
        ): PetWheelGeometry {
            require(count > 0)
            val d = density.coerceAtLeast(0.1f)
            val pad = (14 * d).roundToInt().coerceAtLeast(1)
            val left = area.left + pad
            val top = area.top + pad
            val right = (area.screenW - area.right - pad).coerceAtLeast(left + 1)
            val bottom = (area.screenH - area.bottom - pad).coerceAtLeast(top + 1)
            val size = (52 * d).roundToInt()
            // 62dp of arc per button: room for the chosen one to grow and push its neighbours.
            val radius = maxOf(112f, count * 62f / PI.toFloat()) * d
            val grown = size / 2f * 1.24f + 9 * d // the chosen button, scaled and pushed outward
            val label = 16 * d + 22 * d * fontScale.coerceAtLeast(1f) // the gap and the label's pill
            val halfH = radius * cos(PI / (2 * count)).toFloat() + grown + label
            val inwardW = radius + grown + 24 * d + labelWidth
            val list = fontScale > 1.3f || bottom - top < 2 * halfH || right - left < inwardW + 32 * d
            if (list) {
                val w = (280 * d).roundToInt().coerceAtMost(right - left)
                val h = ((count * 52 + 12) * d * fontScale.coerceAtLeast(1f)).roundToInt().coerceAtMost(bottom - top)
                val x = (if (side == Side.LEFT) anchorX + 16 * d else anchorX - 16 * d - w).roundToInt().coerceIn(left, right - w)
                val y = (anchorY - h / 2f).roundToInt().coerceIn(top, bottom - h)
                return PetWheelGeometry(ScreenRect(x, y, x + w, y + h), side, anchorX, anchorY, 0f, size, size, emptyList(), d, true)
            }
            val cx = if (side == Side.LEFT) anchorX.coerceIn(left + 16 * d, right - inwardW) else anchorX.coerceIn(left + inwardW, right - 16 * d)
            val cy = anchorY.coerceIn(top + halfH, bottom - halfH)
            val sign = if (side == Side.LEFT) 1 else -1
            val centers = List(count) { i ->
                val a = -PI / 2 + (i + 0.5) * PI / count
                (cx + sign * radius * cos(a).toFloat()) to (cy + radius * sin(a).toFloat())
            }
            // The mist fades out past the longest label and reaches back over the pet's own edge.
            val mist = maxOf(radius + 150 * d, inwardW + 40 * d)
            val back = 72 * d
            val x0 = if (side == Side.LEFT) cx - back else cx - mist
            val x1 = if (side == Side.LEFT) cx + mist else cx + back
            return PetWheelGeometry(
                ScreenRect(
                    x0.toInt().coerceAtLeast(area.left), (cy - mist).toInt().coerceAtLeast(area.top),
                    ceil(x1).toInt().coerceAtMost(area.screenW - area.right), ceil(cy + mist).toInt().coerceAtMost(area.screenH - area.bottom),
                ),
                side, cx, cy, radius, size, size, centers, d, false, mist,
            )
        }
    }
}

/** Selection belongs to one physical pointer stream; cancellation can never return an action. */
internal class PetWheelGesture(private val originX: Float, private val originY: Float, private val slop: Float) {
    private var moved = false
    var selected: Int? = null
        private set
    private var ended = false
    private var pinned = false
    private var pinX = 0f
    private var pinY = 0f

    /**
     * A tap on the open fan landed on [index]'s button or label. A label can reach into the
     * neighbouring sector, so that stays the choice until the finger slides off the spot; only
     * then does the sector under it decide.
     */
    fun pin(index: Int, x: Float, y: Float) {
        pinned = true
        pinX = x
        pinY = y
        selected = index
    }

    fun move(x: Float, y: Float, hit: () -> Int?): Int? {
        if (ended) return null
        if (pinned) {
            if (hypot(x - pinX, y - pinY) <= slop) return selected
            pinned = false
        }
        val distance = hypot(x - originX, y - originY)
        if (distance > slop) moved = true
        selected = if (distance < slop * 2) null else hit()
        return selected
    }

    /**
     * A long press let go where it began: the menu stays for a tap (and, as a list, for native
     * scrolling). Having moved away and come back is a cancel like any other.
     */
    fun staysOpen(cancelled: Boolean): Boolean = !ended && !cancelled && !moved

    fun finish(cancelled: Boolean): Int? {
        if (ended) return null
        ended = true
        return if (cancelled) null else selected
    }
}

/**
 * A damped spring stepped by the wheel's one frame loop: pointer moves only change [target], so
 * motion keeps its velocity instead of restarting an animator at touch-sampling frequency.
 */
internal class PetSpring(var x: Float, var stiffness: Float, var damping: Float) {
    var velocity = 0f
        private set
    var target = x

    /** Advances by [seconds]; false once it rests on the target. */
    fun step(seconds: Float): Boolean {
        var n = ceil(seconds / 0.004f).toInt().coerceIn(1, 16)
        val h = seconds / n
        while (n-- > 0) {
            velocity += (-stiffness * (x - target) - damping * velocity) * h
            x += velocity * h
        }
        if (abs(x - target) < 5e-4f && abs(velocity) < 5e-3f) return snap()
        return true
    }

    fun snap(): Boolean {
        x = target
        velocity = 0f
        return false
    }
}
