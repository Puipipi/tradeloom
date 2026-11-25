package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class AutoRestartPolicyTest {
    @Test fun usesThreeDelaysWithinTenMinutes() {
        val now = 1_000_000L
        assertEquals(5_000L, SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, 60_001L, emptyList(), now))
        assertEquals(15_000L, SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, 60_001L, listOf(now - 1), now))
        assertEquals(45_000L, SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, 60_001L, listOf(now - 2, now - 1), now))
        assertNull(SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, 60_001L, listOf(now - 3, now - 2, now - 1), now))
        assertEquals(5_000L, SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, 60_001L, listOf(now - 600_000), now))
    }

    @Test fun rejectsEarlyCleanAndFatalExits() {
        for (up in listOf(null, 0L, 59_999L, 60_000L)) {
            assertNull(SafePolicy.autoRestartDelay(FailureKind.KILLED, 137, up, emptyList(), 1_000_000L))
        }
        assertNull(SafePolicy.autoRestartDelay(FailureKind.KILLED, 0, 90_000L, emptyList(), 1_000_000L))
        for (kind in FailureKind.entries.filter { it != FailureKind.KILLED }) {
            assertNull(SafePolicy.autoRestartDelay(kind, 1, 90_000L, emptyList(), 1_000_000L))
        }
    }
}
