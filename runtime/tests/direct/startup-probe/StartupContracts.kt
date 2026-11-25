package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File

// The startup-policy probe executes the real DshProcess/DirectLaunch/ownership
// code. These adjacent services are absent; SafeMode only marks the harmless
// fixture command as selected. It does not test rescue-profile rewriting.
class RuntimeManifest(
    val abi: String = "x86_64",
    val launchArgv: List<String> = emptyList(),
    val launchEnv: Map<String, String> = emptyMap(),
)
object SafeMode {
    fun profileArg(arg: String, safe: Boolean): String? =
        if (safe && arg == "startup-probe-command") arg else null
}
object SessionSearchGuest {
    fun file(root: File): File = File(root, "missing-search-overlay")
    fun launchArg(arg: String): String? = null
}
object AppAuthGuest {
    fun file(root: File): File = File(root, "missing-auth-overlay")
    fun launchArg(arg: String): String? = null
}
