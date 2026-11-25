package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.os.Process as AndroidProcess
import android.system.Os
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** Calls production guestRecord, including its capture before the node-name check. */
fun main(args: Array<String>) {
    check(AndroidProcess.myUid() != 0)
    val case = args[1]
    check(case in setOf("guest-capture-retry", "empty-cell-recapture", "capture-serialized-with-reap"))
    val root = Files.createTempDirectory(File(args[0]).toPath(), "capture-").toFile()
    val marker = File(root, "launched.txt")
    val launcher = File(root, "fixture-launcher").apply {
        writeText("#!/bin/sh\nprintf 'started\\n' >> '${marker.path}'\n")
        check(setExecutable(true, true))
    }
    val children = mutableListOf<Process>()
    val attempts = mutableListOf<DshProcess>()
    val methods = mutableListOf<Boolean>()
    fun child(): Process = ProcessBuilder("/bin/sleep", "45").directory(root).apply {
        environment()["DSH_GO_RUNTIME_ROOT"] = root.canonicalPath
    }.start().also {
        children += it
        Os.permittedSignalPids += it.pid().toInt()
        File(root, "tmp").mkdirs()
        File(root, "tmp/dsh-web.pid").writeText(it.pid().toString())
    }
    fun process(): DshProcess = DshProcess(Context(root), RuntimeManifest(launchArgv = listOf(
        launcher.path, "/usr/bin/env", "-i", "{GUEST_ENV}", "startup-probe-command",
    )), root, object : DshProcess.Listener {
        override fun onLog(line: String, stream: String, storageLine: String) { println("[$case] $line") }
        override fun onReady(source: DshProcess, baseUrl: String, token: String) {}
        override fun onStartupFailure(source: DshProcess) {}
        override fun onExit(source: DshProcess, code: Int, expected: Boolean) {}
    }).also(attempts::add)
    val guestRecord = DshProcess::class.java.getDeclaredMethod("guestRecord").apply { isAccessible = true }
    fun capture(owner: DshProcess) { guestRecord.invoke(owner) }
    fun expectBlocked() {
        val next = process()
        val failure = runCatching { next.start(emptyMap(), onLaunchMethod = { methods += it }) }.exceptionOrNull()
        check(failure?.message == "runtime cleanup incomplete; stop the engine and retry") {
            "A new launcher forgot guestRecord's captured identity: $failure"
        }
        next.failStart(failure.message!!)
        next.awaitExit()
        check(methods.isEmpty() && !marker.exists() && Os.sentSignals == 0)
    }
    var lockObserved = false
    try {
        var owned = child()
        val first = process()
        if (case == "capture-serialized-with-reap") {
            val pid = owned.pid().toInt()
            Os.denyStatPids += pid
            val sweepEntered = CountDownLatch(1)
            val releaseSweep = CountDownLatch(1)
            val captureStarted = CountDownLatch(1)
            val captureRead = AtomicBoolean(false)
            val paused = AtomicBoolean(false)
            val failure = AtomicReference<Throwable?>(null)
            val second = process()
            Os.beforeStat = { current ->
                if (current == pid) {
                    if (Thread.currentThread().name == "capture-sweep" && paused.compareAndSet(false, true)) {
                        sweepEntered.countDown()
                        check(releaseSweep.await(5, TimeUnit.SECONDS))
                    }
                    if (Thread.currentThread().name == "capture-writer") {
                        captureRead.set(true)
                        Os.denyStatPids -= pid
                    }
                }
            }
            val sweep = thread(name = "capture-sweep") {
                try { check(!first.killStrays()) } catch (error: Throwable) { failure.set(error) }
            }
            var writer: Thread? = null
            try {
                check(sweepEntered.await(5, TimeUnit.SECONDS))
                writer = thread(name = "capture-writer") {
                    captureStarted.countDown()
                    try { capture(second) } catch (error: Throwable) { failure.set(error) }
                }
                check(captureStarted.await(5, TimeUnit.SECONDS))
                val deadline = System.nanoTime() + 2_000_000_000L
                while (!captureRead.get() && writer.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.sleep(5)
                lockObserved = writer.state == Thread.State.BLOCKED && !captureRead.get()
            } finally {
                releaseSweep.countDown()
                sweep.join(8000)
                writer?.join(8000)
                Os.beforeStat = null
            }
            check(!sweep.isAlive && writer?.isAlive == false) { "Capture/cleanup threads did not exit" }
            failure.get()?.let { throw it }
            check(lockObserved && captureRead.get()) { "guestRecord scanned while another object's cleanup snapshot was held" }
            Os.denyStatPids += pid
        } else {
            capture(first)
            if (case == "empty-cell-recapture") {
                owned.destroyForcibly()
                owned.waitFor()
                val replacement = process()
                replacement.killStrays()
                owned = child()
                capture(first)
            }
            Os.denyStatPids += owned.pid().toInt()
        }
        expectBlocked()
        check(owned.isAlive)
        println("{\"case\":\"$case\",\"uid\":${AndroidProcess.myUid()},\"childAlive\":true," +
            "\"signals\":${Os.sentSignals},\"launches\":0,\"sharedLockObserved\":$lockObserved,\"passed\":true}")
    } finally {
        Os.beforeStat = null
        children.forEach {
            Os.denyStatPids -= it.pid().toInt()
            if (it.isAlive) it.destroyForcibly()
            it.waitFor()
        }
        attempts.forEach { it.stop(); it.awaitExit(12000) }
        println("{\"cleanup\":true,\"childrenGone\":${children.all { !File("/proc/${it.pid()}").exists() }}}")
        root.deleteRecursively()
    }
}
