package io.github.ccch1mneyyy.dsh_app.phone.background

import org.junit.Assert.*
import org.junit.Test

class BackgroundGateConnectionStateTest {
    // Values stand in for the two existing localized error resource IDs.
    private val notReady = 1
    private val noResponse = 2

    @Test fun anUnattemptedChannelHasNoFailure() {
        assertNull(BackgroundGateState().snapshot.connectionError)
    }

    @Test fun aFailedConnectIsRememberedUntilTheNextConnectionOrReset() {
        val state = BackgroundGateState()
        state.connectionFailed(notReady) { true }
        assertEquals(notReady, state.snapshot.connectionError)

        state.connected(state.snapshot)
        assertNull(state.snapshot.connectionError)

        state.connectionFailed(noResponse) { true }
        state.reset()
        assertNull(state.snapshot.connectionError)
    }

    @Test fun aCancelledAttemptCannotRecordAFailure() {
        val state = BackgroundGateState()
        val before = state.snapshot

        state.connectionFailed(notReady) { false }

        assertSame(before, state.snapshot)
    }

    @Test fun aLateConnectionCannotClearANewerFailure() {
        val state = BackgroundGateState()
        state.connectionFailed(notReady) { true }
        val observed = state.snapshot
        state.connectionFailed(noResponse) { true }
        val newer = state.snapshot

        state.connected(observed)

        assertSame(newer, state.snapshot)
    }

    @Test fun anOldModeCannotClearAnIdenticalFailureAfterSwitchingAwayAndBack() {
        val state = BackgroundGateState()
        state.connectionFailed(notReady) { true }
        val observed = state.snapshot
        state.reset()
        state.connectionFailed(notReady) { true }
        val newer = state.snapshot
        assertEquals(observed, newer)

        state.connected(observed)

        assertSame(newer, state.snapshot)
    }
}
