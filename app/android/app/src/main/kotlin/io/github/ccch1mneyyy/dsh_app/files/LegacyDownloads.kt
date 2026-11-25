package io.github.ccch1mneyyy.dsh_app.files

import java.io.File
import java.io.InputStream
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE

/** Legacy Downloads: reserve the name and write through the same exclusive open.
 * The caller owns [source]; [name] has already passed FilesPlugin.safeName.
 */
internal object LegacyDownloads {
    fun copy(source: InputStream, directory: File, name: String): File {
        val initialName = boundedName(name, "")
        var number = 1
        while (true) {
            val target = File(directory, if (number == 1) initialName else boundedName(initialName, " ($number)"))
            val output = try {
                Files.newOutputStream(target.toPath(), CREATE_NEW, WRITE)
            } catch (_: FileAlreadyExistsException) {
                number++
                continue
            }
            // No delete/reopen after reservation; another save must choose a
            // different name. Only a successful exclusive open owns cleanup.
            try {
                output.use { source.copyTo(it) }
                return target
            } catch (error: Throwable) {
                try {
                    Files.deleteIfExists(target.toPath())
                } catch (cleanup: Throwable) {
                    if (cleanup !== error) error.addSuppressed(cleanup)
                }
                throw error
            }
        }
    }

    /** Bound the first exclusive-open candidate as well as every numbered retry. */
    private fun boundedName(name: String, suffix: String): String {
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        val stem = name.substring(0, dot)
        val extension = name.substring(dot)
        val budget = 255 - suffix.length // The numeric suffix is ASCII.
        val extensionBytes = extension.toByteArray(Charsets.UTF_8).size
        val prefix = utf8Prefix(stem, budget - extensionBytes)
        // A numbered name remains usable with an empty stem; keep its complete extension when it fits.
        return if (prefix.isNotEmpty() || (suffix.isNotEmpty() && extensionBytes <= budget)) "$prefix$suffix$extension"
            else utf8Prefix(stem + extension, budget) + suffix
    }

    private fun utf8Prefix(text: String, budget: Int): String {
        var end = 0
        var bytes = 0
        while (end < text.length) {
            val point = text.codePointAt(end)
            val size = when {
                point <= 0x7f -> 1
                point <= 0x7ff -> 2
                point <= 0xffff -> 3
                else -> 4
            }
            if (bytes + size > budget) break
            bytes += size
            end += Character.charCount(point)
        }
        return text.substring(0, end)
    }
}
