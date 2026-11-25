package io.github.ccch1mneyyy.dsh_app.runtime

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechGuestTest {
    private val launch = "echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml --host 127.0.0.1 --port 3080 --no-open"

    @Test fun addsTheOverlayRightAfterTheAppsOwnPatch() {
        assertEquals(
            "echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml " +
                "--patch /opt/dsh-app/speech.patch.yml --host 127.0.0.1 --port 3080 --no-open",
            SpeechGuest.launchArg(launch),
        )
    }

    @Test fun chainsAfterTheOtherOverlays() {
        // Message search and the auth bridge come first (DshProcess order); this one is appended after the web patch.
        val searched = SessionSearchGuest.launchArg(launch)!!
        val both = SpeechGuest.launchArg(searched)!!
        assertTrue(both.contains("--patch /opt/dsh-app/search.patch.yml"))
        assertTrue(both.contains("--patch /opt/dsh-app/speech.patch.yml"))
        assertEquals(1, Regex("speech\\.patch\\.yml").findAll(both).count())
    }

    @Test fun leavesOtherArgumentsAndSafeModeAlone() {
        assertNull(SpeechGuest.launchArg("/usr/bin/env"))
        assertNull(SpeechGuest.launchArg("exec /usr/local/bin/dsh web --profile safe --port 1"))
    }

    @Test fun overlayTargetsTheRecognizerAndKeepsItsDataRoot() {
        val yaml = SpeechGuest.PATCH_YAML
        assertTrue(yaml.contains("- id: speech-to-text-sensevoice\n  config:\n"))
        // A patch row replaces the whole config: the bundle's dataRoot must be repeated.
        assertTrue(yaml.contains("    dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')\n"))
        assertTrue(yaml.contains("    idleTimeoutMs: 90000\n"))
        assertTrue(yaml.contains("    threads: 2\n"))
    }

    @Test fun writesTheFileOnceAndRewritesAStaleOne() {
        val root = Files.createTempDirectory("speech-guest").toFile()
        try {
            assertTrue(SpeechGuest.writeFiles(root))
            val file = SpeechGuest.file(root)
            assertEquals(SpeechGuest.PATCH_YAML, file.readText())
            file.writeText("stale")
            assertTrue(SpeechGuest.writeFiles(root))
            assertEquals(SpeechGuest.PATCH_YAML, file.readText())
            assertFalse(root.resolve("opt/dsh-app").listFiles()!!.any { it.name.endsWith(".tmp") })
        } finally {
            root.deleteRecursively()
        }
    }
}
