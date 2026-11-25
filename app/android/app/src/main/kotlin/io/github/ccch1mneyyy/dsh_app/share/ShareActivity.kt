package io.github.ccch1mneyyy.dsh_app.share

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.os.Bundle
import io.github.ccch1mneyyy.dsh_app.MainActivity

/**
 * The system share sheet's target (ACTION_SEND / ACTION_SEND_MULTIPLE, any type): hands what
 * was shared to the app's own task as [SharePlugin.ACTION_SHARE], where [SharePlugin] reads it.
 *
 * Same trampoline as links/LinkTrampolineActivity: apps start share targets inside their own
 * task, so forwarding with NEW_TASK | SINGLE_TOP | CLEAR_TOP brings the existing MainActivity
 * forward (or starts the app) instead of stacking a second Flutter activity in the sender's
 * task. Read access to the shared `content:` URIs travels on with the intent's ClipData.
 *
 * Shared `.dshgo` files come through here too; the Dart side sends a lone share-code file on
 * to the share-code importer and everything else to a new conversation.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val received = intent
        val forward = Intent(received).apply {
            setClass(this@ShareActivity, MainActivity::class.java)
            action = SharePlugin.ACTION_SHARE
            putExtra(SharePlugin.EXTRA_SENT_AS, received.action)
            // The sender's startActivity normally moves EXTRA_STREAM into ClipData (that is
            // what carries the read grant); do it here when it didn't.
            if (clipData == null) {
                val streams = SharePlugin.streamsOf(received)
                if (streams.isNotEmpty()) {
                    clipData = ClipData.newRawUri(null, streams.first()).also { clip ->
                        for (uri in streams.drop(1)) clip.addItem(ClipData.Item(uri))
                    }
                }
            }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        try {
            startActivity(forward)
        } catch (_: SecurityException) {
            // A URI we hold no grant for can't be passed on with one; without the grant the
            // plugin still reads what is readable (public providers) and reports the rest.
            forward.removeFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            forward.clipData = null
            try {
                startActivity(forward)
            } catch (_: Exception) {
            }
        } catch (_: Exception) {
            // Nothing to hand over to: the share is dropped.
        }
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
