package io.github.ccch1mneyyy.dsh_app.nativemedia

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer

private fun floats(size: Int): FloatBuffer =
    ByteBuffer.allocateDirect(size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()

private fun session(bytes: ByteArray): OrtSession = OrtSession.SessionOptions().use { options ->
    options.setIntraOpNumThreads(1)
    options.setInterOpNumThreads(1)
    OrtEnvironment.getEnvironment().createSession(bytes, options)
}

/** Silero v6.2: 512 new samples plus its 64-sample context at 16 kHz. */
class OrtSilero(bytes: ByteArray) : NeuralGate.VadModel {
    private val env = OrtEnvironment.getEnvironment()
    private val model = session(bytes)
    private val input = floats(576)
    private val state = floats(256)
    private val nextState = floats(256)
    private val output = floats(1)
    private val inputs = linkedMapOf(
        "input" to OnnxTensor.createTensor(env, input, longArrayOf(1, 576)),
        "state" to OnnxTensor.createTensor(env, state, longArrayOf(2, 1, 128)),
        "sr" to OnnxTensor.createTensor(env, LongBuffer.wrap(longArrayOf(16000)), longArrayOf()),
    )
    private val outputs = linkedMapOf(
        "output" to OnnxTensor.createTensor(env, output, longArrayOf(1, 1)),
        "stateN" to OnnxTensor.createTensor(env, nextState, longArrayOf(2, 1, 128)),
    )
    private var used = 0
    private var probability = 0f

    override fun probability(frame: ShortArray): Float {
        for (sample in frame) {
            input.put(64 + used++, sample / 32768f)
            if (used == 512) {
                model.run(inputs, outputs).close()
                probability = output.get(0)
                for (i in 0 until 256) state.put(i, nextState.get(i))
                for (i in 0 until 64) input.put(i, input.get(512 + i))
                used = 0
            }
        }
        return probability
    }

    override fun reset() {
        used = 0
        probability = 0f
        for (i in 0 until input.capacity()) input.put(i, 0f)
        for (i in 0 until state.capacity()) state.put(i, 0f)
    }

    override fun close() {
        inputs.values.forEach { it.close() }
        outputs.values.forEach { it.close() }
        model.close()
    }
}

/** The v3.2 CPU export's `logits` output is already a probability. */
class OrtSmartTurn(bytes: ByteArray) : NeuralGate.TurnModel {
    private val env = OrtEnvironment.getEnvironment()
    private val model = session(bytes)
    private val mel = WhisperMel()
    private val input = floats(80 * 800)
    private val output = floats(1)
    private val inputs = mapOf("input_features" to OnnxTensor.createTensor(env, input, longArrayOf(1, 80, 800)))
    private val outputs = mapOf("logits" to OnnxTensor.createTensor(env, output, longArrayOf(1, 1)))

    override fun probability(audio: FloatArray): Float {
        input.rewind()
        input.put(mel.compute(audio))
        input.rewind()
        model.run(inputs, outputs).close()
        return output.get(0)
    }

    override fun close() {
        inputs.values.forEach { it.close() }
        outputs.values.forEach { it.close() }
        model.close()
    }
}
