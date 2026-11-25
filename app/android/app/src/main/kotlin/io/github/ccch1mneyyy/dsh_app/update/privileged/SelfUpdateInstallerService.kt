package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.content.Context
import android.os.Binder
import android.os.Bundle
import android.os.IBinder
import android.os.IInterface
import android.os.Parcel
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess

internal fun updateBundle(values: Map<String, Any?>): Bundle = Bundle().apply {
    values.forEach { (key, value) -> when (value) {
        null -> putString(key, null)
        is Boolean -> putBoolean(key, value)
        is Int -> putInt(key, value)
        is Long -> putLong(key, value)
        is String -> putString(key, value)
        else -> throw SelfUpdateException("invalidArguments")
    } }
}

internal fun Bundle.updateReceipt(): SelfUpdateReceipt = SelfUpdateReceipt(
    getString("status") ?: "unknown", getString("errorCode"), getBoolean("submitted"), getBoolean("outcomeUnknown"))

interface ISelfUpdateInstaller : IInterface {
    fun exchange(request: Bundle, apk: ParcelFileDescriptor? = null): Bundle

    abstract class Stub : Binder(), ISelfUpdateInstaller {
        init { attachInterface(this, DESCRIPTOR) }
        override fun asBinder(): IBinder = this
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code != IBinder.FIRST_CALL_TRANSACTION) return super.onTransact(code, data, reply, flags)
            data.enforceInterface(DESCRIPTOR)
            val request = data.readBundle(javaClass.classLoader) ?: Bundle()
            val apk = if (data.readInt() == 1) ParcelFileDescriptor.CREATOR.createFromParcel(data) else null
            val result = exchange(request, apk)
            reply?.writeNoException()
            reply?.writeBundle(result)
            return true
        }
    }

    companion object {
        const val DESCRIPTOR = "io.github.ccch1mneyyy.dsh_app.update.privileged.ISelfUpdateInstaller"
        const val DESTROY = 16777115
        fun remote(binder: IBinder): ISelfUpdateInstaller = object : ISelfUpdateInstaller {
            override fun asBinder(): IBinder = binder
            override fun exchange(request: Bundle, apk: ParcelFileDescriptor?): Bundle {
                val data = Parcel.obtain()
                val reply = Parcel.obtain()
                try {
                    data.writeInterfaceToken(DESCRIPTOR)
                    data.writeBundle(request)
                    data.writeInt(if (apk != null) 1 else 0)
                    apk?.writeToParcel(data, 0)
                    if (!binder.transact(IBinder.FIRST_CALL_TRANSACTION, data, reply, 0))
                        throw SelfUpdateException("protocolMismatch")
                    reply.readException()
                    return reply.readBundle(javaClass.classLoader) ?: throw SelfUpdateException("protocolMismatch")
                } finally { data.recycle(); reply.recycle() }
            }
        }
    }
}

/** A one-use Shizuku Binder, not a generic command service; all daemon lifetimes are bounded. */
@androidx.annotation.Keep
class SelfUpdateInstallerService(private val context: Context) : ISelfUpdateInstaller.Stub() {
    private val appUid = context.applicationInfo.uid
    private val instance = UUID.randomUUID().toString()
    private val guard = Any()
    @Volatile private var requestId: String? = null
    @Volatile private var result: SelfUpdateReceipt? = null
    @Volatile private var process: java.lang.Process? = null
    private val dispatched = AtomicBoolean(false)

    init {
        Thread({
            try { Thread.sleep(SelfUpdatePolicy.PREPARED_TTL_MS + SelfUpdatePolicy.INSTALL_TIMEOUT_MS) }
            catch (_: InterruptedException) { }
            runCatching { process?.destroyForcibly() }
            exitProcess(0)
        }, "dsh-update-service-lifetime").apply { isDaemon = true; start() }
    }

    override fun exchange(request: Bundle, apk: ParcelFileDescriptor?): Bundle {
        if (Binder.getCallingUid() != appUid) {
            apk?.close()
            throw SecurityException("identityChanged")
        }
        if (request.getString("revision") != SelfUpdatePolicy.REVISION) {
            apk?.close()
            return updateBundle(SelfUpdateReceipt("unavailable", "protocolMismatch").toMap())
        }
        try {
            SelfUpdatePolicy.requireIdentity(Process.myUid())
            return when (request.getString("op")) {
                "probe" -> {
                    apk?.close()
                    updateBundle(mapOf("revision" to SelfUpdatePolicy.REVISION, "instance" to instance,
                        "uid" to Process.myUid(), "busy" to synchronized(guard) { requestId != null }))
                }
                "start" -> {
                    if (request.getString("instance") != instance) throw SelfUpdateException("identityChanged")
                    start(request, apk ?: throw SelfUpdateException("invalidArguments"))
                }
                "poll" -> {
                    apk?.close()
                    if (request.getString("instance") != instance || request.getString("requestId") != requestId)
                        throw SelfUpdateException("identityChanged")
                    updateBundle((result?.toMap() ?: mapOf("done" to false)) + mapOf("done" to (result != null)))
                }
                else -> throw SelfUpdateException("invalidArguments")
            }
        } catch (error: Exception) {
            runCatching { apk?.close() }
            return updateBundle(SelfUpdateReceipt("unavailable", (error as? SelfUpdateException)?.code ?: "unavailable").toMap() + mapOf("done" to true))
        }
    }

    private fun start(request: Bundle, apk: ParcelFileDescriptor): Bundle {
        val id = request.getString("requestId") ?: throw SelfUpdateException("invalidArguments")
        if (runCatching { UUID.fromString(id).toString() }.getOrNull() != id) throw SelfUpdateException("invalidArguments")
        val size = request.getLong("size", -1)
        val version = request.getLong("versionCode", -1)
        val sha = SelfUpdatePolicy.digest(request.getString("sha256").orEmpty())
        val userId = request.getInt("userId", -1)
        if (userId != appUid / 100000 || version <= 0) throw SelfUpdateException("invalidArguments")
        SelfUpdatePolicy.installArgv(userId, size)
        synchronized(guard) {
            if (requestId != null) throw SelfUpdateException("busy")
            requestId = id
        }
        Thread({
            val timedOut = AtomicBoolean(false)
            val completed = AtomicBoolean(false)
            val timer = Thread({
                try {
                    Thread.sleep(SelfUpdatePolicy.INSTALL_TIMEOUT_MS)
                    if (!completed.get()) {
                        synchronized(guard) {
                            timedOut.set(true)
                            runCatching { process?.destroyForcibly() }
                        }
                        runCatching { apk.close() }
                    }
                } catch (_: InterruptedException) { }
            }, "dsh-update-install-deadline").apply { isDaemon = true; start() }
            try {
                result = runInstall(apk, size, sha, version, userId, timedOut)
                if (timedOut.get()) result = SelfUpdatePolicy.unknown()
            } catch (error: Exception) {
                result = if (dispatched.get() || timedOut.get()) SelfUpdatePolicy.unknown() else {
                    val code = stableSelfUpdateFailure(error).code
                    val status = when (code) {
                        "storage" -> "storage"
                        "unavailable" -> "unavailable"
                        else -> "invalid"
                    }
                    SelfUpdateReceipt(status, code)
                }
            } finally {
                completed.set(true)
                timer.interrupt()
                runCatching { apk.close() }
                // A live system session can outlive this helper; never infer cancellation from exit.
                Thread({ try { Thread.sleep(1500) } catch (_: InterruptedException) { }; exitProcess(0) },
                    "dsh-update-service-exit").apply { isDaemon = true; start() }
            }
        }, "dsh-update-install").apply { isDaemon = true; start() }
        return updateBundle(mapOf("done" to false))
    }

    private fun runInstall(apk: ParcelFileDescriptor, size: Long, sha: String, version: Long, userId: Int, timedOut: AtomicBoolean): SelfUpdateReceipt {
        cleanupSelfUpdateDirectories(File("/data/local/tmp"))
        val directory = File("/data/local/tmp", "dsh-self-update-" + UUID.randomUUID().toString())
        if (!directory.mkdir()) throw SelfUpdateException("storage")
        Os.chmod(directory.path, 448)
        val file = File(directory, "base.apk")
        try {
            // FileOutputStream(fd) leaves this caller-owned descriptor open on Android.
            val fd = Os.open(file.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_CLOEXEC, 384)
            try {
                ParcelFileDescriptor.AutoCloseInputStream(apk).use { input ->
                    FileOutputStream(fd).use { output ->
                        SelfUpdatePolicy.copyVerified(input, output, size, sha)
                        output.fd.sync()
                    }
                }
            } finally { Os.close(fd) }
            Os.chmod(file.path, 256)
            SelfUpdatePolicy.requireIdentity(Process.myUid())
            val snapshot = SelfUpdateSnapshot(file, size)
            snapshot.use {
                it.verifyHash(sha)
                SelfUpdateApks(context).validate(file, version)
                it.verifyPath()
                val child = ProcessBuilder(SelfUpdatePolicy.installArgv(userId, size)).apply {
                    environment().clear()
                    environment().putAll(mapOf("PATH" to "/system/bin:/system/xbin", "ANDROID_ROOT" to "/system", "ANDROID_DATA" to "/data"))
                    redirectErrorStream(true)
                }
                val launched = synchronized(guard) {
                    if (timedOut.get()) throw SelfUpdateException("outcomeUnknown")
                    dispatched.set(true)
                    child.start().also { process = it }
                }
                return SelfUpdateStreams.exchange(it.input(), size, sha, launched.inputStream, launched.outputStream,
                    exitCode = { if (launched.waitFor(2, TimeUnit.SECONDS)) launched.exitValue() else null },
                    close = {
                        runCatching { launched.inputStream.close() }
                        runCatching { launched.outputStream.close() }
                        runCatching { launched.errorStream.close() }
                        runCatching { launched.destroyForcibly() }
                    })
            }
        } finally {
            file.delete()
            directory.delete()
        }
    }

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == ISelfUpdateInstaller.DESTROY) {
            val caller = Binder.getCallingUid()
            if (caller != appUid && caller != Process.myUid()) throw SecurityException("identityChanged")
            data.enforceInterface(ISelfUpdateInstaller.DESCRIPTOR)
            // Detaching the app is not a request to revoke a system commit already in flight.
            if (synchronized(guard) { requestId == null }) exitProcess(0)
            return true
        }
        return super.onTransact(code, data, reply, flags)
    }
}
