package io.github.ccch1mneyyy.dsh_app.links

import java.io.File
import java.nio.file.Files

/** Protects only copies still in progress; completed arrivals retain the existing cache policy. */
internal object LinkCopySlots {
    private val lock = Any()
    private val active = HashSet<File>()

    fun <T> withSlot(root: File, copy: (File) -> T): T {
        val slot = synchronized(lock) {
            val old = root.listFiles()?.sortedByDescending { it.lastModified() }.orEmpty()
            for (candidate in old.drop(KEEP_FILES)) {
                if (candidate !in active) candidate.deleteRecursively()
            }
            // Creation and registration share the prune lock: no unprotected visible new slot.
            Files.createTempDirectory(root.toPath(), "arrival-").toFile().also { active += it }
        }
        try {
            return copy(slot) // Provider I/O must not block other arrivals' admission or copies.
        } finally {
            synchronized(lock) { active -= slot }
        }
    }

    private const val KEEP_FILES = 6
}
