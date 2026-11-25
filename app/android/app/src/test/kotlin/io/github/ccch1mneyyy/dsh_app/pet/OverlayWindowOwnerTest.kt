package io.github.ccch1mneyyy.dsh_app.pet

import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

/** Platform registration, delayed attachment and deferred removal are separate fixture events. */
class OverlayWindowOwnerTest {
    private class Window { var attached = false }
    private class Host {
        val registered = LinkedHashSet<Window>()
        var holdRemoval = false
        var failRemoval = false
        var removeCalls = 0
        fun add(v: Window) { check(registered.add(v)) }
        fun remove(v: Window): Boolean {
            removeCalls++
            if (failRemoval) throw IllegalStateException("injected removal failure")
            if (holdRemoval) return false
            registered.remove(v)
            v.attached = false
            return true
        }
    }

    private fun add(owner: OverlayWindowOwner, host: Host, role: OverlayWindowOwner.Role = OverlayWindowOwner.Role.PET): Pair<OverlayWindowOwner.Ticket, Window> {
        val ticket = checkNotNull(owner.claim(role))
        val view = Window()
        assertTrue(owner.install(ticket, { host.remove(view) }, { host.add(view) }))
        return ticket to view
    }

    @Test fun oldAttachmentGuardLeavesTwoRegisteredWindowsBeforeFirstTraversal() {
        val host = Host()
        var current: Window? = null
        // The old attachPet/remove conditions, with the platform's first attach deferred.
        fun oldEvaluate() {
            if (current?.attached == true) return
            current?.let { if (it.attached) host.remove(it) }
            current = null
            current = Window().also(host::add)
        }
        oldEvaluate()
        val orphan = current!!
        oldEvaluate()
        assertEquals(2, host.registered.size)
        host.registered.forEach { it.attached = true }
        assertNotSame(orphan, current)
        assertTrue(orphan.attached)
        // The animation owner's single current reference cannot drive the orphan.
    }

    @Test fun successfulAddOwnsPetBeforeAttachmentAndSecondClaimIsRejected() {
        val owner = OverlayWindowOwner()
        val host = Host()
        assertTrue(owner.begin(host))
        val (ticket, view) = add(owner, host)
        assertFalse(view.attached)
        assertTrue(owner.owns(ticket))
        repeat(100) {
            assertTrue(owner.begin(host))
            assertNull(owner.claim(OverlayWindowOwner.Role.PET))
        }
        assertEquals(1, host.registered.size)
    }

    @Test fun registrationIsReservedBeforePlatformAddCanReenter() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val ticket = owner.claim(OverlayWindowOwner.Role.PET)!!
        val view = Window()
        owner.install(ticket, { host.remove(view) }) {
            assertTrue(owner.owns(ticket))
            assertNull(owner.claim(OverlayWindowOwner.Role.PET))
            host.add(view)
        }
        assertEquals(1, host.registered.size)
    }

    @Test fun pendingAttachmentIsRemovedUnconditionally() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val (ticket, view) = add(owner, host)
        assertFalse(view.attached)
        owner.retire()
        assertEquals(1, host.removeCalls)
        assertEquals(0, host.registered.size)
        assertFalse(owner.owns(ticket))
    }

    @Test fun retirementRevokesCallbacksBeforeInvokingPlatformCleanup() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val ticket = owner.claim(OverlayWindowOwner.Role.PET)!!
        var checked = false
        owner.install(ticket, { assertFalse(owner.owns(ticket)); checked = true; true }, {})
        owner.retire()
        assertTrue(checked)
    }

    @Test fun deferredRemovalBlocksBothSameHostAndReplacementHost() {
        val owner = OverlayWindowOwner()
        val old = Host().apply { holdRemoval = true }
        val next = Host()
        owner.begin(old)
        val (ticket, _) = add(owner, old)
        owner.retire()
        repeat(50) {
            owner.retryRemovals()
            assertFalse(owner.begin(old))
            assertFalse(owner.begin(next))
            assertNull(owner.claim(OverlayWindowOwner.Role.PET))
            assertFalse(owner.owns(ticket))
        }
        assertEquals(1, old.registered.size)
        assertEquals(1, owner.pendingRemovals)
        old.holdRemoval = false
        owner.retryRemovals()
        assertTrue(owner.begin(next))
        add(owner, next)
        assertEquals(0, old.registered.size)
        assertEquals(1, next.registered.size)
    }

    @Test fun failedRemovalIsRetainedAndRecoveryUsesOriginalHost() {
        val owner = OverlayWindowOwner()
        val old = Host().apply { failRemoval = true }
        val next = Host()
        owner.begin(old)
        add(owner, old)
        owner.retire()
        assertFalse(owner.begin(next))
        assertEquals("IllegalStateException", owner.lastRemovalFailure)
        assertEquals(1, owner.registeredWindows)
        old.failRemoval = false
        owner.retryRemovals()
        assertTrue(owner.begin(next))
        add(owner, next)
        assertEquals(0, next.removeCalls)
        assertEquals(0, old.registered.size)
    }

    @Test fun partiallySuccessfulAddRemainsOwnedUntilItsCleanupCompletes() {
        val owner = OverlayWindowOwner()
        val host = Host().apply { holdRemoval = true }
        owner.begin(host)
        val ticket = owner.claim(OverlayWindowOwner.Role.PET)!!
        val view = Window()
        try {
            owner.install(ticket, { host.remove(view) }) {
                host.add(view)
                throw IllegalStateException("after registration")
            }
            fail("injection should escape")
        } catch (_: IllegalStateException) { }
        assertEquals(1, owner.pendingRemovals)
        assertFalse(owner.owns(ticket))
        assertNull(owner.claim(OverlayWindowOwner.Role.PET))
        owner.retire()
        assertFalse(owner.begin(host))
        host.holdRemoval = false
        owner.retryRemovals()
        assertTrue(owner.begin(host))
        add(owner, host)
        assertEquals(1, host.registered.size)
    }

    @Test fun failureBeforeRegistrationAndUninstalledReservationCanBeRetired() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val ticket = owner.claim(OverlayWindowOwner.Role.PET)!!
        try {
            owner.install(ticket, { true }) { throw SecurityException("before registration") }
            fail("injection should escape")
        } catch (_: SecurityException) { }
        assertEquals(0, owner.registeredWindows)
        owner.claim(OverlayWindowOwner.Role.MENU)
        owner.retire()
        assertTrue(owner.begin(Host()))
    }

    @Test fun removeAndRetireAreIdempotentAndCannotRemoveTheSuccessor() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val (old, _) = add(owner, host)
        owner.remove(old)
        owner.remove(old)
        assertEquals(1, host.removeCalls)
        val (next, _) = add(owner, host)
        owner.remove(old)
        assertTrue(owner.owns(next))
        assertEquals(1, host.registered.size)
        owner.retire()
        owner.retire()
        assertEquals(2, host.removeCalls)
    }

    @Test fun auxiliaryWindowsHaveIndependentTicketsWithinOnePetGeneration() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val (pet, _) = add(owner, host)
        val (bubble, _) = add(owner, host, OverlayWindowOwner.Role.BUBBLE)
        val (menu, _) = add(owner, host, OverlayWindowOwner.Role.MENU)
        owner.remove(bubble)
        val (next, _) = add(owner, host, OverlayWindowOwner.Role.BUBBLE)
        assertFalse(owner.owns(bubble))
        assertTrue(owner.owns(next))
        assertTrue(owner.owns(menu))
        assertTrue(owner.owns(pet))
        owner.remove(bubble) // Late timeout for the previous bubble.
        assertTrue(owner.owns(next))
    }

    @Test fun systemDetachRevokesImmediatelyWithoutReentrantPlatformRemoval() {
        val owner = OverlayWindowOwner()
        val host = Host()
        owner.begin(host)
        val (ticket, _) = add(owner, host)
        owner.revoke(ticket)
        assertFalse(owner.owns(ticket))
        assertEquals(0, host.removeCalls)
        owner.retire()
        assertEquals(1, host.removeCalls)
    }

    @Test fun notificationTokenExpiresOnRetirementAndProcessRestart() {
        val host = Host()
        val owner = OverlayWindowOwner("process-one")
        owner.begin(host)
        add(owner, host)
        val first = owner.openToken()!!
        assertTrue(owner.acceptsOpen(first))
        owner.retire()
        assertFalse(owner.acceptsOpen(first))
        owner.begin(host)
        add(owner, host)
        assertFalse(owner.acceptsOpen(first))
        val nextProcess = OverlayWindowOwner("process-two")
        nextProcess.begin(Host())
        val ticket = nextProcess.claim(OverlayWindowOwner.Role.PET)!!
        nextProcess.install(ticket, { true }, {})
        assertFalse(nextProcess.acceptsOpen(first))
        assertFalse(nextProcess.acceptsOpen(owner.openToken()))
        assertFalse(owner.acceptsOpen(null))
    }

    @Test fun newEngineRejectsLateOldPushAndOldDetach() {
        val producers = OverlayProducerOwner()
        val old = producers.attach()
        val next = producers.attach()
        assertFalse(producers.owns(old))
        assertFalse(producers.detach(old))
        assertTrue(producers.owns(next))
        assertTrue(producers.detach(next))
        assertFalse(producers.detach(next))
        assertFalse(producers.owns(next))
        assertTrue(producers.owns(producers.attach()))
    }

    @Test fun aNewPetTicketInvalidatesThePreviousOpenTokenEvenOnTheSameHost() {
        val owner = OverlayWindowOwner("same-process")
        val host = Host()
        owner.begin(host)
        val (old, _) = add(owner, host)
        val token = owner.openToken()
        owner.remove(old)
        add(owner, host)
        assertFalse(owner.acceptsOpen(token))
    }

    @Test fun removalCannotConfirmBeforeTheNextMainTurnEvenWhenNeverAttached() {
        val queue = ArrayList<() -> Unit>()
        var calls = 0
        val removal = OverlayRemoval({ calls++ }, { true }, queue::add)
        assertFalse(removal.attempt())
        repeat(20) { assertFalse(removal.attempt()) }
        assertEquals(1, calls)
        assertEquals(1, queue.size)
        queue.removeAt(0).invoke()
        assertTrue(removal.attempt())
        assertEquals(1, calls)
    }

    @Test fun aSuccessfulButDeferredRemovalWaitsForActualDetach() {
        val queue = ArrayList<() -> Unit>()
        var attached = true
        var calls = 0
        val removal = OverlayRemoval({ calls++ }, { !attached }, queue::add)
        assertFalse(removal.attempt())
        queue.removeAt(0).invoke()
        assertFalse(removal.attempt())
        assertEquals(2, calls)
        attached = false
        assertFalse(removal.attempt())
        queue.removeAt(0).invoke()
        assertTrue(removal.attempt())
    }

    @Test fun aThrowingRemovalNeverUsesDetachedObservationAsProofByItself() {
        val queue = ArrayList<() -> Unit>()
        var fail = true
        var calls = 0
        val removal = OverlayRemoval({ calls++; if (fail) throw SecurityException("remove refused") }, { true }, queue::add)
        repeat(3) {
            try { removal.attempt(); fail("must propagate") } catch (_: SecurityException) { }
        }
        assertEquals(3, calls)
        assertEquals(0, queue.size)
        fail = false
        assertFalse(removal.attempt())
        assertEquals(4, calls)
        queue.removeAt(0).invoke()
        assertTrue(removal.attempt())
    }

    @Test fun ownershipWaitsForRemovalConfirmationAfterThePhysicalWindowIsGone() {
        val queue = ArrayList<() -> Unit>()
        val owner = OverlayWindowOwner()
        val old = Host()
        val next = Host()
        owner.begin(old)
        val ticket = owner.claim(OverlayWindowOwner.Role.PET)!!
        val view = Window()
        val removal = OverlayRemoval({ old.remove(view) }, { !view.attached && view !in old.registered }, queue::add)
        owner.install(ticket, removal::attempt) { old.add(view) }
        owner.retire()
        assertTrue(old.registered.isEmpty())
        assertEquals(1, owner.pendingRemovals)
        assertFalse(owner.begin(next))
        assertFalse(owner.owns(ticket))
        queue.removeAt(0).invoke()
        owner.retryRemovals()
        assertTrue(owner.begin(next))
        add(owner, next)
        assertEquals(1, next.registered.size)
    }

    @Test fun resettingProducerClearsTargetAndActiveStateUntilFreshPush() {
        val machine = OverlayMachine().apply { enabled = true; alwaysShow = true; canHost = true; hasPet = true }
        machine.onForeground(false, 1_000)
        machine.onPush(PetPush("whale-girl", "working", 1, null, "old-session", "old-host", true, "medium"), 1_001)
        assertEquals(Visibility.SHOWN, machine.decide(1_002).visibility)
        machine.resetProducer()
        assertNull(machine.last)
        assertEquals(Visibility.HIDDEN, machine.decide(1_003).visibility)
        assertEquals(0L, machine.lastActiveAt)
        machine.onPush(PetPush("whale-girl", "working", 1, null, "new-session", "new-host", true, "medium"), 1_004)
        assertEquals("new-session", machine.last?.sessionId)
        assertEquals(Visibility.SHOWN, machine.decide(1_005).visibility)
    }

    @Test fun tenThousandInterleavedHostAndRemovalEventsKeepAtMostOnePet() {
        val random = Random(120027)
        val owner = OverlayWindowOwner()
        val hosts = List(3) { Host() }
        val historical = ArrayList<OverlayWindowOwner.Ticket>()
        var active: OverlayWindowOwner.Ticket? = null
        repeat(10_000) {
            when (random.nextInt(6)) {
                0 -> {
                    val host = hosts[random.nextInt(hosts.size)]
                    if (owner.begin(host)) {
                        val ticket = owner.claim(OverlayWindowOwner.Role.PET)
                        if (ticket != null) {
                            val view = Window()
                            owner.install(ticket, { host.remove(view) }, { host.add(view) })
                            active = ticket
                            historical += ticket
                        }
                    }
                }
                1 -> { owner.retire(); active = null }
                2 -> hosts.forEach { h -> h.registered.forEach { it.attached = true } }
                3 -> hosts[random.nextInt(hosts.size)].holdRemoval = random.nextBoolean()
                4 -> hosts[random.nextInt(hosts.size)].failRemoval = random.nextBoolean()
                5 -> owner.retryRemovals()
            }
            assertTrue("event=$it", hosts.sumOf { it.registered.size } <= 1)
            historical.filter { it != active }.forEach { assertFalse(owner.owns(it)) }
        }
        hosts.forEach { it.holdRemoval = false; it.failRemoval = false }
        owner.retire()
        assertEquals(0, hosts.sumOf { it.registered.size })
    }
}
