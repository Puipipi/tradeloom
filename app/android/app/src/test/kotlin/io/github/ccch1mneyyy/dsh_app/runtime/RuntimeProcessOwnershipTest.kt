package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class RuntimeProcessOwnershipTest {
    @Test fun capturedCleanupStateIsIsolatedByUidWithinTheSameRoot() {
        val root = "/test/cleanup-scope-${System.nanoTime()}"
        val owner = RuntimeProcessOwnership.cleanupState(root, 101)
        synchronized(owner) { owner.known[10] = "100" }
        val other = RuntimeProcessOwnership.cleanupState(root, 202)
        synchronized(other) { assertTrue(other.known.isEmpty()) }
        synchronized(owner) { assertEquals(mapOf(10 to "100"), owner.known) }
    }

    private class Reader : RuntimeProcessReader {
        val rows = mutableMapOf(10 to 101, 20 to 101)
        val denied = mutableSetOf<String>()
        val reads = mutableListOf<String>()
        var listed: List<Int> = listOf(10, 20)
        var exitOnStat = false
        var state = "S"
        var started = "100"
        private fun read(pid: Int, field: String) {
            reads += "$pid/$field"
            if ("$pid/$field" in denied) throw IOException("controlled observation failure")
        }
        override fun pids(): List<Int> {
            if ("list" in denied) throw IOException("cannot enumerate")
            return listed
        }
        override fun uid(pid: Int): Int? { read(pid, "uid"); return rows[pid] }
        override fun stat(pid: Int): String {
            if (exitOnStat) rows.remove(pid)
            read(pid, "stat")
            val fields = MutableList(20) { "0" }.also { it[0] = state; it[1] = "1"; it[19] = started }
            return "$pid (owned helper) " + fields.joinToString(" ")
        }
        override fun command(pid: Int): String { read(pid, "command"); return "sleep\u000030\u0000" }
        override fun environment(pid: Int): String { read(pid, "environment"); return "DSH_GO_RUNTIME_ROOT=/owned/root\u0000" }
        override fun cwd(pid: Int): String { read(pid, "cwd"); return "/owned/root" }
    }

    @Test fun unreadableUidIsUnknownAndCannotMeanSuccessfulCleanup() {
        val reader = Reader().apply { denied += "10/uid" }
        val snapshot = RuntimeProcessOwnership.scan(reader, 101, 20)
        assertFalse(snapshot.observed)
        assertEquals(setOf(10), snapshot.uncertain)
        assertTrue(snapshot.retired.isEmpty())
        assertTrue(snapshot.records.isEmpty())
    }

    @Test fun enumerationFailureStillInspectsCapturedIdentitiesButIsNotComplete() {
        val reader = Reader().apply { denied += "list" }
        val snapshot = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertTrue(snapshot.enumerationFailed)
        assertFalse(snapshot.observed)
        assertEquals(listOf(10), snapshot.records.map { it.pid })
    }

    @Test fun failedEnumerationWithoutCapturedPidsCannotProveAnEmptyRuntime() {
        val reader = Reader().apply { denied += "list" }
        val unknown = RuntimeProcessOwnership.scan(reader, 101, 20)
        assertTrue(unknown.enumerationFailed)
        assertFalse(unknown.observed)
        assertTrue(unknown.uncertain.isEmpty())
        assertTrue(RuntimeProcessOwnership.owned(unknown.records, setOf("/owned/root"), 20).isEmpty())
        assertTrue(reader.reads.isEmpty())

        // The absent record was an observation gap, not a confirmed exit.
        reader.denied.clear()
        val recovered = RuntimeProcessOwnership.scan(reader, 101, 20)
        assertTrue(recovered.observed)
        assertEquals(listOf(10), RuntimeProcessOwnership.owned(recovered.records, setOf("/owned/root"), 20).map { it.pid })
    }

    @Test fun confirmedCapturedExitDoesNotRepairFailedGlobalEnumeration() {
        val reader = Reader().apply { denied += "list"; rows.remove(10) }
        val incomplete = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertEquals(setOf(10), incomplete.retired)
        assertTrue(incomplete.records.isEmpty())
        assertFalse(incomplete.observed)

        reader.denied.clear()
        reader.listed = listOf(20)
        val complete = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertTrue(complete.observed)
        assertEquals(setOf(10), complete.retired)
        assertTrue(complete.records.isEmpty())
    }

    @Test fun aKnownPidOmittedFromEnumerationIsExplicitlyRead() {
        val reader = Reader().apply { listed = emptyList() }
        val alive = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertEquals(listOf(10), alive.records.map { it.pid })
        assertTrue(alive.observed)
        reader.rows.remove(10)
        val gone = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertEquals(setOf(10), gone.retired)
        assertTrue(gone.observed)
    }

    @Test fun missingStatMustNotRetireAStillExistingPid() {
        val reader = Reader().apply { denied += "10/stat" }
        val unknown = RuntimeProcessOwnership.scan(reader, 101, 20)
        assertEquals(setOf(10), unknown.uncertain)
        assertTrue(unknown.retired.isEmpty())
        reader.exitOnStat = true
        val gone = RuntimeProcessOwnership.scan(reader, 101, 20)
        assertEquals(setOf(10), gone.retired)
        assertTrue(gone.observed)
    }

    @Test fun partialOwnershipReadsStayVisibleButBlockCompletion() {
        for (field in listOf("command", "environment", "cwd")) {
            val reader = Reader().apply { denied += "10/$field" }
            val snapshot = RuntimeProcessOwnership.scan(reader, 101, 20)
            assertFalse(snapshot.observed)
            assertEquals(setOf(10), snapshot.uncertain)
            assertEquals(listOf(10), RuntimeProcessOwnership.owned(snapshot.records, setOf("/owned/root"), 20).map { it.pid })
        }
    }

    @Test fun confirmedOtherUidIsNeverReadAsAnOwnedProcess() {
        val reader = Reader().apply { rows[10] = 202 }
        val snapshot = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertTrue(snapshot.observed)
        assertEquals(setOf(10), snapshot.retired)
        assertEquals(listOf("10/uid"), reader.reads)
    }

    @Test fun transientObservationFailureCanRecoverWithoutGuessingItExited() {
        val reader = Reader().apply { denied += "10/uid" }
        assertFalse(RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10)).observed)
        reader.denied.clear()
        val recovered = RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10))
        assertTrue(recovered.observed)
        assertEquals("100", recovered.records.single().started)
    }

    @Test fun zombiesAreRetiredAndReusedPidsDoNotMatchCapturedIdentity() {
        val reader = Reader().apply { state = "Z" }
        assertEquals(setOf(10), RuntimeProcessOwnership.scan(reader, 101, 20, setOf(10)).retired)
        reader.state = "S"
        reader.started = "200"
        val live = RuntimeProcessOwnership.scan(reader, 101, 20)
        val unrelated = live.records.map { it.copy(marker = null, cwd = "/other/root") }
        assertTrue(RuntimeProcessOwnership.owned(unrelated, setOf("/owned/root"), 20, mapOf(10 to "100")).isEmpty())
    }
}
