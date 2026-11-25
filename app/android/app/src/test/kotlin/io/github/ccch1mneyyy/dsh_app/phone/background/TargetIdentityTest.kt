package io.github.ccch1mneyyy.dsh_app.phone.background

import io.github.ccch1mneyyy.dsh_app.phone.PhoneAppIdentity
import org.junit.Assert.*
import org.junit.Test

/** The background screen taken as it is: what a request names, what is on top, where an app went. */
class TargetIdentityTest {
    private val a = PhoneAppIdentity("example.app", 10123)
    private val otherUser = PhoneAppIdentity("example.app", 1010123)
    private val sharedUid = PhoneAppIdentity("example.shared", 10123)

    @Test fun aRequestNamesItsTargetWithoutAnyVersionHandshake() {
        assertEquals(a, TargetIdentity.requested(a.packageName, a.uid))
        for (uid in listOf(null, -1, 10123L, "10123")) assertNull(TargetIdentity.requested(a.packageName, uid))
    }

    @Test fun unreadableUidEvidenceFallsBackToThePackage() {
        assertTrue(TargetIdentity.sameApp(a.packageName, a.uid, a))
        // Task info without a readable uid: the package on top decides, the action goes ahead.
        assertTrue(TargetIdentity.sameApp(a.packageName, null, a))
        // A readable different uid is another install (another user's copy): not the same app.
        assertFalse(TargetIdentity.sameApp(otherUser.packageName, otherUser.uid, a))
        assertFalse(TargetIdentity.sameApp(sharedUid.packageName, sharedUid.uid, a))
        assertFalse(TargetIdentity.sameApp(null, null, a))
    }

    @Test fun anAppNotOnTopIsBehindElsewhereOrGone() {
        val owned = 7
        assertEquals(TargetIdentity.Placement.OWNED_DISPLAY, TargetIdentity.placement(a.packageName, owned,
            listOf(owned to setOf("share.sheet"), owned to setOf(a.packageName))))
        // Typically the main screen: already running there, or not allowed on a second display.
        assertEquals(TargetIdentity.Placement.OTHER_DISPLAY, TargetIdentity.placement(a.packageName, owned,
            listOf(0 to setOf("launcher"), 0 to setOf(a.packageName))))
        assertEquals(TargetIdentity.Placement.NONE, TargetIdentity.placement(a.packageName, owned,
            listOf(0 to setOf("launcher"), owned to setOf("other.app"))))
        assertEquals(TargetIdentity.Placement.NONE, TargetIdentity.placement(a.packageName, owned, emptyList()))
        assertEquals(listOf("behind", "leftDisplay", "closed"),
            listOf(TargetIdentity.Placement.OWNED_DISPLAY, TargetIdentity.Placement.OTHER_DISPLAY, TargetIdentity.Placement.NONE).map { it.wire })
    }

    @Test fun aReplyNamesTheAppOnTopOnlyWithATypedUid() {
        assertEquals(a, TargetIdentity.shown(a.packageName, a.uid))
        assertEquals(otherUser, TargetIdentity.shown(otherUser.packageName, otherUser.uid))
        for (uid in listOf(null, -1, 10123L)) assertNull(TargetIdentity.shown(a.packageName, uid))
        assertNull(TargetIdentity.shown(null, a.uid))
    }

    @Test fun coordinateReceiptRequiresActualTypedMatchingIdentity() {
        assertTrue(TargetIdentity.receipt(a, 1, a.packageName, a.uid))
        assertFalse(TargetIdentity.receipt(a, 1L, a.packageName, a.uid))
        assertFalse(TargetIdentity.receipt(a, 1, a.packageName, a.uid.toLong()))
        assertFalse(TargetIdentity.receipt(a, 1, sharedUid.packageName, sharedUid.uid))
        assertFalse(TargetIdentity.receipt(a, 1, otherUser.packageName, otherUser.uid))
        assertFalse(TargetIdentity.receipt(a, null, null, null))
    }

    @Test fun backgroundOpenConfirmationRequiresEveryTypedFactFromThisReply() {
        fun accepts(ok: Any? = true, evidence: Any? = 1, display: Any? = 7,
                    version: Any? = 1, pkg: Any? = a.packageName, uid: Any? = a.uid) =
            TargetIdentity.backgroundOpenConfirmed(a, ok, evidence, display, version, pkg, uid)
        assertTrue(accepts())
        for (bad in listOf(null, false, 1, "true")) assertFalse(accepts(ok = bad))
        for (bad in listOf(null, 0, 2, 1L, "1", true)) assertFalse(accepts(evidence = bad))
        for (bad in listOf(null, 0, -1, 7L, "7", true)) assertFalse(accepts(display = bad))
        for (bad in listOf(null, 0, 2, 1L, "1")) assertFalse(accepts(version = bad))
        for (bad in listOf(null, "other.app", 1)) assertFalse(accepts(pkg = bad))
        for (bad in listOf(null, otherUser.uid, a.uid.toLong(), "10123")) assertFalse(accepts(uid = bad))
    }
}
