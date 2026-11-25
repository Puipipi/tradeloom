package io.github.ccch1mneyyy.dsh_app.performance

import org.junit.Assert.*
import org.junit.Test

class PerformanceRulesTest {
    private val high = DeviceProfile(
        lowRam = false, totalMemoryBytes = 8L * 1024 * PerformanceRules.MIB,
        cpuCores = 8, availableProcessors = 8, sdkInt = 35, mediaPerformanceClass = 35,
    )

    @Test fun androidLowRamWinsOverOtherHighCapacitySignals() {
        assertEquals(DeviceTier.LOW, PerformanceRules.classify(high.copy(lowRam = true)))
        assertTrue(PerformanceRules.reasons(high.copy(lowRam = true)).contains("android_low_ram"))
    }

    @Test fun existingOnboardingMemoryBoundaryIsExact() {
        assertEquals(DeviceTier.LOW, PerformanceRules.classify(high.copy(totalMemoryBytes = PerformanceRules.LOW_MEMORY_BYTES - 1)))
        assertEquals(DeviceTier.HIGH, PerformanceRules.classify(high.copy(totalMemoryBytes = PerformanceRules.LOW_MEMORY_BYTES)))
    }

    @Test fun twoCoresGetAConservativeDefaultEvenWithPlentyOfRam() {
        assertEquals(DeviceTier.LOW, high.copy(cpuCores = 2).tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(cpuCores = 3).tier)
        assertEquals(DeviceTier.HIGH, high.copy(cpuCores = 4).tier)
    }

    @Test fun missingDataIsNotInventedAsLowOrCertifiedHigh() {
        assertEquals(DeviceTier.MEDIUM, DeviceProfile().tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(totalMemoryBytes = null).tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(cpuCores = null).tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(mediaPerformanceClass = 0).tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(mediaPerformanceClass = 30).tier)
        assertEquals(DeviceTier.MEDIUM, high.copy(sdkInt = 30).tier)
    }

    @Test fun clockFrequencyIsDiagnosticNotACrossArchitectureBenchmark() {
        assertEquals(high.tier, high.copy(cpuMaxKhz = listOf(null, 1_000_000)).tier)
        assertEquals(high.tier, high.copy(cpuMaxKhz = listOf(4_000_000)).tier)
        assertEquals(listOf(4_000_000L), high.copy(cpuMaxKhz = listOf(4_000_000)).toMap()["cpuMaxKhz"])
    }

    @Test fun everyTierAndModeHasTheDocumentedStartupDefault() {
        for (tier in DeviceTier.entries) {
            assertEquals(tier != DeviceTier.LOW, PerformanceRules.autoStart(tier, "auto", null))
            assertFalse(PerformanceRules.autoStart(tier, "light", null))
            assertTrue(PerformanceRules.autoStart(tier, "full", null))
            assertFalse(PerformanceRules.autoStart(tier, "full", null, thermal = true))
            assertFalse(PerformanceRules.keepEngineInBackground(tier))
        }
    }

    @Test fun explicitOnAndOffSurviveTierModeAndThermalChanges() {
        for (tier in DeviceTier.entries) for (mode in listOf("auto", "full", "light", "future")) {
            assertTrue(PerformanceRules.autoStart(tier, mode, true, thermal = true))
            assertFalse(PerformanceRules.autoStart(tier, mode, false))
        }
    }

    @Test fun heapBudgetsReserveRamAndHaveAnUpperBound() {
        assertEquals(512, PerformanceRules.oldSpaceMiB(null))
        assertEquals(512, PerformanceRules.oldSpaceMiB(1024L * PerformanceRules.MIB))
        assertEquals(896, PerformanceRules.oldSpaceMiB(3800L * PerformanceRules.MIB))
        assertEquals(1408, PerformanceRules.oldSpaceMiB(5800L * PerformanceRules.MIB))
        assertEquals(2048, PerformanceRules.oldSpaceMiB(16L * 1024 * PerformanceRules.MIB))
        assertEquals(2048, PerformanceRules.oldSpaceMiB(Long.MAX_VALUE))
    }

    @Test fun poolDoesNotExceedAvailableCpusOrTheProfileBudget() {
        assertEquals(1, PerformanceRules.threadPool(1, false))
        assertEquals(3, PerformanceRules.threadPool(3, false))
        assertEquals(4, PerformanceRules.threadPool(16, false))
        assertEquals(2, PerformanceRules.threadPool(16, true))
        assertEquals(4, PerformanceRules.threadPool(null, false))
        assertEquals(2, PerformanceRules.threadPool(0, true))
    }

    @Test fun defaultHeapPreservesTheManifestDnsOption() {
        val defaults = PerformanceRules.manifestEnvironment(
            listOf("proot", "/usr/bin/env", "-i", "HOME=/root", "NODE_OPTIONS=--dns-result-order=ipv4first", "{GUEST_ENV}", "/bin/sh", "-lc", "NODE_OPTIONS=bad"),
            mapOf("TZ" to "UTC"),
        )
        val env = PerformanceRules.engineEnvironment(high, false, mapOf("TZ" to "Asia/Shanghai"), defaults)
        assertEquals("--dns-result-order=ipv4first --max-old-space-size=2048", env["NODE_OPTIONS"])
        assertEquals("Asia/Shanghai", env["TZ"])
        assertEquals("4", env["UV_THREADPOOL_SIZE"])
        assertFalse(env.containsKey("HOME"))
    }

    @Test fun explicitEnvironmentIncludingEmptyOptionsIsNotOverwritten() {
        val env = PerformanceRules.engineEnvironment(high, true,
            mapOf("NODE_OPTIONS" to "", "UV_THREADPOOL_SIZE" to "7"),
            mapOf("NODE_OPTIONS" to "--dns-result-order=ipv4first"))
        assertEquals("", env["NODE_OPTIONS"])
        assertEquals("7", env["UV_THREADPOOL_SIZE"])
    }

    @Test fun manifestHeapAndThreadLimitsRemainAuthoritative() {
        for (option in listOf("--max-old-space-size=1024", "--max_old_space_size 1024", "\"--max-old-space-size=1024\"", "--max-heap-size=1200", "--max-old-space-size-percentage=20")) {
            val env = PerformanceRules.engineEnvironment(high, false, emptyMap(), mapOf("NODE_OPTIONS" to option, "UV_THREADPOOL_SIZE" to "3"))
            assertEquals(option, env["NODE_OPTIONS"])
            assertEquals("3", env["UV_THREADPOOL_SIZE"])
        }
    }
}
