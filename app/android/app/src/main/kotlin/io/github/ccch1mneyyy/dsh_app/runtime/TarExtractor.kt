package io.github.ccch1mneyyy.dsh_app.runtime

import android.system.Os
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPInputStream
import org.tukaani.xz.XZInputStream

/**
 * Streaming tar extractor for the rootfs bundle (.tar.gz / .tar.xz / .tar).
 *
 * Handles ustar, GNU long names ('L'/'K') and pax headers ('x'); restores modes and
 * symlinks; turns hardlinks into copies (no hardlinks across app storage needed).
 * Device nodes and FIFOs are skipped: proot binds the host /dev instead.
 */
class TarExtractor(
    private val root: File,
    private val onProgress: (compressedRead: Long) -> Unit,
) {
    private class CountingStream(input: InputStream, private val onRead: (Long) -> Unit) : FilterInputStream(input) {
        var count = 0L
            private set

        override fun read(): Int {
            val b = super.read()
            if (b >= 0) advance(1)
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, len)
            if (n > 0) advance(n.toLong())
            return n
        }

        private fun advance(n: Long) {
            count += n
            onRead(count)
        }
    }

    private val rootCanonical: String = root.canonicalPath
    private val deferredDirModes = ArrayList<Pair<File, Int>>()
    private val copyBuffer = ByteArray(1 shl 16)

    fun extract(raw: InputStream, fileName: String) {
        val counting = CountingStream(raw.buffered(1 shl 16), onProgress)
        val decoded: InputStream = when {
            fileName.endsWith(".gz") || fileName.endsWith(".tgz") -> GZIPInputStream(counting, 1 shl 16)
            fileName.endsWith(".xz") -> XZInputStream(counting)
            else -> counting
        }
        extractDecoded(decoded)
    }

    fun extractDecoded(decoded: InputStream) {
        decoded.buffered(1 shl 16).use {
            readArchive(it)
            // Consume the tar's trailing padding so the whole compressed asset is read
            // (callers may be hashing the raw stream).
            while (it.read(copyBuffer) >= 0) {}
        }
        // Directory modes last, so read-only directories can still be populated.
        for ((dir, mode) in deferredDirModes.asReversed()) chmod(dir, mode)
    }

    private fun readArchive(input: InputStream) {
        val header = ByteArray(BLOCK)
        var longName: String? = null
        var longLink: String? = null
        var paxPath: String? = null
        var paxLink: String? = null
        var paxSize: Long? = null
        var zeroBlocks = 0
        while (true) {
            if (!readFully(input, header)) break
            if (header.all { it.toInt() == 0 }) {
                if (++zeroBlocks >= 2) break
                continue
            }
            zeroBlocks = 0
            val type = header[156].toInt().toChar()
            var size = paxSize ?: parseNumber(header, 124, 12)
            when (type) {
                'L' -> { longName = readString(input, size); continue }
                'K' -> { longLink = readString(input, size); continue }
                'x' -> {
                    val pax = parsePax(readString(input, size))
                    paxPath = pax["path"]; paxLink = pax["linkpath"]; paxSize = pax["size"]?.toLongOrNull()
                    continue
                }
                'g' -> { skip(input, padded(size)); continue }
            }
            val name = paxPath ?: longName ?: headerName(header)
            val link = paxLink ?: longLink ?: cString(header, 157, 100)
            longName = null; longLink = null; paxPath = null; paxLink = null; paxSize = null
            val mode = parseNumber(header, 100, 8).toInt() and 0xFFF
            val target = resolve(name)
            if (target == null) {
                skip(input, padded(size))
                continue
            }
            when (type) {
                '5' -> {
                    target.mkdirs()
                    deferredDirModes += target to (if (mode == 0) 0x1ED else mode) // 0755
                }
                '2' -> {
                    target.parentFile?.mkdirs()
                    deleteIfExists(target)
                    Os.symlink(link, target.path)
                }
                '1' -> {
                    val source = resolve(link)
                    target.parentFile?.mkdirs()
                    deleteIfExists(target)
                    if (source != null && source.isFile) {
                        FileInputStream(source).use { src -> FileOutputStream(target).use { src.copyTo(it, 1 shl 16) } }
                        chmod(target, mode)
                    }
                }
                '0', '\u0000', '7' -> {
                    target.parentFile?.mkdirs()
                    deleteIfExists(target)
                    FileOutputStream(target).use { out -> copyExactly(input, out, size) }
                    skip(input, padded(size) - size)
                    chmod(target, if (mode == 0) 0x1A4 else mode) // 0644
                    size = 0
                    continue
                }
                else -> Unit // '3' char dev, '4' block dev, '6' FIFO: skipped
            }
            skip(input, padded(size))
        }
    }

    /** Maps an archive path to a file under [root]; rejects paths escaping it. */
    private fun resolve(name: String): File? {
        val clean = name.trimStart('/').removePrefix("./").trimEnd('/')
        if (clean.isEmpty() || clean == ".") return null
        val file = File(root, clean)
        val parentCanonical = file.parentFile?.canonicalPath ?: return null
        if (parentCanonical != rootCanonical && !parentCanonical.startsWith("$rootCanonical/")) return null
        return file
    }

    private fun deleteIfExists(file: File) {
        try {
            Os.lstat(file.path)
            if (file.isDirectory && !isSymlink(file)) file.deleteRecursively() else file.delete()
        } catch (_: Exception) {
            // does not exist
        }
    }

    private fun isSymlink(file: File): Boolean = try {
        android.system.OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)
    } catch (_: Exception) {
        false
    }

    private fun chmod(file: File, mode: Int) {
        try {
            Os.chmod(file.path, mode)
        } catch (_: Exception) {
        }
    }

    private fun headerName(h: ByteArray): String {
        val name = cString(h, 0, 100)
        val magic = String(h, 257, 5, Charsets.US_ASCII)
        val prefix = if (magic == "ustar") cString(h, 345, 155) else ""
        return if (prefix.isNotEmpty()) "$prefix/$name" else name
    }

    private fun cString(h: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && h[end].toInt() != 0) end++
        return String(h, off, end - off, Charsets.UTF_8)
    }

    private fun parseNumber(h: ByteArray, off: Int, len: Int): Long {
        if (h[off].toInt() and 0x80 != 0) { // GNU base-256
            var v = (h[off].toLong() and 0x7F)
            for (i in off + 1 until off + len) v = (v shl 8) or (h[i].toLong() and 0xFF)
            return v
        }
        val s = cString(h, off, len).trim()
        return if (s.isEmpty()) 0 else s.toLong(8)
    }

    private fun parsePax(text: String): Map<String, String> {
        val out = HashMap<String, String>()
        var i = 0
        val bytes = text.toByteArray(Charsets.UTF_8)
        while (i < bytes.size) {
            var sp = i
            while (sp < bytes.size && bytes[sp] != ' '.code.toByte()) sp++
            val len = String(bytes, i, sp - i, Charsets.US_ASCII).toIntOrNull() ?: break
            val record = String(bytes, sp + 1, len - (sp - i) - 2, Charsets.UTF_8) // minus trailing \n
            val eq = record.indexOf('=')
            if (eq > 0) out[record.substring(0, eq)] = record.substring(eq + 1)
            i += len
        }
        return out
    }

    private fun readString(input: InputStream, size: Long): String {
        val buf = ByteArray(size.toInt())
        if (!readFully(input, buf)) throw IOException("truncated tar header data")
        skip(input, padded(size) - size)
        var end = buf.size
        while (end > 0 && buf[end - 1].toInt() == 0) end--
        return String(buf, 0, end, Charsets.UTF_8)
    }

    private fun copyExactly(input: InputStream, out: FileOutputStream, size: Long) {
        val buf = copyBuffer
        var left = size
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) throw IOException("truncated tar entry")
            out.write(buf, 0, n)
            left -= n
        }
    }

    private fun readFully(input: InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) {
                if (off == 0) return false
                throw IOException("truncated tar block")
            }
            off += n
        }
        return true
    }

    private fun skip(input: InputStream, n: Long) {
        var left = n
        val buf = copyBuffer
        while (left > 0) {
            val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw IOException("truncated tar padding")
            left -= r
        }
    }

    private fun padded(size: Long): Long = (size + BLOCK - 1) / BLOCK * BLOCK

    companion object {
        private const val BLOCK = 512
    }
}
