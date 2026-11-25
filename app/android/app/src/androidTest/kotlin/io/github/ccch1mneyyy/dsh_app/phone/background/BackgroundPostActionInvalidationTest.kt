package io.github.ccch1mneyyy.dsh_app.phone.background

import android.os.Bundle
import android.test.AndroidTestCase
import io.github.ccch1mneyyy.dsh_app.phone.PhoneAction
import io.github.ccch1mneyyy.dsh_app.phone.PhoneAppIdentity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger

/** Uses real Android Bundles, driver result processing and the original coordinate receipt state. */
@Suppress("DEPRECATION")
class BackgroundPostActionInvalidationTest : AndroidTestCase() {
    private class Fixture(
        val localAllowed: () -> Boolean = { false },
        val withText: Boolean = false,
    ) {
        var beforeReply: () -> Unit = {}
        var wrongOwner = false
        var replyPackage: String? = "example.app"
        var replyUid = 10123
        var replyError: String? = null
        var replyNote: String? = null
        val sends = AtomicInteger()
        val peer = object : PrivilegedChannel {
            override val backgroundLimit = 1
            override fun alive() = true
            override fun close() {}
            override fun execute(request: Bundle, beforeSend: () -> Unit): Bundle {
                beforeSend()
                sends.incrementAndGet()
                beforeReply()
                return Bundle().apply {
                    putInt(Proto.OWNER_SCOPE_VERSION, 1)
                    putString(Proto.OWNER, if (wrongOwner) "other-owner" else request.getString(Proto.OWNER))
                    val error = replyError
                    putBoolean(Proto.OK, error == null)
                    if (error != null) {
                        // A refused action names only what is on top now.
                        putString(Proto.ERROR, error); replyPackage?.let { putString(Proto.FG_PKG, it) }
                        return@apply
                    }
                    putInt(Proto.TARGET_IDENTITY_VERSION, 1)
                    replyPackage?.let { putString(Proto.PKG, it); putInt(Proto.TARGET_UID, replyUid) }
                    replyNote?.let { putString(Proto.SHOWN_NOTE, it) }
                    if (request.getString(Proto.OP) == Proto.OP_RELEASE) {
                        putInt(Proto.RELEASE_RECEIPT, 1)
                        putBoolean("released", true); putBoolean(Proto.TASK_SCOPE_EMPTY, true)
                    } else if (withText) {
                        putBoolean(Proto.POOR, true); putBoolean(Proto.SECURE, false)
                        putInt(Proto.COUNT, 1)
                        putStringArray(Proto.A_ROLE, arrayOf("文本"))
                        putStringArray(Proto.A_LABEL, arrayOf("late-original-text"))
                    }
                    // Original default fixture still has no COUNT/SECURE or afterVisual.
                }
            }
        }
        val driver = BackgroundDisplay(channelProvider = { peer },
            mayUse = { true }, admitUse = { action -> action(); true },
            localOcrAllowed = { localAllowed() })
        fun field(name: String) = BackgroundDisplay::class.java.getDeclaredField(name).apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val io = field("resourceIo").get(driver) as BackgroundDisplayIo<PrivilegedChannel>
        val coordinates = field("coordinateImage").get(driver) as BackgroundCoordinateImage
        val original = BackgroundCoordinateImage.Receipt("old-receipt", 48, 48)
        init {
            field("currentTarget").set(driver, PhoneAppIdentity("example.app", 10123))
            field("coordinateSupported").setBoolean(driver, true)
            io.call { io.startResource(peer, { beforeSend -> beforeSend(); Unit }) { true } }
            coordinates.candidate("b-old", original)
            driver.acceptVisualObservation("b-old")
        }
        fun finish() { check(io.release { true }) }
    }

    fun testSuccessfulBackWithNoPostSnapshotRevokesTheOldAcceptedReceipt() {
        val f = Fixture()
        try {
            val result = f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK))
            assertTrue(result.ok)
            assertNull(result.screen)
            assertEquals(1, f.sends.get())
            f.driver.acceptVisualObservation("b-old") // A delayed old acceptance must not revive it.
            assertNull(f.coordinates.take("b-old"))
        } finally { f.finish() }
    }

    fun testPostActionRetiresItsOcrTokenWithoutTouchingAnotherResource() {
        val f = Fixture(); val other = Fixture()
        try {
            f.field("coordinateOcrEpoch").set(f.driver, 7L)
            val result = f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK))
            assertTrue(result.ok)
            assertNull(result.screen)
            assertNull(f.field("coordinateOcrEpoch").get(f.driver))
            assertNull(f.coordinates.take("b-old"))
            assertEquals(other.original, other.coordinates.take("b-old"))
            assertEquals(0, other.sends.get())
        } finally { f.finish(); other.finish() }
    }

    fun testObservationReleasedAfterIdentityCheckCannotReviveOldTextOrNullPackage() {
        val entered = CountDownLatch(1); val answer = CountDownLatch(1)
        val f = Fixture(localAllowed = {
            entered.countDown()
            check(answer.await(5, TimeUnit.SECONDS))
            true
        }, withText = true)
        val result = AtomicReference<io.github.ccch1mneyyy.dsh_app.phone.ScreenSnapshot?>()
        val failure = AtomicReference<Throwable?>()
        val reader = Thread {
            try { result.set(f.driver.observe(false, false)) }
            catch (e: Throwable) { failure.set(e) }
        }.apply { start() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            // localOcr is null: this existing policy callback is first reached after
            // the reply has named the app read, not by request preparation. No SDK is substituted.
            f.driver.seal()
            assertTrue(f.driver.release())
            assertNull(f.field("currentTarget").get(f.driver))
            answer.countDown(); reader.join(5_000)
            assertFalse(reader.isAlive)
            assertNull(result.get())
            assertTrue(failure.get() is IllegalStateException)
            assertNull(f.field("lastScreenId").get(f.driver))
            assertNull(f.coordinates.take("b-old"))
        } finally { answer.countDown(); reader.join(5_000); f.finish() }
    }

    fun testCurrentObservationStillPublishesItsOriginalTextAndPackage() {
        val f = Fixture(localAllowed = { true }, withText = true)
        try {
            val result = f.driver.observe(false, false)
            assertTrue(result.text.contains("late-original-text"))
            assertEquals("example.app", result.packageName)
            assertEquals(setOf("example.app"), result.readPackages)
        } finally { f.finish() }
    }

    fun testSealedPostActionScreenDoesNotRewriteSuccessfulActionAck() {
        val f = Fixture(withText = true)
        try {
            f.beforeReply = { f.driver.seal() }
            val result = f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK))
            assertTrue(result.ok)
            assertNull(result.screen)
            assertNull(f.field("lastScreenId").get(f.driver))
            assertNull(f.coordinates.take("b-old"))
            assertEquals(1, f.sends.get())
        } finally { f.beforeReply = {}; f.finish() }
    }

    fun testWrongOwnerReplyIsStillRejectedBeforeObservationPublication() {
        val f = Fixture(withText = true)
        try {
            f.wrongOwner = true
            var failure: Throwable? = null
            try { f.driver.observe(false, false) } catch (e: Throwable) { failure = e }
            assertTrue(failure is IllegalStateException)
            assertNull(f.field("lastScreenId").get(f.driver))
        } finally { f.finish() }
    }

    fun testAnActionAckStandsWhicheverAppIsOnTopAfterwards() {
        // The screen may have moved on (a share sheet, a login app): the action still happened, and
        // the next read follows the screen. Nothing is refused over the reply naming another app.
        for ((pkg, uid) in listOf("example.app" to 10123, "other.app" to 10123, "example.app" to 10124)) {
            val f = Fixture()
            try {
                f.replyPackage = pkg; f.replyUid = uid
                val result = f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK))
                assertTrue(result.ok)
                assertNull(result.screen)
                assertEquals(1, f.sends.get())
            } finally { f.finish() }
        }
    }

    fun testAReadFollowsTheAppOnTopAndRecoversWhenTheOpenedAppComesBack() {
        val f = Fixture(withText = true)
        try {
            f.field("openedTarget").set(f.driver, PhoneAppIdentity("example.app", 10123))
            // A launched B (a login or share app): the read shows B, says so, and actions now go to B,
            // so B's own read/write rules apply instead of anything granted for A.
            f.replyPackage = "other.app"; f.replyUid = 10200
            val other = f.driver.observe(false, false)
            assertEquals("other.app", other.packageName)
            assertEquals(setOf("other.app"), other.readPackages)
            assertTrue(other.text, other.text.contains("不是当初打开的 example.app"))
            assertEquals("other.app", f.driver.foregroundPackage())
            // A is back on top: no refusal, no reopen, no note.
            f.replyPackage = "example.app"; f.replyUid = 10123
            val back = f.driver.observe(false, false)
            assertEquals("example.app", back.packageName)
            assertFalse(back.text, back.text.contains("不是当初打开的"))
            assertEquals("example.app", f.driver.foregroundPackage())
        } finally { f.finish() }
    }

    fun testCollectingPagesChecksTheReadRuleOfTheAppEachPageShows() {
        val f = Fixture(withText = true)
        try {
            val first = f.driver.observe(false, false)
            // The list is collected from A, but the first page read now shows B, which may not be read.
            f.replyPackage = "other.app"; f.replyUid = 10200
            val asked = mutableListOf<String?>()
            val result = f.driver.collect(first.id, 1, 3, null, { true }) { pkg -> asked.add(pkg); pkg != "other.app" }
            assertEquals("本页内容不允许读取", result.stopReason)
            assertTrue(result.items.isEmpty()) // B's text is not among what is handed back
            assertTrue(asked.toString(), "other.app" in asked)
            assertFalse(result.readPackages.toString(), "other.app" in result.readPackages)
        } finally { f.finish() }
    }

    fun testAnEmptyScreenIsReportedAsItIsWithWhereTheOpenedAppWent() {
        val f = Fixture()
        try {
            f.field("openedTarget").set(f.driver, PhoneAppIdentity("example.app", 10123))
            f.replyPackage = null; f.replyNote = "leftDisplay"
            val empty = f.driver.observe(false, false)
            assertNull(empty.packageName)
            assertTrue(empty.text, empty.text.contains("现在没有应用界面"))
            assertTrue(empty.text, empty.text.contains("现在在主屏上"))
        } finally { f.finish() }
    }

    fun testAnActionForAnAppNoLongerOnTopIsRefusedOnceAsStale() {
        val f = Fixture()
        try {
            f.replyError = "foregroundChanged"; f.replyPackage = "other.app"
            val result = f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK))
            assertFalse(result.ok)
            assertTrue(result.staleSnapshot) // The caller re-reads the screen and shows it.
            assertTrue(result.message, result.message.contains("后台屏上现在是 other.app"))
            // Nothing latched: the next action is sent as usual.
            f.replyError = null; f.replyPackage = "example.app"
            assertTrue(f.driver.perform(PhoneAction.Key("b-old", PhoneAction.GlobalKey.BACK)).ok)
            assertEquals(2, f.sends.get())
        } finally { f.finish() }
    }
}
