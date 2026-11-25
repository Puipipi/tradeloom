package io.github.ccch1mneyyy.dsh_app.shortcuts

import org.junit.Assert.*
import org.junit.Test

class ShortcutLabelsTest {
    @Test fun shortTitlesStayWhole() {
        assertEquals("修复登录", ShortcutLabels.short("修复登录"))
        assertEquals("修复登录重复提交", ShortcutLabels.long("  修复登录\n重复提交 ").replace(" ", ""))
    }

    @Test fun longTitlesEndInAnEllipsisWithinTheLimit() {
        val title = "把周报整理成表格并发给团队里的每一个人"
        val short = ShortcutLabels.short(title)
        assertEquals(ShortcutLabels.SHORT, short.codePointCount(0, short.length))
        assertTrue(short.endsWith("…"))
        assertEquals("把周报整理成表格并…", short)
    }

    @Test fun emojiAreNeverCutInHalf() {
        val title = "🎉".repeat(12)
        val short = ShortcutLabels.short(title)
        assertEquals("🎉".repeat(9) + "…", short)
    }

    @Test fun whitespaceCollapses() {
        assertEquals("a b", ShortcutLabels.long("a \n\t b"))
    }
}
