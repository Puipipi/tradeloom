package io.github.ccch1mneyyy.dsh_app.web

import java.net.URI
import java.util.Locale

/** Parsing only: no filesystem reads, grants or Android dependencies. */
internal object WebFilePolicy {
    private val mime = Regex("""^[a-z0-9!#$&^_.+-]+/([a-z0-9!#$&^_.+-]+|[*])$""")

    fun acceptTypes(raw: List<String>, extensionType: (String) -> String?): List<String> {
        val types = raw.flatMap { it.split(',') }.mapNotNull {
            val value = it.trim().lowercase(Locale.ROOT)
            if (value.startsWith('.')) extensionType(value.drop(1)) else value
        }.filter { it == "*/*" || mime.matches(it) }.distinct()
        return if (types.isEmpty() || "*/*" in types) listOf("*/*") else types
    }

    fun isExternalContent(raw: String, appId: String): Boolean {
        val uri = runCatching { URI(raw) }.getOrNull() ?: return false
        val authority = uri.authority ?: return false
        return uri.scheme == "content" && authority.isNotEmpty() &&
            authority != appId && !authority.startsWith(appId + ".")
    }
}
