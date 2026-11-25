package io.github.ccch1mneyyy.dsh_app.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File
import java.security.MessageDigest

/**
 * Self-update through the PackageInstaller session API: the APK is streamed into a
 * session (no FileProvider, no content:// URI), the system shows its confirm dialog,
 * and the outcome comes back as a broadcast to a receiver registered for that one
 * session. On success the system replaces this process, so callers rarely see it.
 */
class ApkInstaller(private val context: Context) {

    private val pm: PackageManager get() = context.packageManager

    fun info(): Map<String, Any?> {
        val pkg = pm.getPackageInfo(context.packageName, 0)
        return mapOf(
            "versionName" to pkg.versionName,
            "versionCode" to versionCodeOf(pkg),
            // .../lib/arm64 or .../lib/x86_64: the ABI this APK was built for.
            "abi" to context.applicationInfo.nativeLibraryDir?.let { File(it).name },
            "sdkInt" to Build.VERSION.SDK_INT,
            "canRequestInstalls" to canRequestInstalls(),
            "freeBytes" to context.cacheDir.usableSpace,
            // The base delta patches start from, and what tells one installed build from another.
            "apkPath" to context.applicationInfo.sourceDir,
            "lastUpdateTime" to pkg.lastUpdateTime,
        )
    }

    /** Android 8+: the per-app "install unknown apps" switch. */
    fun canRequestInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || pm.canRequestPackageInstalls()

    /** The system page for that switch, or false when this ROM has none. */
    fun openInstallPermission(launcher: Context?): Boolean {
        val intents = listOf(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
        )
        for (intent in intents) {
            val started = runCatching {
                if (launcher != null) {
                    launcher.startActivity(intent)
                } else {
                    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }.isSuccess
            if (started) return true
        }
        return false
    }

    /** Package, version and signer of [apk] compared with the installed app. Slow: verifies the APK. */
    fun inspect(apk: File): Map<String, Any?> {
        val archive = archiveInfo(apk) ?: return mapOf("valid" to false)
        val installed = installedInfo()
        return mapOf(
            "valid" to true,
            "packageName" to archive.packageName,
            "versionName" to archive.versionName,
            "versionCode" to versionCodeOf(archive),
            "samePackage" to (archive.packageName == context.packageName),
            "signatureMatches" to signersMatch(archive, installed),
        )
    }

    /**
     * Writes [apk] into a new session and commits it. [onResult] gets exactly one map
     * `{status, message}` once the session ends; `confirm` launches the system dialog
     * (false when it couldn't).
     * Runs on the caller's thread (not the main one: the copy takes seconds).
     */
    fun install(apk: File, confirm: (Intent) -> Boolean, onResult: (Map<String, Any?>) -> Unit) {
        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        val sessionId = try {
            installer.createSession(params)
        } catch (e: Exception) {
            return onResult(result(failureStatus(e), e.message))
        }
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { out ->
                        input.copyTo(out, 1 shl 16)
                        session.fsync(out)
                    }
                }
                val action = "${context.packageName}.UPDATE_INSTALL_STATUS.$sessionId"
                register(action, sessionId, confirm, onResult)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    // The installer fills in the status extras.
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(action).setPackage(context.packageName),
                    flags,
                )
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            onResult(result(failureStatus(e), e.message))
        }
    }

    private fun register(action: String, sessionId: Int, confirm: (Intent) -> Boolean, onResult: (Map<String, Any?>) -> Unit) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    val dialog = confirmIntent(intent)
                    if (dialog != null && confirm(dialog)) return
                    // No way to ask the person: give the session up instead of leaving it pending.
                    runCatching { pm.packageInstaller.abandonSession(sessionId) }
                }
                runCatching { context.unregisterReceiver(this) }
                onResult(result(statusName(status, message), message))
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Our own PendingIntent delivers it, so it need not be exported.
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            context.registerReceiver(receiver, filter)
        }
    }

    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    private fun archiveInfo(apk: File): PackageInfo? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val info = pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            // Android 9 leaves signingInfo null for archives; GET_SIGNATURES still works there.
            if (info?.signingInfo != null) return info
        }
        @Suppress("DEPRECATION")
        return pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNATURES)
    }

    private fun installedInfo(): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
        }

    /** (current signers, signers including past ones in the rotation lineage), as SHA-256 hex. */
    private fun signers(info: PackageInfo): Pair<Set<String>, Set<String>>? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.let { signing ->
                val current = signing.apkContentsSigners.map(::fingerprint).toSet()
                val history = if (signing.hasMultipleSigners()) current
                else signing.signingCertificateHistory.map(::fingerprint).toSet() + current
                return current to history
            }
        }
        @Suppress("DEPRECATION")
        val legacy = info.signatures?.map(::fingerprint)?.toSet() ?: return null
        return legacy to legacy
    }

    /**
     * Whether the system would accept [archive] as an update of [installed]: the same
     * signer set, or a rotated key whose lineage includes the installed signer.
     * Null when either side's signers can't be read.
     */
    private fun signersMatch(archive: PackageInfo, installed: PackageInfo): Boolean? {
        val (newCurrent, newHistory) = signers(archive) ?: return null
        val (oldCurrent, _) = signers(installed) ?: return null
        if (newCurrent.isEmpty() || oldCurrent.isEmpty()) return null
        // Multiple signers form one identity; only single-signer packages can rotate.
        return newCurrent == oldCurrent ||
            (newCurrent.size == 1 && oldCurrent.size == 1 && newHistory.containsAll(oldCurrent))
    }

    private fun fingerprint(signature: android.content.pm.Signature): String =
        MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }

    companion object {
        fun versionCodeOf(info: PackageInfo): Long =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }

        private fun result(status: String, message: String?) = mapOf("status" to status, "message" to message)

        internal fun failureStatus(error: Exception): String {
            if (error !is java.io.IOException) return "failure"
            val message = error.message.orEmpty()
            // AOSP can reject the default INTERNAL_ONLY session before it has a status callback.
            return if (message.contains("ENOSPC") || message == "Requested internal only, but not enough space")
                "storage" else "failure"
        }

        /**
         * PackageInstaller status → the Dart `InstallStatus` name. A signature mismatch
         * arrives as STATUS_FAILURE_CONFLICT (INSTALL_FAILED_UPDATE_INCOMPATIBLE) and a
         * downgrade as STATUS_FAILURE_INCOMPATIBLE; the message tells them apart.
         */
        fun statusName(status: Int, message: String?): String {
            val text = message.orEmpty()
            return when {
                status == PackageInstaller.STATUS_SUCCESS -> "success"
                text.contains("UPDATE_INCOMPATIBLE") || text.contains("signatures do not match", ignoreCase = true) -> "signature"
                text.contains("VERSION_DOWNGRADE") -> "downgrade"
                status == PackageInstaller.STATUS_FAILURE_ABORTED -> "aborted"
                status == PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
                status == PackageInstaller.STATUS_FAILURE_CONFLICT -> "conflict"
                status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
                status == PackageInstaller.STATUS_FAILURE_INVALID -> "invalid"
                status == PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
                else -> "failure"
            }
        }
    }
}
