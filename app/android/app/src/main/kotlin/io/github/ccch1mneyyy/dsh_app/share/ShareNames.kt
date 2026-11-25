package io.github.ccch1mneyyy.dsh_app.share

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS

/** File names for shared items (pure: unit-tested on the JVM). */
internal object ShareNames {
    /** Incoming-share slots only; the same root also holds outgoing share PNGs. */
    fun pruneSlots(dir: File, keep: Int) {
        val slotName = Regex("[0-9a-z]+-[0-9]+")
        val slots = dir.listFiles()?.filter {
            slotName.matches(it.name) && Files.isDirectory(it.toPath(), NOFOLLOW_LINKS)
        }?.sortedByDescending { it.lastModified() } ?: return
        for (old in slots.drop(keep)) old.deleteRecursively()
    }

    /** A share-code file (lib/share_code/share_codec.dart `shareFileExtension`). */
    const val SHARE_CODE_MIME = "application/vnd.dshgo+json"
    const val SHARE_CODE_EXTENSION = "dshgo"

    private val unsafe = Regex("[\\u0000-\\u001f\\\\:*?\"<>|]")

    /** A file name without path separators or control characters, at most 120 chars. */
    fun safeName(name: String): String {
        val cleaned = name.substringAfterLast('/').replace(unsafe, "_").trim().trimStart('.')
        val value = cleaned.ifEmpty { "shared" }
        var end = minOf(value.length, 120)
        if (end < value.length && Character.isHighSurrogate(value[end - 1]) &&
            Character.isLowSurrogate(value[end])) end--
        return value.substring(0, end)
    }

    /** What to call an item whose sender gave no name. */
    fun fallbackName(
        mime: String?,
        file: String = "文件", // l10n:keep test default
        image: String = "图片", // l10n:keep test default
        video: String = "视频", // l10n:keep test default
        audio: String = "音频", // l10n:keep test default
        text: String = "文本", // l10n:keep test default
    ): String = when {
        mime == null -> file
        mime.startsWith("image/") -> image
        mime.startsWith("video/") -> video
        mime.startsWith("audio/") -> audio
        mime.startsWith("text/") -> text
        else -> file
    }

    /** [name] with `.extension` added when it has none. */
    fun withExtension(name: String, extension: String?): String {
        if (extension.isNullOrEmpty() || hasExtension(name)) return name
        return "$name.$extension"
    }

    fun hasExtension(name: String): Boolean {
        val dot = name.lastIndexOf('.')
        return dot > 0 && dot < name.length - 1
    }

    /** [name], or `name (2).ext`, `name (3).ext`… when [dir] already has it. */
    fun unique(dir: File, name: String): File {
        var file = File(dir, candidateName(name, ""))
        var n = 2
        while (file.exists()) file = File(dir, candidateName(name, " (${n++})"))
        return file
    }

    /** Budget the final basename, including the extension and this collision suffix. */
    private fun candidateName(name: String, suffix: String): String {
        val budget = 255 - suffix.toByteArray(Charsets.UTF_8).size
        val dot = name.lastIndexOf('.')
        val (base, ext) = if (dot > 0) name.substring(0, dot) to name.substring(dot) else name to ""
        val stem = utf8Prefix(base, budget - ext.toByteArray(Charsets.UTF_8).size)
        return if (stem.isNotEmpty()) "$stem$suffix$ext" else utf8Prefix(name, budget) + suffix
    }

    /** Preserve complete code points; the sender's already-malformed UTF-16 is not repaired. */
    private fun utf8Prefix(value: String, budget: Int): String {
        var end = 0
        var bytes = 0
        while (end < value.length) {
            val next = end + Character.charCount(Character.codePointAt(value, end))
            val size = value.substring(end, next).toByteArray(Charsets.UTF_8).size
            if (bytes + size > budget) break
            bytes += size
            end = next
        }
        return value.substring(0, end)
    }

    /** [name] with its extension swapped for [extension] (`IMG_1.HEIC` → `IMG_1.jpg`). */
    fun replaceExtension(name: String, extension: String): String {
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        return "$base.$extension"
    }
}
