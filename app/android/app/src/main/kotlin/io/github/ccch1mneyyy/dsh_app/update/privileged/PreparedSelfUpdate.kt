package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/** Native-only one-shot capability; no caller-supplied command, package or installer identity. */
class PreparedSelfUpdate internal constructor(
    val versionName: String,
    val versionCode: Long,
    val sha256: String,
    val backend: String,
    val uid: Int,
    internal val owner: Any,
    internal val snapshot: SelfUpdateSnapshot,
    internal val identity: SelfUpdateIdentity,
    internal val transport: SelfUpdateTransport,
    internal val createdNanos: Long,
    private val onClose: (PreparedSelfUpdate) -> Unit,
) : Closeable {
    val digest: String get() = sha256
    internal val consumed = AtomicBoolean(false)
    internal val closed = AtomicBoolean(false)
    internal val submitted = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { transport.close() }
        runCatching { snapshot.close() }
        onClose(this)
    }
}

internal class SelfUpdateSnapshot(val file: File, val size: Long) : Closeable {
    private val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val initial = Os.fstat(descriptor.fileDescriptor)

    fun verifyPath() {
        val current = Os.lstat(file.path)
        if (!OsConstants.S_ISREG(current.st_mode) || current.st_dev != initial.st_dev ||
            current.st_ino != initial.st_ino || current.st_size != size ||
            Os.fstat(descriptor.fileDescriptor).st_size != size)
            throw SelfUpdateException("snapshotChanged")
    }

    fun duplicate(): ParcelFileDescriptor {
        verifyPath()
        return ParcelFileDescriptor.dup(descriptor.fileDescriptor).also {
            Os.lseek(it.fileDescriptor, 0, OsConstants.SEEK_SET)
        }
    }

    fun input(): InputStream = ParcelFileDescriptor.AutoCloseInputStream(duplicate())

    fun verifyHash(expected: String) {
        verifyPath()
        val actual = input().use { SelfUpdatePolicy.hash(it) }
        verifyPath()
        if (actual != expected) throw SelfUpdateException("hashMismatch")
    }

    override fun close() {
        runCatching { descriptor.close() }
        // Only this randomly named, privately created snapshot is ever removed.
        file.delete()
    }
}

internal interface SelfUpdateTransport : Closeable {
    val uid: Int
    fun verifyIdentity()
    fun install(prepared: PreparedSelfUpdate, userId: Int, requestId: String): SelfUpdateReceipt
}
