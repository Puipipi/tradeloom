package io.github.ccch1mneyyy.dsh_app.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebFilePolicyTest {
    @Test fun normalizesMimeListsAndExtensionsWithoutDiscardingFilters() {
        val types = WebFilePolicy.acceptTypes(listOf(" image/*, APPLICATION/PDF ", ".pdf", "image/*")) {
            if (it == "pdf") "application/pdf" else null
        }
        assertEquals(listOf("image/*", "application/pdf"), types)
    }

    @Test fun emptyOrUnknownAcceptUsesSystemAllFilesWithoutConstructingAnInvalidIntentType() {
        assertEquals(listOf("*/*"), WebFilePolicy.acceptTypes(emptyList()) { null })
        assertEquals(listOf("*/*"), WebFilePolicy.acceptTypes(listOf("", ".unknown", "image/*;bad")) { null })
        assertEquals(listOf("*/*"), WebFilePolicy.acceptTypes(listOf("image/*", "*/*")) { null })
    }

    @Test fun rejectsPrivateFilePathsOwnProvidersAndMalformedContentUris() {
        val app = "io.github.ccch1mneyyy.dsh_app"
        assertTrue(WebFilePolicy.isExternalContent("content://com.android.providers.downloads.documents/document/12", app))
        assertFalse(WebFilePolicy.isExternalContent("file:///data/user/0/" + app + "/private", app))
        assertFalse(WebFilePolicy.isExternalContent("content://" + app + ".files/private", app))
        assertFalse(WebFilePolicy.isExternalContent("content://" + app + "/private", app))
        assertFalse(WebFilePolicy.isExternalContent("content:///missing", app))
        assertFalse(WebFilePolicy.isExternalContent("https://example.com/file", app))
    }
}
