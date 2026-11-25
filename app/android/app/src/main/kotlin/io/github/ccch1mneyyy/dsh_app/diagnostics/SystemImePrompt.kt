package io.github.ccch1mneyyy.dsh_app.diagnostics

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel
import io.github.ccch1mneyyy.dsh_app.R
import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import io.github.ccch1mneyyy.dsh_app.phone.background.BackgroundControl
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Activity-owned, per-call consent. Never remembers approval or uses phone-control prompt state. */
internal class SystemImePrompt : Application.ActivityLifecycleCallbacks {
    private val main = Handler(Looper.getMainLooper())
    private var host: Activity? = null
    private var resumed = false
    private val running = AtomicBoolean(false)
    private class Pending(val result: MethodChannel.Result) {
        val consent = SystemImeConsent()
        var dialog: AlertDialog? = null
        var timeout: Runnable? = null
    }
    private var pending: Pending? = null

    fun attach(activity: Activity) {
        detach()
        host = activity
        resumed = activity.hasWindowFocus()
        activity.application.registerActivityLifecycleCallbacks(this)
    }

    fun detach() {
        cancel()
        host?.application?.unregisterActivityLifecycleCallbacks(this)
        host = null
        resumed = false
    }

    fun cancel() { pending?.let { finish(it, SystemImeEvidence.result("cancelled")) } }

    fun collect(result: MethodChannel.Result) {
        if (pending != null || running.get()) { result.success(SystemImeEvidence.result("busy")); return }
        val activity = host
        // Consent is a main-screen user action, never a virtual-display automation target.
        if (activity == null || !resumed || activity.isFinishing || activity.isDestroyed ||
            activity.window.decorView.display?.displayId != android.view.Display.DEFAULT_DISPLAY) {
            result.success(SystemImeEvidence.result("cancelled")); return
        }
        val call = Pending(result)
        pending = call
        try {
            val collect = io.github.ccch1mneyyy.dsh_app.phone.PhonePromptUi.PromptButton(
                activity, android.os.SystemClock.elapsedRealtime() + 600,
            ) { pending === call && resumed && host === activity &&
                activity.window.decorView.display?.displayId == android.view.Display.DEFAULT_DISPLAY }.apply {
                text = AppStrings.get(activity, R.string.ime_diagnostics_consent_collect)
                val padding = (24 * resources.displayMetrics.density).toInt()
                setPadding(padding, padding, padding, padding)
                setOnClickListener {
                    if (pending !== call || host !== activity || !resumed || !call.consent.approveAndConsume()) {
                        finish(call, SystemImeEvidence.result("cancelled"))
                    } else {
                        call.dialog?.dismiss()
                        start(call, activity)
                    }
                }
            }
            call.dialog = AlertDialog.Builder(activity)
                .setTitle(AppStrings.get(activity, R.string.ime_diagnostics_consent_title))
                .setMessage(AppStrings.get(activity, R.string.ime_diagnostics_consent_body))
                .setNegativeButton(AppStrings.get(activity, R.string.ime_diagnostics_consent_cancel)) { _, _ ->
                    finish(call, SystemImeEvidence.result("denied"))
                }
                .setView(collect)
                .setOnCancelListener { finish(call, SystemImeEvidence.result("denied")) }
                .create().also { it.setCanceledOnTouchOutside(false); it.show() }
        } catch (_: Exception) { finish(call, SystemImeEvidence.result("cancelled")) }
    }

    private fun start(call: Pending, activity: Activity) {
        if (!running.compareAndSet(false, true)) { finish(call, SystemImeEvidence.result("busy")); return }
        call.timeout = Runnable { finish(call, SystemImeEvidence.result("timeout")) }.also { main.postDelayed(it, 4000) }
        thread(name = "dsh-system-ime", isDaemon = true) {
            val value = try {
                BackgroundControl.get(activity.applicationContext).collectSystemIme { call.consent.allowed() }
            } catch (_: Exception) { SystemImeEvidence.result("failed") }
            finally { running.set(false) }
            main.post {
                if (pending === call) finish(call,
                    if (call.consent.allowed()) value else SystemImeEvidence.result("cancelled"))
            }
        }
    }

    private fun finish(call: Pending, value: Map<String, Any?>) {
        if (pending !== call) return
        pending = null
        call.consent.cancel()
        call.timeout?.let { main.removeCallbacks(it) }
        // Never interrupt a shared ADB/root exchange: that would retire the phone-control link.
        // In-flight reads finish under the privileged logcat deadline; their result is discarded.
        call.dialog?.dismiss()
        call.result.success(value)
    }

    override fun onActivityResumed(activity: Activity) { if (activity === host) resumed = true }
    override fun onActivityPaused(activity: Activity) { if (activity === host) { resumed = false; cancel() } }
    override fun onActivityStopped(activity: Activity) { if (activity === host) { resumed = false; cancel() } }
    override fun onActivityDestroyed(activity: Activity) { if (activity === host) detach() }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
}
