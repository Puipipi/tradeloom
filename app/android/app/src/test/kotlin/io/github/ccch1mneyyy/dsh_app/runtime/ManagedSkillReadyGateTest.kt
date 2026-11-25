package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class ManagedSkillReadyGateTest {
    @Test fun readyBeforeFirstAttachmentIsAvailableWithoutARepeatedReady() {
        val gate = ManagedSkillRuntimeGate()
        gate.ready(4, "current")
        assertNull(gate.generationFor("current"))
        val owner = ManagedSkillOwner()
        gate.attach(owner)
        val grant = gate.generationFor("current")!!
        assertNotNull(gate.capture(owner, "current", grant))
        gate.ready(4, "current")
        assertEquals(grant, gate.generationFor("current"))
    }

    @Test fun replacementUsesTheStillReadyRuntimeButNeverTheOldPermission() {
        val gate = ManagedSkillRuntimeGate()
        val old = ManagedSkillOwner()
        gate.attach(old)
        gate.ready(4, "current")
        val oldGrant = gate.generationFor("current")!!
        val oldScope = gate.capture(old, "current", oldGrant)!!
        val next = ManagedSkillOwner()
        assertSame(old, gate.attach(next))
        val nextGrant = gate.generationFor("current")!!
        assertNotEquals(oldGrant, nextGrant)
        assertFalse(gate.current(oldScope))
        assertNull(gate.capture(next, "current", oldGrant))
        assertNull(gate.capture(old, "current", nextGrant))
        gate.detach(old)
        assertNotNull(gate.capture(next, "current", nextGrant))
        gate.ready(4, "current")
        assertEquals(nextGrant, gate.generationFor("current"))
    }

    @Test fun detachingTheOnlyOwnerKeepsReadyButNotItsWritePermission() {
        val gate = ManagedSkillRuntimeGate()
        val old = ManagedSkillOwner()
        gate.attach(old)
        gate.ready(4, "current")
        val oldGrant = gate.generationFor("current")!!
        gate.detach(old)
        assertNull(gate.generationFor("current"))
        assertNull(gate.capture(old, "current", oldGrant))
        val next = ManagedSkillOwner()
        gate.attach(next)
        val nextGrant = gate.generationFor("current")!!
        assertNotEquals(oldGrant, nextGrant)
        assertNotNull(gate.capture(next, "current", nextGrant))
    }

    @Test fun replacementBeforeReadyOnlyAuthorizesTheLatestOwner() {
        val gate = ManagedSkillRuntimeGate()
        val old = ManagedSkillOwner()
        val next = ManagedSkillOwner()
        gate.attach(old)
        gate.attach(next)
        assertNull(gate.generationFor("current"))
        gate.ready(4, "current")
        val grant = gate.generationFor("current")!!
        assertNull(gate.capture(old, "current", grant))
        assertNotNull(gate.capture(next, "current", grant))
    }

    @Test fun retirementBeforeAttachmentCannotBeUndoneByTheAttachment() {
        for (withOwner in listOf(false, true)) {
            val gate = ManagedSkillRuntimeGate()
            if (withOwner) gate.attach(ManagedSkillOwner())
            gate.ready(4, "current")
            gate.retire() // new STARTING, install/reset, exit/error
            val next = ManagedSkillOwner()
            gate.attach(next)
            assertNull(gate.generationFor("current"))
            gate.ready(5, "current")
            val grant = gate.generationFor("current")!!
            assertNotNull(gate.capture(next, "current", grant))
        }
    }

    @Test fun stopCannotBeUndoneByAttachmentOrSameRunReadyButNextRunWorks() {
        for (withOwner in listOf(false, true)) {
            val gate = ManagedSkillRuntimeGate()
            if (withOwner) gate.attach(ManagedSkillOwner())
            gate.ready(4, "same")
            val oldGrant = gate.generationFor("same")
            gate.stop(4)
            val next = ManagedSkillOwner()
            gate.attach(next)
            gate.ready(4, "same")
            assertNull(gate.generationFor("same"))
            gate.ready(5, "same")
            val nextGrant = gate.generationFor("same")!!
            assertNotEquals(oldGrant, nextGrant)
            assertNotNull(gate.capture(next, "same", nextGrant))
            if (oldGrant != null) assertNull(gate.capture(next, "same", oldGrant))
        }
    }
}
