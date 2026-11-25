package io.github.ccch1mneyyy.dsh_app.shortcuts

import java.io.File
import java.util.UUID

/** Private, short-lived screenshot slots; never accept a general share path at this entry. */
internal object ScreenshotFiles {
    const val DIRECTORY = "pet_screenshots"
    const val MAX_BYTES = 8L * 1024 * 1024
    private const val MAX_SLOTS = 8
    private const val MAX_AGE_MS = 60L * 60 * 1000
    private val slotName = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val names = setOf("screenshot.png", "screenshot.jpg")

    fun validate(cacheDir: File, path: String?): File? = try {
        val root = root(cacheDir)
        val file = path?.let(::File)
        if (file == null || !file.isAbsolute || file.absolutePath != file.canonicalPath ||
            file.parentFile?.parentFile != root || !slotName.matches(file.parentFile?.name.orEmpty()) ||
            file.name !in names || !file.isFile || file.length() !in 1..MAX_BYTES) null else file
    } catch (_: Exception) { null }

    fun createSlot(cacheDir: File, now: Long = System.currentTimeMillis()): File {
        val root = root(cacheDir)
        check(root.isDirectory || root.mkdirs())
        val slots = root.listFiles().orEmpty().filter {
            it.isDirectory && slotName.matches(it.name) && it.canonicalFile == it.absoluteFile
        }.sortedByDescending { it.lastModified() }
        slots.forEachIndexed { index, slot ->
            if (index >= MAX_SLOTS - 1 || now - slot.lastModified() > MAX_AGE_MS) deleteSlot(slot)
        }
        return File(root, UUID.randomUUID().toString()).also { check(it.mkdir()) }
    }

    /** Only files that this producer writes, without following links or deleting other content. */
    fun deleteSlot(slot: File) {
        slot.listFiles().orEmpty().forEach { file ->
            if (file.name in names && file.absoluteFile == file.canonicalFile && file.isFile) file.delete()
        }
        slot.delete()
    }

    private fun root(cacheDir: File): File {
        val expected = File(cacheDir.canonicalFile, DIRECTORY)
        check(expected.canonicalFile == expected) { "Screenshot cache must not be a link" }
        return expected
    }
}
