package io.github.ccch1mneyyy.dsh_app.nativemedia

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import io.github.ccch1mneyyy.dsh_app.R
import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings

/**
 * What a plugin's capabilities show over the app (never over other apps): the listening indicator
 * and the one-line caption, stacked at the top centre just under the chat header. Both are the
 * app's own views in the activity, so they are only there while the app is on screen and need no
 * window permission. The indicator is drawn by the app, not the plugin: its text names the plugin,
 * its 停止 ends the plugin's listening and playback, and it cannot be hidden while listening runs.
 * The caption's text comes from the plugin; its × is the app's.
 */
internal class MediaOverlays(private val onStop: () -> Unit, private val onCaptionClosed: () -> Unit) {
    private var activity: Activity? = null
    private var column: LinearLayout? = null
    private var indicator: View? = null
    private var caption: CaptionView? = null
    private var topDp = DEFAULT_TOP_DP
    private var listeningTitle: String? = null
    private var captionText: String? = null

    val listening get() = listeningTitle != null
    val captionShown get() = captionText != null

    /** The activity to draw in (or none); what was showing comes back in the new one. */
    fun attach(host: Activity?) {
        if (host === activity) return
        detachViews()
        activity = host
        listeningTitle?.let { showIndicator(it) }
        captionText?.let { placeCaption(it) }
    }

    /** Where the stack starts, in dp from the top of the window (under the chat header). */
    fun setTop(dp: Float) {
        if (dp <= 0f || dp == topDp) return
        topDp = dp
        (column?.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
            lp.topMargin = column!!.context.px(topDp)
            column!!.layoutParams = lp
        }
    }

    /** Shows the indicator for [pluginTitle]; false when there is no activity to show it in. */
    fun showIndicator(pluginTitle: String): Boolean {
        listeningTitle = pluginTitle
        val col = ensureColumn() ?: return false
        indicator?.let { col.removeView(it) }
        val v = indicatorView(col.context, pluginTitle)
        indicator = v
        col.addView(v, 0, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        reveal(v)
        spaceRows()
        return true
    }

    fun hideIndicator() {
        listeningTitle = null
        indicator?.let { column?.removeView(it) }
        indicator = null
        spaceRows()
        removeColumnIfEmpty()
    }

    /**
     * Shows (or replaces) the caption line; false without an activity. An empty text keeps it
     * waiting, unseen, for the first line.
     */
    fun showCaption(text: String): Boolean {
        if (activity == null) return false
        captionText = text
        return placeCaption(text)
    }

    /** New caption text: the same view, only its text changes. */
    fun updateCaption(text: String): Boolean {
        if (captionText == null) return false
        captionText = text
        return placeCaption(text)
    }

    private fun placeCaption(text: String): Boolean {
        caption?.let {
            it.setText(text)
            return true
        }
        if (text.isBlank()) return true
        val col = ensureColumn() ?: return false
        val v = CaptionView(col.context, Palette.of(col.context)) { hideCaption(); onCaptionClosed() }
        v.setText(text)
        caption = v
        col.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        reveal(v)
        spaceRows()
        return true
    }

    fun hideCaption() {
        captionText = null
        caption?.let { column?.removeView(it) }
        caption = null
        spaceRows()
        removeColumnIfEmpty()
    }

    fun hideAll() {
        hideIndicator()
        hideCaption()
    }

    private fun ensureColumn(): LinearLayout? {
        column?.let { return it }
        val host = activity ?: return null
        val content = host.findViewById<ViewGroup>(android.R.id.content) ?: return null
        val col = LinearLayout(host).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            clipChildren = false
            clipToPadding = false
            // Room for the pills' shadow.
            val pad = host.px(SHADOW_DP)
            setPadding(pad, 0, pad, pad)
        }
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
        lp.topMargin = host.px(topDp)
        return runCatching { content.addView(col, lp) }.map { col }.getOrNull()?.also { column = it }
    }

    private fun spaceRows() {
        val col = column ?: return
        for (i in 0 until col.childCount) {
            val lp = col.getChildAt(i).layoutParams as LinearLayout.LayoutParams
            lp.topMargin = if (i == 0) 0 else col.context.px(GAP_DP)
            col.getChildAt(i).layoutParams = lp
        }
    }

    private fun removeColumnIfEmpty() {
        val col = column ?: return
        if (col.childCount > 0) return
        (col.parent as? ViewGroup)?.removeView(col)
        column = null
    }

    private fun detachViews() {
        column?.let { (it.parent as? ViewGroup)?.removeView(it) }
        column = null
        indicator = null
        caption = null
    }

    private fun reveal(v: View) {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        v.alpha = 0f
        v.translationY = -v.context.px(4f).toFloat()
        v.animate().alpha(1f).translationY(0f).setDuration(160).start()
    }

    // ---- views ---------------------------------------------------------------------------------

    private fun indicatorView(context: Context, pluginTitle: String): View {
        val c = Palette.of(context)
        val label = AppStrings.get(context, R.string.native_media_listening, pluginTitle)
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            pill(this, c)
            // The 停止 key sits KEY_INSET from the pill on its top, right and bottom.
            setPadding(context.px(16f), context.px(KEY_INSET_DP), context.px(KEY_INSET_DP), context.px(KEY_INSET_DP))
            addView(
                View(context).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c.danger) } },
                LinearLayout.LayoutParams(context.px(8f), context.px(8f)),
            )
            addView(
                TextView(context).apply {
                    text = label
                    textSize = 14f
                    setTextColor(c.ink)
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    maxWidth = context.px(MAX_LABEL_DP)
                    includeFontPadding = false
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    marginStart = context.px(8f)
                    marginEnd = context.px(10f)
                },
            )
            addView(
                TextView(context).apply {
                    text = AppStrings.get(context, R.string.native_media_stop)
                    textSize = 14f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(c.ink)
                    gravity = Gravity.CENTER
                    includeFontPadding = false
                    setPadding(context.px(14f), 0, context.px(14f), 0)
                    minHeight = context.px(KEY_DP)
                    background = RippleDrawable(
                        ColorStateList.valueOf(c.ripple),
                        GradientDrawable().apply { cornerRadius = context.px(KEY_DP / 2).toFloat(); setColor(c.field) },
                        null,
                    )
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { onStop() }
                },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.px(KEY_DP)),
            )
            contentDescription = label
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
    }

    @SuppressLint("ViewConstructor")
    private class CaptionView(context: Context, c: Palette, onClose: () -> Unit) : LinearLayout(context) {
        private val text = TextView(context).apply {
            textSize = 14f
            setTextColor(c.ink)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            includeFontPadding = false
        }

        init {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            pill(this, c)
            setPadding(context.px(16f), context.px(KEY_INSET_DP), context.px(KEY_INSET_DP), context.px(KEY_INSET_DP))
            val maxText = context.resources.displayMetrics.widthPixels - context.px(2 * SIDE_DP + 16f + KEY_DP + KEY_INSET_DP + 8f + 2 * SHADOW_DP)
            text.maxWidth = maxText.coerceAtLeast(context.px(96f))
            addView(text, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginEnd = context.px(8f) })
            addView(
                CloseKey(context, c).apply {
                    contentDescription = AppStrings.get(context, R.string.native_media_close_caption)
                    setOnClickListener { onClose() }
                },
                LayoutParams(context.px(KEY_DP), context.px(KEY_DP)),
            )
        }

        fun setText(value: String) {
            if (text.text.toString() != value) text.text = value
        }
    }

    /** ×, 14 dp, in a 32 dp round key. */
    private class CloseKey(context: Context, private val c: Palette) : View(context) {
        private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeWidth = context.pxf(1.6f)
            color = c.muted
        }

        init {
            isClickable = true
            isFocusable = true
            background = RippleDrawable(
                ColorStateList.valueOf(c.ripple),
                GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c.field) },
                InsetDrawable(GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }, 0),
            )
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val r = context.pxf(5f)
            val cx = width / 2f
            val cy = height / 2f
            canvas.drawLine(cx - r, cy - r, cx + r, cy + r, ink)
            canvas.drawLine(cx - r, cy + r, cx + r, cy - r, ink)
        }
    }

    /** The app's 雾蓝 surfaces (as phone/a11y/ControlOverlay.kt draws them). */
    internal class Palette(
        val top: Int, val bottom: Int, val stroke: Int, val ink: Int, val muted: Int,
        val field: Int, val ripple: Int, val danger: Int,
    ) {
        companion object {
            private val light = Palette(
                top = 0xFFFBFCFF.toInt(), bottom = 0xFFEEF1F9.toInt(), stroke = 0xCCDCE0E8.toInt(), ink = 0xFF1E232E.toInt(),
                muted = 0xFF646974.toInt(), field = 0xFFE7EBF4.toInt(), ripple = 0x224B67B4, danger = 0xFFD93025.toInt(),
            )
            private val dark = Palette(
                top = 0xFF232730.toInt(), bottom = 0xFF1C1F28.toInt(), stroke = 0xCC343841.toInt(), ink = 0xFFE6E9F0.toInt(),
                muted = 0xFF9A9EA9.toInt(), field = 0xFF2D323C.toInt(), ripple = 0x3397B1F0, danger = 0xFFFF8A80.toInt(),
            )

            fun of(context: Context): Palette =
                if (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) dark else light
        }
    }

    companion object {
        const val DEFAULT_TOP_DP = 96f
        const val KEY_DP = 32f
        const val KEY_INSET_DP = 4f
        const val GAP_DP = 8f
        const val SIDE_DP = 16f
        const val SHADOW_DP = 8f
        const val MAX_LABEL_DP = 200f

        private fun pill(v: View, c: Palette) {
            val radius = v.context.pxf((KEY_DP + 2 * KEY_INSET_DP) / 2)
            v.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(c.top, c.bottom)).apply {
                cornerRadius = radius
                setStroke(v.context.px(1f).coerceAtLeast(1), c.stroke)
            }
            v.minimumHeight = v.context.px(KEY_DP + 2 * KEY_INSET_DP)
            v.elevation = v.context.pxf(6f)
            v.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, radius)
            }
        }
    }
}

internal fun Context.px(dp: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics).toInt()
internal fun Context.pxf(dp: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics)
