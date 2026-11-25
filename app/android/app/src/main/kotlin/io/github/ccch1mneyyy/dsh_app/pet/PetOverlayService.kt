package io.github.ccch1mneyyy.dsh_app.pet

import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import io.github.ccch1mneyyy.dsh_app.BuildConfig
import io.github.ccch1mneyyy.dsh_app.MainActivity
import io.github.ccch1mneyyy.dsh_app.R

/**
 * Keeps the process (and with it Dart's connection to a remote host) up while the pet is out and
 * DshService isn't running — someone who only uses remote hosts. With the local engine running,
 * DshService already does this and the pet rides on it. Not sticky: without the app's Dart side
 * there is nothing to show, so it isn't brought back after the process dies.
 */
class PetOverlayService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            ensureChannel(this)
            val n = notification(this)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, n)
            }
        } catch (e: Exception) {
            Log.w("DshPet", "pet service could not go foreground", e)
            keepAlive.promotionFailed()
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val action = keepAlive.promoted()
        if (intent?.action == ACTION_SNOOZE) PetOverlay.snoozeToday()
        dispatch(applicationContext, action)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        dispatch(applicationContext, keepAlive.destroyed())
    }

    companion object {
        private const val ACTION_SNOOZE = "io.github.ccch1mneyyy.dsh_app.PET_SNOOZE"
        private const val CHANNEL_ID = "dsh-pet"
        private const val NOTIFICATION_ID = 3090

        private val keepAlive = OverlayKeepAlive()
        val running get() = keepAlive.running

        /** Match the visible overlay without canceling a pending foreground start. */
        fun ensure(context: Context, on: Boolean) = dispatch(context, keepAlive.setNeeded(on))

        private fun dispatch(context: Context, action: OverlayKeepAlive.Action) {
            if (action == OverlayKeepAlive.Action.NONE) return
            val intent = Intent(context, PetOverlayService::class.java)
            try {
                if (action == OverlayKeepAlive.Action.START) {
                    context.startForegroundService(intent)
                } else if (!context.stopService(intent)) {
                    dispatch(context, keepAlive.destroyed())
                }
            } catch (e: Exception) {
                Log.w("DshPet", "pet service action refused: ${action.name.lowercase()}", e)
                keepAlive.requestFailed(action)
            }
        }

        private fun channelTitle(context: Context) = AppStrings.get(context,
            if (BuildConfig.TRADELOOM) R.string.tradeloom_workbench_overlay else R.string.pet_channel)

        private fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, channelTitle(context), NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                },
            )
        }

        private fun notification(context: Context): Notification {
            val open = PendingIntent.getActivity(
                context, NOTIFICATION_ID,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val snooze = PendingIntent.getService(
                context, NOTIFICATION_ID + 1,
                Intent(context, PetOverlayService::class.java).setAction(ACTION_SNOOZE),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_dsh)
                .setContentTitle(if (BuildConfig.TRADELOOM) channelTitle(context) else AppStrings.APP_NAME)
                .setContentText(AppStrings.get(context,
                    if (BuildConfig.TRADELOOM) R.string.tradeloom_workbench_overlay_enabled else R.string.pet_running))
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(Notification.Action.Builder(null, AppStrings.get(context, R.string.pet_snooze), snooze).build())
                .build()
        }
    }
}
