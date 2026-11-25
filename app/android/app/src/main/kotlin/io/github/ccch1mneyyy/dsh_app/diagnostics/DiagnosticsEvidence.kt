package io.github.ccch1mneyyy.dsh_app.diagnostics

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** No raw exception messages, speech content, exit descriptions or exit traces. */
object DiagnosticsEvidence {
    private val gate = Any()
    private val failed = ConcurrentHashMap.newKeySet<String>()
    private val main = Handler(Looper.getMainLooper())
    private val writer = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(64)) {
        Thread(it, "dsh-evidence").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }

    fun record(context: Context, kind: String, raw: Any?, result: MethodChannel.Result) {
        val at = System.currentTimeMillis()
        val fields = (raw as? Map<*, *>)?.let { EvidenceStore.sanitize(kind, it, at) }
        if (fields == null) {
            result.error("invalid_evidence", "Invalid diagnostic fields", null)
            return
        }
        try {
            writer.execute {
                val outcome = runCatching {
                    synchronized(gate) {
                        store(context).append(kind, fields, at)
                        failed.remove(kind)
                    }
                }
                if (outcome.isFailure) failed.add(kind)
                main.post {
                    if (outcome.isSuccess) result.success(null)
                    else result.error("evidence_unavailable", "Evidence storage unavailable", null)
                }
            }
        } catch (_: RejectedExecutionException) {
            failed.add(kind)
            result.error("evidence_unavailable", "Evidence queue full", null)
        }
    }

    /** Call on a worker thread: reads app-private persisted records and this app's exit metadata. */
    fun snapshot(context: Context): Map<String, Any?> = synchronized(gate) {
        val availability = mutableMapOf<String, String>()
        fun records(kind: String): List<Map<String, Any?>> {
            val rows = runCatching { store(context).read(kind) }
            availability[kind] = if (rows.isSuccess && kind !in failed) "available" else "unavailable"
            return rows.getOrDefault(emptyList())
        }
        val errors = records("appErrors")
        val stages = records("voiceStages")
        val exits = if (Build.VERSION.SDK_INT < 30) {
            availability["processExits"] = "unsupported"
            emptyList()
        } else {
            val rows = runCatching {
                val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                manager.getHistoricalProcessExitReasons(context.packageName, 0, 8)
                    .filter { it.packageUid == context.applicationInfo.uid }
                    .take(8).map {
                        mapOf(
                            "at" to it.timestamp, "reason" to it.reason, "status" to it.status,
                            "importance" to it.importance, "pssKb" to it.pss, "rssKb" to it.rss,
                        )
                    }
            }
            availability["processExits"] = if (rows.isSuccess) "available" else "unavailable"
            rows.getOrDefault(emptyList())
        }
        mapOf(
            "appErrors" to errors, "voiceStages" to stages, "processExits" to exits,
            "availability" to availability,
            "limits" to mapOf("maxEntries" to EvidenceStore.MAX_ENTRIES, "maxBytes" to EvidenceStore.MAX_BYTES),
        )
    }

    private fun store(context: Context) = EvidenceStore(File(context.noBackupFilesDir, "diagnostic-evidence"))
}
