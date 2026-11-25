package io.github.ccch1mneyyy.dsh_app.update.privileged

import org.junit.Assert.*
import org.junit.Test

class SelfUpdateRecoveryTest {
    private val hash = "ab".repeat(32)
    private val target = SelfUpdatePending("pending", 11, hash, setOf("signer"), 123)
    private val installed = SelfUpdateIdentity(SelfUpdatePolicy.PACKAGE, 11, "new", setOf("signer"))

    @Test fun onlyRealVersionSizeHashAndCurrentSignerProveInstalled() {
        assertEquals("installed", SelfUpdateRecovery.state(target, installed, 123, hash, false))
        assertEquals("installed", SelfUpdateRecovery.state(target.copy(state = "unknown"), installed, 123, hash, false))
        assertEquals("installed", SelfUpdateRecovery.state(target.copy(state = "failed"), installed, 123, hash, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, installed, 123, "00".repeat(32), false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, installed, 124, hash, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, installed.copy(signers = setOf("other")), 123, hash, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, installed.copy(packageName = "another.app"), 123, hash, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target.copy(signers = emptySet()), installed, 123, hash, false))
    }

    @Test fun OldVersionAfterDispatchOrProcessDeathIsUnknownNotFailure() {
        val old = installed.copy(versionCode = 10)
        assertEquals("unknown", SelfUpdateRecovery.state(target, old, null, null, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target.copy(state = "unknown"), old, null, null, false))
        assertEquals("pending", SelfUpdateRecovery.state(target, old, null, null, true))
        assertEquals("failed", SelfUpdateRecovery.state(target.copy(state = "failed"), old, null, null, false))
    }

    @Test fun newerInstalledBuildIsSupersededNotProofOfExactTargetInstallation() {
        val future = installed.copy(versionCode = 12)
        assertEquals("superseded", SelfUpdateRecovery.state(target, future, null, null, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, future.copy(signers = setOf("other")), null, null, false))
        assertEquals("unknown", SelfUpdateRecovery.state(target, future.copy(signers = setOf("rotated"), signerHistory = setOf("signer", "rotated")), null, null, false))
    }

    @Test fun verifiedInstalledCacheSkipsHashOnlyForIdenticalMetadata() {
        val cached = target.copy(state = "installed", verifiedLastUpdateTime = 42)
        assertTrue(SelfUpdateRecovery.canReuseInstalled(cached, installed, 123, 42))
        assertEquals("installed", SelfUpdateRecovery.state(cached, installed, 123, null, false, 42))
        assertEquals("unknown", SelfUpdateRecovery.state(cached, installed, 123, "00".repeat(32), false, 42))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(cached, installed, 123, 43))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(cached, installed, 124, 42))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(cached, installed.copy(versionCode = 12), 123, 42))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(cached, installed.copy(signers = setOf("other")), 123, 42))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(cached, installed.copy(packageName = "another.app"), 123, 42))
        assertEquals("unknown", SelfUpdateRecovery.state(cached, installed, 123, null, false, 43))
        // A metadata change can become installed only after a fresh matching digest.
        assertEquals("installed", SelfUpdateRecovery.state(cached, installed, 123, hash, false, 43))
    }

    @Test fun unverifiedOrNonterminalReceiptsNeverReuseInstalledCache() {
        for (state in listOf("pending", "unknown", "failed", "none", "superseded")) {
            val pending = target.copy(state = state, verifiedLastUpdateTime = 42)
            assertFalse(state, SelfUpdateRecovery.canReuseInstalled(pending, installed, 123, 42))
            assertNotEquals(state, "installed", SelfUpdateRecovery.state(pending, installed, 123, null, false, 42))
        }
        assertFalse(SelfUpdateRecovery.canReuseInstalled(target.copy(state = "installed"), installed, 123, 42))
        assertFalse(SelfUpdateRecovery.canReuseInstalled(target.copy(state = "installed", verifiedLastUpdateTime = 42), installed, 123, null))
    }

    @Test fun verifiedUpdateTimeParticipatesInJournalCasIdentity() {
        val before = "request" to target.copy(state = "installed", verifiedLastUpdateTime = 42)
        val current = "request" to target.copy(state = "installed", verifiedLastUpdateTime = 43)
        assertNotEquals(before, current)
    }

    @Test fun missingInstalledEvidenceCannotTurnCliSuccessIntoInstalled() {
        assertEquals("unknown", SelfUpdateRecovery.state(target, installed, null, null, false))
        assertEquals("pending", SelfUpdateRecovery.state(target, installed, null, null, true))
    }
}
