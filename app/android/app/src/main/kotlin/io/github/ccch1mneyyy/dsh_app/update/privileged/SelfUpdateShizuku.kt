package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.os.ParcelFileDescriptor
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.atomic.AtomicBoolean
import rikka.shizuku.Shizuku
import rikka.sui.Sui

internal class SelfUpdateShizuku private constructor(
    private val args: Shizuku.UserServiceArgs,
    private val connection: ServiceConnection,
    private val binder: IBinder,
    private val instance: String,
    override val uid: Int,
) : SelfUpdateTransport {
    private val remote = ISelfUpdateInstaller.remote(binder)
    private val closed = AtomicBoolean(false)
    private val submitted = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "dsh-update-rpc").apply { isDaemon = true } }

    override fun verifyIdentity() {
        if (!granted() || !binder.isBinderAlive || closed.get()) throw SelfUpdateException("permissionRequired")
        val response = rpc(updateBundle(mapOf("op" to "probe")))
        SelfUpdatePolicy.requireIdentity(response.getInt("uid", -1))
        if (response.getString("instance") != instance || response.getString("revision") != SelfUpdatePolicy.REVISION)
            throw SelfUpdateException("identityChanged")
    }

    override fun install(prepared: PreparedSelfUpdate, userId: Int, requestId: String): SelfUpdateReceipt {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(SelfUpdatePolicy.INSTALL_TIMEOUT_MS + 2000)
        submitted.set(true)
        return try {
            var response = prepared.snapshot.duplicate().use { apk ->
                rpc(updateBundle(mapOf("op" to "start", "requestId" to requestId, "size" to prepared.snapshot.size,
                    "sha256" to prepared.sha256, "versionCode" to prepared.versionCode, "userId" to userId)), apk)
            }
            while (!response.getBoolean("done")) {
                if (System.nanoTime() >= deadline) return SelfUpdatePolicy.unknown()
                Thread.sleep(100)
                response = rpc(updateBundle(mapOf("op" to "poll", "requestId" to requestId)))
            }
            response.updateReceipt()
        } catch (error: Exception) {
            if (error is InterruptedException) Thread.currentThread().interrupt()
            SelfUpdatePolicy.unknown()
        }
    }

    private fun rpc(body: Bundle, apk: ParcelFileDescriptor? = null): Bundle {
        if (closed.get() || !binder.isBinderAlive) throw SelfUpdateException("transportLost")
        body.putString("revision", SelfUpdatePolicy.REVISION)
        body.putString("instance", instance)
        val future = worker.submit<Bundle> { remote.exchange(body, apk) }
        return try { future.get(5, TimeUnit.SECONDS) } catch (error: Exception) {
            future.cancel(true)
            if (error is InterruptedException) Thread.currentThread().interrupt()
            throw SelfUpdateException("transportLost")
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        worker.shutdownNow()
        detach(args, connection, remove = !submitted.get())
    }

    companion object {
        // A wedged SDK Binder call occupies at most one daemon thread, never the main thread.
        private val sdk = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(4),
            { task -> Thread(task, "dsh-update-shizuku-sdk").apply { isDaemon = true } }).apply { allowCoreThreadTimeOut(true) }
        private const val REQUEST_CODE = 4612

        private fun <T> sdkCall(action: () -> T): T? {
            val future = runCatching { sdk.submit<T> { action() } }.getOrNull() ?: return null
            return try { future.get(2, TimeUnit.SECONDS) } catch (error: Exception) {
                future.cancel(true)
                sdk.remove(future as Runnable)
                if (error is InterruptedException) Thread.currentThread().interrupt()
                null
            }
        }

        private fun sdkAsync(action: () -> Unit): Boolean = runCatching {
            sdk.execute { runCatching { action() } }
            true
        }.getOrDefault(false)

        fun status(context: Context): Map<String, Any?> = mapOf(
            "installed" to (runCatching { context.packageManager.getApplicationInfo("moe.shizuku.privileged.api", 0); true }.getOrDefault(false) || Sui.isSui()),
            "running" to running(), "granted" to granted(),
        )

        private fun running(): Boolean = runCatching { Shizuku.getBinder()?.isBinderAlive == true }.getOrDefault(false)
        private fun granted(): Boolean = running() &&
            sdkCall { Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED } == true

        fun requestPermission(): Boolean = running() && sdkAsync { Shizuku.requestPermission(REQUEST_CODE) }

        fun connect(context: Context): SelfUpdateShizuku {
            val status = status(context)
            if (status["installed"] != true) throw SelfUpdateException("shizukuMissing")
            if (status["running"] != true) throw SelfUpdateException("shizukuStopped")
            if (status["granted"] != true) throw SelfUpdateException("permissionRequired")
            val args = Shizuku.UserServiceArgs(ComponentName(context, SelfUpdateInstallerService::class.java))
                .tag(SelfUpdatePolicy.TAG).processNameSuffix("self_update").version(1).daemon(true)
            val latch = CountDownLatch(1)
            val valid = AtomicBoolean(true)
            var remote: IBinder? = null
            val listener = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                    if (valid.get()) { remote = service; latch.countDown() }
                    else detach(args, this, false)
                }
                override fun onServiceDisconnected(name: ComponentName?) { latch.countDown() }
            }
            var result: SelfUpdateShizuku? = null
            try {
                if (!sdkAsync {
                        if (valid.get()) runCatching { Shizuku.bindUserService(args, listener) }.onFailure { latch.countDown() }
                    }) throw SelfUpdateException("connectFailed")
                if (!latch.await(15, TimeUnit.SECONDS)) throw SelfUpdateException("connectFailed")
                val binder = remote ?: throw SelfUpdateException("connectFailed")
                val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "dsh-update-probe").apply { isDaemon = true } }
                val probe = try {
                    executor.submit<Bundle> { ISelfUpdateInstaller.remote(binder).exchange(updateBundle(mapOf(
                        "op" to "probe", "revision" to SelfUpdatePolicy.REVISION))) }.get(5, TimeUnit.SECONDS)
                } finally { executor.shutdownNow() }
                if (probe.getString("revision") != SelfUpdatePolicy.REVISION) throw SelfUpdateException(probe.getString("errorCode") ?: "protocolMismatch")
                SelfUpdatePolicy.requireIdentity(probe.getInt("uid", -1))
                if (probe.getBoolean("busy")) throw SelfUpdateException("busy")
                val instance = probe.getString("instance") ?: throw SelfUpdateException("protocolMismatch")
                result = SelfUpdateShizuku(args, listener, binder, instance, probe.getInt("uid"))
                return result
            } catch (error: Exception) {
                if (error is InterruptedException) Thread.currentThread().interrupt()
                throw if (error is SelfUpdateException) error else SelfUpdateException("connectFailed")
            } finally {
                if (result == null) {
                    valid.set(false)
                    // Never destroy an older service which may still be committing an earlier request.
                    detach(args, listener, false)
                }
            }
        }

        private fun detach(args: Shizuku.UserServiceArgs, connection: ServiceConnection, remove: Boolean) {
            sdkAsync {
                runCatching { Shizuku.unbindUserService(args, connection, false) }
                if (remove) runCatching { Shizuku.unbindUserService(args, connection, true) }
            }
        }
    }
}
