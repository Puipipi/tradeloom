package io.github.ccch1mneyyy.dsh_app.update

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** A foreground, one-attempt native confirmation; never inherits phone-task waivers. */
internal class SelfUpdateConfirmation(
    private val main: Handler,
    private val activity: () -> Activity?,
) {
    private class Request(val host: Activity, val answer: CompletableFuture<Boolean>) {
        var dialog: AlertDialog? = null
    }
    // Only the main thread owns the visible request.
    private var visible: Request? = null

    fun ask(title: Int, message: String, positive: Int, allowed: () -> Boolean = { true }): Boolean {
        val answer = CompletableFuture<Boolean>()
        var request: Request? = null
        main.post {
            val host = activity()
            if (answer.isDone || !allowed() || visible != null || host == null || host.isFinishing ||
                host.isDestroyed || !host.hasWindowFocus()) {
                answer.complete(false)
                return@post
            }
            val current = Request(host, answer)
            request = current
            visible = current
            try {
                current.dialog = AlertDialog.Builder(host)
                    .setTitle(AppStrings.get(host, title))
                    .setMessage(message)
                    .setPositiveButton(AppStrings.get(host, positive)) { dialog, _ ->
                        val valid = allowed() && visible === current && activity() === host &&
                            !host.isFinishing && !host.isDestroyed
                        answer.complete(valid)
                        dialog.dismiss()
                    }
                    .setNegativeButton(AppStrings.context(host).getString(android.R.string.cancel)) { _, _ -> answer.complete(false) }
                    .setOnCancelListener { answer.complete(false) }
                    .setOnDismissListener {
                        answer.complete(false)
                        if (visible === current) visible = null
                    }
                    .create()
                current.dialog?.show()
            } catch (_: RuntimeException) {
                if (visible === current) visible = null
                answer.complete(false)
            }
        }
        return try {
            answer.get(90, TimeUnit.SECONDS) && allowed() && request?.let {
                activity() === it.host && !it.host.isFinishing && !it.host.isDestroyed
            } == true
        } catch (_: Exception) {
            false
        } finally {
            answer.complete(false)
            main.post {
                val current = request
                if (current != null && visible === current) {
                    visible = null
                    current.dialog?.dismiss()
                }
            }
        }
    }

    fun cancelPending() {
        main.post {
            val current = visible ?: return@post
            visible = null
            current.answer.complete(false)
            current.dialog?.dismiss()
        }
    }
}
