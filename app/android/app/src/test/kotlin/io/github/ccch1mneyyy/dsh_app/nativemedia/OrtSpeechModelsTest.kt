package io.github.ccch1mneyyy.dsh_app.nativemedia

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

class OrtSpeechModelsTest {
    @Test fun realExportsAndStreamingVadAgreeWithReference() {
        val dir = File(System.getenv("DSH_SPEECH_MODELS") ?: "src/main/assets/speech")
        val silero = File(dir, "silero_vad.onnx")
        val smart = File(dir, "smart-turn-v3.2-cpu.onnx")
        assumeTrue("Download speech models first", silero.isFile && smart.isFile)
        val vad = OrtSilero(silero.readBytes())
        val turn = OrtSmartTurn(smart.readBytes())
        // CPU ORT 1.27.0, official exports, zero PCM. No sigmoid on smart-turn's output.
        // The last digits move between processors (ORT picks AVX2 / AVX-512 kernels).
        assertEquals(0f, vad.probability(ShortArray(320)), 0f)
        assertEquals(0.0016697943f, vad.probability(ShortArray(320)), 0.0001f)
        assertEquals(0.9870367f, turn.probability(FloatArray(128000)), 0.001f)
        vad.reset()
        NeuralGate(vad, turn).use { gate ->
            repeat(100) { assertEquals(SpeechGate.Edge.NONE, gate.consume(ShortArray(320), -100.0, it * 20L)) }
        }
    }
}
