package io.github.ccch1mneyyy.dsh_app.pet

import android.app.Notification

/**
 * 「做完了」「出错了」 notifications while the floating pet says it:
 * still posted, but no heads-up, no sound, no vibration. 「等你确认 / 回答」 always alert.
 */
object ResultSilence {
    /** The pet is out, lit, not hidden by the system, and bubbles are on. */
    fun petSpeaks(visibility: Visibility, attached: Boolean, systemShown: Boolean, quiet: Boolean): Boolean =
        visibility == Visibility.SHOWN && attached && systemShown && !quiet

    /** Whether a chat notification goes out silently. */
    fun silenced(attention: Boolean, petSpeaks: Boolean): Boolean = !attention && petSpeaks

    /**
     * Silences [builder] when [silenced]: how NotificationCompat's setSilent does it on every API
     * level — a group child that only lets its summary alert. (Channels own sound and vibration
     * from API 26, the minimum here, so the group rule is the whole switch.) [group] is the group
     * the notification already has; it is set again so the rule can't apply to an ungrouped one.
     */
    fun apply(builder: Notification.Builder, group: String, attention: Boolean) {
        if (!silenced(attention, PetOverlay.speaksForResults)) return
        builder.setGroup(group).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
    }
}
