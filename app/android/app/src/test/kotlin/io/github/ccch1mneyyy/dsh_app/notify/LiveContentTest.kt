package io.github.ccch1mneyyy.dsh_app.notify

import io.github.ccch1mneyyy.dsh_app.phone.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveContentTest {
    private val running = mapOf(
        "kind" to "running",
        "title" to "修一下登录页",
        "text" to "正在工作 · 2 个对话在跑",
        "chip" to "工作中",
        "publicText" to "DSH 正在工作",
        "sinceMs" to 1_793_000_000_000L,
        "packId" to "deepy",
        "mood" to "working",
        "sessionId" to "s1",
        "host" to "local",
    )

    @Test fun readsTheAgentsActivity() {
        val c = LiveContent.fromMap(running)!!
        assertEquals(LiveContent.Kind.RUNNING, c.kind)
        assertEquals("修一下登录页", c.title)
        assertEquals("工作中", c.chip)
        assertEquals(1_793_000_000_000L, c.sinceMs)
        assertEquals("deepy", c.packId)
        assertEquals("s1", c.sessionId)
        assertTrue(c.busy)
        assertFalse(c.ending)
    }

    @Test fun rejectsWhatDartNeverSends() {
        assertNull(LiveContent.fromMap(null))
        assertNull(LiveContent.fromMap(running - "title"))
        assertNull(LiveContent.fromMap(running + ("title" to "  ")))
        assertNull(LiveContent.fromMap(running + ("kind" to "sleeping")))
        // Phone control is native's alone: Dart can't post a 「正在操作手机」.
        assertNull(LiveContent.fromMap(running + ("kind" to "phone")))
    }

    @Test fun noPetAndNoClockAreReadAsNone() {
        val c = LiveContent.fromMap(running + ("packId" to "none") + ("sinceMs" to 0))!!
        assertNull(c.packId)
        assertNull(c.sinceMs)
    }

    @Test fun longTextIsCut() {
        val c = LiveContent.fromMap(running + ("title" to "长".repeat(500)) + ("chip" to "很长很长很长很长很长的胶囊"))!!
        assertEquals(LiveContent.TITLE_MAX, c.title.length)
        assertEquals(LiveContent.CHIP_MAX, c.chip!!.length)
    }

    @Test fun aRunsChipShowsItsClockAndTheRestTheirWords() {
        val run = LiveContent.fromMap(running)!!
        assertNull(run.chipWords)
        assertEquals("工作中", run.copy(sinceMs = null).chipWords)
        assertEquals("待确认", run.copy(kind = LiveContent.Kind.WAITING, chip = "待确认").chipWords)
        val done = run.copy(kind = LiveContent.Kind.DONE, chip = "完成")
        assertEquals("完成", done.chipWords)
        assertTrue(done.ending)
        assertFalse(done.busy)
    }

    @Test fun phoneControlOutranksTheAgent() {
        val agent = LiveContent.fromMap(running)!!
        val phone = LiveContent(LiveContent.Kind.PHONE, "DSH 正在操作手机", "点击「发送」", "操作中", "DSH 正在操作手机")
        assertSame(phone, LiveContent.pick(phone, agent))
        assertSame(agent, LiveContent.pick(null, agent))
        assertNull(LiveContent.pick(null, null))
    }

    @Test fun xiaomiFocusTemplate() {
        val c = LiveContent.fromMap(running + ("kind" to "waiting") + ("chip" to "待确认") + ("text" to "运行：git push"))!!
        @Suppress("UNCHECKED_CAST")
        val v2 = (Json.parse(XiaomiFocus.param(c)) as Map<String, Any?>)["param_v2"] as Map<String, Any?>
        assertEquals("dsh_live_waiting", v2["business"])
        assertEquals(true, v2["updatable"])
        assertEquals(false, v2["enableFloat"])
        assertEquals("待确认", v2["aodTitle"])
        @Suppress("UNCHECKED_CAST")
        val island = v2["param_island"] as Map<String, Any?>
        val big = (island["bigIslandArea"] as Map<*, *>)["imageTextInfoLeft"] as Map<*, *>
        assertEquals(XiaomiFocus.PIC_ICON, (big["picInfo"] as Map<*, *>)["pic"])
        assertEquals("待确认", (big["textInfo"] as Map<*, *>)["title"])
        val base = v2["baseInfo"] as Map<*, *>
        assertEquals("修一下登录页", base["title"])
        assertEquals("运行：git push", base["content"])
    }

    @Test fun xiaomiFocusTemplateStaysWithinItsCap() {
        val huge = LiveContent(LiveContent.Kind.WAITING, "题".repeat(LiveContent.TITLE_MAX), "字".repeat(5000), "待确认", "x")
        val json = XiaomiFocus.param(huge)
        assertTrue(json.toByteArray(Charsets.UTF_8).size <= XiaomiFocus.PARAM_MAX_BYTES)
        Json.parse(json)
    }
}
