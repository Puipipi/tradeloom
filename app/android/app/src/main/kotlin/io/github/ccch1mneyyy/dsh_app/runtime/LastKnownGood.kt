package io.github.ccch1mneyyy.dsh_app.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files

/** Enabled bundles, installed packages and settings layer of the main profile at one moment. */
data class ProfileSnapshot(
    /** `dsh.profile.bundles`, in order. */
    val bundles: List<String>,
    /** `dependencies` (installed third-party packages). */
    val deps: Set<String>,
    /** Installed versions of [deps] that could be read from node_modules. */
    val versions: Map<String, String>,
    /** `cordis.patch.yml` text, or null when the file is absent. */
    val patch: String?,
)

/**
 * What restoring the last good snapshot changes in the current profile: the bundle list
 * goes back to the snapshot's, minus packages uninstalled or upgraded since (an upgraded package
 * can only be turned off, not downgraded); the settings layer goes back when it differs.
 * Nothing is installed or removed.
 */
data class LkgPlan(
    val target: List<String>,
    val disable: List<String>,
    val enable: List<String>,
    /** Enabled packages whose installed version differs from the snapshot's (part of [disable]). */
    val changed: List<String>,
    val patchChanged: Boolean,
    val bundlesChanged: Boolean,
) {
    val isEmpty: Boolean get() = !bundlesChanged && !patchChanged

    fun toMap(): Map<String, Any?> = mapOf(
        "disable" to disable,
        "enable" to enable,
        "changed" to changed,
        "patchChanged" to patchChanged,
        "empty" to isEmpty,
    )

    companion object {
        fun of(lkg: ProfileSnapshot, current: ProfileSnapshot): LkgPlan {
            fun sameVersion(name: String): Boolean {
                val then = lkg.versions[name]
                val now = current.versions[name]
                return then == null || now == null || then == now
            }
            val target = lkg.bundles.filter { name ->
                when {
                    name !in lkg.deps -> true // ships with DSH
                    name !in current.deps -> false // uninstalled since
                    else -> sameVersion(name)
                }
            }.distinct()
            return LkgPlan(
                target = target,
                disable = current.bundles.filter { it !in target }.distinct(),
                enable = target.filter { it !in current.bundles },
                changed = lkg.bundles.filter { it in lkg.deps && it in current.deps && it in current.bundles && !sameVersion(it) }.distinct(),
                patchChanged = !samePatch(lkg.patch, current.patch),
                bundlesChanged = target != current.bundles,
            )
        }

        fun samePatch(a: String?, b: String?): Boolean {
            val trivialA = a == null || SafeMode.isTrivialPatch(a)
            val trivialB = b == null || SafeMode.isTrivialPatch(b)
            if (trivialA && trivialB) return true
            return a?.trimEnd() == b?.trimEnd()
        }
    }
}

/**
 * The last good plugin set of profile `web`, kept outside the rootfs in
 * `filesDir/runtime/lkg/lkg.json` and recorded after each healthy two-minute normal run.
 */
object LastKnownGood {
    class Record(val at: Long, val snapshot: ProfileSnapshot)

    fun webDir(rootfs: File): File = File(rootfs, "root/.dsh/profiles/web")

    /** The main profile as it is now; null before DSH has created it. */
    fun read(rootfs: File): ProfileSnapshot? {
        val dir = webDir(rootfs)
        val pkg = profileSource(rootfs, "package.json") ?: return null
        return parse(JSONObject(pkg.readText()), dir, rootfs)
    }

    // Capture happens before a PRoot start materializes tawc names. Resolve only for reads;
    // locks, replacements and deletions still belong to the original profile name.
    private fun profileSource(rootfs: File, name: String): File? =
        File(webDir(rootfs), name).takeIf { it.isFile }
            ?: io.github.ccch1mneyyy.dsh_app.files.GuestFiles.resolve(rootfs, "/root/.dsh/profiles/web/$name", PhoneStorage.GUEST_PATH)

    /**
     * What a normal run booted with, fixed when it reports ready: [atLaunch], or on a first boot
     * (DSH creates the profile after the launch read found none) the profile [readNow] returns.
     * Null when it is still missing or can't be read.
     */
    fun bootedAtReady(atLaunch: ProfileSnapshot?, readNow: () -> ProfileSnapshot?): ProfileSnapshot? =
        atLaunch ?: try {
            readNow()
        } catch (_: Exception) {
            null
        }

    /**
     * A healthy run pins exactly what it booted with, never a later read of the disk: the app may
     * have imported a profile since that nobody has seen run. False, keeping the old pin, without one.
     */
    fun pinBooted(booted: ProfileSnapshot?, save: (ProfileSnapshot) -> Unit): Boolean {
        save(booted ?: return false)
        return true
    }

    private fun parse(json: JSONObject, dir: File, rootfs: File): ProfileSnapshot {
        val bundles = json.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles").strings()
        val depsJson = json.optJSONObject("dependencies")
        val deps = LinkedHashSet<String>()
        depsJson?.keys()?.forEach { deps += it }
        val versions = LinkedHashMap<String, String>()
        for (name in deps) {
            val version = try {
                val text = io.github.ccch1mneyyy.dsh_app.files.GuestFiles.resolve(
                    rootfs, "/root/.dsh/profiles/web/node_modules/$name/package.json", PhoneStorage.GUEST_PATH,
                )?.readText() ?: continue
                JSONObject(text).optString("version")
            } catch (_: Exception) {
                null
            }
            if (!version.isNullOrEmpty()) versions[name] = version
        }
        val patch = profileSource(rootfs, "cordis.patch.yml")?.readText()
        return ProfileSnapshot(bundles, deps, versions, patch)
    }

    fun load(file: File): Record? {
        if (!file.isFile) return null
        return try {
            val json = JSONObject(file.readText())
            val versionsJson = json.optJSONObject("versions")
            val versions = LinkedHashMap<String, String>()
            versionsJson?.keys()?.forEach { versions[it] = versionsJson.optString(it) }
            Record(
                at = json.optLong("at"),
                snapshot = ProfileSnapshot(
                    bundles = json.optJSONArray("bundles").strings(),
                    deps = json.optJSONArray("deps").strings().toCollection(LinkedHashSet()),
                    versions = versions,
                    patch = if (json.isNull("patch")) null else json.optString("patch"),
                ),
            )
        } catch (_: Exception) {
            null
        }
    }

    fun save(file: File, snapshot: ProfileSnapshot, at: Long) {
        val versions = JSONObject()
        snapshot.versions.forEach { (k, v) -> versions.put(k, v) }
        val json = JSONObject()
            .put("at", at)
            .put("bundles", JSONArray(snapshot.bundles))
            .put("deps", JSONArray(snapshot.deps.toList()))
            .put("versions", versions)
            .put("patch", snapshot.patch ?: JSONObject.NULL)
        file.parentFile?.mkdirs()
        SafeMode.writeAtomic(file, json.toString(2) + "\n")
    }

    /**
     * Applies [LkgPlan.of] to the main profile under DSH's `package.json.lock`. The settings
     * layer being replaced is kept as `cordis.patch.yml.bak-<stamp>`.
     */
    fun restore(
        rootfs: File, lkg: ProfileSnapshot, stamp: String,
        missingConfig: String = "找不到主配置 profiles/web/package.json", // l10n:keep test default
        busyConfig: String = "插件配置正被别的程序修改，稍后再试", // l10n:keep test default
    ): LkgPlan {
        val dir = webDir(rootfs)
        val pkg = File(dir, "package.json")
        if (profileSource(rootfs, "package.json") == null) throw IllegalStateException(missingConfig)
        return withLock(pkg, busyConfig) {
            val source = profileSource(rootfs, "package.json") ?: throw IllegalStateException(missingConfig)
            val json = JSONObject(source.readText())
            val plan = LkgPlan.of(lkg, parse(json, dir, rootfs))
            if (plan.bundlesChanged) {
                val dsh = json.optJSONObject("dsh") ?: JSONObject().also { json.put("dsh", it) }
                val profile = dsh.optJSONObject("profile") ?: JSONObject().also { dsh.put("profile", it) }
                profile.put("bundles", JSONArray(plan.target))
                // Android's org.json escapes every '/' as "\/"; undo that so the file stays as DSH writes it.
                SafeMode.writeAtomic(pkg, json.toString(2).replace("\\/", "/") + "\n")
            }
            if (plan.patchChanged) {
                val patchFile = File(dir, "cordis.patch.yml")
                profileSource(rootfs, "cordis.patch.yml")?.copyTo(File(dir, "cordis.patch.yml.bak-$stamp"), overwrite = true)
                val text = lkg.patch
                if (text != null) SafeMode.writeAtomic(patchFile, text) else Files.deleteIfExists(patchFile.toPath())
            }
            plan
        }
    }

    /**
     * DSH's writer lock (`dsh-atomic-write`): a sibling `<file>.lock` created exclusively,
     * holding the writer's pid; a lock whose pid no longer exists is taken over.
     */
    private fun <T> withLock(file: File, busyConfig: String, block: () -> T): T {
        val lock = File(file.path + ".lock")
        val deadline = System.currentTimeMillis() + 3000
        val owner = File.createTempFile(".dsh-lkg-lock-", ".pid", file.parentFile)
        var published = false
        try {
            // Readers follow the relative link, which is published only after its PID is complete.
            owner.writeText("${android.os.Process.myPid()}\n")
            while (true) {
                try {
                    Files.createSymbolicLink(lock.toPath(), owner.toPath().fileName)
                    published = true
                    break
                } catch (_: FileAlreadyExistsException) {
                    // Keep the existing PID read and stale-lock takeover rules.
                }
                val holder = try {
                    lock.readText().trim().toIntOrNull()
                } catch (_: Exception) {
                    null
                }
                if (holder != null && !File("/proc/$holder").exists()) {
                    if (lock.delete()) continue
                }
                if (System.currentTimeMillis() > deadline) throw IllegalStateException(busyConfig)
                Thread.sleep(50)
            }
            return block()
        } finally {
            // A lock we could not unlink must keep its readable PID record.
            if (!published || lock.delete()) owner.delete()
        }
    }

    private fun JSONArray?.strings(): List<String> {
        if (this == null) return emptyList()
        val out = ArrayList<String>(length())
        for (i in 0 until length()) optString(i).takeIf { it.isNotEmpty() }?.let { out += it }
        return out
    }
}
