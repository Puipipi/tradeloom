const MAX_TEXT_CHARS = 12_000
const MAX_TURN_TRACKING = 32
const MAX_AUDIO_QUEUE = 32

function speechError(code) { return Object.assign(new Error(code), { code }) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function finalText(data) {
  if (!isRecord(data) || data.interrupted === true || !Number.isSafeInteger(data.turn) || data.turn < 1
    || !Number.isSafeInteger(data.step) || data.step < 1 || !Number.isSafeInteger(data.seq) || data.seq < 1
    || !isRecord(data.message) || !Array.isArray(data.message.content)) return null
  const blocks = data.message.content
  if (blocks.some(block => isRecord(block) && (block.type === 'tool-call' || block.type === 'tool-call-delta'))) return null
  const text = blocks.filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('')
  if (!text.trim()) return null
  if (text.length > MAX_TEXT_CHARS) return { turn: data.turn, step: data.step, seq: data.seq, error: 'session_speech_text_too_long' }
  return { turn: data.turn, step: data.step, seq: data.seq, text }
}

function providerAudio(value) {
  if (!isRecord(value) || value.mimeType !== 'audio/wav' || !(value.bytes instanceof Uint8Array)
    || !isRecord(value.format) || value.format.encoding !== 'pcm'
    || !Number.isSafeInteger(value.format.channels) || value.format.channels < 1
    || !Number.isSafeInteger(value.format.sampleRate) || value.format.sampleRate < 1
    || !Number.isSafeInteger(value.format.bitsPerSample) || value.format.bitsPerSample < 1
    || !Number.isFinite(value.format.durationSeconds) || value.format.durationSeconds <= 0) {
    throw speechError('session_speech_provider_invalid')
  }
  return {
    mimeType: 'audio/wav',
    format: { ...value.format },
    bytes: Uint8Array.from(value.bytes),
  }
}

/** Consume only completed final messages from one explicitly selected live Agent. */
export function createSessionSpeechController({ ctx, provider, onAudio, onError = () => {} } = {}) {
  if (!ctx?.agents || typeof ctx.agents.get !== 'function' || typeof ctx.on !== 'function'
    || !provider || typeof provider.synthesize !== 'function' || typeof onAudio !== 'function'
    || typeof onError !== 'function') throw speechError('session_speech_unavailable')

  let disposed = false
  let disposePromise = null
  let generation = 0
  let binding = null
  let changeTail = Promise.resolve()
  let stopPromise = null
  const ownedTasks = new Set()

  function identityCurrent(target) {
    return !disposed && binding === target && !target.closed
      && ctx.agents.get(target.agentId) === target.agent
      && target.agent.session === target.session
      && target.agent.session?.id === target.sessionId
      && (target.agent.session?.header?.agentPreset ?? null) === target.agentPreset
  }

  function report(target, code, job = null) {
    try {
      const result = onError({
        code,
        sessionId: target.sessionId,
        ...(job ? { turn: job.turn, seq: job.seq } : {}),
        generation: target.generation,
      })
      if (result && typeof result.then === 'function') void result.catch(() => {})
    } catch {}
  }

  function deliver(target, dto, job) {
    try {
      const result = onAudio(dto)
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => report(target, 'session_speech_delivery_failed', job))
      }
    } catch {
      report(target, 'session_speech_delivery_failed', job)
    }
  }

  async function drain(target) {
    while (identityCurrent(target) && target.queue.length > 0) {
      const job = target.queue.shift()
      const controller = new AbortController()
      target.activeController = controller
      try {
        const output = providerAudio(await provider.synthesize(job.text, { signal: controller.signal }))
        if (!identityCurrent(target) || controller.signal.aborted) continue
        const dto = Object.freeze({
          sessionId: job.sessionId, turn: job.turn, seq: job.seq, generation: job.generation,
          mimeType: output.mimeType, format: output.format, bytes: output.bytes,
        })
        deliver(target, dto, job)
      } catch (error) {
        if (identityCurrent(target) && !controller.signal.aborted) {
          report(target, typeof error?.code === 'string' && /^session_speech_[a-z_]+$/.test(error.code)
            ? error.code
            : 'session_speech_synthesis_failed', job)
        }
      } finally {
        if (target.activeController === controller) target.activeController = null
      }
    }
  }

  function startDrain(target) {
    if (!identityCurrent(target) || target.pumpPromise) return
    const task = Promise.resolve().then(() => drain(target))
    target.pumpPromise = task
    ownedTasks.add(task)
    task.then(
      () => { if (target.pumpPromise === task) target.pumpPromise = null; ownedTasks.delete(task) },
      () => { if (target.pumpPromise === task) target.pumpPromise = null; ownedTasks.delete(task) },
    )
  }

  function handleEvent(target, session, event) {
    if (!identityCurrent(target)) {
      void stopBinding(target)
      return
    }
    if (session !== target.session || !isRecord(event) || !isRecord(event.data)) return
    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (!Number.isSafeInteger(turn) || turn < 1 || turn <= target.lastEndedTurn) return
      target.turns.set(turn, null)
      if (target.turns.size > MAX_TURN_TRACKING) {
        const oldest = [...target.turns.keys()].sort((a, b) => a - b)[0]
        target.turns.delete(oldest)
      }
      return
    }
    if (event.type === 'assistant/message') {
      const item = finalText({ ...event.data, seq: event.seq })
      if (item && target.turns.has(item.turn) && item.turn > target.lastEndedTurn) target.turns.set(item.turn, item)
      else if (Number.isSafeInteger(event.data.turn) && target.turns.has(event.data.turn)) target.turns.set(event.data.turn, null)
      return
    }
    if (event.type !== 'turn/end') return
    const turn = event.data.turn
    if (!Number.isSafeInteger(turn) || turn < 1 || turn <= target.lastEndedTurn) return
    const candidate = target.turns.get(turn)
    target.turns.delete(turn)
    target.lastEndedTurn = turn
    if (event.data.reason?.kind !== 'completed' || !candidate || !identityCurrent(target)) return
    if (candidate.error) {
      report(target, candidate.error, candidate)
      return
    }
    if (target.queue.length >= MAX_AUDIO_QUEUE) {
      report(target, 'session_speech_queue_full', candidate)
      return
    }
    target.queue.push({ ...candidate, sessionId: target.sessionId, generation: target.generation })
    startDrain(target)
  }

  function stopBinding(target) {
    if (target.stopPromise) return target.stopPromise
    if (binding === target) binding = null
    target.closed = true
    target.turns.clear()
    target.queue.length = 0
    target.unsubscribeSession?.()
    target.unsubscribeDisposed?.()
    target.activeController?.abort()
    const pump = target.pumpPromise
    target.stopPromise = (async () => { if (pump) await pump })()
    return target.stopPromise
  }

  function serializeChange(task) {
    const pending = changeTail.then(task)
    changeTail = pending.catch(() => {})
    return pending
  }

  async function bindAgent(agentId) {
    return await serializeChange(async () => {
      if (disposed) throw speechError('session_speech_closed')
      if (typeof agentId !== 'string' || !agentId) throw speechError('invalid_arguments')
      if (binding) await stopBinding(binding)
      if (disposed) throw speechError('session_speech_closed')
      const agent = ctx.agents.get(agentId)
      const session = agent?.session
      const agentCtx = agent?.ctx
      const sessionId = session?.id
      const preset = session?.header?.agentPreset ?? null
      if (!agent || agent.id !== agentId || !session || sessionId !== agentId
        || (preset !== null && typeof preset !== 'string') || typeof agentCtx?.on !== 'function'
        || ctx.agents.get(agentId) !== agent) throw speechError('session_speech_agent_unavailable')
      const target = {
        agentId, agent, session, sessionId, agentPreset: preset, generation: ++generation,
        closed: false, turns: new Map(), lastEndedTurn: 0, queue: [], pumpPromise: null,
        activeController: null, stopPromise: null, unsubscribeSession: null, unsubscribeDisposed: null,
      }
      target.unsubscribeSession = agentCtx.on('session/event', (observedSession, event) => handleEvent(target, observedSession, event))
      if (typeof target.unsubscribeSession !== 'function') {
        target.unsubscribeSession?.()
        throw speechError('session_speech_agent_unavailable')
      }
      target.unsubscribeDisposed = ctx.on('agent/disposed', ({ agent: disposedAgent } = {}) => {
        if (disposedAgent === target.agent) void stopBinding(target)
      })
      binding = target
      return { status: 'bound', sessionId, generation: target.generation }
    })
  }

  function stop() {
    if (stopPromise) return stopPromise
    if (binding) void stopBinding(binding)
    const beforeStop = changeTail
    const pending = beforeStop.then(async () => {
      if (binding) await stopBinding(binding)
      await Promise.all([...ownedTasks])
      return { status: 'stopped' }
    })
    stopPromise = pending
    changeTail = pending.catch(() => {})
    const clear = () => { if (stopPromise === pending) stopPromise = null }
    void pending.then(clear, clear)
    return pending
  }

  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    disposePromise = serializeChange(async () => {
      if (binding) await stopBinding(binding)
      await Promise.all([...ownedTasks])
    })
    return disposePromise
  }

  return Object.freeze({ bindAgent, stop, dispose, getCurrentTarget: () => binding && identityCurrent(binding)
    ? Object.freeze({ sessionId: binding.sessionId, generation: binding.generation }) : null })
}
