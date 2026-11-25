package io.github.ccch1mneyyy.dsh_app.update

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import io.github.ccch1mneyyy.dsh_app.R
import io.github.ccch1mneyyy.dsh_app.i18n.AppStrings
import io.github.ccch1mneyyy.dsh_app.update.privileged.PrivilegedSelfUpdater
import io.github.ccch1mneyyy.dsh_app.update.privileged.SelfUpdateException
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.Executors

/** Flutter bridge for in-app updates: MethodChannel `dsh/update` (see lib/update/installer.dart). */
class UpdatePlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {

    private lateinit var channel: MethodChannel
    private lateinit var appContext: Context
    private lateinit var installer: ApkInstaller
    private lateinit var selfUpdater: PrivilegedSelfUpdater
    @Volatile private var activity: Activity? = null
    private val main = Handler(Looper.getMainLooper())
    private var worker = Executors.newFixedThreadPool(2)
    private val confirmation = SelfUpdateConfirmation(main) { activity }
    private val privilegedBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var engineEpoch = 0L

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        ++engineEpoch
        appContext = binding.applicationContext
        installer = ApkInstaller(appContext)
        selfUpdater = PrivilegedSelfUpdater(appContext)
        if (worker.isShutdown) worker = Executors.newFixedThreadPool(2)
        channel = MethodChannel(binding.binaryMessenger, "dsh/update").also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        ++engineEpoch
        channel.setMethodCallHandler(null)
        confirmation.cancelPending()
        worker.shutdown()
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        activity = null
        confirmation.cancelPending()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "privilegedInstallStatus" -> privilegedRead(result) { selfUpdater.status() }
            "reconcileSelfUpdate" -> privilegedRead(result) { selfUpdater.reconcile() }
            "requestUpdateShizukuPermission" -> result.success(
                activity?.let { !it.isFinishing && !it.isDestroyed && it.hasWindowFocus() } == true &&
                    !privilegedBusy.get() && runCatching { selfUpdater.requestShizukuPermission() }.getOrDefault(false),
            )
            "installPrivileged" -> installPrivileged(call, result)
            "acknowledgeUnknownSelfUpdate" -> acknowledgeUnknown(result)
            "info" -> result.success(installer.info())
            "canRequestInstalls" -> result.success(installer.canRequestInstalls())
            "openInstallPermission" -> result.success(installer.openInstallPermission(activity))
            "inspect" -> {
                val apk = apkArgument(call, result) ?: return
                worker.execute {
                    val info = runCatching { installer.inspect(apk) }.getOrElse { mapOf("valid" to false) }
                    main.post { result.success(info) }
                }
            }
            "install" -> {
                val apk = apkArgument(call, result) ?: return
                var replied = false
                worker.execute {
                    installer.install(
                        apk,
                        confirm = ::showConfirm,
                        onResult = { outcome ->
                            main.post {
                                if (!replied) {
                                    replied = true
                                    result.success(outcome)
                                }
                            }
                        },
                    )
                }
            }
            "openWithSystem" -> {
                val apk = apkArgument(call, result) ?: return
                result.success(openWithSystem(apk))
            }
            else -> result.notImplemented()
        }
    }

    private fun privilegedRead(result: MethodChannel.Result, read: () -> Map<String, Any?>) {
        val epoch = engineEpoch
        worker.execute {
            try {
                val value = read()
                main.post { if (engineEpoch == epoch) result.success(value) }
            } catch (_: Exception) {
                main.post {
                    if (engineEpoch == epoch) result.error("self_update_unavailable", "Self-update status unavailable", null)
                }
            }
        }
    }

    private fun privilegedFailure(code: String, unknown: Boolean = false) = mapOf(
        "status" to if (unknown) "unknown" else if (code == "storage") "storage" else "failure",
        "errorCode" to code,
        "submitted" to unknown,
        "outcomeUnknown" to unknown,
    )

    private fun installPrivileged(call: MethodCall, result: MethodChannel.Result) {
        val request = SelfUpdateArguments.parse(call.arguments)
        if (request == null) {
            result.success(privilegedFailure("invalidArguments"))
            return
        }
        if (!privilegedBusy.compareAndSet(false, true)) {
            result.success(privilegedFailure("busy"))
            return
        }
        val epoch = engineEpoch
        val updater = selfUpdater
        worker.execute {
            var attempted = false
            val outcome = try {
                updater.prepare(request.path, request.sha256, request.versionCode, request.backend, request.port).use { prepared ->
                    val message = AppStrings.get(appContext, R.string.self_update_confirm,
                        prepared.backend, prepared.uid, prepared.versionName,
                        prepared.versionCode, prepared.sha256)
                    if (!confirmation.ask(R.string.self_update_confirm_title, message,
                            R.string.self_update_allow_once) { engineEpoch == epoch }) {
                        mapOf("status" to "aborted", "errorCode" to "declined",
                            "submitted" to false, "outcomeUnknown" to false)
                    } else {
                        attempted = true
                        updater.install(prepared)
                    }
                }
            } catch (error: SelfUpdateException) {
                privilegedFailure(error.code, attempted)
            } catch (_: Exception) {
                privilegedFailure(if (attempted) "outcomeUnknown" else "unavailable", attempted)
            } finally {
                privilegedBusy.set(false)
            }
            main.post { if (engineEpoch == epoch) result.success(outcome) }
        }
    }

    private fun acknowledgeUnknown(result: MethodChannel.Result) {
        val epoch = engineEpoch
        val updater = selfUpdater
        if (!privilegedBusy.compareAndSet(false, true)) {
            privilegedRead(result) { updater.reconcile() }
            return
        }
        worker.execute {
            try {
                val before = updater.reconcile()
                val accepted = before["state"] == "unknown" && before["canAcknowledge"] == true &&
                    confirmation.ask(R.string.self_update_wait_title,
                        AppStrings.get(appContext, R.string.self_update_wait_confirm),
                        R.string.self_update_wait_end) { engineEpoch == epoch }
                val value = if (accepted) updater.acknowledgeUnknown() else before
                main.post { if (engineEpoch == epoch) result.success(value) }
            } catch (_: Exception) {
                main.post {
                    if (engineEpoch == epoch) result.error("self_update_unavailable", "Self-update status unavailable", null)
                }
            } finally {
                privilegedBusy.set(false)
            }
        }
    }

    /**
     * The package in the system's own installer: some OEM builds stop the session install before
     * the person is asked (it reads as cancelled), while opening the file goes through.
     */
    private fun openWithSystem(apk: File): Boolean = runCatching {
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val host = activity
        if (host != null) host.startActivity(intent) else appContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.isSuccess

    private fun apkArgument(call: MethodCall, result: MethodChannel.Result): File? {
        val path = call.argument<String>("path")
        val file = path?.let(::File)
        if (file == null || !file.isFile) {
            result.error("no_file", "APK not found: $path", null)
            return null
        }
        return file
    }

    /** The system's "install this update?" dialog, over our activity when we have one. */
    private fun showConfirm(intent: Intent): Boolean {
        val host = activity
        return runCatching {
            if (host != null) host.startActivity(intent) else appContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.isSuccess
    }
}
