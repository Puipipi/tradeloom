package io.github.ccch1mneyyy.dsh_app.media

import org.junit.Assert.*
import org.junit.Test

class MediaPermissionQueueTest {
    @Test fun onePromptGrantsEverySaveOnceInAdmissionOrder() {
        val queue = MediaPermissionQueue()
        val events = mutableListOf<String>()
        val owner = queue.owner
        assertTrue(queue.enqueue(owner, { events.add("a") }, { fail("a denied") }))
        assertFalse(queue.enqueue(owner, { events.add("b") }, { fail("b denied") }))
        queue.resolve(true)
        queue.resolve(true)
        assertEquals(listOf("a", "b"), events)
        assertFalse(queue.waiting)
    }

    @Test fun denialCompletesAllAndAllowsFreshUserRequest() {
        val queue = MediaPermissionQueue()
        val events = mutableListOf<String>()
        repeat(2) { n -> queue.enqueue(queue.owner, { fail("unexpected retry") }, { events.add("denied$n") }) }
        queue.resolve(false)
        assertEquals(listOf("denied0", "denied1"), events)
        assertTrue(queue.enqueue(queue.owner, { events.add("new") }, { fail("new denied") }))
        queue.resolve(true)
        assertEquals(listOf("denied0", "denied1", "new"), events)
    }

    @Test fun finalDetachRejectsQueuedAndLateWorkerOwner() {
        val queue = MediaPermissionQueue()
        val old = queue.owner
        val events = mutableListOf<String>()
        repeat(2) { n -> queue.enqueue(old, { fail("retired retry") }, { events.add("denied$n") }) }
        queue.retire()
        assertFalse(queue.enqueue(old, { fail("late retry") }, { events.add("late denied") }))
        assertFalse(queue.waiting)
        assertTrue(queue.enqueue(queue.owner, { events.add("new") }, { fail("new denied") }))
        queue.resolve(true)
        assertEquals(listOf("denied0", "denied1", "late denied", "new"), events)
    }

    @Test fun resolutionClearsOldBatchBeforeCallbacksCanEnqueueNextBatch() {
        val queue = MediaPermissionQueue()
        val events = mutableListOf<String>()
        queue.enqueue(queue.owner, {
            assertFalse(queue.waiting)
            assertTrue(queue.enqueue(queue.owner, { events.add("next") }, { fail("next denied") }))
            events.add("first")
        }, { fail("first denied") })
        queue.resolve(true)
        assertEquals(listOf("first"), events)
        assertTrue(queue.waiting)
        queue.resolve(true)
        assertEquals(listOf("first", "next"), events)
    }

    @Test fun unchangedOwnerCanJoinDuringActivityConfigurationGap() {
        val queue = MediaPermissionQueue()
        val owner = queue.owner
        var retried = 0
        assertTrue(queue.enqueue(owner, { retried++ }, { fail("denied") }))
        // Config detach only changes the Activity binding, not this queue or its owner.
        assertSame(owner, queue.owner)
        assertFalse(queue.enqueue(owner, { retried++ }, { fail("denied") }))
        queue.resolve(true)
        assertEquals(2, retried)
    }
}
