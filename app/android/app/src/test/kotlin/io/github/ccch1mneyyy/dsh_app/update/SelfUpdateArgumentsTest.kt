package io.github.ccch1mneyyy.dsh_app.update

import org.junit.Assert.*
import org.junit.Test

class SelfUpdateArgumentsTest {
    private fun valid() = mapOf<String, Any?>("path" to "/private/cache/updates/update.apk",
        "sha256" to "ab".repeat(32), "versionCode" to 11091500, "backend" to "adb")

    @Test fun parsesOnlyTheDedicatedUpdateSchema() {
        val value = SelfUpdateArguments.parse(valid())!!
        assertEquals("adb", value.backend)
        assertEquals(11091500L, value.versionCode)
        assertNull(value.port)
    }

    @Test fun acceptsRangeCheckedIntegerPortAndVersion() {
        val value = SelfUpdateArguments.parse(valid() + mapOf("port" to 65535L, "versionCode" to Long.MAX_VALUE))!!
        assertEquals(65535, value.port)
        assertEquals(Long.MAX_VALUE, value.versionCode)
    }

    @Test fun rejectsFloatingPointAndStringVersions() {
        for (bad in listOf(1.0, 1.5, "12", true, 0, -1L))
            assertNull(SelfUpdateArguments.parse(valid() + ("versionCode" to bad)))
    }

    @Test fun rejectsInvalidPortsWithoutCoercion() {
        for (bad in listOf(0, -1, 65536, 4294967297L, 1.0, "5555", true))
            assertNull(SelfUpdateArguments.parse(valid() + ("port" to bad)))
    }

    @Test fun rejectsPortsForShizuku() {
        assertNull(SelfUpdateArguments.parse(valid() + mapOf("backend" to "shizuku", "port" to 5555)))
        assertNotNull(SelfUpdateArguments.parse(valid() + ("backend" to "shizuku")))
    }

    @Test fun neverAcceptsACommandTargetOrInstallerIdentity() {
        for (key in listOf("command", "package", "installerPackageName", "flags"))
            assertNull(SelfUpdateArguments.parse(valid() + (key to "untrusted")))
    }

    @Test fun rejectsRootAndAutomaticRoutes() {
        for (bad in listOf("root", "su", "auto", "system", true, null))
            assertNull(SelfUpdateArguments.parse(valid() + ("backend" to bad)))
    }

    @Test fun requiresACompleteSha256() {
        for (bad in listOf("", "a".repeat(63), "g".repeat(64), "a".repeat(65), 32))
            assertNull(SelfUpdateArguments.parse(valid() + ("sha256" to bad)))
        assertEquals("ab".repeat(32), SelfUpdateArguments.parse(valid() + ("sha256" to "AB".repeat(32)))!!.sha256)
    }

    @Test fun rejectsMalformedPathsAndMapsWithoutThrowing() {
        for (bad in listOf("", "x".repeat(4097), "line\n.apk", "nul\u0000.apk", 42))
            assertNull(SelfUpdateArguments.parse(valid() + ("path" to bad)))
        for (bad in listOf(null, "args", listOf("args"), emptyMap<String, Any>()))
            assertNull(SelfUpdateArguments.parse(bad))
    }
}
