package io.github.ccch1mneyyy.dsh_app.runtime

import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class GuestDnsTest {
    private fun pick(vararg addresses: String) = GuestSetup.pickDns(addresses.map(InetAddress::getByName))

    @Test fun fillsZeroOneAndTwoServers() {
        assertEquals(listOf("223.5.5.5", "119.29.29.29", "8.8.8.8"), pick())
        assertEquals(listOf("1.1.1.1", "223.5.5.5", "119.29.29.29"), pick("1.1.1.1"))
        assertEquals(listOf("1.1.1.1", "9.9.9.9", "223.5.5.5"), pick("1.1.1.1", "9.9.9.9"))
    }

    @Test fun capsNetworkDnsAtTwoAndKeepsIpv4First() {
        assertEquals(listOf("1.1.1.1", "9.9.9.9", "223.5.5.5"), pick("1.1.1.1", "9.9.9.9", "8.8.4.4", "4.2.2.1"))
        val v6 = InetAddress.getByName("2001:4860:4860::8888").hostAddress
        assertEquals(listOf("1.1.1.1", v6, "223.5.5.5"), pick("2001:4860:4860::8888", "1.1.1.1"))
    }

    @Test fun excludesLinkLocalAndDuplicates() {
        assertEquals(listOf("1.1.1.1", "223.5.5.5", "119.29.29.29"), pick("fe80::1", "169.254.1.1", "1.1.1.1", "1.1.1.1"))
    }
}
