package io.github.ccch1mneyyy.dsh_app.update.privileged

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS

/** Reclaims old helper snapshots before the single install worker creates its own directory. */
internal fun cleanupSelfUpdateDirectories(parent: File) {
    val names = Regex("dsh-self-update-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    parent.listFiles().orEmpty().filter { names.matches(it.name) }.forEach { directory ->
        runCatching {
            if (!Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) return@runCatching
            val apk = File(directory, "base.apk")
            if (Files.isRegularFile(apk.toPath(), NOFOLLOW_LINKS)) apk.delete()
            directory.delete()
        }
    }
}
