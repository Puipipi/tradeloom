package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes

internal data class GroupNamesResult(val added: Int, val skipped: String? = null)

/** Only called on freshly extracted staging, before activation; never edits a live rootfs. */
internal fun appendAndroidGroupNames(staging: File, statusText: String?): GroupNamesResult {
    fun skip(reason: String) = GroupNamesResult(0, reason)
    val groupLines = statusText?.lineSequence()?.filter { it.startsWith("Groups:") }?.toList()
        ?: return skip("process groups unavailable")
    if (groupLines.size != 1) return skip("unsupported process groups")
    val tokens = groupLines.single().substringAfter(':').trim()
        .let { if (it.isEmpty()) emptyList() else it.split(Regex("\\s+")) }
    val gids = linkedSetOf<Long>()
    for (token in tokens) {
        val gid = token.takeIf { it.all { c -> c in '0'..'9' } }?.toLongOrNull()
        if (gid == null || gid > Int.MAX_VALUE) return skip("unsupported process group id")
        gids.add(gid)
    }
    if (gids.isEmpty()) return GroupNamesResult(0)

    val group = File(staging, "etc/group")
    val prepared = try {
        fun attributes(file: File) = Files.readAttributes(
            file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        fun readRegular(file: File): ByteArray {
            if (!attributes(file).isRegularFile) throw IOException("not a regular file")
            return file.readBytes()
        }
        fun decode(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
        if (!attributes(File(staging, "etc")).isDirectory) return skip("unsupported etc directory")
        val nss = decode(readRegular(File(staging, "etc/nsswitch.conf")))
        for (database in listOf("group", "gshadow")) {
            val sources = nss.lineSequence().map { it.substringBefore('#').trim() }
                .filter { it.substringBefore(':').trim() == database }.toList()
            if (sources.size != 1 || sources.single().substringAfter(':', "").trim() != "files") {
                return skip("unsupported $database name service")
            }
        }
        val original = readRegular(group)
        val names = mutableSetOf<String>()
        val existingGids = mutableSetOf<Long>()
        for (line in decode(original).lineSequence()) {
            if (line.isBlank() || line.trimStart().startsWith('#')) continue
            val fields = line.split(':')
            if (fields.size != 4 || (fields[0].isEmpty() || fields[0].any { it.isWhitespace() })) return skip("unsupported group database")
            val gid = fields[2].takeIf { it.isNotEmpty() && it.all { c -> c in '0'..'9' } }
                ?.toLongOrNull()
            if (gid == null || gid > 0xffffffffL) return skip("unsupported group database")
            names.add(fields[0])
            existingGids.add(gid)
        }
        val shadow = File(staging, "etc/gshadow")
        val shadowAttributes = try { attributes(shadow) } catch (_: NoSuchFileException) { null }
        if (shadowAttributes != null) {
            if (!shadowAttributes.isRegularFile) return skip("unsupported shadow group database")
            for (line in decode(shadow.readBytes()).lineSequence()) {
                if (line.isBlank() || line.trimStart().startsWith('#')) continue
                val fields = line.split(':')
                if (fields.size != 4 || (fields[0].isEmpty() || fields[0].any { it.isWhitespace() })) return skip("unsupported shadow group database")
                names.add(fields[0])
            }
        }
        val additions = gids.filter { it !in existingGids && "android_gid_$it" !in names }
        if (additions.isEmpty()) return GroupNamesResult(0)
        val suffix = buildString {
            if (original.isNotEmpty() && original.last() != '\n'.code.toByte()) append('\n')
            additions.forEach { append("android_gid_$it:!:$it:\n") }
        }.toByteArray(Charsets.UTF_8)
        additions.size to suffix
    } catch (_: IOException) {
        return skip("group database could not be read")
    } catch (_: SecurityException) {
        return skip("group database access denied")
    } catch (_: UnsupportedOperationException) {
        return skip("group database filesystem unsupported")
    }
    // Do not catch append/close failures: installation must not activate a partial staging file.
    FileOutputStream(group, true).use { it.write(prepared.second) }
    return GroupNamesResult(prepared.first)
}
