package io.github.ccch1mneyyy.dsh_app.update.privileged

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.pm.PackageManager
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class PrivilegedSelfUpdaterPersistenceTest {
    @Test fun failedAcknowledgementKeepsTheReceiptAndRetrySurvivesReopen() {
        checkAcknowledgementRecovery(failedWrites = 1)
    }

    @Test fun failedRollbackStillKeepsTheWholeReceiptForAnExplicitRetry() {
        checkAcknowledgementRecovery(failedWrites = 2)
    }

    private fun checkAcknowledgementRecovery(failedWrites: Int) {
        val files = Files.createTempDirectory("self-update-ack-").toFile()
        try {
            val original = mapOf<String, Any>(
                "state" to "unknown", "backend" to "adb",
                "requestId" to "9fa3e872-99e7-4ff4-89aa-850de2c6d452",
                "versionCode" to 11L, "size" to 123L, "sha256" to "ab".repeat(32),
                "signers" to setOf("first-signer", "second-signer"),
                "verifiedLastUpdateTime" to 0L, "errorCode" to "outcomeUnknown",
            )
            val preferences = MemoryAndDiskPreferences(original).apply { failNextWrites = failedWrites }
            val updater = PrivilegedSelfUpdater(TestContext(preferences, files))

            val failed = updater.acknowledgeUnknown()
            assertEquals("unknown", failed["state"])
            assertEquals(true, failed["canAcknowledge"])
            assertEquals("persistenceFailed", failed["errorCode"])
            assertEquals(failedWrites, preferences.failedWrites)
            assertEquals("A failed commit must not discard any receipt identity", original, preferences.getAll())
            assertEquals(original, preferences.diskSnapshot())

            // Freeing space permits a later, explicitly acknowledged clear to reach disk.
            preferences.failNextWrites = 0
            val cleared = updater.acknowledgeUnknown()
            val none = mapOf("state" to "none", "canAcknowledge" to false)
            assertEquals(none, cleared)
            val reopened = MemoryAndDiskPreferences(preferences.diskSnapshot())
            assertEquals(none, PrivilegedSelfUpdater(TestContext(reopened, files)).reconcile())
        } finally {
            files.deleteRecursively()
        }
    }

    private class TestContext(
        private val preferences: SharedPreferences,
        private val files: File,
    ) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
        override fun getPackageName(): String = SelfUpdatePolicy.PACKAGE
        override fun getFilesDir(): File = files
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            check(name == "self-update-pending-v1" && mode == Context.MODE_PRIVATE)
            return preferences
        }
        // Reconciliation must preserve unknown when live package evidence is unavailable.
        override fun getPackageManager(): PackageManager = throw UnsupportedOperationException("package evidence unavailable")
    }

    /** Models the SharedPreferences boundary: commit changes RAM before a disk write can fail. */
    private class MemoryAndDiskPreferences(initial: Map<String, Any>) : SharedPreferences {
        private var memory = copy(initial)
        private var disk = copy(initial)
        private var memoryGeneration = 0L
        private var diskGeneration = 0L
        var failNextWrites = 0
        var failedWrites = 0
            private set

        fun diskSnapshot(): Map<String, Any> = copy(disk)
        override fun getAll(): MutableMap<String, *> = copy(memory)
        override fun contains(key: String): Boolean = memory.containsKey(key)
        override fun getString(key: String, defValue: String?): String? = memory[key] as String? ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
            (memory[key] as Set<String>?)?.toMutableSet() ?: defValues?.toMutableSet()
        override fun getLong(key: String, defValue: Long): Long = memory[key] as Long? ?: defValue
        override fun getInt(key: String, defValue: Int): Int = memory[key] as Int? ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = memory[key] as Float? ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = memory[key] as Boolean? ?: defValue
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
        override fun edit(): SharedPreferences.Editor = Editor()

        private inner class Editor : SharedPreferences.Editor {
            private val changes = linkedMapOf<String, Any?>()
            private var cleared = false
            private fun put(key: String, value: Any?): SharedPreferences.Editor {
                changes[key] = value
                return this
            }
            override fun putString(key: String, value: String?): SharedPreferences.Editor = put(key, value)
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = put(key, values?.toSet())
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = put(key, value)
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = put(key, value)
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = put(key, value)
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = put(key, value)
            override fun remove(key: String): SharedPreferences.Editor = put(key, null)
            override fun clear(): SharedPreferences.Editor {
                cleared = true
                return this
            }
            override fun apply() {
                error("This test requires synchronous receipt persistence")
            }
            override fun commit(): Boolean {
                val next = if (cleared) linkedMapOf<String, Any>() else copy(memory)
                changes.forEach { (key, value) -> if (value == null) next.remove(key) else next[key] = value }
                if (next != memory) {
                    memory = copy(next)
                    memoryGeneration++
                }
                changes.clear()
                cleared = false
                // The initial reconcile commits unchanged fields. It must not consume the fault.
                if (diskGeneration == memoryGeneration) return true
                if (failNextWrites > 0) {
                    failNextWrites--
                    failedWrites++
                    return false
                }
                disk = copy(memory)
                diskGeneration = memoryGeneration
                return true
            }
        }

        private fun copy(values: Map<String, Any>): MutableMap<String, Any> =
            values.mapValuesTo(linkedMapOf()) { (_, value) -> if (value is Set<*>) value.toSet() else value }
    }
}
