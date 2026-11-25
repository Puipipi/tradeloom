package io.github.ccch1mneyyy.dsh_app.launch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** The launch window's geometry, and the resources that have to agree with it. */
class LaunchGeometryTest {
    private val res = File("src/main/res")

    private fun xml(path: String): Element =
        DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, path)).documentElement

    private fun Element.children(tag: String): List<Element> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    @Test fun iconBoxRoundsLikeADimensionResource() {
        assertEquals(160, LaunchGeometry.iconPx(1f))
        assertEquals(420, LaunchGeometry.iconPx(2.625f))
        assertEquals(440, LaunchGeometry.iconPx(2.75f))
        // 160 × 2.8125 = 450.0; 160 × 3.0 = 480.
        assertEquals(450, LaunchGeometry.iconPx(2.8125f))
        assertEquals(480, LaunchGeometry.iconPx(3f))
        assertEquals(240, LaunchGeometry.iconPx(1.5f))
        // Never zero for a non-zero size, as TypedValue.complexToDimensionPixelSize.
        assertEquals(1, LaunchGeometry.iconPx(0.003f))
    }

    @Test fun centringIsIntegerDivisionLikeFrameLayout() {
        assertEquals(330, LaunchGeometry.centred(1080, 420))
        // An odd remainder rounds down: the box sits half a pixel left of the true centre.
        assertEquals(330, LaunchGeometry.centred(1081, 420))
        assertEquals(1060, LaunchGeometry.centred(2340, 220))
    }

    @Test fun anIconExactlyWhereTheFirstFrameDrewItNeedsNoRoundTrip() {
        // 1080 × 2400 view, a 420 px icon: the first frame drew it at (330, 990).
        assertTrue(LaunchGeometry.inPlace(330, 990, 420, 420, 1080, 2400, 420))
        // A vendor's splash a pixel off, or smaller, or no icon size known: redraw and fade.
        assertFalse(LaunchGeometry.inPlace(330, 991, 420, 420, 1080, 2400, 420))
        assertFalse(LaunchGeometry.inPlace(345, 1005, 390, 390, 1080, 2400, 420))
        assertFalse(LaunchGeometry.inPlace(330, 990, 420, 420, 1080, 2400, 0))
    }

    @Test fun aColdStartIsAnEngineThatHadToBeStartedNow() {
        // Not running at launch, LaunchStart started it: cold.
        assertTrue(LaunchEngine.cold(runningAtLaunch = false, started = true, phaseNow = "starting"))
        // Already running (an engine that outlived the app): warm, whatever came after.
        assertFalse(LaunchEngine.cold(runningAtLaunch = true, started = true, phaseNow = "running"))
        // Not started (auto start off, not installed, the failure card waits): nothing to cover.
        assertFalse(LaunchEngine.cold(runningAtLaunch = false, started = false, phaseNow = "installed"))
        // LaunchStart still deciding: a start under way counts.
        assertTrue(LaunchEngine.cold(runningAtLaunch = false, started = null, phaseNow = "starting"))
        assertFalse(LaunchEngine.cold(runningAtLaunch = false, started = null, phaseNow = "installed"))
        assertFalse(LaunchEngine.cold(runningAtLaunch = false, started = null, phaseNow = null))
    }

    @Test fun splashIconLoadsSharperOnTwelveAndUp() {
        // 12+: the splash's own density (box / 108 × 1.2) picks the xxxhdpi foreground on a 440 dpi phone.
        assertEquals(782, LaunchGeometry.iconDpi(31, 440))
        assertEquals(782, LaunchGeometry.iconDpi(35, 440))
        // 8–11: the window inflates the layer-list at its own density.
        assertEquals(440, LaunchGeometry.iconDpi(30, 440))
    }

    @Test fun measuredIconIsRelativeToTheFlutterViewInLogicalPixels() {
        val rect = LaunchGeometry.relative(330, 960, 420, 420, 0, 0, 2.625f)
        assertEquals(listOf(330 / 2.625, 960 / 2.625, 160.0, 160.0), rect)
        // A view that doesn't start at the window's corner (a cutout band, freeform).
        val shifted = LaunchGeometry.relative(330, 960, 420, 420, 0, 84, 2.625f)
        assertEquals(876 / 2.625, shifted[1], 1e-9)
    }

    @Test fun launchLineReadsFromProcessStart() {
        assertEquals(512L, LaunchGeometry.sinceStart(1000L, 1512L))
        assertNull(LaunchGeometry.sinceStart(null, 1512L))
        assertNull(LaunchGeometry.sinceStart(2000L, 1512L))
        // Long after the start: not a launch.
        assertNull(LaunchGeometry.sinceStart(1000L, 61_000L))
        val line = LaunchGeometry.line(linkedMapOf("firstFrame" to 512L, "handedOver" to 590L, "ready" to 840L))
        assertEquals("[dsh-app] launch: first frame 512 ms, handed over 590 ms, ready 840 ms", line)
        assertNull(LaunchGeometry.line(emptyMap()))
        // Written when the launch screen is gone: a late hand-over still shows.
        val late = LaunchGeometry.line(linkedMapOf("firstFrame" to 500L, "ready" to 540L, "handedOver" to 610L, "gone" to 900L))
        assertEquals("[dsh-app] launch: first frame 500 ms, ready 540 ms, handed over 610 ms, gone 900 ms", late)
    }

    @Test fun launchWindowIsThePageAloneNoIcon() {
        for (dir in listOf("drawable", "drawable-v21")) {
            val items = xml("$dir/launch_background.xml").children("item")
            // A window background can't follow the chosen 桌面图标: no icon at all.
            assertTrue(dir, items.none { it.hasAttribute("android:drawable") })
            assertEquals(dir, 1, items.size)
            // The page gradient, from the colours the app reads back in `begin`.
            val gradient = items.single().children("gradient").single()
            assertEquals("@color/launch_background_top", gradient.getAttribute("android:startColor"))
            assertEquals("@color/launch_background_bottom", gradient.getAttribute("android:endColor"))
        }
    }

    @Test fun theManifestSplashIsThePageColourWithoutAnIcon() {
        for (dir in listOf("values-v31", "values-night-v31")) {
            val launch = xml("$dir/styles.xml").children("style").single { it.getAttribute("name") == "LaunchTheme" }
            val items = launch.children("item").associate { it.getAttribute("name") to it.textContent.trim() }
            assertEquals(dir, "@color/launch_background_top", items["android:windowSplashScreenBackground"])
            // Never the splash colour (LaunchThemesTest: the icon themes' 160dp square).
            assertEquals(dir, "@color/launch_icon_ground", items["android:windowSplashScreenIconBackgroundColor"])
            assertEquals(dir, "@drawable/launch_icon_none", items["android:windowSplashScreenAnimatedIcon"])
        }
        val none = xml("drawable/launch_icon_none.xml")
        assertEquals("@android:color/transparent", none.children("solid").single().getAttribute("android:color"))
    }
}
