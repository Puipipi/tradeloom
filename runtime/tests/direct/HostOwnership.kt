package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException

/** Linux adapter for the production pure ownership classifier, not an Android signal mock. */
fun main(args: Array<String>) {
    require(args.size in 1..2) { "rootfs [pid:started,...]" }
    val root = File(args[0]).canonicalPath
    val self = ProcessHandle.current()
    val excluded = mutableSetOf<Int>()
    var ancestor: ProcessHandle? = self
    while (ancestor != null && excluded.add(ancestor.pid().toInt())) ancestor = ancestor.parent().orElse(null)
    val uid = Files.getAttribute(File("/proc/self").toPath(), "unix:uid") as Int
    val known = args.getOrNull(1).orEmpty().split(',').filter { it.isNotEmpty() }.associate {
        val pair = it.split(':', limit = 2); pair[0].toInt() to pair[1]
    }
    val reader = object : RuntimeProcessReader {
        override fun pids(): List<Int> = (File("/proc").listFiles() ?: throw IOException("cannot enumerate /proc"))
            .mapNotNull { it.name.toIntOrNull() }.filter { it !in excluded }
        override fun uid(pid: Int): Int? {
            if (pid in excluded) return null
            return try { Files.getAttribute(File("/proc/$pid").toPath(), "unix:uid") as Int }
            catch (_: NoSuchFileException) { null }
        }
        private fun text(pid: Int, name: String) = Files.readAllBytes(File("/proc/$pid/$name").toPath()).toString(Charsets.UTF_8)
        override fun stat(pid: Int) = text(pid, "stat")
        override fun command(pid: Int) = text(pid, "cmdline")
        override fun environment(pid: Int) = text(pid, "environ")
        override fun cwd(pid: Int) = Files.readSymbolicLink(File("/proc/$pid/cwd").toPath()).toString()
    }
    val snapshot = RuntimeProcessOwnership.scan(reader, uid, self.pid().toInt(), known.keys)
    check(snapshot.observed) { "runtime process observation incomplete: ${snapshot.uncertain.size} unavailable; enumerationFailed=${snapshot.enumerationFailed}" }
    val owned = RuntimeProcessOwnership.owned(snapshot.records, setOf(root), self.pid().toInt(), known)
    println(owned.joinToString(",", "[", "]") {
        "{\"pid\":${it.pid},\"started\":\"${it.started}\",\"proot\":${it.proot}}"
    })
}
