package io.github.ccch1mneyyy.dsh_app.voice

import java.security.MessageDigest

/** Content-free facts about the recognizer selected by Android. */
data class VoiceEnvironment(
    val sdk: Int,
    val osBuild: String,
    val service: String?,
    val servicePackage: String?,
    val serviceVersion: Long?,
    val serviceUpdatedAt: Long?,
    val recognizerAvailable: Boolean,
    val onDeviceAvailable: Boolean?,
) {
    // An unobservable/default-less service must not acquire a permanent failure mark.
    val identity: String? get() {
        if (osBuild.isBlank() || osBuild == "unknown" || service.isNullOrBlank() || servicePackage.isNullOrBlank() ||
            serviceVersion == null || serviceUpdatedAt == null
        ) return null
        val parts = listOf(sdk.toString(), osBuild, service, servicePackage, serviceVersion.toString(), serviceUpdatedAt.toString())
        val bytes = parts.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    fun diagnosticFields(): Map<String, Any?> = linkedMapOf(
        "sdk" to sdk,
        "defaultService" to service?.take(256),
        "servicePackage" to servicePackage?.take(256),
        "serviceVersion" to serviceVersion,
        "serviceUpdatedAt" to serviceUpdatedAt,
        "recognizerAvailable" to recognizerAvailable,
        "onDeviceFactoryApiAvailable" to (sdk >= 31),
        "onDeviceAvailable" to onDeviceAvailable,
        "environmentId" to identity,
    )
}

/** No audio, text, arbitrary exception message, or request object enters this policy. */
object VoicePolicy {
    const val MAX_FAILURES = 20

    // ERROR_CLIENT may also follow cancel(). The plugin retires that listener BEFORE cancel(),
    // so an explicit user cancellation never reaches this classification.
    fun serviceFailure(code: Int): Boolean = code != 6 && code != 7 && code != 9

    fun isUnreliable(environment: VoiceEnvironment, remembered: String?): Boolean =
        environment.identity?.let { it == remembered } == true

    fun errorName(code: Int): String = when (code) {
        1 -> "NETWORK_TIMEOUT"
        2 -> "NETWORK"
        3 -> "AUDIO"
        4 -> "SERVER"
        5 -> "CLIENT"
        6 -> "SPEECH_TIMEOUT"
        7 -> "NO_MATCH"
        8 -> "RECOGNIZER_BUSY"
        9 -> "INSUFFICIENT_PERMISSIONS"
        10 -> "TOO_MANY_REQUESTS"
        11 -> "SERVER_DISCONNECTED"
        12 -> "LANGUAGE_NOT_SUPPORTED"
        13 -> "LANGUAGE_UNAVAILABLE"
        14 -> "CANNOT_CHECK_SUPPORT"
        15 -> "CANNOT_LISTEN_TO_DOWNLOAD_EVENTS"
        100 -> "RECORDER_FAILED"
        else -> "UNKNOWN"
    }

    fun failureFields(environment: VoiceEnvironment, code: Int, stage: String, at: Long, exceptionType: String? = null): Map<String, Any?> =
        environment.diagnosticFields() + mapOf(
            "at" to at,
            "code" to code,
            "name" to errorName(code),
            "stage" to stage.takeIf { it in setOf("start", "listen", "stop", "record") },
            "exceptionType" to exceptionType?.take(80)?.filter { it.isLetterOrDigit() || it == '_' || it == '$' },
        )
}
