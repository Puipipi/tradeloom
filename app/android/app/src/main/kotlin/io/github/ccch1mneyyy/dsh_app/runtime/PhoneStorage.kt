package io.github.ccch1mneyyy.dsh_app.runtime

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings

/**
 * Optional access to the phone's shared storage from the Linux environment.
 *
 * With targetSdk 28 the app keeps legacy external storage, so the classic
 * READ/WRITE_EXTERNAL_STORAGE grant is enough; "All files access" is the fallback
 * for devices that don't honour legacy mode.
 */
object PhoneStorage {
    /** Guest path the phone's internal storage appears at. */
    const val GUEST_PATH = "/sdcard"

    fun hostRoot(): String = Environment.getExternalStorageDirectory().absolutePath // /storage/emulated/0

    fun isGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) return true
        val write = context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        if (!write) return false
        // Legacy view: the permission really grants file-path access to shared storage.
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Environment.isExternalStorageLegacy()
    }

    fun status(context: Context): Map<String, Any?> = mapOf(
        "granted" to isGranted(context),
        "permission" to (context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED),
        "legacy" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Environment.isExternalStorageLegacy()),
        "guestPath" to GUEST_PATH,
        "hostPath" to hostRoot(),
    )

    /** proot `-b` values: the phone's storage at /sdcard, plus /storage for absolute paths apps share. */
    fun binds(): List<String> {
        // Skip the mount rather than fail the launch when the path isn't readable.
        if (!java.io.File(hostRoot()).canRead()) return emptyList()
        return listOf("${hostRoot()}:$GUEST_PATH", "/storage")
    }

    /** `/root/手机存储` → `/sdcard` inside the rootfs, present only while the mode is on. */
    fun syncShortcut(rootfs: java.io.File, enabled: Boolean) {
        // l10n:keep guest filesystem path
        val link = java.io.File(rootfs, "root/手机存储")
        try {
            val info = android.system.Os.lstat(link.path)
            if (!enabled && android.system.OsConstants.S_ISLNK(info.st_mode) &&
                android.system.Os.readlink(link.path) == GUEST_PATH) {
                link.delete()
            }
            return
        } catch (_: Exception) {
            // absent
        }
        if (enabled) runCatching { android.system.Os.symlink(GUEST_PATH, link.path) }
    }

    /** Opens the system "All files access" page for this app (Android 11+). */
    fun allFilesAccessIntent(context: Context): Intent? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
