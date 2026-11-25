package io.github.ccch1mneyyy.dsh_app.launch

import io.github.ccch1mneyyy.dsh_app.runtime.RuntimeController

/**
 * Whether this launch is a cold start of the engine: the launch screen then stays for its whole
 * motion (or until the engine is up) instead of leaving the moment the app is usable, since
 * nothing can be asked until the engine answers. Pure, unit-tested.
 */
internal object LaunchEngine {
    /**
     * [runningAtLaunch]: the engine already ran when the first activity of this process was
     * created (one that outlived the app, taken over again). [started]: LaunchStart started it
     * for this launch (null: it hasn't decided yet, then [phaseNow] being `starting` counts).
     */
    fun cold(runningAtLaunch: Boolean, started: Boolean?, phaseNow: String?): Boolean =
        !runningAtLaunch && (started ?: (phaseNow == RuntimeController.Phase.STARTING.wire))
}

/**
 * Where the system draws the launch icon, so the app's first frame (app/lib/launch/) can put the
 * same pixels in the same place. Pure, unit-tested on the JVM; [LaunchScreen] uses it.
 *
 * - Android 13+, once the chosen icon's own splash theme is in place (LaunchThemes): the system
 *   splash (Shell's SplashscreenContentDrawer) draws that adaptive icon
 *   (windowSplashScreenAnimatedIcon), cut to the device's icon mask, in an [ICON_DP] square centred
 *   in the window. That takes a `windowSplashScreenIconBackgroundColor` other than the splash
 *   colour (launch_icon_ground): transparent or equal, the icon is drawn 1.2x larger. Vendors may
 *   move it: the splash view handed to the app is measured ([relative]) and the app follows it.
 * - Otherwise (Android 8–12, a first launch, a custom launch screen) the system shows the page
 *   alone, and the app's first frame brings the icon in at this same square.
 */
internal object LaunchGeometry {
    /** Shell's `starting_surface_icon_size`: the splash icon's square, and the app's on every Android. */
    const val ICON_DP = 160f

    /** AOSP's own splash icon density factor: icon box / 108 dp default size × 1.2 (no-background scale). */
    private const val SPLASH_DPI_SCALE = 160f / 108f * 1.2f

    /** The icon square in pixels, rounded as Resources.getDimensionPixelSize rounds a dp value. */
    fun iconPx(density: Float): Int {
        val f = ICON_DP * density
        val px = (f + 0.5f).toInt()
        return if (px == 0 && f > 0f) 1 else px
    }

    /**
     * The density the icon is loaded at. 12+: as the splash loads it (its foreground then comes
     * from the sharpest bucket there is); 8–11: the window's own density.
     */
    fun iconDpi(sdk: Int, densityDpi: Int): Int =
        if (sdk >= SPLASH_SDK) (0.5f + SPLASH_DPI_SCALE * densityDpi).toInt() else densityDpi

    /** Left (or top) of a [size] box centred in [extent]: FrameLayout's and Gravity.CENTER's integer division. */
    fun centred(extent: Int, size: Int): Int = (extent - size) / 2

    /**
     * The splash icon as measured in the window ([iconLeft], [iconTop], [iconWidth] ×
     * [iconHeight], window pixels), relative to the Flutter view at [viewLeft], [viewTop], in
     * logical pixels: `[left, top, width, height]`.
     */
    fun relative(
        iconLeft: Int,
        iconTop: Int,
        iconWidth: Int,
        iconHeight: Int,
        viewLeft: Int,
        viewTop: Int,
        density: Float,
    ): List<Double> = listOf(
        (iconLeft - viewLeft) / density.toDouble(),
        (iconTop - viewTop) / density.toDouble(),
        iconWidth / density.toDouble(),
        iconHeight / density.toDouble(),
    )

    /**
     * Whether a splash icon at [left], [top] (pixels from the Flutter view's corner), [width] ×
     * [height], is the square the app's first frame put its own icon in: [iconPx] centred in the
     * [viewWidth] × [viewHeight] view, by whole pixels.
     */
    fun inPlace(left: Int, top: Int, width: Int, height: Int, viewWidth: Int, viewHeight: Int, iconPx: Int): Boolean =
        iconPx > 0 && width == iconPx && height == iconPx &&
            left == centred(viewWidth, iconPx) && top == centred(viewHeight, iconPx)

    /** Android 12: the system splash, and an app's say over how it leaves. */
    const val SPLASH_SDK = 31

    /**
     * Process start → [mark], for the log line, or null when the process was already up long
     * before (a start that isn't a cold launch).
     */
    fun sinceStart(processStart: Long?, mark: Long): Long? {
        if (processStart == null || processStart <= 0 || mark < processStart) return null
        val ms = mark - processStart
        return if (ms < LAUNCH_WINDOW_MS) ms else null
    }

    /** The launch line: `[dsh-app] launch: first frame 512 ms, handed over 590 ms, ready 840 ms`. */
    fun line(marks: Map<String, Long>): String? {
        if (marks.isEmpty()) return null
        val parts = marks.entries.joinToString(", ") { (name, ms) -> "${label(name)} $ms ms" }
        return "[dsh-app] launch: $parts"
    }

    private fun label(name: String) = when (name) {
        "firstFrame" -> "first frame"
        "handedOver" -> "handed over"
        "ready" -> "ready"
        "gone" -> "gone"
        else -> name
    }

    private const val LAUNCH_WINDOW_MS = 30_000L
}
