package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException

/**
 * Voice input on the phone: a `--patch` overlay for the voice-input bundle's local recognizer
 * (`speech-to-text-sensevoice`). Its worker process holds the SenseVoice model (about 390 MB
 * resident once loaded) and by default stays 5 minutes after the last recording; on a phone that
 * memory is better given back sooner. A wake costs a model load (about 1 s on a desktop CPU, a
 * few seconds on a phone), so 90 s still covers a run of dictations in one conversation.
 *
 * A patch row replaces the entry's whole `config`, so it repeats the bundle's `dataRoot`. While the
 * bundle is off the row matches no entry: DSH logs a warning and skips it (cordis-plugin-include
 * `applyEntryPatches`), and switching the bundle on later applies it live.
 */
object SpeechGuest {
    const val PATCH = "/opt/dsh-app/speech.patch.yml"
    const val IDLE_TIMEOUT_MS = 90_000
    const val THREADS = 2

    private const val WEB_PATCH_ARG = "--patch /etc/dsh-app/dsh-web.patch.yml"
    private const val DSH_WEB = "/usr/local/bin/dsh web"

    // l10n:keep guest config comment
    val PATCH_YAML = """# dsh-app: on-device voice input. The DSH App rewrites this file at every engine start and passes
# it with --patch on normal launches (never in safe mode). Edits do not survive.
- id: speech-to-text-sensevoice
  config:
    dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')
    idleTimeoutMs: $IDLE_TIMEOUT_MS
    threads: $THREADS
"""

    /** The launch shell command with this overlay right after the app's own one; null when [arg] is not the `dsh web` launch. */
    fun launchArg(arg: String): String? {
        val web = arg.indexOf("$DSH_WEB ")
        if (web < 0 || arg.indexOf("$DSH_WEB ", web + 1) >= 0 || arg.contains("--profile")) return null
        val patch = arg.indexOf(WEB_PATCH_ARG, web)
        val at = if (patch >= 0 && arg.indexOf(WEB_PATCH_ARG, patch + 1) < 0) patch + WEB_PATCH_ARG.length else web + DSH_WEB.length
        return arg.substring(0, at) + " --patch $PATCH" + arg.substring(at)
    }

    fun file(rootfs: File) = File(rootfs, PATCH.removePrefix("/"))

    /** Writes the overlay; false when it could not be written, so this launch leaves it out. Cleanup is best effort. */
    fun writeFiles(rootfs: File): Boolean {
        val target = file(rootfs)
        return try {
            val dir = target.parentFile ?: throw IOException("no parent for ${target.path}")
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create ${dir.path}")
            if (!target.exists() || target.readText() != PATCH_YAML) {
                val tmp = File(dir, ".${target.name}.dsh-app-${System.nanoTime()}.tmp")
                try {
                    tmp.writeText(PATCH_YAML)
                    tmp.setReadable(true, false)
                    if (!tmp.renameTo(target)) throw IOException("could not replace ${target.path}")
                } finally {
                    if (tmp.exists()) tmp.delete()
                }
            }
            true
        } catch (_: Exception) {
            target.delete()
            false
        }
    }
}
