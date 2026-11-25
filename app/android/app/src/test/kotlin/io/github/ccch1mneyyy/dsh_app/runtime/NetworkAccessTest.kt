package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.*
import org.junit.Test

class NetworkAccessTest {
    @Test fun logsOnlyChanges() {
        val access = NetworkAccess()
        val watch = access.startWatch()
        // The first report after registering is usually "not blocked": nothing to say.
        assertNull(access.onBlocked(watch, nowBlocked = false, inForeground = true))
        assertFalse(access.isBlocked)

        val cut = access.onBlocked(watch, nowBlocked = true, inForeground = false)
        assertNotNull(cut)
        assertTrue(cut!!.contains("blocked this app's network"))
        assertTrue(cut.contains("app in background"))
        assertTrue(access.isBlocked)
        // Repeated reports (another network, a capability change) stay quiet.
        assertNull(access.onBlocked(watch, nowBlocked = true, inForeground = false))

        val back = access.onBlocked(watch, nowBlocked = false, inForeground = true)
        assertNotNull(back)
        assertTrue(back!!.contains("lifted"))
        assertTrue(back.contains("app in foreground"))
        assertFalse(access.isBlocked)
    }

    @Test fun keepsWhenTheLatestBlockStartedAfterItLifts() {
        val access = NetworkAccess()
        val watch = access.startWatch()
        assertNull(access.blockedAt)
        access.onBlocked(watch, nowBlocked = true, inForeground = false, now = 1_000)
        access.onBlocked(watch, nowBlocked = true, inForeground = false, now = 2_000)
        assertEquals(1_000L, access.blockedAt)
        access.onBlocked(watch, nowBlocked = false, inForeground = true, now = 3_000)
        assertEquals(1_000L, access.blockedAt)
        access.onBlocked(watch, nowBlocked = true, inForeground = false, now = 4_000)
        assertEquals(4_000L, access.blockedAt)
        access.reset(watch)
        assertEquals(4_000L, access.blockedAt)
    }

    @Test fun resetForgetsSilently() {
        val access = NetworkAccess()
        val watch = access.startWatch()
        access.onBlocked(watch, nowBlocked = true, inForeground = false)
        access.reset(watch)
        assertFalse(access.isBlocked)
        // A new run starts clean: the next block is news again.
        val restartedWatch = access.startWatch()
        assertNotNull(access.onBlocked(restartedWatch, nowBlocked = true, inForeground = false))
    }

    @Test fun callbackAlreadyDispatchedBeforeRetirementCannotRestoreBlockedState() {
        val access = NetworkAccess()
        val old = access.startWatch()
        // The callback owns its registration even if invocation/enqueue resumes later.
        val lateCallback = { access.onBlocked(old, true, false, 1000) }
        access.reset(old)
        assertNull(lateCallback())
        assertFalse(access.isBlocked)
        assertNull(access.blockedAt)
        assertFalse(access.isCurrent(old))
    }

    @Test fun oldCallbackAndOldRetirementCannotMutateTheReplacementWatch() {
        val access = NetworkAccess()
        val old = access.startWatch()
        access.onBlocked(old, true, false, 1000)
        val current = access.startWatch()
        assertFalse(access.isBlocked)
        assertEquals(1000L, access.blockedAt)
        access.onBlocked(current, true, true, 2000)
        assertNull(access.onBlocked(old, false, false, 3000))
        assertNull(access.onBlocked(old, true, false, 4000))
        access.reset(old)
        assertTrue(access.isBlocked)
        assertEquals(2000L, access.blockedAt)
        assertFalse(access.isCurrent(old))
        assertTrue(access.isCurrent(current))
        assertNotNull(access.onBlocked(current, false, true, 5000))
        assertFalse(access.isBlocked)
    }

    @Test fun registrationFailureRetiresCallbacksAndLaterRegistrationStillWorks() {
        val access = NetworkAccess()
        val failed = access.startWatch()
        access.reset(failed)
        assertFalse(access.isCurrent(failed))
        assertNull(access.onBlocked(failed, true, false, 1000))
        val current = access.startWatch()
        assertTrue(access.isCurrent(current))
        assertNotNull(access.onBlocked(current, true, false, 2000))
        assertEquals(2000L, access.blockedAt)
    }

    @Test fun policyLineNamesEachSetting() {
        assertEquals(
            "[dsh-app] background policy: battery optimization on, data saver off, notifications on",
            NetworkAccess.policyLine(batteryExempt = false, dataSaverStatus = 1, notifications = true),
        )
        assertEquals(
            "[dsh-app] background policy: battery optimization off, data saver on, notifications off",
            NetworkAccess.policyLine(batteryExempt = true, dataSaverStatus = 3, notifications = false),
        )
        assertTrue(NetworkAccess.policyLine(true, 2, true).contains("data saver on, app exempt"))
        assertTrue(NetworkAccess.policyLine(true, 0, true).contains("data saver unknown"))
    }
}
