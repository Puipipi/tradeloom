package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import android.system.Os
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/** Actual production killStrays; only this probe's own children may be signalled. */
fun main(args: Array<String>) {
    val output = File(args.single()).apply { mkdirs() }
    val scenarios = listOf("readable", "denied-before-capture", "denied-after-capture", "transient-denial", "other-root", "other-uid")
    for (scenario in scenarios) {
        val root = Files.createTempDirectory(output.toPath(), "cleanup-").toFile()
        val childRoot = if (scenario == "other-root") Files.createTempDirectory(output.toPath(), "other-").toFile() else root
        val logs = mutableListOf<String>()
        val child = ProcessBuilder("/bin/sleep", "30").directory(childRoot).apply {
            environment()["DSH_GO_RUNTIME_ROOT"] = childRoot.canonicalPath
        }.start()
        val pid = child.pid().toInt()
        File(root, "tmp").mkdir()
        File(root, "tmp/dsh-web.pid").writeText("$pid\n")
        Os.permittedSignalPids += pid
        Os.deniedReads = 0; Os.sentSignals = 0; Os.signalledPids.clear()
        when (scenario) {
            "denied-before-capture" -> Os.denyStatPids += pid
            "denied-after-capture" -> { Os.denyAfterSignal += pid; Os.ignoreSignals += pid }
            "transient-denial" -> Os.denyOnce += pid
            "other-uid" -> Os.foreignUid += pid
        }
        try {
            val runtime = DshProcess(Context(root), RuntimeManifest(), root, object : DshProcess.Listener {
                override fun onLog(line: String, stream: String, storageLine: String) { logs += line }
                override fun onReady(source: DshProcess, baseUrl: String, token: String) {}
                override fun onStartupFailure(source: DshProcess) {}
                override fun onExit(source: DshProcess, code: Int, expected: Boolean) {}
            })
            val clean = runtime.killStrays()
            if (clean && scenario !in setOf("other-root", "other-uid")) child.waitFor(1, TimeUnit.SECONDS)
            val alive = child.isAlive
            val denied = Os.deniedReads
            val signals = Os.sentSignals
            val blocked = scenario.startsWith("denied-")
            val foreign = scenario in setOf("other-root", "other-uid")
            check(if (blocked) !clean && alive && denied > 0 && logs.any { "observation" in it }
                else if (foreign) clean && alive && signals == 0
                else clean && !alive && signals > 0) { "unexpected cleanup result for $scenario: clean=$clean alive=$alive logs=$logs" }
            if (scenario == "denied-before-capture") check(signals == 0)
            if (scenario == "denied-after-capture") check(signals == 1)
            var recovered: Boolean? = null
            if (blocked) {
                Os.denyStatPids -= pid; Os.denyAfterSignal -= pid; Os.ignoreSignals -= pid
                recovered = runtime.killStrays()
                child.waitFor(1, TimeUnit.SECONDS)
                check(recovered && !child.isAlive) { "captured cleanup did not recover when observation returned" }
            }
            check(Os.signalledPids.all { it == pid })
            println("""{"case":"$scenario","reportedClean":$clean,"childAliveAfterFirst":$alive,"deniedReads":$denied,"signalsBeforeRecovery":$signals,"recovered":$recovered,"diagnosticCount":${logs.size},"pass":true}""")
        } finally {
            Os.denyStatPids -= pid; Os.denyOnce -= pid; Os.denyAfterSignal -= pid; Os.ignoreSignals -= pid; Os.foreignUid -= pid
            if (child.isAlive) child.destroyForcibly()
            child.waitFor()
            Os.permittedSignalPids -= pid
            root.deleteRecursively()
            if (childRoot != root) childRoot.deleteRecursively()
        }
    }
}
