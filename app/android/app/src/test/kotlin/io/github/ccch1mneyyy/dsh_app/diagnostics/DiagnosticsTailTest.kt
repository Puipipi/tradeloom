package io.github.ccch1mneyyy.dsh_app.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DiagnosticsTailTest {
    @get:Rule
    val dir = TemporaryFolder()

    @Test
    fun missingFileIsEmpty() {
        assertEquals(emptyList<String>(), DiagnosticsPlugin.tail(File(dir.root, "nope.log"), 1024))
    }

    @Test
    fun smallFileComesBackWhole() {
        val file = dir.newFile("dsh.log").apply { writeText("one\ntwo\nthree\n") }
        assertEquals(listOf("one", "two", "three"), DiagnosticsPlugin.tail(file, 1024))
    }

    @Test
    fun cutFirstLineIsDropped() {
        val file = dir.newFile("dsh.log").apply { writeText("first line\nsecond\nthird\n") }
        // The last 12 bytes start inside "second"; 14 start on the newline before it.
        assertEquals(listOf("third"), DiagnosticsPlugin.tail(file, 12))
        assertEquals(listOf("second", "third"), DiagnosticsPlugin.tail(file, 14))
    }

    @Test
    fun defaultBudgetKeepsTheCompleteFirstLineAtTheBoundary() {
        val line = "x".repeat(1023)
        val file = dir.newFile("dsh.log").apply {
            writeText("older\n" + (line + "\n").repeat(512))
        }
        val lines = DiagnosticsPlugin.tail(file, 512 * 1024)
        assertEquals(512, lines.size)
        assertEquals(line, lines.first())
        assertEquals(line, lines.last())
    }

    @Test
    fun utf8LineStartIsKeptButACutCodePointIsDropped() {
        val file = dir.newFile("dsh.log").apply { writeText("older\n第二行\nthird\n") }
        // Three Chinese code points (9 bytes), LF, and "third" + LF make 16 bytes.
        assertEquals(listOf("第二行", "third"), DiagnosticsPlugin.tail(file, 16))
        assertEquals(listOf("third"), DiagnosticsPlugin.tail(file, 15))
    }

    @Test
    fun completeEmptyLineAtTheBoundaryIsKept() {
        val file = dir.newFile("dsh.log").apply { writeText("older\n\nnext\n") }
        assertEquals(listOf("", "next"), DiagnosticsPlugin.tail(file, 6))
    }

    @Test
    fun multiByteTextSurvives() {
        val file = dir.newFile("dsh.log").apply { writeText("[dsh-app] 已启动\n引擎就绪\n") }
        assertEquals(listOf("[dsh-app] 已启动", "引擎就绪"), DiagnosticsPlugin.tail(file, 4096))
    }
}
