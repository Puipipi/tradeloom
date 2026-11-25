package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.res.AssetFileDescriptor
import android.system.ErrnoException
import android.system.Os
import java.io.IOException
import org.tukaani.xz.SeekableInputStream

/** One uncompressed APK asset with its own descriptor; positions are relative to the asset. */
internal class AssetSeekableInputStream(private val asset: AssetFileDescriptor) : SeekableInputStream() {
    private var offset = 0L

    override fun length(): Long = asset.length

    override fun position(): Long = offset

    override fun seek(pos: Long) {
        offset = pos
    }

    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (offset >= asset.length) return -1
        val count = minOf(len.toLong(), asset.length - offset).toInt()
        val read = try {
            // pread leaves the APK descriptor's shared file position alone.
            Os.pread(asset.fileDescriptor, b, off, count, asset.startOffset + offset)
        } catch (e: ErrnoException) {
            throw IOException("Cannot read asset", e)
        }
        if (read == 0) return -1
        offset += read
        return read
    }

    override fun close() = asset.close()
}
