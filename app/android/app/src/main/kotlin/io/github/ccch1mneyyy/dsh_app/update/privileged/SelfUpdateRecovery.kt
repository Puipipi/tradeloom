package io.github.ccch1mneyyy.dsh_app.update.privileged

/** Persisted receipt summary only: no APK path, pairing material or shell command. */
internal data class SelfUpdatePending(
    val state: String,
    val versionCode: Long,
    val sha256: String?,
    val signers: Set<String>,
    val size: Long,
    val verifiedLastUpdateTime: Long = 0,
)

internal object SelfUpdateRecovery {
    fun canReuseInstalled(pending: SelfUpdatePending, installed: SelfUpdateIdentity, installedSize: Long?, lastUpdateTime: Long?): Boolean =
        pending.state == "installed" && pending.verifiedLastUpdateTime > 0 &&
            pending.verifiedLastUpdateTime == lastUpdateTime && pending.sha256 != null &&
            installed.packageName == SelfUpdatePolicy.PACKAGE && installed.versionCode == pending.versionCode &&
            SelfUpdatePolicy.sameSigner(installed, SelfUpdateIdentity(SelfUpdatePolicy.PACKAGE, pending.versionCode, null, pending.signers)) &&
            pending.size > 0 && installedSize == pending.size

    fun state(pending: SelfUpdatePending, installed: SelfUpdateIdentity, installedSize: Long?, installedHash: String?, inFlight: Boolean, lastUpdateTime: Long? = null): String = when {
        installedHash == null && canReuseInstalled(pending, installed, installedSize, lastUpdateTime) -> "installed"
        installed.packageName != SelfUpdatePolicy.PACKAGE || pending.signers.isEmpty() -> "unknown"
        installed.versionCode == pending.versionCode && installed.signers == pending.signers &&
            installedSize == pending.size && installedHash != null && installedHash == pending.sha256 -> "installed"
        installed.versionCode > pending.versionCode && SelfUpdatePolicy.sameSigner(installed,
            SelfUpdateIdentity(SelfUpdatePolicy.PACKAGE, pending.versionCode, null, pending.signers)) -> "superseded"
        pending.state == "failed" -> "failed"
        inFlight -> "pending"
        else -> "unknown"
    }
}
