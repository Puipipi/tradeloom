package io.github.ccch1mneyyy.dsh_app.nativemedia

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log

/**
 * Debug builds only (registered when the app is debuggable, like pet/PetOverlayProbe): an emulator
 * has no voice to hear, so this stands in for the speech gate's edges and logs the state.
 *
 * ```
 * adb shell am broadcast -a io.github.ccch1mneyyy.dsh_app.MEDIA_PROBE --es cmd speech --es edge start|end
 * adb shell am broadcast -a io.github.ccch1mneyyy.dsh_app.MEDIA_PROBE --es cmd state
 * ```
 * Every command logs `DshMedia: probe {…}`.
 */
internal object NativeMediaProbe {
    const val ACTION = "io.github.ccch1mneyyy.dsh_app.MEDIA_PROBE"

    fun register(context: Context, onEdge: (SpeechGate.Edge) -> Unit, state: () -> String): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.getStringExtra("cmd") == "speech") {
                    onEdge(if (intent.getStringExtra("edge") == "end") SpeechGate.Edge.END else SpeechGate.Edge.START)
                }
                Log.i("DshMedia", "probe ${state()}")
            }
        }
        val filter = IntentFilter(ACTION)
        // Exported so adb's shell can reach it; debuggable builds only.
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED) else context.registerReceiver(receiver, filter)
        return receiver
    }
}
