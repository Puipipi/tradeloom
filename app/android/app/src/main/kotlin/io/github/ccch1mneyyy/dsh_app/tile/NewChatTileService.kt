package io.github.ccch1mneyyy.dsh_app.tile

import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import io.github.ccch1mneyyy.dsh_app.R
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import io.github.ccch1mneyyy.dsh_app.shortcuts.EntryActivity

/**
 * Quick Settings tile 「新对话」: opens the app on a new conversation (through
 * shortcuts/EntryActivity, like the launcher shortcut). An action, not a switch: always
 * inactive, with the app's name as its second line (otherwise the system writes 「关闭」 there).
 * On the lock screen it asks to unlock first.
 */
class NewChatTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        tile.state = Tile.STATE_INACTIVE
        tile.label = AppStrings.get(this, R.string.tile_new_chat_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = applicationInfo.loadLabel(packageManager)
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { open() } else open()
    }

    private fun open() {
        val intent = EntryActivity.newChat(this).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startActivityAndCollapse(
                    PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
                )
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        } catch (_: Exception) {
        }
    }
}
