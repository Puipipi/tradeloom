package io.github.ccch1mneyyy.dsh_app.files

import android.content.Context
import io.github.ccch1mneyyy.dsh_app.runtime.PhoneStorage
import io.github.ccch1mneyyy.dsh_app.runtime.TawcrootLinks
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption

/**
 * Where a path of the local Linux environment lives on Android.
 *
 * proot maps the guest root onto the rootfs (`filesDir/runtime/rootfs`, see
 * RuntimeInstaller) and, with phone storage on, binds the shared storage at
 * `/sdcard` and `/storage` (PhoneStorage.binds). Symlinks usually hold guest
 * targets (`/usr/lib/…`), but `--link2symlink` uses host-absolute targets in
 * the rootfs's `/root/.l2s`. Rebase those targets before following each link
 * in the guest world, not by Android. tawc's opaque hard-link names instead
 * refer to objects in the rootfs's sibling store.
 */
object GuestFiles {
    private const val MAX_LINKS = 16

    fun rootfs(context: Context): File = File(context.filesDir, "runtime/rootfs")

    /** Host file for a guest or physical-rootfs [path]; null unless it is a readable regular file. */
    fun resolve(context: Context, path: String): File? =
        resolve(rootfs(context), path, PhoneStorage.hostRoot())

    internal fun resolve(rootfs: File, path: String, phoneRoot: String): File? {
        if (!path.startsWith("/")) return null
        val rootPaths = listOf(rootfs.absolutePath, rootfs.canonicalPath)
        // Direct media results already name the physical rootfs before any symlink is followed.
        val initialRoot = rootPaths.firstOrNull { path == it || path.startsWith("$it/") }
        val pending = ArrayDeque(segments(if (initialRoot == null) path else path.removePrefix(initialRoot)))
        val resolved = ArrayList<String>()
        var links = 0
        while (pending.isNotEmpty()) {
            val segment = pending.removeFirst()
            when (segment) {
                "", "." -> continue
                ".." -> { if (resolved.isNotEmpty()) resolved.removeAt(resolved.size - 1); continue }
            }
            resolved += segment
            val host = hostOf(rootfs, resolved, phoneRoot)
            val nio = host.toPath()
            if (!Files.isSymbolicLink(nio)) continue
            if (++links > MAX_LINKS) return null
            var target = try { Files.readSymbolicLink(nio).toString() } catch (_: Exception) { return null }
            if (target.startsWith(TawcrootLinks.PREFIX)) {
                // Shared-storage links must not index the app's private store.
                if (resolved.first() == PhoneStorage.GUEST_PATH.removePrefix("/") || resolved.first() == "storage") return null
                val token = target.removePrefix(TawcrootLinks.PREFIX)
                if (!Regex("[0-9]+(-[0-9]+)?").matches(token)) return null
                val obj = File(TawcrootLinks.storeOf(rootfs), "link/$token")
                if (Files.isSymbolicLink(obj.toPath())) {
                    // A hard-linked symlink still resolves from its guest name's parent.
                    target = try { Files.readSymbolicLink(obj.toPath()).toString() } catch (_: Exception) { return null }
                } else {
                    return obj.takeIf { pending.isEmpty() && Files.isRegularFile(it.toPath(), LinkOption.NOFOLLOW_LINKS) && it.canRead() }
                }
            }
            resolved.removeAt(resolved.size - 1)
            if (target.startsWith("/")) {
                val root = rootPaths.firstOrNull { target == it || target.startsWith("$it/") }
                if (root != null) {
                    // PRoot l2s links name the host rootfs, not another guest /data/... path.
                    target = target.removePrefix(root)
                } else if (target.startsWith(phoneRoot)) {
                    val rest = pending.joinToString("/")
                    val file = if (rest.isEmpty()) File(target) else File(target, rest)
                    return file.takeIf { it.isFile && it.canRead() }
                }
                resolved.clear()
            }
            segments(target).reversed().forEach { pending.addFirst(it) }
        }
        val file = hostOf(rootfs, resolved, phoneRoot)
        return file.takeIf { Files.isRegularFile(it.toPath(), LinkOption.NOFOLLOW_LINKS) && it.canRead() }
    }

    /** Host path of resolved guest [segments] (no symlinks left to follow in them). */
    private fun hostOf(rootfs: File, segments: List<String>, phoneRoot: String): File {
        val guest = "/" + segments.joinToString("/")
        val phone = PhoneStorage.GUEST_PATH
        return when {
            guest == phone || guest.startsWith("$phone/") -> File(phoneRoot + guest.removePrefix(phone))
            guest == "/storage" || guest.startsWith("/storage/") -> File(guest)
            else -> File(rootfs, guest.removePrefix("/"))
        }
    }

    private fun segments(path: String): List<String> = path.split('/').filter { it.isNotEmpty() }
}
