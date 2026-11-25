package io.github.ccch1mneyyy.dsh_app.update

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Test

class ApkInstallerFailureTest {
    @Test fun sessionAllocationAndStreamWriteBothReportInsufficientSpace() {
        // PackageHelper / InstallLocationUtils rejects the default INTERNAL_ONLY
        // SessionParams during createSession, before a session or status broadcast exists.
        assertEquals("storage", ApkInstaller.failureStatus(
            IOException("Requested internal only, but not enough space")))
        assertEquals("storage", ApkInstaller.failureStatus(
            IOException("write failed: ENOSPC (No space left on device)")))
    }

    @Test fun otherIoFailuresAndNonIoExceptionsStayGeneric() {
        for (error in listOf(
            IOException(),
            IOException("open failed: EACCES (Permission denied)"),
            IOException("Not allowed to install non-system apps on internal storage"),
            IOException("Cannot automatically move app to internal storage"),
            SecurityException("Requested internal only, but not enough space"),
        )) assertEquals("failure", ApkInstaller.failureStatus(error))
    }
}
