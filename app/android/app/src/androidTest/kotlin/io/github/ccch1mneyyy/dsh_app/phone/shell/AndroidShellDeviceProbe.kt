package io.github.ccch1mneyyy.dsh_app.phone.shell

import android.os.Process

/** Standalone app_process probe. Uses only synthetic commands and does not install/grant anything. */
object AndroidShellDeviceProbe {
    @JvmStatic fun main(args: Array<String>) {
        val output = java.io.PrintStream(java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8")
        try { run(args, output) } catch (error: Throwable) {
            error.printStackTrace(output)
            kotlin.system.exitProcess(1)
        }
    }

    private fun run(args: Array<String>, output: java.io.PrintStream) {
        check(Process.myUid() == 2000)
        val classpath = args.single()
        var count = 0
        fun done(core: ShellJobCore, id: String): Map<String, Any?> {
            val deadline = System.nanoTime() + 10_000_000_000L
            while (System.nanoTime() < deadline) {
                val result = core.poll(id)
                if (result["done"] == true) return result
                Thread.sleep(20)
            }
            error("Probe did not finish: $id")
        }
        fun test(name: String, body: (ShellJobCore) -> Unit) {
            val core = ShellJobCore { command, timeout -> AndroidShellProcess(command, timeout, classpath) }
            try { output.println("RUN $name"); body(core); count++; output.println("PASS $name") } finally { core.destroy() }
        }
        test("split-streams-and-real-exit") { core ->
            core.start("exit", "printf ok; printf err >&2; exit 7", 5000)
            val r = done(core, "exit")
            check(r["started"] == true && r["exitCode"] == 7 && r["errorCode"] == null) { r.toString() }
            check(r["stdout"] == "ok" && r["stderr"] == "err") { r.toString() }
        }
        test("utf8") { core ->
            core.start("unicode", "printf '\u6d4b\u8bd5\ud83d\ude00'", 5000)
            check(done(core, "unicode")["stdout"] == "\u6d4b\u8bd5\ud83d\ude00")
        }
        test("bounded-parallel-drain") { core ->
            core.start("cap", "(head -c 90000 /dev/zero | tr '\\000' x) & (head -c 90000 /dev/zero | tr '\\000' y >&2) & wait", 8000)
            val r = done(core, "cap")
            check(r["exitCode"] == 0 && r["truncated"] == true && r["errorCode"] == null) {
                r.filterKeys { it !in setOf("stdout", "stderr") }.toString()
            }
            check((r["stdout"] as String).toByteArray().size + (r["stderr"] as String).toByteArray().size <= ShellProtocol.MAX_OUTPUT_BYTES)
            check(core.poll("cap") == r)
        }
        test("deadline") { core ->
            core.start("timeout", "sleep 20", 1200)
            val r = done(core, "timeout")
            check(r["timedOut"] == true && r["errorCode"] == "timeout") { r.toString() }
        }
        test("cancel-and-cancel-before-start") { core ->
            core.cancel("not-started")
            check(core.start("not-started", "printf forbidden", 5000)["errorCode"] == "cancelled")
            core.start("cancel", "sleep 20", 8000)
            val end = System.nanoTime() + 5_000_000_000L
            while (core.poll("cancel")["started"] != true && System.nanoTime() < end) Thread.sleep(20)
            check(core.poll("cancel")["started"] == true)
            core.cancel("cancel")
            val r = done(core, "cancel")
            check(r["cancelled"] == true && r["errorCode"] == "cancelled") { r.toString() }
        }
        output.println("ANDROID_SHELL_PROBE_OK tests=$count uid=${Process.myUid()}")
    }
}
