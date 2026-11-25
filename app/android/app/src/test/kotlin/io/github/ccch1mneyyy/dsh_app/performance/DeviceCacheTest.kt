package io.github.ccch1mneyyy.dsh_app.performance

import org.junit.Assert.*
import org.junit.Test

class DeviceCacheTest {
    private val raw = DeviceProfile(
        totalMemoryBytes = 8L * 1024 * PerformanceRules.MIB,
        cpuCores = 8,
        sdkInt = 34,
        mediaPerformanceClass = 33,
        measuredAtMs = 1234,
    ).toMap()

    @Test fun systemOrPolicyChangesInvalidateTheKey() {
        assertEquals("${PerformanceRules.VERSION}|34|build-a", PerformanceRules.cacheKey(34, "build-a"))
        assertNotEquals(PerformanceRules.cacheKey(34, "build-a"), PerformanceRules.cacheKey(35, "build-a"))
        assertNotEquals(PerformanceRules.cacheKey(34, "build-a"), PerformanceRules.cacheKey(34, "build-b"))
        assertNull(PerformanceRules.cachedProfile(raw + ("policyVersion" to -1), 34))
        assertNull(PerformanceRules.cachedProfile(raw, 35))
    }

    @Test fun classificationIsRecomputedFromFacts() {
        val p = PerformanceRules.cachedProfile(raw + ("tier" to "low") + ("reasons" to listOf("stale")), 34)!!
        assertEquals(DeviceTier.HIGH, p.tier)
        assertEquals(listOf("declared_mpc_with_capacity"), PerformanceRules.reasons(p))
        assertEquals(1234L, p.measuredAtMs)
        assertNull(p.availableProcessors)
    }

    @Test fun malformedAndUnavailableValuesDoNotBecomeZeroMeasurements() {
        val p = PerformanceRules.cachedProfile(raw + mapOf(
            "totalMemoryBytes" to -1L, "lowRam" to "false", "cpuCores" to Int.MAX_VALUE,
            "cpuMaxKhz" to listOf(1800000, null, 0, -1, "unknown"), "mediaPerformanceClass" to -1,
        ), 34)!!
        assertNull(p.totalMemoryBytes)
        assertNull(p.lowRam)
        assertNull(p.cpuCores)
        assertNull(p.mediaPerformanceClass)
        assertEquals(listOf(1800000L, null, null, null, null), p.cpuMaxKhz)
        assertEquals(DeviceTier.MEDIUM, p.tier)
    }

    @Test fun cachedListsHaveTheSameBoundAsTheSystemProbe() {
        val p = PerformanceRules.cachedProfile(raw + ("cpuMaxKhz" to List(1000) { 1L }), 34)!!
        assertEquals(PerformanceRules.MAX_CPUS, p.cpuMaxKhz.size)
    }
}
