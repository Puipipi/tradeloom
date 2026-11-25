package io.github.ccch1mneyyy.dsh_app.icons

import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.FROST
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.INK
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.MIST
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.MIST_ALT
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.NIGHT
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.ORIGINAL
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.STATE_DEFAULT
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.STATE_DISABLED
import io.github.ccch1mneyyy.dsh_app.icons.LauncherIcons.STATE_ENABLED
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class LauncherIconsTest {

    /** PackageManager's stored settings, as the plugin applies them (enable list, then disable). */
    private class Device {
        val states = HashMap<String, Int>()
        val writes = ArrayList<LauncherIcons.Step>()
        val stateOf: (String) -> Int = { states[it] ?: STATE_DEFAULT }

        fun on() = LauncherIcons.aliases.filter { LauncherIcons.isOn(it, stateOf(it.className)) }

        fun apply(plan: LauncherIcons.Plan, afterEach: () -> Unit = {}) {
            for (step in plan.enable + plan.disable) {
                states[step.className] = step.state
                writes += step
                afterEach()
            }
        }
    }

    private fun alias(variant: String) = LauncherIcons.aliases.first { it.variant == variant && it !== ORIGINAL }

    private companion object {
        const val PKG = "io.github.ccch1mneyyy.dsh_app"
    }

    @Test fun aFreshInstallShowsMist() {
        val device = Device()
        assertEquals(listOf(ORIGINAL), device.on())
        assertEquals(MIST, LauncherIcons.current(device.stateOf, null))
        assertTrue(LauncherIcons.plan(MIST, device.stateOf, originalInUse = false).isEmpty)
    }

    @Test fun theFirstSwitchEnablesTheNewEntryThenDisablesTheOriginal() {
        val device = Device()
        val plan = LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = false)
        assertEquals("[LauncherNight=$STATE_ENABLED]", plan.enable.toString())
        assertEquals("[LauncherMist=$STATE_DISABLED]", plan.disable.toString())
        assertFalse(plan.deferred)
        device.apply(plan)
        assertEquals(listOf(alias(NIGHT)), device.on())
        assertEquals(NIGHT, LauncherIcons.current(device.stateOf, NIGHT))
    }

    @Test fun theOriginalGoesOnceItsTaskIsSafelyInTheBackground() {
        val device = Device()
        val plan = LauncherIcons.plan(FROST, device.stateOf, originalInUse = true)
        assertTrue(plan.deferred)
        assertTrue(plan.disable.isEmpty())
        device.apply(plan)
        assertEquals(listOf(ORIGINAL, alias(FROST)), device.on())
        // The picker and new shortcuts use the choice while the old entry is waiting.
        assertEquals(FROST, LauncherIcons.current(device.stateOf, FROST))
        assertEquals(FROST, LauncherIcons.current(device.stateOf, null))
        assertEquals(alias(FROST), LauncherIcons.aliasFor(FROST, device.stateOf))
        // Home: it is now safe to disable the original, without a three-second delay.
        val settled = LauncherIcons.plan(FROST, device.stateOf, originalInUse = false)
        assertTrue(settled.enable.isEmpty())
        assertEquals("[LauncherMist=$STATE_DISABLED]", settled.disable.toString())
        device.apply(settled)
        assertEquals(listOf(alias(FROST)), device.on())
    }

    private fun task(
        opened: LauncherIcons.Alias,
        activities: Int,
        viaOrigActivity: Boolean = false,
        id: Int = 1,
        top: String? = PKG,
    ) = LauncherIcons.Task(
        if (viaOrigActivity) listOf("$PKG.MainActivity", opened.className) else listOf(opened.className, null),
        activities,
        id,
        top,
    )

    private fun keep(
        tasks: List<LauncherIcons.Task>,
        visible: Boolean = true,
        resumed: Int? = null,
        interactive: Boolean = true,
        locked: Boolean = false,
    ) = LauncherIcons.keepOriginal(tasks, PKG, visible, resumed, interactive, locked)

    @Test fun foregroundSwitchKeepsItsTaskUntilHome() {
        val tasks = listOf(task(ORIGINAL, 1))
        val device = Device()
        val foreground = LauncherIcons.plan(NIGHT, device.stateOf, keep(tasks, resumed = 1))
        assertTrue(foreground.deferred)
        device.apply(foreground)
        assertEquals(listOf(ORIGINAL, alias(NIGHT)), device.on())
        val background = LauncherIcons.plan(NIGHT, device.stateOf, keep(tasks, visible = false))
        assertFalse(background.deferred)
        device.apply(background)
        assertEquals(listOf(alias(NIGHT)), device.on())
    }

    @Test fun aSetCompletingAfterHomeCanSettleWithoutAnotherStopEvent() {
        val tasks = listOf(task(ORIGINAL, 1))
        val device = Device()
        // The stop callback ran before switchTo set its deferred flag. The set completion must
        // consult current visibility as well, without waiting for another lifecycle event.
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, LauncherIcons.originalInUse(tasks)))
        assertEquals(2, device.on().size)
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, keep(tasks, visible = false)))
        assertEquals(listOf(alias(NIGHT)), device.on())
    }

    @Test fun rapidChoicesSettleOnlyTheLatestPickAndMistCanCancelTheWait() {
        val device = Device()
        val tasks = listOf(task(ORIGINAL, 1))
        for (pick in listOf(NIGHT, FROST, INK)) {
            device.apply(LauncherIcons.plan(pick, device.stateOf, keep(tasks, resumed = 1)))
            assertEquals(listOf(ORIGINAL, alias(pick)), device.on())
        }
        val chosen = INK
        device.apply(LauncherIcons.plan(
            LauncherIcons.current(device.stateOf, chosen), device.stateOf, keep(tasks, visible = false),
        ))
        assertEquals(listOf(alias(INK)), device.on())

        val fresh = Device()
        for (pick in listOf(NIGHT, FROST, MIST)) {
            fresh.apply(LauncherIcons.plan(pick, fresh.stateOf, keep(tasks, resumed = 1)))
        }
        fresh.apply(LauncherIcons.plan(MIST, fresh.stateOf, keep(tasks, visible = false)))
        assertEquals(listOf(ORIGINAL), fresh.on())
    }

    @Test fun customTabsAndDocumentPickersKeepTheirOriginalTaskEvenAfterHome() {
        val tasks = listOf(task(ORIGINAL, 2, top = "com.android.documentsui"))
        assertTrue(keep(tasks, visible = false))
        // A second task resumes while the picker still lives on the original: leave both alone.
        assertTrue(keep(tasks + task(alias(NIGHT), 1, id = 2), resumed = 2))
        // Once the picker returns, a later Home can finish the deferred switch.
        assertFalse(keep(listOf(task(ORIGINAL, 1)), visible = false))
    }

    @Test fun unknownTaskTopsAreProtectedUntilANewSnapshotIsAvailable() {
        assertTrue(keep(listOf(task(ORIGINAL, 1, top = null)), visible = false))
        assertFalse(keep(listOf(task(ORIGINAL, 0, top = null)), visible = false))
    }

    @Test fun aForeignActivityInAnotherTaskDoesNotBlockRetiringTheOriginal() {
        val tasks = listOf(task(ORIGINAL, 1), task(alias(NIGHT), 2, id = 2, top = "com.android.documentsui"))
        assertFalse(keep(tasks, visible = false))
    }

    @Test fun screenOffAndLockAreNotHome() {
        val tasks = listOf(task(ORIGINAL, 1))
        assertTrue(keep(tasks, visible = false, interactive = false))
        assertTrue(keep(tasks, visible = false, locked = true))
        assertFalse(keep(tasks, visible = false, interactive = true, locked = false))
    }

    @Test fun nextLaunchWaitsForResumeBeforeRetiringAnOldTaskWithActivityRecords() {
        // A killed process need not have numActivities=0 in Recents. Do not close the old task
        // while the new activity is still starting, or if the user reopened the old entry.
        val tasks = listOf(task(ORIGINAL, 1), task(alias(NIGHT), 1, id = 2))
        assertTrue(keep(tasks, resumed = null))
        assertTrue(keep(tasks, resumed = 1))
        assertFalse(keep(tasks, resumed = 2))
    }

    @Test fun everyOriginalTaskMustBeOutOfSightAndFreeOfForeignActivities() {
        val tasks = listOf(task(ORIGINAL, 1), task(ORIGINAL, 1, id = 2))
        assertTrue(keep(tasks, resumed = 2))
        assertFalse(keep(tasks, visible = false))
        assertTrue(keep(tasks + task(ORIGINAL, 2, id = 3, top = "com.android.chrome"), visible = false))
    }

    @Test fun destructionOrSwipingTheLastActivityAwayLeavesNoTaskToProtect() {
        assertFalse(keep(emptyList()))
        assertFalse(keep(listOf(task(ORIGINAL, 0))))
        assertFalse(keep(listOf(task(ORIGINAL, 0)), interactive = false, locked = true))
    }

    @Test fun onlyAnOpenTaskOpenedThroughTheOriginalKeepsItOn() {
        assertFalse(LauncherIcons.originalInUse(emptyList()))
        assertTrue(LauncherIcons.originalInUse(listOf(task(ORIGINAL, 1))))
        assertTrue(LauncherIcons.originalInUse(listOf(task(ORIGINAL, 2, viaOrigActivity = true))))
        assertFalse(LauncherIcons.originalInUse(listOf(task(alias(NIGHT), 1), task(MIST_ALT, 1))))
        // A card with no activities can be removed. A process kill may instead keep activity records.
        assertFalse(LauncherIcons.originalInUse(listOf(task(ORIGINAL, 0))))
        assertFalse(LauncherIcons.originalInUse(listOf(task(ORIGINAL, 0), task(alias(NIGHT), 1))))
    }

    @Test fun theNextStartThroughTheNewEntryEndsTwoEntriesLeftByAnEndedProcess() {
        // Switched to 夜幕 from a task opened through the original, then the process ended before
        // the original went: two entries, and the old task only a card in Recents.
        val device = Device()
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = true))
        assertEquals(listOf(ORIGINAL, alias(NIGHT)), device.on())
        val tasks = listOf(task(ORIGINAL, 0), task(alias(NIGHT), 1))
        val start = LauncherIcons.plan(
            LauncherIcons.current(device.stateOf, NIGHT), device.stateOf, LauncherIcons.originalInUse(tasks),
        )
        assertFalse(start.deferred)
        device.apply(start)
        assertEquals(listOf(alias(NIGHT)), device.on())
    }

    @Test fun theNextStartThroughTheOriginalStillWaitsForHome() {
        val device = Device()
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = true))
        // Opened through the old entry again: keep its visible task until the user goes Home.
        val start = LauncherIcons.plan(
            LauncherIcons.current(device.stateOf, NIGHT), device.stateOf,
            LauncherIcons.originalInUse(listOf(task(ORIGINAL, 1))),
        )
        assertTrue(start.deferred)
        assertTrue(start.isEmpty)
        assertEquals(alias(NIGHT), start.target)
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = false))
        assertEquals(listOf(alias(NIGHT)), device.on())
    }

    @Test fun pickingMistWhileTheOriginalWaitsKeepsTheOriginal() {
        val device = Device()
        device.apply(LauncherIcons.plan(INK, device.stateOf, originalInUse = true))
        val back = LauncherIcons.plan(MIST, device.stateOf, originalInUse = true)
        assertSame(ORIGINAL, back.target)
        assertTrue(back.enable.isEmpty())
        assertEquals("[LauncherInk=$STATE_DEFAULT]", back.disable.toString())
        assertFalse(back.deferred)
        device.apply(back)
        assertEquals(listOf(ORIGINAL), device.on())
        assertEquals(MIST, LauncherIcons.current(device.stateOf, MIST))
    }

    @Test fun mistComesBackThroughItsTwinAndOthersAreOnlyEverResetToDefault() {
        val device = Device()
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = false))
        val back = LauncherIcons.plan(MIST, device.stateOf, originalInUse = false)
        assertSame(MIST_ALT, back.target)
        assertEquals("[LauncherMistAlt=$STATE_ENABLED]", back.enable.toString())
        assertEquals("[LauncherNight=$STATE_DEFAULT]", back.disable.toString())
        device.apply(back)
        assertEquals(listOf(MIST_ALT), device.on())
        assertEquals(MIST, LauncherIcons.current(device.stateOf, null))
        // Away from 雾蓝 again: its twin goes back to the manifest's "off", nothing is DISABLED.
        val again = LauncherIcons.plan(INK, device.stateOf, originalInUse = true)
        assertEquals("[LauncherMistAlt=$STATE_DEFAULT]", again.disable.toString())
        assertFalse(again.deferred)
    }

    @Test fun anyWalkKeepsOneEntryAndDisablesTheOriginalAtMostOnce() {
        val random = Random(7)
        repeat(200) {
            val device = Device()
            var chosen: String? = null
            repeat(30) {
                val pick = LauncherIcons.variants.random(random)
                val inUse = random.nextBoolean()
                chosen = pick
                // New entry first: never a moment without one.
                device.apply(LauncherIcons.plan(pick, device.stateOf, inUse)) { assertTrue(device.on().isNotEmpty()) }
                assertEquals(pick, LauncherIcons.current(device.stateOf, chosen))
                val on = device.on()
                assertTrue(on.toString(), on.size == 1 || (on.size == 2 && ORIGINAL in on))
                if (random.nextInt(3) == 0) {
                    // A later safe background/start checkpoint finishes the deferred switch-off.
                    device.apply(LauncherIcons.plan(LauncherIcons.current(device.stateOf, chosen), device.stateOf, false))
                    assertEquals(1, device.on().size)
                    assertEquals(pick, LauncherIcons.current(device.stateOf, null))
                }
            }
            val disabled = device.writes.filter { it.state == STATE_DISABLED }
            assertTrue(disabled.all { it.className == ORIGINAL.className })
            assertTrue(disabled.size <= 1)
            assertTrue(device.writes.none { it.className == ORIGINAL.className && it.state != STATE_DISABLED })
        }
    }

    @Test fun anInterruptedSwitchIsSettledTowardsTheLastPick() {
        // Killed between "enable frost" and "disable night": two entries, the pick remembered.
        val device = Device()
        device.states[ORIGINAL.className] = STATE_DISABLED
        device.states[alias(NIGHT).className] = STATE_ENABLED
        device.states[alias(FROST).className] = STATE_ENABLED
        assertEquals(FROST, LauncherIcons.current(device.stateOf, FROST))
        device.apply(LauncherIcons.plan(FROST, device.stateOf, originalInUse = false))
        assertEquals(listOf(alias(FROST)), device.on())
    }

    @Test fun rebootRollbackToManifestDefaultsRestoresTheSavedChoiceWithoutClosingItsOldTask() {
        val device = Device()
        device.apply(LauncherIcons.plan(FROST, device.stateOf, originalInUse = true))
        // chosen=frost was synchronously persisted, but PM had not flushed its alias settings.
        device.states.clear()
        assertEquals(listOf(ORIGINAL), device.on())
        assertEquals(MIST, LauncherIcons.current(device.stateOf, FROST))
        val restart = LauncherIcons.settlePlan(device.stateOf, FROST, originalInUse = true)
        assertEquals(alias(FROST), restart.target)
        assertTrue(restart.deferred)
        assertTrue(restart.disable.isEmpty())
        device.apply(restart) { assertTrue(device.on().isNotEmpty()) }
        assertEquals(listOf(ORIGINAL, alias(FROST)), device.on())
        assertEquals(FROST, LauncherIcons.current(device.stateOf, FROST))
        // Home finishes the repair using the same persisted choice.
        device.apply(LauncherIcons.settlePlan(device.stateOf, FROST, originalInUse = false))
        assertEquals(listOf(alias(FROST)), device.on())
    }

    @Test fun rollbackToAnOlderNonDefaultEntryAlsoRestoresTheLatestChoice() {
        val device = Device()
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = false))
        val repair = LauncherIcons.settlePlan(device.stateOf, FROST, originalInUse = false)
        assertEquals("[LauncherFrost=$STATE_ENABLED]", repair.enable.toString())
        assertEquals("[LauncherNight=$STATE_DEFAULT]", repair.disable.toString())
        device.apply(repair) { assertTrue(device.on().isNotEmpty()) }
        assertEquals(listOf(alias(FROST)), device.on())
    }

    @Test fun aSavedMistChoiceOverridesAnOlderEntryIncludingTheFixtureReset() {
        for (originalInUse in listOf(true, false)) {
            val device = Device()
            device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse))
            val repair = LauncherIcons.settlePlan(device.stateOf, MIST, originalInUse)
            assertEquals(if (originalInUse) ORIGINAL else MIST_ALT, repair.target)
            assertFalse(repair.deferred)
            device.apply(repair) { assertTrue(device.on().isNotEmpty()) }
            assertEquals(listOf(repair.target), device.on())
            assertEquals(MIST, LauncherIcons.current(device.stateOf, MIST))
        }
        assertTrue(LauncherIcons.settlePlan(Device().stateOf, MIST, originalInUse = false).isEmpty)
    }

    @Test fun oldInstallsAndUnknownSavedValuesKeepTheirExistingIcon() {
        for (chosen in listOf(null, "", "rainbow")) {
            val device = Device()
            device.apply(LauncherIcons.plan(INK, device.stateOf, originalInUse = false))
            val plan = LauncherIcons.settlePlan(device.stateOf, chosen, originalInUse = false)
            assertEquals(alias(INK), plan.target)
            assertTrue(plan.isEmpty)
            val fresh = LauncherIcons.settlePlan(Device().stateOf, chosen, originalInUse = false)
            assertSame(ORIGINAL, fresh.target)
            assertTrue(fresh.isEmpty)
        }
    }

    @Test fun planningOrFailingToEnableDoesNotReportTheSavedIconAsAlreadyCurrent() {
        val device = Device()
        device.apply(LauncherIcons.plan(NIGHT, device.stateOf, originalInUse = false))
        val plan = LauncherIcons.settlePlan(device.stateOf, FROST, originalInUse = false)
        assertEquals(alias(FROST), plan.target)
        // PM throws before the enable step is applied; the persisted intent is not a success.
        assertEquals(NIGHT, LauncherIcons.current(device.stateOf, FROST))
        val retry = LauncherIcons.settlePlan(device.stateOf, FROST, originalInUse = false)
        assertEquals(plan.enable.toString(), retry.enable.toString())
        device.apply(retry)
        assertEquals(FROST, LauncherIcons.current(device.stateOf, FROST))
    }

    @Test fun noEntryAtAllIsRepairedWithTheSavedChoice() {
        val device = Device()
        device.states[ORIGINAL.className] = STATE_DISABLED
        device.apply(LauncherIcons.settlePlan(device.stateOf, NIGHT, originalInUse = false))
        assertEquals(listOf(alias(NIGHT)), device.on())
    }

    @Test fun noEntryAtAllAndNoSavedChoiceIsRepairedWithMist() {
        val device = Device()
        device.states[ORIGINAL.className] = STATE_DISABLED
        assertTrue(device.on().isEmpty())
        assertEquals(MIST, LauncherIcons.current(device.stateOf, NIGHT))
        device.apply(LauncherIcons.settlePlan(device.stateOf, null, originalInUse = false))
        assertEquals(listOf(MIST_ALT), device.on())
    }

    @Test fun userDisabledCountsAsOff() {
        val device = Device()
        device.states[alias(INK).className] = 3 // COMPONENT_ENABLED_STATE_DISABLED_USER
        assertFalse(LauncherIcons.isOn(alias(INK), 3))
        assertEquals(MIST, LauncherIcons.current(device.stateOf, INK))
    }

    @Test(expected = IllegalArgumentException::class)
    fun unknownIconsAreRefused() {
        LauncherIcons.plan("rainbow", Device().stateOf, originalInUse = false)
    }

    @Test fun everyVariantHasExactlyOneAliasBesidesTheOriginal() {
        assertEquals(listOf(MIST, NIGHT, FROST, INK), LauncherIcons.variants)
        for (variant in LauncherIcons.variants) {
            assertEquals(1, LauncherIcons.aliases.count { it.variant == variant && it !== ORIGINAL })
        }
        assertEquals(listOf(ORIGINAL), LauncherIcons.aliases.filter { it.enabledByManifest })
    }
}
