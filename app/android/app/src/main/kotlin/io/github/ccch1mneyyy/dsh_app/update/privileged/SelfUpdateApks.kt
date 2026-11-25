package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipFile

internal data class SelfUpdateInstalled(val identity: SelfUpdateIdentity, val source: File, val lastUpdateTime: Long)

internal class SelfUpdateApks(private val context: Context) {
    private val pm get() = context.packageManager

    fun installed(): SelfUpdateIdentity = identity(installedInfo())

    fun installedSnapshot(): SelfUpdateInstalled {
        val info = installedInfo()
        return SelfUpdateInstalled(identity(info), File(info.applicationInfo?.sourceDir
            ?: throw SelfUpdateException("installedUnavailable")), info.lastUpdateTime)
    }

    fun inspect(file: File): SelfUpdateIdentity {
        val info = if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
                ?.takeIf { it.signingInfo != null }
        } else null
        @Suppress("DEPRECATION")
        return identity(info ?: pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNATURES)
            ?: throw SelfUpdateException("invalidApk"))
    }

    fun validate(file: File, version: Long): SelfUpdateIdentity {
        val candidate = inspect(file)
        SelfUpdatePolicy.validate(candidate, installed(), version)
        checkAbi(file)
        return candidate
    }

    private fun installedInfo(): PackageInfo {
        if (context.packageName != SelfUpdatePolicy.PACKAGE) throw SelfUpdateException("packageMismatch")
        val info = if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(SelfUpdatePolicy.PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES)
                .takeIf { it.signingInfo != null }
        } else null
        @Suppress("DEPRECATION")
        return info ?: pm.getPackageInfo(SelfUpdatePolicy.PACKAGE, PackageManager.GET_SIGNATURES)
    }

    private fun identity(info: PackageInfo): SelfUpdateIdentity {
        val current: Set<String>
        val history: Set<String>
        val signing = if (Build.VERSION.SDK_INT >= 28) info.signingInfo else null
        if (signing != null) {
            current = signing.apkContentsSigners.orEmpty().map { fingerprint(it.toByteArray()) }.toSet()
            history = if (signing.hasMultipleSigners()) current
                else signing.signingCertificateHistory.orEmpty().map { fingerprint(it.toByteArray()) }.toSet() + current
        } else {
            @Suppress("DEPRECATION")
            val legacy = info.signatures.orEmpty().map { fingerprint(it.toByteArray()) }.toSet()
            current = legacy
            history = legacy
        }
        return SelfUpdateIdentity(info.packageName, if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }, info.versionName, current, history)
    }

    private fun checkAbi(file: File) {
        val expected = when (File(context.applicationInfo.nativeLibraryDir.orEmpty()).name) {
            "arm64" -> "arm64-v8a"
            "arm" -> "armeabi-v7a"
            "x86_64" -> "x86_64"
            "x86" -> "x86"
            else -> null
        }
        ZipFile(file).use { zip ->
            val abis = mutableSetOf<String>()
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val parts = entry.name.split('/')
                if (!entry.isDirectory && parts.size == 3 && parts[0] == "lib" && parts[2].endsWith(".so"))
                    abis += parts[1]
            }
            if (abis.isNotEmpty() && (expected != null && expected !in abis ||
                    expected == null && abis.none { it in Build.SUPPORTED_ABIS }))
                throw SelfUpdateException("unsupportedAbi")
        }
    }

    private fun fingerprint(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
