package io.github.ccch1mneyyy.dsh_app.phone.background

import android.os.Bundle
import android.test.AndroidTestCase

/** Real channel exchange and Android Bundles, without a live Shizuku service or display. */
@Suppress("DEPRECATION")
class ShizukuCapabilityRefreshTest : AndroidTestCase() {
    private fun completeProbe() = Bundle().apply {
        putBoolean(Proto.OK, true)
        putInt(Proto.RELEASE_RECEIPT, 1)
        putInt(Proto.OWNER_SCOPE_VERSION, 1); putInt(Proto.SCOPE_LIMIT, 3)
        putInt(Proto.TARGET_IDENTITY_VERSION, 1)
    }

    private class Remote(var reply: Bundle, private val peer: String?) : IPrivilegedDisplay.Stub() {
        var calls = 0
        override fun execute(request: Bundle): Bundle {
            calls++
            return if (peer == null) Bundle(reply)
            else MuxProtocol.wrap(reply, peer, request.getLong(Proto.REQUEST_ID))
        }
    }

    private fun probe(channel: ShizukuChannel) = channel.execute(Bundle().apply { putString(Proto.OP, Proto.OP_PROBE) })

    fun testFreshProbeRestoresCapacityOnTheSameSerialAndMultiplexedConnection() {
        for (peer in listOf(null, "30000000-0000-0000-0000-000000000001")) {
            val remote = Remote(completeProbe(), peer)
            val channel = ShizukuChannel(remote, peer, 0)
            assertEquals(0, channel.backgroundLimit)
            probe(channel)
            assertEquals(if (peer == null) 1 else 3, channel.backgroundLimit)
            assertEquals(1, remote.calls)
            channel.close()
            assertEquals(0, channel.backgroundLimit)
        }
    }

    fun testMissingCapabilityDowngradesAndLaterRecoveryIsNotPermanentlyZero() {
        val remote = Remote(completeProbe(), null)
        val channel = ShizukuChannel(remote, null, 1)
        remote.reply.remove(Proto.RELEASE_RECEIPT)
        probe(channel)
        assertEquals(0, channel.backgroundLimit)
        remote.reply = completeProbe()
        probe(channel)
        assertEquals(1, channel.backgroundLimit)
        channel.close()
    }

    fun testBusinessRepliesDoNotOverwriteTheCapabilitySnapshot() {
        val remote = Remote(Bundle().apply { putBoolean(Proto.OK, true) }, null)
        val channel = ShizukuChannel(remote, null, 1)
        channel.execute(Bundle().apply { putString(Proto.OP, Proto.OP_OBSERVE) })
        assertEquals(1, channel.backgroundLimit)
        channel.close()
    }
}
