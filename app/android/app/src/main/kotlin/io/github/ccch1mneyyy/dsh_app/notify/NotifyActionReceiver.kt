package io.github.ccch1mneyyy.dsh_app.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The approval buttons on chat notifications (not exported: only our own PendingIntents reach it). */
class NotifyActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ChatNotifier(context.applicationContext).receiveAction(intent)
    }
}
