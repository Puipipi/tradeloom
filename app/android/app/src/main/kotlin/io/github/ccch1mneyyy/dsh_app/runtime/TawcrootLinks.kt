package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.NotLinkException
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.SecureRandom

/**
 * Turns tawcroot's emulated hard links back into real files. tawcroot (tawc's
 * link store, format 1) moves a file that gets a second name to
 * `<runtime>/tawcroot/link/<token>` and makes every name a symlink whose target
 * is the literal `tawcroot:link:<token>`. Only tawcroot can read such a name, so
 * before PRoot or Direct start, each name gets a copy of its object (mode and
 * mtime kept) renamed over it. One rename per name: a killed run leaves every
 * name readable by tawcroot or already a file, and the next start carries on.
 *
 * [within] limits the walk to these rootfs-relative paths (what a reset keeps);
 * otherwise the whole rootfs is converted and the store removed once nothing
 * refers to it.
 */
class TawcrootLinks(
    rootfs: File,
    private val flush: () -> Unit,
    private val freeBytes: () -> Long = { rootfs.usableSpace },
    private val within: List<String>? = null,
) {
    sealed class Result {
        /** [names] became real files; [storeRemoved] when the whole tree was done; [unseen] when a
         * directory could not be read or a name's object is gone (the store then stays). */
        data class Done(val names: Int, val storeRemoved: Boolean, val unseen: Boolean = false) : Result()
        data class NotEnoughSpace(val need: Long, val free: Long) : Result()
    }

    private val root = rootfs.canonicalFile.toPath()
    private val store = storeOf(rootfs).toPath()
    private val objects = store.resolve("link")
    private val random = SecureRandom()

    /** Throws on an IO error, leaving every name readable. [onSlow] runs once when this takes more than a moment. */
    fun run(onSlow: () -> Unit = {}): Result {
        if (!pending(root.toFile())) return Result.Done(0, false)
        recoverNewNames()
        val started = System.nanoTime()
        var slow = false
        fun tick() {
            if (!slow && System.nanoTime() - started > SLOW_NANOS) { slow = true; onSlow() }
        }

        val names = ArrayList<Pair<Path, Path>>()
        // A name we could not see or whose object is gone: keep the store for it.
        var incomplete = false
        val starts = within?.map { root.resolve(it.trimStart('/')).normalize() }?.filter { it.startsWith(root) } ?: listOf(root)
        for (start in starts) {
            try {
                Files.readAttributes(start, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (_: NoSuchFileException) {
                continue
            } catch (_: IOException) {
                incomplete = true // can't tell: never treat it as absent
                continue
            }
            Files.walkFileTree(start, object : SimpleFileVisitor<Path>() {
                override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
                    // The runtime's and phone storage's bind mount points can't be read by the app,
                    // and tawcroot never stores links through a bind.
                    if (file.parent != root || file.fileName.toString() !in MOUNT_POINTS) incomplete = true
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    tick()
                    if (attrs.isSymbolicLink) {
                        val target = Files.readSymbolicLink(file).toString()
                        if (target.startsWith(PREFIX)) {
                            val token = target.removePrefix(PREFIX)
                            val obj = objects.resolve(token)
                            if (TOKEN.matches(token) && Files.exists(obj, LinkOption.NOFOLLOW_LINKS)) names += file to obj
                            else incomplete = true
                        }
                    } else if (attrs.isRegularFile && TEMP.matches(file.fileName.toString())) {
                        Files.delete(file) // a copy from a run that was killed before its rename
                    }
                    return FileVisitResult.CONTINUE
                }
            })
        }

        val need = names.sumOf { (name, obj) ->
            val attrs = Files.readAttributes(obj, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            when {
                attrs.isSymbolicLink -> 0L
                attrs.isRegularFile -> blocks(attrs.size())
                // NEW can store a FIFO after a denied hard link. Files.copy opens it for
                // reading and waits for a writer; reject before publishing any batch.
                else -> throw IOException("tawcroot: cannot convert linked special file /${root.relativize(name)}; turn tawcroot on again")
            }
        }
        if (need > 0) {
            val free = freeBytes()
            if (free < need + L2sMigration.MARGIN) return Result.NotEnoughSpace(need, free)
        }

        var done = 0
        for (batch in names.sortedBy { it.first }.chunked(BATCH)) {
            val copies = ArrayList<Pair<Path, Path>>()
            try {
                for ((name, obj) in batch) {
                    tick()
                    val temp = name.resolveSibling(TEMP_PREFIX + "%016x".format(random.nextLong()) + ".tmp")
                    if (Files.isSymbolicLink(obj)) Files.createSymbolicLink(temp, Files.readSymbolicLink(obj))
                    else Files.copy(obj, temp, StandardCopyOption.COPY_ATTRIBUTES, LinkOption.NOFOLLOW_LINKS)
                    copies += temp to name
                }
                flush()
                for ((temp, name) in copies) {
                    Files.move(temp, name, StandardCopyOption.ATOMIC_MOVE)
                    done++
                }
            } finally {
                for ((temp, _) in copies) runCatching { Files.deleteIfExists(temp) }
            }
        }
        if (within != null || incomplete) return Result.Done(done, false, incomplete)
        flush()
        deleteTree(store)
        return Result.Done(done, true)
    }

    /** Finish only NEW's missing names before walking. Keep the journal/counts for tawc if this
     * conversion stops or is limited to [within]; converting names only reduces live token refs. */
    private fun recoverNewNames() {
        val input = try { Files.newInputStream(store.resolve("intent")) } catch (_: NoSuchFileException) { return }
        val (token, source, destination) = DataInputStream(input).use { stream ->
            // Pinned format 1's intent_hdr on arm64/x64: uint64 cnt at 8, lengths at 16/20/24,
            // then four padding bytes. Only NEW (3) can have moved an original name out of view.
            val header = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN)
            stream.readFully(header.array())
            if (header.getInt(0) != 0x494c5754) throw IOException("tawcroot: invalid link intent")
            if (header.getInt(4) != 3) return
            val tokenSize = header.getInt(16)
            val sourceSize = header.getInt(20)
            val destinationSize = header.getInt(24)
            if (tokenSize !in 1..31 || sourceSize !in 0..4095 || destinationSize !in 0..4095) {
                throw IOException("tawcroot: invalid link intent lengths")
            }
            fun text(size: Int) = ByteArray(size).also { stream.readFully(it) }.toString(Charsets.UTF_8)
            val token = text(tokenSize)
            if (!TOKEN.matches(token)) throw IOException("tawcroot: invalid link intent token")
            Triple(token, text(sourceSize), text(destinationSize))
        }
        val objectPresent = try {
            Files.readAttributes(objects.resolve(token), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            true
        } catch (_: NoSuchFileException) { false }
        val work = store.resolve("work")
        val staged = listOf(work.resolve("$token.dst") to destination, work.resolve("$token.src") to source)
        if (objectPresent) {
            for ((entry, recorded) in staged) {
                if (!matchesToken(entry, token)) continue // consumed: never recreate from the recorded path
                val name = recoveryPath(recorded) ?: continue
                try {
                    Files.move(entry, name) // no REPLACE/ATOMIC_MOVE: a later occupant belongs to its writer
                } catch (_: FileAlreadyExistsException) {
                    // Like tawc's NOREPLACE recovery, leave the staged entry parked.
                } catch (_: NoSuchFileException) {
                    // The recorded parent vanished; do not recreate a directory or a name elsewhere.
                }
            }
        } else {
            // NEW never moved the original: discard only its staged/published token names.
            for ((entry, _) in staged) if (matchesToken(entry, token)) Files.delete(entry)
            recoveryPath(destination)?.let { if (matchesToken(it, token)) Files.delete(it) }
        }
    }

    /** Recorded paths are host paths, not guest symlink targets. Resolve only the existing parent:
     * the leaf may be a dangling token, and a renamed parent must not send recovery outside rootfs. */
    private fun recoveryPath(recorded: String): Path? {
        if (recorded.isEmpty()) return null
        val path = root.fileSystem.getPath(recorded)
        if (!path.isAbsolute || !path.normalize().startsWith(root) || path == root) {
            return null
        }
        val parent = try { path.parent.toRealPath() } catch (_: NoSuchFileException) { return null }
        if (!parent.startsWith(root)) return null
        return parent.resolve(path.fileName)
    }

    private fun matchesToken(path: Path, token: String): Boolean = try {
        Files.readSymbolicLink(path).toString() == PREFIX + token
    } catch (_: NoSuchFileException) { false } catch (_: NotLinkException) { false }

    private fun deleteTree(dir: Path) {
        Files.walkFileTree(dir, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                if (exc != null) throw exc
                Files.deleteIfExists(dir)
                return FileVisitResult.CONTINUE
            }
        })
    }

    companion object {
        const val PREFIX = "tawcroot:link:"
        private val MOUNT_POINTS = setOf("system", "apex", "sdcard", "storage", "dev", "proc", "sys")
        private val TOKEN = Regex("[0-9]+(-[0-9]+)?")
        const val TEMP_PREFIX = ".dsh-go-tawc-"
        val TEMP = Regex("""\.dsh-go-tawc-[0-9a-f]{16}\.tmp""")
        private const val SLOW_NANOS = 500_000_000L
        private const val BATCH = 2000

        private fun blocks(size: Long) = 4096 + (size + 4095) / 4096 * 4096

        /** tawcroot derives its store from the rootfs: `<rootfs>/../tawcroot`. */
        fun storeOf(rootfs: File): File = File(rootfs.canonicalFile.parentFile, "tawcroot")

        /** Whether tawcroot ever stored a linked file for this rootfs. */
        fun pending(rootfs: File): Boolean = try {
            val store = storeOf(rootfs).toPath()
            val dir = store.resolve("link")
            Files.exists(store.resolve("intent"), LinkOption.NOFOLLOW_LINKS) ||
                (Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS) && Files.newDirectoryStream(dir).use { it.iterator().hasNext() })
        } catch (_: NoSuchFileException) { false }
    }
}
