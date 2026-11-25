package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The out-of-app bubble over the bundled pets, as PetOverlay places it: over the picture on screen
 * (the body and the current animation's cell), never in front of it, at every kind of dock.
 */
class PetBubbleTest {
    private fun shipped(id: String): PetPack {
        val dir = generateSequence(File("").absoluteFile) { it.parentFile }
            .flatMap { sequenceOf(File(it, "app/assets/pets/$id"), File(it, "assets/pets/$id")) }
            .firstOrNull { File(it, "pack.json").isFile }
        assertNotNull("bundled pack $id", dir)
        return PetPack.parse(File(dir, "pack.json").readText())
    }

    // A 1080×2400 phone at 2.75 px per dp: 96 px status bar, 63 px gesture bar; the overlay's
    // 8 dp edge and 4 dp gap; a 「标题 · 做完了」 card about 110 × 35 dp with its 6 dp tail.
    private val area = SafeArea(1080, 2400, left = 0, top = 96, right = 0, bottom = 63)
    private val margin = 22
    private val gap = 11
    private val card = 300 to 96
    private val tailH = 16
    private val tailInset = 55

    private fun place(f: PetFrames, rest: WindowPos, side: Side, shown: PetAnimation) = EdgeSnap.bubble(
        f.body.at(rest), f.art(shown).at(rest), side, card.first, card.second, tailH, area, gap, margin, tailInset,
    )

    private fun inside(r: ScreenRect) =
        r.left >= area.left + margin && r.right <= area.screenW - area.right - margin &&
            r.top >= area.top + margin && r.bottom <= area.screenH - area.bottom - margin

    private val mid = listOf(Dock(Side.RIGHT, 0.62f), Dock(Side.LEFT, 0.5f))
    private val top = listOf(Dock(Side.RIGHT, 0f), Dock(Side.LEFT, 0f))

    /** Docked right or left mid-screen: above the picture, whatever it is, the tail at the body. */
    @Test fun midScreenTheBubbleSitsOverThePicture() {
        for (id in listOf("deepy-whale", "whale-girl")) {
            val p = shipped(id)
            val f = PetFrames.of(p, p.windowBox(), p.screenScale(PetSize.MEDIUM, 2.75f))
            for (dock in mid) {
                val rest = EdgeSnap.position(dock, f.reach, area, margin)
                val body = f.body.at(rest)
                for (name in listOf("idle", "happy", "waking", "typing", "thinking", "notification")) {
                    val a = p.animations[name] ?: continue
                    val art = f.art(a).at(rest)
                    val b = place(f, rest, dock.side, a)
                    val where = "$id $dock $name: bubble ${b.rect}, picture $art"
                    assertEquals(where, Tail.DOWN, b.tail)
                    assertEquals(where, art.top - gap, b.rect.bottom)
                    assertFalse(where, b.rect.intersects(art))
                    assertTrue(where, inside(b.rect))
                    // The tail at the body's middle, unless that would put it on a rounded corner.
                    assertEquals(where, (body.centerX - b.pos.x).coerceIn(tailInset, b.w - tailInset), b.tailAt)
                    // Its inner edge lined up with the body's, reaching towards the middle.
                    if (dock.side == Side.RIGHT) assertEquals(where, body.right, b.rect.right) else assertEquals(where, body.left, b.rect.left)
                }
            }
        }
    }

    /** The owner's case: mid-jump, the whale is under the bubble's bottom edge, not behind it. */
    @Test fun duringHappyTheBubbleBottomIsAboveThePicture() {
        val p = shipped("deepy-whale")
        val f = PetFrames.of(p, p.windowBox(), p.screenScale(PetSize.MEDIUM, 2.75f))
        val rest = EdgeSnap.position(Dock.DEFAULT, f.reach, area, margin)
        val happy = p.animations.getValue("happy")
        val idle = p.primary(PetPack.IDLE, 0)
        val overHappy = place(f, rest, Side.RIGHT, happy)
        val overIdle = place(f, rest, Side.RIGHT, idle)
        // The jump reaches 21 art px above the body (y 5 against 26), k physical px each.
        val jump = 21 * p.devicePixels(PetSize.MEDIUM, 2.75f)
        assertEquals(f.body.top - jump, f.art(happy).top)
        assertTrue(overHappy.rect.bottom <= f.art(happy).at(rest).top)
        assertTrue(overHappy.rect.bottom < f.body.at(rest).top)
        // Idle: where it always was, just over the body. Happy: as much higher as the jump.
        assertEquals(f.body.at(rest).top - gap, overIdle.rect.bottom)
        assertEquals(jump, overIdle.pos.y - overHappy.pos.y)
        assertEquals(overIdle.pos.x, overHappy.pos.x)
        // Every visible pixel of happy lies inside its cell, so none is behind the bubble.
        assertFalse(overHappy.rect.intersects(f.cell(happy).at(rest)))
    }

    /** Docked at the top: no room above, so beside the picture, towards the middle, clear of the bars. */
    @Test fun dockedAtTheTopTheBubbleGoesBeside() {
        for (id in listOf("deepy-whale", "whale-girl")) {
            val p = shipped(id)
            val f = PetFrames.of(p, p.windowBox(), p.screenScale(PetSize.MEDIUM, 2.75f))
            for (dock in top) {
                val rest = EdgeSnap.position(dock, f.reach, area, margin)
                val body = f.body.at(rest)
                for (name in listOf("idle", "happy", "waking", "typing")) {
                    val a = p.animations.getValue(name)
                    val art = f.art(a).at(rest)
                    val b = place(f, rest, dock.side, a)
                    val where = "$id $dock $name: bubble ${b.rect}, picture $art"
                    assertEquals(where, if (dock.side == Side.RIGHT) Tail.RIGHT else Tail.LEFT, b.tail)
                    assertFalse(where, b.rect.intersects(art))
                    assertTrue(where, inside(b.rect))
                    if (dock.side == Side.RIGHT) assertEquals(where, art.left - gap, b.rect.right) else assertEquals(where, art.right + gap, b.rect.left)
                    assertEquals(where, card.first + tailH, b.w)
                    assertEquals(where, body.centerY, b.pos.y + b.tailAt)
                }
            }
        }
    }

    /** Every dock, every size: wherever it goes, the bubble is on screen and never over the picture. */
    @Test fun neverOverThePictureNorOffScreen() {
        for (id in listOf("deepy-whale", "whale-girl")) {
            val p = shipped(id)
            for (size in listOf("small", "medium", "large")) {
                val f = PetFrames.of(p, p.windowBox(), p.screenScale(PetSize.fromName(size), 2.75f))
                for (side in Side.values()) for (y in listOf(0f, 0.05f, 0.1f, 0.5f, 1f)) {
                    val dock = Dock(side, y)
                    val rest = EdgeSnap.position(dock, f.reach, area, margin)
                    for (a in p.animations.values) {
                        val b = place(f, rest, side, a)
                        val where = "$id $size $dock ${a.name}: ${b.rect}"
                        assertTrue(where, inside(b.rect))
                        assertFalse(where, b.rect.intersects(f.art(a).at(rest)))
                    }
                }
            }
        }
    }
}
