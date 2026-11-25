package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.util.concurrent.*
import kotlin.concurrent.thread

class RuntimeLogsTest {
    private class Fixture : AutoCloseable {
        val dir = Files.createTempDirectory("runtime-logs-test").toFile()
        val file = File(dir, "logs/dsh.log")
        val writer = ScheduledThreadPoolExecutor(1)
        val main = LinkedBlockingQueue<() -> Unit>()
        val delivered = mutableListOf<RuntimeLogs.Entry>()
        val logs = RuntimeLogs(file, { 123L }, { main.add(it) }, { delivered.addAll(it) }, writer)
        fun flush() { logs.flush().get(10, TimeUnit.SECONDS) }
        fun drainMain() { while (true) (main.poll() ?: return).invoke() }
        fun saved() = listOf(File(file.path + ".1"), file).filter { it.exists() }.flatMap { it.readLines() }
        fun hold(): CountDownLatch {
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            writer.execute { entered.countDown(); release.await() }
            assertTrue(entered.await(2, TimeUnit.SECONDS)); return release
        }
        override fun close() { writer.shutdownNow(); writer.awaitTermination(2, TimeUnit.SECONDS); dir.deleteRecursively() }
    }

    @Test fun normalTenThousandRotatePreserveAllBytesAndOneMainPost() = Fixture().use { f ->
        val hold = f.hold()
        val raw = List(10_000) { "[engine] item=$it token=SYNTHETIC_SECRET_$it " + "x".repeat(220) }
        raw.forEachIndexed { i, line -> f.logs.accept(line, if (i % 2 == 0) "stdout" else "stderr") }
        val done = f.logs.flush(); hold.countDown(); done.get(5, TimeUnit.SECONDS)
        val expected = raw.map(CrashClassifier::redact)
        assertEquals(expected, f.saved()); assertEquals(2_558_890L, File(f.file.path + ".1").length() + f.file.length())
        assertEquals(0L to 0L, f.logs.dropped()); assertEquals(1, f.main.size)
        f.drainMain(); assertEquals(expected, f.delivered.map { it.line })
        assertEquals((1L..10_000L).toList(), f.delivered.map { it.seq })
        assertEquals(2000, f.logs.snapshot(2000).entries.size)
    }

    @Test fun redactsBeforeRingDiskAndDeliveryAndStampsOnlySystem() = Fixture().use { f ->
        f.logs.accept("token=SYNTHETIC_SECRET", "system"); f.logs.accept("hello", "stdout"); f.flush(); f.drainMain()
        val lines = f.logs.recent(10)
        assertEquals("[mono=123ms] ${CrashClassifier.redact("token=SYNTHETIC_SECRET")}", lines[0])
        assertEquals("hello", lines[1]); assertEquals(lines, f.saved()); assertEquals(lines, f.delivered.map { it.line })
        assertFalse(lines.joinToString().contains("SYNTHETIC_SECRET"))
    }

    @Test fun fullRulesMaskDiskWhileLiveUsesTheSameCredentialTokenNames() = Fixture().use { f ->
        val raw = listOf(
            "\u001B[32mBasic setup\u001B[0m",
            "API_KEY=SYNTHETIC_VALUE password='synthetic phrase, tail' token=SYNTHETIC_TOKEN",
            "oauth_token=sampleXY x_auth_token=sampleXY gh_token=sampleXY bot_token=sampleXY next_token=page-cursor-123",
        )
        raw.forEach { f.logs.accept(it, "stderr") }
        f.flush(); f.drainMain()
        val live = listOf(raw[0], "API_KEY=SYNTHETIC_VALUE password='synthetic phrase, tail' token=•••",
            "oauth_token=••• x_auth_token=••• gh_token=••• bot_token=••• next_token=page-cursor-123")
        assertEquals(live, f.logs.recent(10))
        assertEquals(live, f.logs.snapshot(10).entries.map { it.line })
        assertEquals(live, f.delivered.map { it.line })
        assertEquals(listOf("Basic •••", "API_KEY=••• password='•••' token=•••", live[2]), f.saved())
        assertEquals(listOf(1L, 2L, 3L), f.delivered.map { it.seq })
    }

    @Test fun streamPrivateKeyStateOnlyChangesTheDiskCopy() = Fixture().use { f ->
        val redactor = LogRedactor()
        val begin = "-----BEGIN " + "PRIVATE KEY-----"
        val end = "-----END " + "PRIVATE KEY-----"
        val raw = listOf(begin, "SYNTHETIC-PRIVATE-MATERIAL", end, "done")
        raw.forEach { f.logs.accept(it, "stdout", redactor.line(it)) }
        f.flush(); f.drainMain()
        assertEquals(raw, f.logs.recent(10))
        assertEquals(raw, f.delivered.map { it.line })
        assertEquals(listOf(begin, "•••", end, "done"), f.saved())
    }

    @Test fun concurrentAdmissionHasOneOrderAndSnapshotCutoff() = Fixture().use { f ->
        val hold = f.hold()
        val threads = List(4) { p -> thread { repeat(400) { f.logs.accept("$p:$it", "stdout") } } }
        while (threads.any { it.isAlive }) {
            val snapshot = f.logs.snapshot(2000)
            assertEquals((1L..snapshot.throughSeq).toList(), snapshot.entries.map { it.seq })
        }
        threads.forEach { it.join() }; val snapshot = f.logs.snapshot(2000)
        hold.countDown(); f.flush(); f.drainMain()
        assertEquals(1600L, snapshot.throughSeq); assertEquals(snapshot.entries.map { it.line }, f.saved())
        assertEquals(snapshot.entries, f.delivered); assertEquals(0L to 0L, f.logs.dropped())
    }

    @Test fun emptySnapshotAndTailDoNotResetSequence() = Fixture().use { f ->
        assertEquals(0L, f.logs.snapshot(0).throughSeq)
        f.logs.accept("one", "stdout"); val old = f.logs.snapshot(1)
        f.logs.accept("two", "stderr"); assertEquals(listOf("one"), old.entries.map { it.line })
        assertEquals(2L, f.logs.snapshot(0).throughSeq); assertTrue(f.logs.snapshot(0).entries.isEmpty())
        assertEquals(listOf("two"), f.logs.snapshot(1).entries.map { it.line }); f.flush()
    }

    @Test fun firstDeadlineDoesNotSlideAndBlockedMainGetsOnlyOnePost() = Fixture().use { f ->
        val start = System.nanoTime(); f.logs.accept("first", "stdout")
        Thread.sleep(60); f.logs.accept("second", "stdout")
        val runnable = f.main.poll(100, TimeUnit.MILLISECONDS)
        assertNotNull(runnable); val elapsed = (System.nanoTime() - start) / 1_000_000
        assertTrue("timer fired too early: $elapsed", elapsed >= 75)
        assertTrue("deadline slid: $elapsed", elapsed < 155)
        f.logs.accept("third", "stdout"); Thread.sleep(130)
        assertEquals(0, f.main.size); runnable!!.invoke(); assertEquals(3, f.delivered.size)
        f.flush()
    }

    @Test fun overloadRetainsTailWithBoundedQueueAndNoWarningLoop() = Fixture().use { f ->
        val hold = f.hold(); repeat(20_010) { f.logs.accept("line-$it", "stdout") }
        assertEquals(10L to 10L, f.logs.dropped())
        hold.countDown(); f.flush(); f.drainMain()
        assertEquals((10 until 20_010).map { "line-$it" }, f.saved())
        assertEquals(f.saved(), f.delivered.map { it.line })
        assertTrue(f.logs.recent(1).single().contains("log queue dropped: disk=10 delivery=10"))
        f.flush(); assertEquals(10L to 10L, f.logs.dropped())
    }

    @Test fun fullDiskLimitDoesNotChangeTheLiveQueueByteLimit() = Fixture().use { f ->
        val hold = f.hold()
        f.logs.accept("x".repeat(8 * 1024 * 1024), "stdout")
        f.logs.accept("tail", "stdout")
        hold.countDown(); f.flush(); f.drainMain()
        assertEquals(0L to 1L, f.logs.dropped())
        assertEquals("x".repeat(2000) + "…", f.saved()[0])
        assertEquals("tail", f.saved()[1]); assertEquals(3, f.saved().size)
        assertTrue(f.saved()[2].contains("disk=0 delivery=1"))
        assertEquals(f.saved().drop(1), f.delivered.map { it.line })
    }

    @Test fun utf8ByteBudgetEvictsOldestEvenBelowLineLimit() = Fixture().use { f ->
        val hold = f.hold(); val body = "界".repeat(500_000)
        repeat(9) { f.logs.accept("$it:$body", "stdout") }
        assertEquals(0L to 4L, f.logs.dropped()); hold.countDown(); f.flush(); f.drainMain()
        assertEquals((5L..9L).toList(), f.delivered.filter { it.stream == "stdout" }.map { it.seq })
        assertTrue(f.delivered.last().line.contains("disk=0 delivery=4"))
        assertEquals((0..8).map { "$it:" + "界".repeat(1998) + "…" }, f.saved().dropLast(1))
    }

    @Test fun deliveryOverflowIndependentOfDiskAndWarningIsOrdered() = Fixture().use { f ->
        repeat(3) { batch -> repeat(8000) { f.logs.accept("$batch:$it", "stdout") }; f.flush() }
        assertEquals(0L, f.logs.dropped().first); assertTrue(f.logs.dropped().second > 0)
        assertEquals(1, f.main.size); f.drainMain()
        assertTrue(f.delivered.zipWithNext().all { (a,b) -> a.seq < b.seq })
        assertTrue(f.saved().any { it.contains("log queue dropped: disk=0 delivery=") })
    }

    @Test fun fileFailureDoesNotKillWriterAndFlushMeansAttempted() = Fixture().use { f ->
        f.file.parentFile!!.mkdirs(); f.file.mkdir()
        f.logs.accept("failed", "stdout"); f.flush()
        f.file.delete(); f.logs.accept("recovered", "stdout"); f.flush()
        assertEquals(listOf("recovered"), f.saved())
    }

    @Test fun resetBarrierDiscardsOldQueueKeepsNewAndSequence() = Fixture().use { f ->
        val hold = f.hold(); f.logs.accept("old", "stdout")
        assertTrue(f.logs.pauseDisk()); f.file.parentFile!!.deleteRecursively()
        f.logs.accept("during-reset", "stdout"); hold.countDown()
        Thread.sleep(130); assertFalse(f.file.exists())
        f.logs.resumeDisk(); f.flush(); assertEquals(listOf("during-reset"), f.saved())
        assertEquals(listOf("old", "during-reset"), f.logs.recent(10)); assertEquals(2L, f.logs.snapshot(0).throughSeq)
    }

    private fun blockRealWrite(f: Fixture): Thread {
        f.file.parentFile!!.mkdirs()
        assertEquals(0, ProcessBuilder("mkfifo", f.file.path).start().waitFor())
        f.logs.accept("blocked", "stdout"); f.logs.flush()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (System.nanoTime() < deadline) {
            val worker = Thread.getAllStackTraces().entries.firstOrNull { (_, frames) ->
                frames.any { it.className == "java.io.FileOutputStream" && it.methodName == "open0" }
            }?.key
            if (worker != null) return worker
            Thread.yield()
        }
        error("actual FIFO writer never blocked")
    }

    @Test fun successfulResetWaitsForActualOpenWriteThenUsesNewDirectory() = Fixture().use { f ->
        blockRealWrite(f); var paused = false
        val pauser = thread { paused = f.logs.pauseDisk() }
        Thread.sleep(30); assertTrue(pauser.isAlive)
        val reader = thread { FileInputStream(f.file).use { it.readBytes() } }
        pauser.join(2000); reader.join(2000); assertFalse(pauser.isAlive); assertTrue(paused)
        val retired = File(f.dir, "retired")
        assertTrue(f.file.parentFile!!.renameTo(retired)); retired.deleteRecursively()
        f.logs.accept("new directory", "stdout"); f.logs.resumeDisk(); f.flush()
        assertEquals(listOf("new directory"), f.saved()); assertFalse(retired.exists())
    }

    @Test fun resetTimeoutResumesAndLateWriterCannotPauseAgain() = Fixture().use { f ->
        blockRealWrite(f)
        val start = System.nanoTime(); assertFalse(f.logs.pauseDisk())
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) >= 4900)
        f.logs.resumeDisk()
        val reader = thread { FileInputStream(f.file).use { it.readBytes() } }
        f.flush(); reader.join(2000); assertFalse(reader.isAlive)
        f.file.delete(); f.logs.accept("after-timeout", "stdout"); f.flush()
        assertEquals(listOf("after-timeout"), f.saved())
    }

    @Test fun stopTailFlushIsImmediateAndLoggerSurvivesNextRun() = Fixture().use { f ->
        f.logs.accept("last stdout", "stdout"); f.logs.accept("DSH exited", "system"); f.flush()
        assertEquals(listOf("last stdout", "[mono=123ms] DSH exited"), f.saved())
        f.logs.accept("next run", "stdout"); f.flush(); assertEquals("next run", f.saved().last())
    }
}
