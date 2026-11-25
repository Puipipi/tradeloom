package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File

// killStrays does not use these startup-only dependencies. Keep their signatures
// available while compiling the unchanged complete production DshProcess file.
class RuntimeManifest(
    val abi: String = "x86_64",
    val launchArgv: List<String> = emptyList(),
    val launchEnv: Map<String, String> = emptyMap(),
)
object SafeMode { fun profileArg(arg: String, safe: Boolean): String? = null }
object SessionSearchGuest {
    fun file(root: File): File = File(root, "missing-search-overlay")
    fun launchArg(arg: String): String? = null
}
object AppAuthGuest {
    fun file(root: File): File = File(root, "missing-auth-overlay")
    fun launchArg(arg: String): String? = null
}
