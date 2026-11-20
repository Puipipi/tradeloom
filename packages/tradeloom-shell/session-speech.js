import { createHash, randomUUID } from 'node:crypto'
import { createWindowsSpeechProvider } from './windows-speech-provider.js'
import { createStateStore, getRoleBindingRevision } from './state.js'

const MAX_TEXT_CHARS = 12_000
const MAX_TURN_TRACKING = 32
const MAX_AUDIO_QUEUE = 32

function speechError(code) { return Object.assign(new Error(code), { code }) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function readFinalAssistantText(data) {
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

function validateProviderAudio(value) {
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
        const output = validateProviderAudio(await provider.synthesize(job.text, { signal: controller.signal }))
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
      const item = readFinalAssistantText({ ...event.data, seq: event.seq })
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

export const SESSION_AUDIO_ROUTE = '/tradeloom/session-audio'
const AUDIO_ENDPOINT = SESSION_AUDIO_ROUTE.slice(1)
const AUDIO_LEASE_SOURCE_FIELDS = ['guestId', 'generation', 'sceneId', 'panelId', 'roleId', 'sessionId',
  'workspaceId', 'workspacePath', 'agentPreset', 'bindingRevision']
const AUDIO_LEASE_IDLE_MS = 60_000
const AUDIO_LEASE_SWEEP_MS = 5_000
const MAX_AUDIO_LEASES = 8
const MAX_LEASE_AUDIO_QUEUE = 2
const sameAudioLeaseSource = (a, b) => a && b && AUDIO_LEASE_SOURCE_FIELDS.every(key => a[key] === b[key])

/** Explicit, expiring playback subscriptions. Audio stays in owned memory and
 * Windows temp WAVs, never in sessions, logs, program resources or snapshots. */
export function createSessionAudioHandler(ctx, authority, dependencies = {}) {
  const entries = new Map()
  const providerFactory = dependencies.createProvider ?? createWindowsSpeechProvider
  const stateFactory = dependencies.createStateStore ?? createStateStore
  const now = dependencies.now ?? Date.now
  let closed = false, state
  const readState = async () => (await (state ??= stateFactory())).read()
  async function assertBinding(source) {
    const current = await readState(), binding = current.roles?.[source.roleId]
    if (closed || !binding || binding.sessionId !== source.sessionId || binding.workspaceId !== source.workspaceId
      || binding.workspacePath !== source.workspacePath || getRoleBindingRevision(current, source.roleId) !== source.bindingRevision) throw speechError('session_speech_binding_changed')
  }
  async function stop(entry) {
    if (entry.closing) return entry.closing
    entries.delete(entry.id); entry.queue.length = 0
    entry.closing = (async () => {
      try { await entry.controller.dispose() }
      finally {
        try { await entry.provider.dispose() }
        finally { if (entry.workId) await authority.releaseOriginWork(entry.origin, entry.workId, 'session-audio-stopped', entry) }
      }
    })()
    return entry.closing
  }
  const expiry = setInterval(() => {
    for (const entry of entries.values()) if (now() - entry.touched > AUDIO_LEASE_IDLE_MS) void stop(entry).catch(() => { closed = true })
  }, AUDIO_LEASE_SWEEP_MS)
  expiry.unref?.()
  async function execute(origin, input) {
    const source = authority.sourceForOrigin(origin)
    await assertBinding(source)
    if (input.action === 'start') {
      for (const previous of [...entries.values()]) if (sameAudioLeaseSource(previous.source, source)) await stop(previous)
      if (closed) throw speechError('session_speech_closed')
      if (entries.size >= MAX_AUDIO_LEASES) throw speechError('session_speech_limit_reached')
      const provider = providerFactory()
      const entry = { id: randomUUID(), source, provider, queue: [], touched: now(), error: null }
      entry.origin = origin
      entry.workId = authority.retainOriginWork(origin, { kind: 'queue', owner: entry })
      const assertLease = async () => {
        authority.captureQueuedOrigin(entry.origin, entry.workId, entry)
        await assertBinding(source)
        if (entry.closing) throw speechError('session_speech_binding_changed')
      }
      entry.controller = createSessionSpeechController({ ctx,
        provider: { async synthesize(text, options) { await assertLease(); const audio = await provider.synthesize(text, options); await assertLease(); return audio } },
        onAudio: audio => {
          if (closed || entry.closing || !entries.has(entry.id)) return
          if (entry.queue.length >= MAX_LEASE_AUDIO_QUEUE) throw speechError('session_speech_queue_full')
          entry.queue.push({ mimeType: audio.mimeType, bytes: Buffer.from(audio.bytes).toString('base64') })
        }, onError: error => { entry.error = error.code },
      })
      entries.set(entry.id, entry)
      try { await entry.controller.bindAgent(source.sessionId); await assertBinding(source) }
      catch (error) { await stop(entry); throw error }
      return { lease: entry.id, enabled: true }
    }
    const entry = entries.get(input.lease)
    // A newly rebound frame may stop its own old subscription, never read it.
    // Main still issues this request's body-bound proof from the actual sender.
    if (input.action === 'stop' && entry && source.guestId === entry.source.guestId) { await stop(entry); return { enabled: false } }
    if (!entry || !sameAudioLeaseSource(source, entry.source)) throw speechError('session_speech_binding_changed')
    const previousOrigin = entry.origin, previousWork = entry.workId
    entry.origin = origin
    entry.workId = authority.retainOriginWork(origin, { kind: 'queue', owner: entry })
    await authority.releaseOriginWork(previousOrigin, previousWork, 'session-audio-proof-renewed', entry)
    entry.touched = now()
    if (input.action === 'stop') { await stop(entry); return { enabled: false } }
    if (input.action !== 'poll') throw speechError('invalid_arguments')
    const audio = entry.queue.shift() ?? null, error = entry.error
    entry.error = null
    return { enabled: true, audio, error }
  }
  return {
    async handle(req, res) {
      const respond = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)) }
      const rejected = ctx.connection.requestRejection(req)
      if (rejected !== undefined) return respond(rejected, { ok: false, error_code: 'request_forbidden' })
      if (req.method !== 'POST') return respond(405, { ok: false, error_code: 'method_not_allowed' })
      try {
        if (closed) throw speechError('session_speech_closed')
        const chunks = []; let size = 0
        for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 2048) throw speechError('invalid_arguments'); chunks.push(bytes) }
        const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8'))
        if (!isRecord(input) || Object.keys(input).some(key => !['id', 'action', 'lease'].includes(key))
          || !/^[a-f0-9-]{36}$/.test(input.id ?? '') || !['start', 'stop', 'poll'].includes(input.action)) throw speechError('invalid_arguments')
        const origin = await authority.verifyRequest({ token: req.headers['x-tradeloom-origin'], endpoint: AUDIO_ENDPOINT, routePath: AUDIO_ENDPOINT, httpMethod: 'POST', method: AUDIO_ENDPOINT,
          rpcId: input.id, bodyBytes: bytes, bodyDigest: createHash('sha256').update(bytes).digest('hex'), peerId: 'desktop-session-audio', peerPrincipal: 'owner' })
        const result = await authority.withVerifiedRequestOrigin(origin, () => execute(origin, input))
        respond(200, { ok: true, result })
      } catch (error) {
        const code = typeof error?.code === 'string' && /^session_speech_[a-z_]+$/.test(error.code) ? error.code : 'session_speech_unavailable'
        respond(409, { ok: false, error_code: code })
      }
    },
    async dispose() { closed = true; clearInterval(expiry); await Promise.all([...entries.values()].map(stop)) },
  }
}
