package io.github.ccch1mneyyy.dsh_app.runtime

/**
 * What to say when an unpack ends with nobody looking. First run sets up while the
 * runtime unpacks and its waiting page promises 「完成时会通知你」, so someone who left
 * hears that it is ready (or that it stopped). Nothing while the app is on screen,
 * where the page moves on by itself, and nothing when notifications are off.
 */
enum class InstallAlert {
    READY,
    FAILED;

    companion object {
        fun choose(ok: Boolean, inForeground: Boolean, notificationsEnabled: Boolean): InstallAlert? = when {
            inForeground || !notificationsEnabled -> null
            ok -> READY
            else -> FAILED
        }
    }
}
