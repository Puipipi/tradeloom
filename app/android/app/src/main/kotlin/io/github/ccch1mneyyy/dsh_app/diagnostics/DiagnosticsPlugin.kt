package io.github.ccch1mneyyy.dsh_app.diagnostics

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.github.ccch1mneyyy.dsh_app.voice.VoiceDiagnostics
import io.github.ccch1mneyyy.dsh_app.runtime.RuntimeManifest
import io.github.ccch1mneyyy.dsh_app.update.ApkInstaller
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import kotlin.concurrent.thread

/**
 * Facts for the diagnostics bundle that only Android knows: MethodChannel `dsh/diagnostics`.
 *
 * - `info` → `{app: {versionName, versionCode, abi}, device: {manufacturer, brand, model,
 *   android, sdkInt, abis, memoryMb, freeStorageMb, display: {widthPx, heightPx, density,
 *   densityDpi, fontScale}}, manifest: {runtimeVersion, abi,
 *   dshVersion, nodeVersion, pnpmVersion, ubuntuVersion, prootVersion, rootfsBytes,
 *   uncompressedBytes, files}}` (the bundled runtime's `assets/runtime/manifest.json`).
 * - `engineLog {maxBytes}` → the last lines of the engine's log file (`dsh.log`, and the
 *   rotated `dsh.log.1` before it), which outlives the app process. Lines were already
 *   masked when written (`CrashClassifier.redact`); Dart masks them again.
 *
 * - `info.evidence` contains bounded persisted app errors/voice stages and this app's
 *   system exit metadata, with per-source availability. No exception bodies or exit traces.
 * - `recordAppError` / `recordVoiceStage` validate fixed fields and acknowledge after
 *   background durable storage; invalid_evidence / evidence_unavailable do not affect app handlers.
 *
 * System IME capture returns only allowlisted events; raw lines are confined to the
 * privileged parser and are never returned, persisted or sent to the engine log.
 */
class DiagnosticsPlugin : FlutterPlugin, io.flutter.embedding.engine.plugins.activity.ActivityAware, MethodChannel.MethodCallHandler {

    private val systemIme = SystemImePrompt()

    override fun onAttachedToActivity(binding: io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding) = systemIme.attach(binding.activity)
    override fun onReattachedToActivityForConfigChanges(binding: io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding) = systemIme.attach(binding.activity)
    override fun onDetachedFromActivityForConfigChanges() = systemIme.detach()
    override fun onDetachedFromActivity() = systemIme.detach()

    private var methods: MethodChannel? = null
    private lateinit var context: Context
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        systemIme.detach()
        methods?.setMethodCallHandler(null)
        methods = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "info" -> background(result) { mapOf("app" to app(), "device" to device(), "manifest" to manifest(), "voice" to VoiceDiagnostics.snapshot(context), "evidence" to DiagnosticsEvidence.snapshot(context)) }
            "recordAppError" -> DiagnosticsEvidence.record(context, "appErrors", call.arguments, result)
            "recordVoiceStage" -> DiagnosticsEvidence.record(context, "voiceStages", call.arguments, result)
            "collectSystemIme" -> systemIme.collect(result)
            "cancelSystemIme" -> { systemIme.cancel(); result.success(null) }
            "engineLog" -> {
                val maxBytes = (call.argument<Int>("maxBytes") ?: DEFAULT_LOG_BYTES).coerceIn(1024, MAX_LOG_BYTES)
                background(result) { engineLog(maxBytes) }
            }
            else -> result.notImplemented()
        }
    }

    private fun background(result: MethodChannel.Result, work: () -> Any?) {
        thread(name = "dsh-diagnostics") {
            val outcome = runCatching(work)
            main.post {
                outcome.fold(
                    onSuccess = { result.success(it) },
                    onFailure = { result.error("failed", it.message, null) },
                )
            }
        }
    }

    private fun app(): Map<String, Any?> {
        val pkg = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
        return mapOf(
            "versionName" to pkg?.versionName,
            "versionCode" to pkg?.let { ApkInstaller.versionCodeOf(it) },
            // .../lib/arm64 or .../lib/x86_64: the ABI this APK was built for.
            "abi" to context.applicationInfo.nativeLibraryDir?.let { File(it).name },
        )
    }

    private fun device(): Map<String, Any?> {
        val memory = ActivityManager.MemoryInfo()
        runCatching { (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory) }
        return mapOf(
            "manufacturer" to Build.MANUFACTURER,
            "brand" to Build.BRAND,
            "model" to Build.MODEL,
            "android" to Build.VERSION.RELEASE,
            "sdkInt" to Build.VERSION.SDK_INT,
            "abis" to Build.SUPPORTED_ABIS.toList(),
            "memoryMb" to memory.totalMem / MB,
            "freeStorageMb" to context.filesDir.usableSpace / MB,
            // What dp and the pet's k are computed from (pet/PetPack.kt): a size that looks wrong
            // in the overlay or the app is read against these.
            "display" to display(),
        )
    }

    private fun display(): Map<String, Any?> {
        val metrics = context.resources.displayMetrics
        return mapOf(
            "widthPx" to metrics.widthPixels,
            "heightPx" to metrics.heightPixels,
            "density" to metrics.density,
            "densityDpi" to metrics.densityDpi,
            "fontScale" to context.resources.configuration.fontScale,
        )
    }

    private fun manifest(): Map<String, Any?> {
        val json = runCatching { RuntimeManifest.load(context).raw }.getOrNull() ?: return emptyMap()
        return manifestSummary(json)
    }

    private fun engineLog(maxBytes: Int): List<String> {
        val dir = File(context.filesDir, "runtime/logs")
        val current = File(dir, "dsh.log")
        val rotated = File(dir, "dsh.log.1")
        val fromCurrent = tail(current, maxBytes)
        val room = maxBytes - fromCurrent.sumOf { it.toByteArray(Charsets.UTF_8).size + 1 }
        val fromRotated = if (room > 1024) tail(rotated, room) else emptyList()
        return fromRotated + fromCurrent
    }

    companion object {
        const val CHANNEL = "dsh/diagnostics"
        private const val MB = 1024L * 1024L
        private const val DEFAULT_LOG_BYTES = 512 * 1024
        private const val MAX_LOG_BYTES = 4 * 1024 * 1024

        /** The manifest fields a bug report needs; checksums, notes and launch details left out. */
        fun manifestSummary(json: JSONObject): Map<String, Any?> {
            fun str(key: String) = json.optString(key).ifEmpty { null }
            fun long(key: String) = json.optLong(key, -1L).takeIf { it >= 0 }
            val entries = json.optJSONObject("entries")
            return mapOf(
                "runtimeVersion" to str("runtimeVersion"),
                "abi" to str("abi"),
                "dshVersion" to str("dshVersion"),
                "nodeVersion" to str("nodeVersion"),
                "pnpmVersion" to str("pnpmVersion"),
                "ubuntuVersion" to str("ubuntuVersion"),
                "prootVersion" to str("prootVersion"),
                "rootfsBytes" to long("rootfsBytes"),
                "uncompressedBytes" to long("uncompressedBytes"),
                "files" to entries?.optLong("file", -1L)?.takeIf { it >= 0 },
            ).filterValues { it != null }
        }

        /** The last whole lines of [file] within [maxBytes]; empty when it is missing. */
        fun tail(file: File, maxBytes: Int): List<String> {
            if (!file.isFile) return emptyList()
            return RandomAccessFile(file, "r").use { raf ->
                val length = raf.length()
                val start = (length - maxBytes).coerceAtLeast(0)
                val bytes = ByteArray((length - start).toInt())
                var cutFirstLine = false
                if (start > 0) {
                    raf.seek(start - 1)
                    cutFirstLine = raf.read() != '\n'.code
                }
                raf.seek(start)
                raf.readFully(bytes)
                val lines = String(bytes, Charsets.UTF_8).split('\n')
                // Drop only a clipped first line; an exact line boundary is complete.
                val whole = if (cutFirstLine) lines.drop(1) else lines
                whole.dropLastWhile { it.isEmpty() }
            }
        }
    }
}
