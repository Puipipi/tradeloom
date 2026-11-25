package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.os.Process as AndroidProcess
import android.system.Os
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Production launcher replacement: canonical scope, isolation and retirement. */
fun main(args: Array<String>) {
    check(AndroidProcess.myUid() != 0)
    val case = args[1]
    check(case in setOf("alias-captured", "other-root-isolated", "exited-retry", "foreign-uid-retired"))
    val base = Files.createTempDirectory(File(args[0]).toPath(), "scope-").toFile()
    val root = File(base, "runtime").apply { mkdirs() }
    val other = File(base, "other").apply { mkdirs() }
    val alias = File(base, "alias")
    Files.createSymbolicLink(alias.toPath(), root.toPath())
    for (directory in listOf(root, other)) {
        File(directory, "fixture-launcher").apply {
            writeText("#!/bin/sh\nprintf 'started\\n' >> '${File(directory, "launched.txt").path}'\n")
            check(setExecutable(true, true))
        }
    }
    val child = ProcessBuilder("/bin/sleep", "45").directory(root).apply {
        environment()["DSH_GO_RUNTIME_ROOT"] = root.canonicalPath
    }.start()
    val pid = child.pid().toInt()
    val started = RuntimeProcessOwnership.stat(File("/proc/$pid/stat").readText())!!.second
    Os.permittedSignalPids += pid
    Os.ignoreSignals += pid
    Os.denyAfterSignal += pid
    val attempts = mutableListOf<DshProcess>()
    val decisions = mutableListOf<Boolean>()
    val methods = mutableListOf<Boolean>()
    fun launch(directory: File): Boolean {
        val done = CountDownLatch(1)
        val process = DshProcess(Context(directory), RuntimeManifest(launchArgv = listOf(
            File(directory, "fixture-launcher").path, "/usr/bin/env", "-i", "{GUEST_ENV}", "startup-probe-command",
        )), directory, object : DshProcess.Listener {
            override fun onLog(line: String, stream: String, storageLine: String) { println("[$case] $line") }
            override fun onReady(source: DshProcess, baseUrl: String, token: String) {}
            override fun onStartupFailure(source: DshProcess) {}
            override fun onExit(source: DshProcess, code: Int, expected: Boolean) { done.countDown() }
        })
        attempts += process
        val failure = runCatching {
            process.start(emptyMap(), onLaunchMethod = { methods += it })
        }.exceptionOrNull()
        if (failure != null) {
            check(failure.message == "runtime cleanup incomplete; stop the engine and retry") { failure }
            process.failStart(failure.message!!)
            process.awaitExit()
        } else {
            check(done.await(12, TimeUnit.SECONDS)) { "Fixture launcher did not exit" }
            process.awaitExit(1000)
        }
        return (failure == null).also(decisions::add)
    }
    try {
        check(!launch(root)) { "First launch must capture and retain the live child" }
        check(Os.sentSignals > 0 && child.isAlive)
        val capturedSignals = Os.sentSignals
        when (case) {
            "alias-captured" -> {
                check(alias.canonicalPath == root.canonicalPath)
                check(!launch(alias)) { "A spelling alias forgot a captured identity" }
            }
            "other-root-isolated" -> {
                check(launch(other)) { "Another root inherited an unrelated captured identity" }
                check(!launch(root)) { "Launching another root erased the original ownership" }
            }
            "exited-retry" -> {
                child.destroyForcibly()
                child.waitFor()
                check(!File("/proc/$pid").exists())
                Os.denyStatPids -= pid
                check(launch(root)) { "A confirmed exited identity still blocked startup" }
            }
            "foreign-uid-retired" -> {
                Os.denyStatPids -= pid
                Os.foreignUid += pid
                check(launch(root)) { "A confirmed other UID was not retired" }
            }
        }
        check(Os.sentSignals == capturedSignals) { "Replacement signalled an unobservable or other-UID process" }
        if (case != "exited-retry") {
            check(child.isAlive && RuntimeProcessOwnership.stat(File("/proc/$pid/stat").readText())?.second == started)
        }
        val expectedLaunches = if (case == "alias-captured") 0 else 1
        check(methods == List(expectedLaunches) { false })
        val launchCount = listOf(root, other).sumOf { directory ->
            File(directory, "launched.txt").takeIf { it.isFile }?.readLines()?.size ?: 0
        }
        check(launchCount == expectedLaunches)
        println("{\"case\":\"$case\",\"uid\":${AndroidProcess.myUid()},\"pid\":$pid," +
            "\"started\":\"$started\",\"decisions\":$decisions,\"methods\":$methods," +
            "\"signals\":${Os.sentSignals},\"launches\":$launchCount,\"passed\":true}")
    } finally {
        Os.denyStatPids -= pid
        Os.ignoreSignals -= pid
        Os.denyAfterSignal -= pid
        Os.foreignUid -= pid
        if (child.isAlive) child.destroyForcibly()
        child.waitFor()
        attempts.forEach { it.stop(); it.awaitExit(12000) }
        println("{\"cleanup\":true,\"childGone\":${!File("/proc/$pid").exists()}}")
        alias.delete()
        base.deleteRecursively()
    }
}
