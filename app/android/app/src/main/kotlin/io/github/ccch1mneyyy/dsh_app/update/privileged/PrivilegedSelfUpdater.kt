package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.content.Context
import android.os.Process
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Dedicated self-update lifecycle. It never enables PhoneControl or the general shell capability. */
class PrivilegedSelfUpdater(context: Context) {
    private val context = context.applicationContext
    private val owner = Any()
    private val preferences = this.context.getSharedPreferences("self-update-pending-v1", Context.MODE_PRIVATE)
    private val apks = SelfUpdateApks(this.context)

    fun status(): Map<String, Any?> = mapOf(
        "v" to 1,
        "shizuku" to SelfUpdateShizuku.status(context),
        "adb" to mapOf("paired" to File(context.filesDir, "phone-adb/paired").isFile),
        "pending" to pendingMap(),
    )

    fun requestShizukuPermission(): Boolean = SelfUpdateShizuku.requestPermission()

    fun prepare(path: String, sha256: String, versionCode: Long, backend: String, port: Int? = null): PreparedSelfUpdate {
        if (backend !in setOf("shizuku", "adb") || versionCode <= 0 ||
            port != null && (backend != "adb" || port !in 1..65535)) throw SelfUpdateException("invalidArguments")
        val digest = SelfUpdatePolicy.digest(sha256)
        val ticket = Any()
        synchronized(globalGuard) {
            if (reservation != null) throw SelfUpdateException("busy")
            reservation = ticket
        }
        var snapshot: SelfUpdateSnapshot? = null
        var transport: SelfUpdateTransport? = null
        try {
            val pending = reconcile()
            if (pending["state"] == "unknown" || pending["state"] == "pending")
                throw SelfUpdateException("outcomeUnknown")
            val updates = File(context.cacheDir, "updates")
            if (updates.canonicalFile != File(context.cacheDir.canonicalFile, "updates"))
                throw SelfUpdateException("invalidPath")
            val source = SelfUpdatePolicy.inputFile(path, updates)
            cleanupSnapshots()
            snapshot = snapshot(source, digest)
            snapshot.verifyHash(digest)
            val identity = apks.validate(snapshot.file, versionCode)
            snapshot.verifyPath()
            transport = if (backend == "shizuku") SelfUpdateShizuku.connect(context) else SelfUpdateAdb.connect(context, port)
            SelfUpdatePolicy.requireIdentity(transport.uid)
            val prepared = PreparedSelfUpdate(identity.versionName.orEmpty(), versionCode, digest, backend,
                transport.uid, owner, snapshot, identity, transport, System.nanoTime()) {
                synchronized(globalGuard) { if (reservation === ticket) reservation = null }
            }
            return prepared
        } catch (error: Exception) {
            runCatching { transport?.close() }
            runCatching { snapshot?.close() }
            synchronized(globalGuard) { if (reservation === ticket) reservation = null }
            throw stableSelfUpdateFailure(error)
        }
    }

    /** The caller must show its native confirmation after prepare and before this one-shot call. */
    fun install(prepared: PreparedSelfUpdate): Map<String, Any?> {
        if (prepared.owner !== owner || prepared.closed.get() || !prepared.consumed.compareAndSet(false, true))
            return SelfUpdateReceipt("invalid", "confirmationExpired").toMap()
        var receipt: SelfUpdateReceipt
        var persisted = false
        try {
            if (System.nanoTime() - prepared.createdNanos > TimeUnit.MILLISECONDS.toNanos(SelfUpdatePolicy.PREPARED_TTL_MS))
                throw SelfUpdateException("confirmationExpired")
            prepared.snapshot.verifyHash(prepared.sha256)
            val now = apks.validate(prepared.snapshot.file, prepared.versionCode)
            prepared.snapshot.verifyPath()
            if (now.signers != prepared.identity.signers) throw SelfUpdateException("snapshotChanged")
            prepared.transport.verifyIdentity()
            SelfUpdatePolicy.requireIdentity(prepared.transport.uid)
            val requestId = UUID.randomUUID().toString()
            // A synchronous durable write precedes even opening the install stream or the Binder start RPC.
            synchronized(globalGuard) {
                if (!preferences.edit().clear().putString("state", "pending").putString("backend", prepared.backend)
                        .putString("requestId", requestId).putLong("versionCode", prepared.versionCode)
                        .putLong("size", prepared.snapshot.size).putString("sha256", prepared.sha256)
                        .putStringSet("signers", prepared.identity.signers).commit()) {
                    // commit already changed memory; this attempt never reached the transport.
                    preferences.edit().clear().apply()
                    throw SelfUpdateException("persistenceFailed")
                }
                persisted = true
                installing = true
            }
            prepared.submitted.set(true)
            receipt = prepared.transport.install(prepared, Process.myUid() / 100000, requestId)
            if (receipt.status == "success") {
                val actual = reconcile()
                receipt = if (actual["state"] == "installed" || actual["state"] == "superseded")
                    SelfUpdateReceipt("success", submitted = true) else SelfUpdatePolicy.unknown()
            }
        } catch (error: Exception) {
            receipt = if (persisted) SelfUpdatePolicy.unknown() else SelfUpdateReceipt("unavailable", stableSelfUpdateFailure(error).code)
        } finally {
            synchronized(globalGuard) { installing = false }
        }
        if (persisted) {
            val actual = reconcile()
            synchronized(globalGuard) {
                val state = when {
                    actual["state"] == "installed" || actual["state"] == "superseded" -> {
                        receipt = SelfUpdateReceipt("success", submitted = true)
                        actual["state"] as String
                    }
                    receipt.outcomeUnknown || receipt.status == "success" -> "unknown"
                    else -> "failed"
                }
                if (state == "unknown") receipt = SelfUpdatePolicy.unknown()
                val saved = preferences.edit().putString("state", state).putString("errorCode", receipt.errorCode).commit()
                if (!saved && receipt.status != "success") receipt = SelfUpdatePolicy.unknown()
            }
        }
        prepared.close()
        return receipt.toMap()
    }

    /** A request or CLI Success is not installation evidence: only the live installed APK is. */
    fun reconcile(): Map<String, Any?> {
        val before = synchronized(globalGuard) { pendingRecord() }
        val (requestId, pending) = before
        if (pending.state == "none") return mapOf("state" to "none", "canAcknowledge" to false)
        var verifiedLastUpdateTime = 0L
        val next = try {
            val actual = apks.installedSnapshot()
            val installed = actual.identity
            val source = actual.source.takeIf { installed.versionCode == pending.versionCode }
            val size = source?.length()
            // Only a previously digest-verified installed receipt can skip the APK read.
            val cached = SelfUpdateRecovery.canReuseInstalled(pending, installed, size, actual.lastUpdateTime)
            val hash = if (cached) null else source?.inputStream()?.use { SelfUpdatePolicy.hash(it) }
            SelfUpdateRecovery.state(pending, installed, size, hash, synchronized(globalGuard) { installing }, actual.lastUpdateTime)
                .also { if (it == "installed") verifiedLastUpdateTime = actual.lastUpdateTime.coerceAtLeast(0) }
        } catch (_: Exception) { "unknown" }
        return synchronized(globalGuard) {
            // Hashing is slow. Never overwrite a newer request or a concurrently finalized receipt.
            if (pendingRecord() == before && preferences.getString("requestId", null) == requestId) {
                preferences.edit().putString("state", next)
                    .putLong("verifiedLastUpdateTime", if (next == "installed") verifiedLastUpdateTime else 0)
                    .putString("errorCode", if (next == "unknown") "outcomeUnknown" else if (next == "failed")
                        preferences.getString("errorCode", "systemRejected") else null).commit()
            }
            pendingMap()
        }
    }

    /** Risk confirmation belongs to the native UI; this acknowledges no install and sends nothing. */
    fun acknowledgeUnknown(): Map<String, Any?> {
        val current = reconcile()
        if (current["state"] == "installed" || current["state"] == "superseded") return current
        synchronized(globalGuard) {
            val latest = pendingMap()
            if (installing || reservation != null || latest["state"] != "unknown") return latest
            if (!preferences.edit().putString("state", "none").commit()) {
                // commit changes memory even on failure. Keep the receipt for an explicit retry.
                preferences.edit().putString("state", "unknown").commit()
                return latest + mapOf("errorCode" to "persistenceFailed")
            }
            runCatching { cleanupSnapshots() }
        }
        return mapOf("state" to "none", "canAcknowledge" to false)
    }

    private fun pendingRecord(): Pair<String?, SelfUpdatePending> =
        preferences.getString("requestId", null) to SelfUpdatePending(
            preferences.getString("state", "none") ?: "none", preferences.getLong("versionCode", -1),
            preferences.getString("sha256", null), preferences.getStringSet("signers", emptySet()).orEmpty().toSet(),
            preferences.getLong("size", -1), preferences.getLong("verifiedLastUpdateTime", 0))

    private fun pendingMap(): Map<String, Any?> = synchronized(globalGuard) {
        val state = preferences.getString("state", "none") ?: "none"
        if (state == "none") return@synchronized mapOf("state" to "none", "canAcknowledge" to false)
        mapOf("state" to state, "backend" to preferences.getString("backend", null),
            "versionCode" to preferences.getLong("versionCode", -1), "errorCode" to preferences.getString("errorCode", null),
            "canAcknowledge" to (state == "unknown" && !installing && reservation == null))
    }

    private fun snapshot(source: File, digest: String): SelfUpdateSnapshot {
        val directory = File(context.filesDir, "self-update-v1")
        if (!directory.isDirectory && !directory.mkdir()) throw SelfUpdateException("storage")
        if (directory.canonicalFile != File(context.filesDir.canonicalFile, "self-update-v1")) throw SelfUpdateException("invalidPath")
        val file = File(directory, UUID.randomUUID().toString() + ".apk")
        try {
            // Android streams constructed from a FileDescriptor do not own it.
            val fd = Os.open(source.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
            val size = try {
                FileInputStream(fd).use { input ->
                    val stat = Os.fstat(fd)
                    if (!OsConstants.S_ISREG(stat.st_mode)) throw SelfUpdateException("invalidPath")
                    val outFd = Os.open(file.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_CLOEXEC, 384)
                    try {
                        FileOutputStream(outFd).use { output ->
                            SelfUpdatePolicy.copyVerified(input, output, stat.st_size, digest)
                            output.fd.sync()
                        }
                    } finally { Os.close(outFd) }
                    stat.st_size
                }
            } finally { Os.close(fd) }
            Os.chmod(file.path, 256)
            return SelfUpdateSnapshot(file, size)
        } catch (error: Exception) {
            file.delete()
            throw error
        }
    }

    private fun cleanupSnapshots() {
        val directory = File(context.filesDir, "self-update-v1")
        if (!directory.isDirectory || directory.canonicalFile != File(context.filesDir.canonicalFile, "self-update-v1")) return
        val names = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]apk")
        directory.listFiles().orEmpty().filter { names.matches(it.name) }.forEach { file ->
            runCatching { if (OsConstants.S_ISREG(Os.lstat(file.path).st_mode)) file.delete() }
        }
    }

    private companion object {
        val globalGuard = Any()
        var reservation: Any? = null
        var installing = false
    }
}

internal fun stableSelfUpdateFailure(error: Exception): SelfUpdateException = when {
    error is SelfUpdateException -> error
    // Os.open throws errno directly; FileOutputStream.write wraps it in IOException.
    (error as? ErrnoException ?: error.cause as? ErrnoException)?.errno == OsConstants.ENOSPC ->
        SelfUpdateException("storage")
    else -> SelfUpdateException("unavailable")
}
