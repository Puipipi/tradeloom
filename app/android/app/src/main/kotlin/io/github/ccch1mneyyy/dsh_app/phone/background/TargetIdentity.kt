package io.github.ccch1mneyyy.dsh_app.phone.background

import io.github.ccch1mneyyy.dsh_app.phone.PhoneAppIdentity

/**
 * The app a background-screen request is addressed to, and where an app is now. The background
 * screen is taken as it actually is: a read reports whichever app is on top, and only an action
 * meant for an app that is no longer on top is refused (once; a fresh read continues).
 */
internal object TargetIdentity {
    /** A request's target: the package plus the uid the App resolved. Same APK on both ends. */
    fun requested(pkg: String, uid: Any?): PhoneAppIdentity? = (uid as? Int)?.takeIf { it >= 0 }?.let { PhoneAppIdentity(pkg, it) }

    /** The app on top is [target]: same package, and the same uid when the uid could be read. */
    fun sameApp(shownPackage: String?, shownUid: Int?, target: PhoneAppIdentity): Boolean =
        shownPackage == target.packageName && (shownUid == null || shownUid == target.uid)

    /** Where an app that is not on top of the owned display is now, from one running-task read. */
    enum class Placement(val wire: String) { OTHER_DISPLAY("leftDisplay"), NONE("closed"), OWNED_DISPLAY("behind") }

    /** [tasks] are (displayId, packages of that task) rows. */
    fun placement(pkg: String, ownedDisplay: Int, tasks: List<Pair<Int, Set<String>>>): Placement = when {
        tasks.any { it.first == ownedDisplay && pkg in it.second } -> Placement.OWNED_DISPLAY
        tasks.any { pkg in it.second } -> Placement.OTHER_DISPLAY
        else -> Placement.NONE
    }

    fun supported(version: Any?): Boolean = version is Int && version == 1

    fun matches(expected: PhoneAppIdentity, packageName: String?, uid: Int?): Boolean =
        packageName == expected.packageName && uid == expected.uid

    /** A coordinate or navigation receipt names exactly the app it was taken from. */
    fun receipt(expected: PhoneAppIdentity, version: Any?, pkg: Any?, uid: Any?): Boolean =
        supported(version) && pkg is String && uid is Int && matches(expected, pkg, uid)

    /** The app a reply says is on top, or null when the screen has no app (or the reply names none). */
    fun shown(pkg: Any?, uid: Any?): PhoneAppIdentity? =
        if (pkg is String && uid is Int && uid >= 0) PhoneAppIdentity(pkg, uid) else null

    /** Used only after the real open's OwnerScope envelope has matched its pinned resource. */
    fun backgroundOpenConfirmed(expected: PhoneAppIdentity, ok: Any?, evidence: Any?, displayId: Any?,
                                targetVersion: Any?, pkg: Any?, uid: Any?): Boolean =
        ok is Boolean && ok && evidence is Int && evidence == 1 && displayId is Int && displayId > 0 &&
            receipt(expected, targetVersion, pkg, uid)
}
