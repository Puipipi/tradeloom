package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InstallAlertTest {
    @Test fun saysReadyOrStoppedToSomeoneWhoLeft() {
        assertEquals(InstallAlert.READY, InstallAlert.choose(ok = true, inForeground = false, notificationsEnabled = true))
        assertEquals(InstallAlert.FAILED, InstallAlert.choose(ok = false, inForeground = false, notificationsEnabled = true))
    }

    @Test fun staysQuietWhileTheAppIsOnScreen() {
        // The waiting page moves on (or shows the failure) by itself.
        assertNull(InstallAlert.choose(ok = true, inForeground = true, notificationsEnabled = true))
        assertNull(InstallAlert.choose(ok = false, inForeground = true, notificationsEnabled = true))
    }

    @Test fun postsNothingWhenNotificationsAreOff() {
        assertNull(InstallAlert.choose(ok = true, inForeground = false, notificationsEnabled = false))
        assertNull(InstallAlert.choose(ok = false, inForeground = false, notificationsEnabled = false))
    }
}
