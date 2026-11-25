package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

/**
 * RuntimeController's last-good sequence: launch read → [LastKnownGood.bootedAtReady] when DSH
 * reports ready → [LastKnownGood.pinBooted] two minutes later. The disk is a variable here.
 */
class LastKnownGoodBootTest {
    private val a = ProfileSnapshot(listOf("core", "a"), setOf("a"), mapOf("a" to "1"), "a: true\n")
    private val b = ProfileSnapshot(listOf("core", "a", "imported"), setOf("a", "imported"), mapOf("a" to "1", "imported" to "1"), "b: true\n")
    private val p = ProfileSnapshot(listOf("core", "p"), setOf("p"), mapOf("p" to "1"), null)

    private var disk: ProfileSnapshot? = null
    private var reads = 0
    private var pin: ProfileSnapshot? = null
    private var pins = 0

    private fun readDisk(): ProfileSnapshot? { reads++; return disk }
    private fun healthy(booted: ProfileSnapshot?) = LastKnownGood.pinBooted(booted) { pins++; pin = it }

    @Test fun firstBootPinsTheProfileItBootedEvenIfAnImportReplacesItBeforeTheHealthyCallback() {
        val atLaunch = disk // no profile yet: DSH creates it after the launch read
        disk = a // DSH created it and reports ready
        val booted = LastKnownGood.bootedAtReady(atLaunch, ::readDisk)
        disk = b // the app imports a newer, unproven config while RUNNING
        assertTrue(healthy(booted))
        assertEquals(a, pin)
        assertEquals(1, reads)
    }

    @Test fun aProfileReadAtLaunchIsKeptAndTheDiskIsNotReadAgain() {
        disk = a
        val atLaunch = disk
        disk = b
        val booted = LastKnownGood.bootedAtReady(atLaunch, ::readDisk)
        assertEquals(a, booted)
        assertEquals(0, reads)
        assertTrue(healthy(booted))
        assertEquals(a, pin)
    }

    @Test fun anUnreadableProfileAtReadyKeepsTheExistingPin() {
        pin = p
        val booted = LastKnownGood.bootedAtReady(null) { throw IllegalStateException("malformed package.json") }
        assertNull(booted)
        disk = b // readable again by the time the run is healthy: still not pinned
        assertFalse(healthy(booted))
        assertEquals(p, pin)
        assertEquals(0, pins)
    }

    @Test fun aProfileStillMissingAtReadyKeepsTheExistingPin() {
        pin = p
        val booted = LastKnownGood.bootedAtReady(null, ::readDisk)
        assertNull(booted)
        disk = b
        assertFalse(healthy(booted))
        assertEquals(p, pin)
        assertEquals(0, pins)
    }
}
