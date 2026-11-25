package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.os.Process as AndroidProcess
import android.system.Os
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Two production process objects, following RuntimeController's failed-start disposal order. */
fun main(args: Array<String>) {
    check(AndroidProcess.myUid() != 0) { "This probe requires an actual non-root UID" }
    val base = File(args[0])
    val captured = args[1] == "captured-retry"
    check(captured || args[1] == "ambient-retry")
    val root = Files.createTempDirectory(base.toPath(), "runtime-").toFile()
    val other = Files.createTempDirectory(base.toPath(), "other-").toFile()
    val marker = File(root, "launched.txt")
    val launcher = File(root, "fixture-launcher").apply {
        writeText("#!/bin/sh\nprintf 'started\\n' >> '${marker.path}'\n")
        check(setExecutable(true, true))
    }
    val child = ProcessBuilder("/bin/sleep", "45").directory(if (captured) root else other).apply {
        if (captured) environment()["DSH_GO_RUNTIME_ROOT"] = root.canonicalPath
        else environment().remove("DSH_GO_RUNTIME_ROOT")
    }.start()
    val pid = child.pid().toInt()
    val started = RuntimeProcessOwnership.stat(File("/proc/$pid/stat").readText())!!.second
    Os.permittedSignalPids += pid
    if (captured) {
        Os.ignoreSignals += pid
        Os.denyAfterSignal += pid
    } else Os.denyStatPids += pid
    data class Attempt(val process: DshProcess, val logs: MutableList<String>,
                       val methods: MutableList<Boolean>, val exits: MutableList<Int>,
                       val done: CountDownLatch)
    fun newAttempt(): Attempt {
        val logs = Collections.synchronizedList(mutableListOf<String>())
        val methods = Collections.synchronizedList(mutableListOf<Boolean>())
        val exits = Collections.synchronizedList(mutableListOf<Int>())
        val done = CountDownLatch(1)
        val process = DshProcess(Context(root), RuntimeManifest(launchArgv = listOf(
            launcher.path, "/usr/bin/env", "-i", "{GUEST_ENV}", "startup-probe-command",
        )), root, object : DshProcess.Listener {
            override fun onLog(line: String, stream: String, storageLine: String) { logs += line }
            override fun onReady(source: DshProcess, baseUrl: String, token: String) {}
            override fun onStartupFailure(source: DshProcess) {}
            override fun onExit(source: DshProcess, code: Int, expected: Boolean) {
                exits += code
                done.countDown()
            }
        })
        return Attempt(process, logs, methods, exits, done)
    }
    val attempts = mutableListOf<Attempt>()
    fun launch(attempt: Attempt): Throwable? {
        val failure = runCatching {
            attempt.process.start(emptyMap(), directEngine = false,
                onLaunchMethod = { attempt.methods += it })
        }.exceptionOrNull()
        if (failure == null) {
            check(attempt.done.await(12, TimeUnit.SECONDS)) { "Fixture launch did not exit" }
            attempt.process.awaitExit(1000)
        }
        return failure
    }
    fun quoted(text: String): String = "\"" + text.replace("\\", "\\\\")
        .replace("\"", "\\\"").replace("\n", "\\n") + "\""
    fun strings(values: List<String>): String = values.joinToString(",", "[", "]", transform = ::quoted)
    try {
        val first = newAttempt().also(attempts::add)
        var controllerReference: DshProcess? = first.process
        val firstFailure = launch(first)
        val firstSignalCount = Os.sentSignals
        if (firstFailure != null) {
            // RuntimeController's startProcess catch executes these production
            // methods and then drops its object reference. The controller itself
            // is not instantiated by this bounded JVM probe.
            controllerReference?.failStart(firstFailure.message ?: firstFailure.javaClass.simpleName)
            controllerReference?.awaitExit()
        }
        controllerReference = null
        val sameIdentityBeforeRetry = child.isAlive &&
            RuntimeProcessOwnership.stat(File("/proc/$pid/stat").readText())?.second == started
        val second = newAttempt().also(attempts::add)
        controllerReference = second.process
        val secondFailure = launch(second)
        val secondSignalCount = Os.sentSignals - firstSignalCount
        val sameIdentityAfterRetry = child.isAlive &&
            RuntimeProcessOwnership.stat(File("/proc/$pid/stat").readText())?.second == started
        val firstCleanup = first.process.killStrays()
        val secondCleanup = second.process.killStrays()
        val errors = mutableListOf<String>()
        fun expect(value: Boolean, message: String) { if (!value) errors += message }
        expect(sameIdentityBeforeRetry && sameIdentityAfterRetry, "Fixture process identity changed")
        expect(!firstCleanup && !secondCleanup, "Observation failure was misreported as cleanup success")
        if (captured) {
            expect(firstFailure?.message == "runtime cleanup incomplete; stop the engine and retry",
                "The first captured-identity launch was not refused")
            expect(firstSignalCount > 0, "No production signal attempt captured the original identity")
            expect(secondFailure?.message == "runtime cleanup incomplete; stop the engine and retry",
                "A new process object forgot the captured living identity and allowed PRoot")
            expect(first.methods.isEmpty() && second.methods.isEmpty() && !marker.exists(),
                "A captured, unretired identity reached a callback or launch")
        } else {
            expect(firstFailure == null && secondFailure == null,
                "Unrelated ambient uncertainty blocked default PRoot")
            expect(Os.sentSignals == 0, "An unrelated process received a signal")
            expect(first.methods == listOf(false) && second.methods == listOf(false),
                "The actual default mode was not reported")
        }
        println("{" + listOf(
            "\"case\":${quoted(args[1])}", "\"uid\":${AndroidProcess.myUid()}",
            "\"childPid\":$pid", "\"childStarted\":${quoted(started)}",
            "\"firstFailure\":${firstFailure?.message?.let(::quoted) ?: "null"}",
            "\"secondFailure\":${secondFailure?.message?.let(::quoted) ?: "null"}",
            "\"firstSignals\":$firstSignalCount", "\"secondSignals\":$secondSignalCount",
            "\"sameIdentityBeforeRetry\":$sameIdentityBeforeRetry",
            "\"sameIdentityAfterRetry\":$sameIdentityAfterRetry",
            "\"firstCleanupComplete\":$firstCleanup", "\"secondCleanupComplete\":$secondCleanup",
            "\"firstMethods\":${first.methods}", "\"secondMethods\":${second.methods}",
            "\"secondIsNewObject\":${controllerReference !== first.process}",
            "\"launchMarkerLines\":${if (marker.isFile) marker.readLines().size else 0}",
            "\"firstLogs\":${strings(first.logs.toList())}",
            "\"secondLogs\":${strings(second.logs.toList())}",
            "\"errors\":${strings(errors)}",
        ).joinToString(",") + "}")
        check(errors.isEmpty()) { errors.joinToString("; ") }
    } finally {
        Os.denyStatPids -= pid
        Os.ignoreSignals -= pid
        Os.denyAfterSignal -= pid
        if (child.isAlive) child.destroyForcibly()
        child.waitFor()
        attempts.forEach { it.process.stop(); it.process.awaitExit(12000) }
        println("{\"cleanup\":true,\"childGone\":${!File("/proc/$pid").exists()},\"uid\":${AndroidProcess.myUid()}}")
        root.deleteRecursively()
        other.deleteRecursively()
    }
}
