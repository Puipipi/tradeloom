package io.github.ccch1mneyyy.dsh_app.nativemedia

import java.io.File

/**
 * Which files a plugin clip may be played from: only `<cache>/native-media/<owner>/clip`, written by
 * the app's own download (lib/plugins/native/native_capabilities.dart), as a real file of
 * 1 byte .. 16 MiB with a supported audio type. Never a URL, a content URI or another path.
 */
object ClipPath {
    const val DIR = "native-media"
    const val MAX_BYTES = 16L * 1024 * 1024
    val TYPES = setOf("audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/aac")

    /** The canonical file when [path] is an allowed clip under [cacheDir] for [owner]; else null. */
    fun allowed(cacheDir: File, owner: String, path: String, contentType: String): File? {
        if (contentType !in TYPES || !OWNER.matches(owner)) return null
        val raw = File(path)
        if (!raw.isAbsolute || raw.name != "clip") return null
        val file = runCatching { raw.canonicalFile }.getOrNull() ?: return null
        val expected = runCatching { File(File(cacheDir, DIR), owner).canonicalFile }.getOrNull() ?: return null
        if (file.parentFile != expected || file.path != File(expected, "clip").path) return null
        if (!file.isFile || file.length() !in 1L..MAX_BYTES) return null
        return file
    }

    private val OWNER = Regex("^[0-9a-f]{16,64}$")
}
