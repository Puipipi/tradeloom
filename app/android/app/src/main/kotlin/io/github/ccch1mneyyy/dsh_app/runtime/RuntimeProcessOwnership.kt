package io.github.ccch1mneyyy.dsh_app.runtime

/** A /proc snapshot already filtered to this app's uid. Never logs environments. */
data class RuntimeProcessRecord(
    val pid: Int,
    val parent: Int,
    val started: String,
    val argv: List<String>,
    val marker: String?,
    val cwd: String?,
) {
    val proot: Boolean get() = argv.firstOrNull()?.substringAfterLast('/') in setOf("libproot.so", "proot")
}

/** A missing process is distinct from an observation that failed. */
interface RuntimeProcessReader {
    fun pids(): List<Int>
    /** null only when the PID directory is confirmed absent. Other failures throw. */
    fun uid(pid: Int): Int?
    fun stat(pid: Int): String
    fun command(pid: Int): String
    fun environment(pid: Int): String
    fun cwd(pid: Int): String
}

data class RuntimeProcessSnapshot(
    val records: List<RuntimeProcessRecord>,
    val uncertain: Set<Int>,
    val retired: Set<Int>,
    val enumerationFailed: Boolean,
) {
    val observed: Boolean get() = !enumerationFailed && uncertain.isEmpty()
}

/** Captured identities outlive one launcher. Access only under this monitor. */
internal class RuntimeCleanupState {
    val known = mutableMapOf<Int, String>()
}

/**
 * Root-specific ownership, plus descendants captured before any parent is killed.
 * Unlike matching "dsh web" or "/opt/node" anywhere, another rootfs does not match.
 * An inherited marker/cwd catches detached children after the engine parent exits.
 */
object RuntimeProcessOwnership {
    private data class CleanupScope(val root: String, val uid: Int)
    private val cleanupStates = mutableMapOf<CleanupScope, RuntimeCleanupState>()

    /** App-process lifetime, including failed-launcher replacement. Never remove
     * an empty state: an older launcher may still capture into that same state. */
    @Synchronized internal fun cleanupState(canonicalRoot: String, uid: Int): RuntimeCleanupState =
        cleanupStates.getOrPut(CleanupScope(canonicalRoot, uid)) { RuntimeCleanupState() }

    fun within(path: String?, root: String): Boolean = path == root || path?.startsWith("$root/") == true

    /**
     * Inspect known PIDs even if one directory enumeration omits them. A failed
     * cmdline/environ/cwd read can hide ownership, so it never means "not ours".
     * A partial record can still identify an owned process, but cleanup cannot
     * succeed until all uncertainty is resolved or that process is gone.
     */
    fun scan(reader: RuntimeProcessReader, uid: Int, appPid: Int, known: Set<Int> = emptySet()): RuntimeProcessSnapshot {
        val enumeration = runCatching { reader.pids() }
        val records = mutableListOf<RuntimeProcessRecord>()
        val uncertain = mutableSetOf<Int>()
        val retired = mutableSetOf<Int>()
        for (pid in (enumeration.getOrDefault(emptyList()) + known).toSet()) {
            if (pid == appPid) continue
            val owner = runCatching { reader.uid(pid) }
            if (owner.isFailure) { uncertain += pid; continue }
            if (owner.getOrNull() != uid) { retired += pid; continue }
            val text = runCatching { reader.stat(pid) }
            if (text.isFailure) {
                // A missing stat file alone is not proof of process exit: its
                // directory must also be absent (or now belong to another uid).
                val after = runCatching { reader.uid(pid) }
                if (after.isSuccess && after.getOrNull() != uid) retired += pid else uncertain += pid
                continue
            }
            val value = text.getOrThrow()
            if (value.substringAfterLast(") ", "").firstOrNull() in setOf('Z', 'X')) { retired += pid; continue }
            val identity = stat(value)
            if (identity == null) { uncertain += pid; continue }
            fun field(read: () -> String): String? = try { read() } catch (_: Exception) { uncertain += pid; null }
            val command = field { reader.command(pid) }?.split('\u0000')?.filter { it.isNotEmpty() }.orEmpty()
            val marker = field { reader.environment(pid) }?.split('\u0000')
                ?.firstOrNull { it.startsWith("DSH_GO_RUNTIME_ROOT=") }?.substringAfter('=')
            val cwd = field { reader.cwd(pid) }
            records += RuntimeProcessRecord(pid, identity.first, identity.second, command, marker, cwd)
        }
        return RuntimeProcessSnapshot(records, uncertain, retired, enumeration.isFailure)
    }

    fun owned(records: List<RuntimeProcessRecord>, roots: Set<String>, appPid: Int, known: Map<Int, String> = emptyMap()): List<RuntimeProcessRecord> {
        val owned = records.filter { record ->
            record.pid != appPid && (known[record.pid] == record.started || roots.any { root ->
                record.marker == root || within(record.cwd, root) || record.argv.any { arg ->
                    within(arg, root) || arg == "--rootfs=$root" || arg.startsWith("$root:") ||
                        arg.split(':').any { within(it, root) }
                }
            })
        }.mapTo(mutableSetOf()) { it.pid }
        var changed: Boolean
        do {
            changed = false
            for (record in records) if (record.pid != appPid && record.parent in owned && owned.add(record.pid)) changed = true
        } while (changed)
        return records.filter { it.pid in owned }
    }

    /** /proc/PID/stat: comm can contain spaces and parentheses. */
    fun stat(text: String): Pair<Int, String>? {
        val tail = text.substringAfterLast(") ", "").trim().split(Regex(" +"))
        if (tail.size < 20) return null
        val parent = tail[1].toIntOrNull() ?: return null
        return parent to tail[19]
    }
}
