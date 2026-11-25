package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.system.Os
import java.io.File
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real start/cleanup and child process; /proc visibility is limited to this probe's own fixtures. */
fun main(args: Array<String>) {
    val realUid = File("/proc/self/status").readLines().first { it.startsWith("Uid:") }
        .substringAfter(':').trim().substringBefore('\t').trim().toInt()
    check(realUid != 0) { "run as a real non-root OS identity, not just PRoot's displayed root" }
    val base = Files.createTempDirectory(File(args[0]).toPath(), "temp-cleanup-").toFile()
    val case = args[1]
    val context = Context(File(base, "app").apply { mkdirs() })
    val root = File(context.filesDir, "runtime-a").apply { mkdirs() }
    val other = File(context.filesDir, "runtime-b").apply { mkdirs() }
    val outside = File(base, "outside").apply { mkdirs() }
    val sentinel = File(outside, "sentinel").apply { writeText("keep") }
    val backing = File(root, "root/.l2s/persistent").apply { parentFile.mkdirs(); writeText("keep") }
    val temp = File(context.cacheDir, "proot-tmp")
    temp.parentFile.mkdirs()
    if (case == "store-symlink") Files.createSymbolicLink(temp.toPath(), outside.toPath()) else temp.mkdirs()
    val stale = File(temp, "proot-2147483647-abcdef")
    if (case == "candidate-symlink") Files.createSymbolicLink(stale.toPath(), outside.toPath())
    else { stale.mkdirs(); File(stale, "placeholder").writeText("temporary") }
    val unknown = case == "observation-gap"
    val child = ProcessBuilder("/bin/sleep", "45").directory(other).apply {
        if (case == "other-runtime") environment()["DSH_GO_RUNTIME_ROOT"] = other.canonicalPath
        else environment().remove("DSH_GO_RUNTIME_ROOT")
    }.start()
    val pid = child.pid().toInt()
    Os.permittedSignalPids += pid
    // The app in this fixture has one unrelated process. Never inspect/signal the phone's real engine.
    Os.beforeStat = { observed -> if (observed != null && observed != pid && observed != 2147483647) Os.foreignUid += observed }
    if (unknown) Os.denyStatPids += pid
    if (case == "pid-denied") Os.denyStatPids += 2147483647
    val live = File(temp, "proot-$pid-AbC123").apply { mkdirs() }
    val recorded = File(base, "launch-env")
    val warning = "proot error: can't chmod '/fixture/proot-123-abcdef': No such file or directory"
    val launcher = File(base, "launcher").apply {
        writeText("#!/bin/sh\nprintf '%s\\n%s\\n' \"\$TMPDIR\" \"\$PROOT_TMP_DIR\" > '${recorded.path}'\nprintf '%s\\n' \"$warning\" >&2\n")
        check(setExecutable(true, true))
    }
    val logs = Collections.synchronizedList(mutableListOf<String>())
    val done = CountDownLatch(1)
    val runtime = DshProcess(context, RuntimeManifest(launchArgv = listOf(launcher.path)), root, object : DshProcess.Listener {
        override fun onLog(line: String, stream: String, storageLine: String) { logs += line }
        override fun onReady(source: DshProcess, baseUrl: String, token: String) {}
        override fun onStartupFailure(source: DshProcess) {}
        override fun onExit(source: DshProcess, code: Int, expected: Boolean) { check(code == 0); done.countDown() }
    })
    try {
        runtime.start(emptyMap())
        check(done.await(12, TimeUnit.SECONDS)) { "fixture did not exit" }
        runtime.awaitExit(1000)
        val shouldReclaim = case == "stale"
        check(Files.exists(stale.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS) != shouldReclaim) { "incorrect stale-directory outcome for $case" }
        check(live.isDirectory && child.isAlive) { "a live instance's directory or process was removed" }
        check(Os.sentSignals == 0) { "temporary cleanup signalled a process" }
        check(sentinel.readText() == "keep" && backing.readText() == "keep") { "cleanup escaped temporary storage" }
        check(recorded.readLines() == listOf(temp.absolutePath, temp.absolutePath)) { "the PRoot temp path changed" }
        check(warning in logs) { "cleanup warning was hidden" }
        check(logs.any { it.contains("reclaimed 1 stale proot temporary directories") } == shouldReclaim)
        if (case == "store-symlink") check(logs.any { it.contains("proot temporary cleanup incomplete") })
        println("{\"case\":\"$case\",\"nonRootOsIdentity\":true,\"reclaimed\":$shouldReclaim,\"activePreserved\":true,\"warningPreserved\":true}")
    } finally {
        Os.denyStatPids.clear()
        Os.beforeStat = null
        if (child.isAlive) child.destroyForcibly()
        child.waitFor()
        runtime.awaitExit(12000)
        if (case == "store-symlink" || case == "candidate-symlink") Files.delete(if (case == "store-symlink") temp.toPath() else stale.toPath())
        base.deleteRecursively()
    }
}
