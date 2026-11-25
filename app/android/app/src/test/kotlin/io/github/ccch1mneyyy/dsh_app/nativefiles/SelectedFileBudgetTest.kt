package io.github.ccch1mneyyy.dsh_app.nativefiles

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SelectedFileBudgetTest {
    @Test fun rejectsCountAndMetadataBeforeAnyRead() {
        val budget = SelectedFileBudget(2, 8, 12)
        assertThrows(IllegalArgumentException::class.java) { budget.metadata(listOf(1, 1, 1)) }
        assertThrows(IllegalArgumentException::class.java) { budget.metadata(listOf(9)) }
        assertThrows(IllegalArgumentException::class.java) { budget.metadata(listOf(8, 5)) }
        budget.metadata(listOf(null, 0))
    }

    @Test fun unknownOrDishonestSizeStillHasActualPerFileAndTotalCaps() {
        val budget = SelectedFileBudget(2, 8, 12)
        budget.metadata(listOf(null, 1))
        budget.accept("a", 8)
        assertEquals(1, budget.chunkSize("a"))
        assertThrows(IllegalArgumentException::class.java) { budget.accept("a", 1) }
        // A rejected byte never consumes budget for the next file.
        budget.accept("b", 4)
        assertEquals(1, budget.chunkSize("b"))
        assertThrows(IllegalArgumentException::class.java) { budget.accept("b", 1) }
    }

    @Test fun channelChunkHasAConstantMemoryBound() {
        val budget = SelectedFileBudget(4, 8 * 1024 * 1024, 16 * 1024 * 1024)
        assertEquals(64 * 1024, budget.chunkSize("a"))
        repeat(128) { budget.accept("a", 64 * 1024) }
        assertEquals(1, budget.chunkSize("a"))
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(5, 8, 16) }
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(1, Int.MAX_VALUE, 16) }
    }

    @Test fun onlyTheAppsOwnPickReadsUpTo30Mb() {
        val mb30 = 30 * 1024 * 1024
        // A plugin can't ask for it.
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(1, mb30, mb30) }
        val budget = SelectedFileBudget(1, mb30, mb30, own = true)
        budget.metadata(listOf(mb30.toLong()))
        assertThrows(IllegalArgumentException::class.java) { budget.metadata(listOf(mb30 + 1L)) }
        // One file, and not a byte past 30 MB.
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(2, mb30, mb30, own = true) }
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(1, mb30 + 1, mb30 + 1, own = true) }
    }

    @Test fun theWallpapersPhotoPickIsTheAppsOwnToo() {
        // lib/wallpaper/custom_wallpaper.dart: 15 MB, photos only. A plugin's budget refuses it.
        val mb15 = 15 * 1024 * 1024
        assertThrows(IllegalArgumentException::class.java) { SelectedFileBudget(1, mb15, mb15) }
        val budget = SelectedFileBudget(1, mb15, mb15, own = true)
        budget.metadata(listOf(mb15.toLong()))
        assertThrows(IllegalArgumentException::class.java) { budget.metadata(listOf(mb15 + 1L)) }
    }
}
