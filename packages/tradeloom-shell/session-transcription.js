const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details })
const ORIGINAL = Symbol.for('cordis.original')
const READINESS_PHASES = new Set(['unprepared', 'ready', 'standby', 'cancelled', 'downloading', 'checking', 'loading', 'waking', 'cancelling', 'failed'])

function original(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
  try { return value[ORIGINAL] ?? value } catch { return value }
}

function liveAgent(ctx, agentId) {
  let agent
  let session
  try {
    agent = ctx.agents.get(agentId)
    session = agent?.session
    if (!agent || agent.id !== agentId || !session || typeof session.id !== 'string' || !session.id
      || ctx.agents.get(agentId) !== agent || agent.session !== session) throw new Error()
  } catch {
    throw fail('session_transcription_agent_unavailable')
  }
  return { agent, session, sessionId: session.id }
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function safeProviderFailure(value) {
  if (!isRecord(value)) return undefined
  if (Object.hasOwn(value, 'code') && value.code === 'model-unavailable' && Object.keys(value).length === 1) {
    return Object.freeze({ code: 'model-unavailable' })
  }
  if (Object.hasOwn(value, 'code') && value.code === 'worker-exited' && Object.keys(value).length === 3
    && Object.hasOwn(value, 'exitCode') && (value.exitCode === null || Number.isInteger(value.exitCode))
    && Object.hasOwn(value, 'signal') && (value.signal === null || typeof value.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(value.signal))) {
    return Object.freeze({ code: 'worker-exited', exitCode: value.exitCode, signal: value.signal })
  }
  return undefined
}

function providerFailureCode(failure) {
  return failure?.code === 'model-unavailable'
    ? 'session_transcription_model_unavailable'
    : failure?.code === 'worker-exited' ? 'session_transcription_worker_exited' : undefined
}

function describedProviderFailure(service, error) {
  try {
    return typeof service.describeProviderFailure === 'function'
      ? safeProviderFailure(service.describeProviderFailure(error)) : undefined
  } catch { return undefined }
}

function readinessOf(service, providerId) {
  if (!service || typeof service.snapshot !== 'function') return Object.freeze({ status: 'unavailable', phase: 'unknown' })
  let snapshot
  try { snapshot = service.snapshot() } catch { return Object.freeze({ status: 'unknown', phase: 'unknown' }) }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.providers) || !isRecord(snapshot.selection)) {
    return Object.freeze({ status: 'unknown', phase: 'unknown' })
  }
  const id = providerId ?? snapshot.selection.providerId
  if (typeof id !== 'string' || !id) return Object.freeze({ status: 'unknown', phase: 'unknown' })
  const provider = snapshot.providers.find(item => isRecord(item) && item.id === id)
  if (!provider) return Object.freeze({ status: 'unavailable', providerId: id, phase: 'unknown' })
  const phase = provider.preparation?.phase
  if (typeof phase !== 'string' || !READINESS_PHASES.has(phase)) return Object.freeze({ status: 'unknown', providerId: id, phase: 'unknown' })
  const failure = safeProviderFailure(provider.preparation?.failure)
  return Object.freeze({ status: phase === 'ready' || phase === 'standby' ? 'ready' : 'not_ready', providerId: id, phase,
    ...(failure ? { failure } : {}) })
}

function languagesFor(service, providerId) {
  try {
    const provider = service.snapshot()?.providers?.find(item => item?.id === providerId)
    return Array.isArray(provider?.languages) ? provider.languages : null
  } catch { return null }
}

function validTranscript(value) {
  return isRecord(value) && typeof value.text === 'string'
    && Number.isFinite(value.audioSeconds) && value.audioSeconds >= 0
    && Number.isFinite(value.inferenceSeconds) && value.inferenceSeconds >= 0
}

/** Explicitly transcribe one completed recording for a captured live Agent binding. */
export function createSessionTranscriptionController({ ctx } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || !ctx.agents || typeof ctx.agents.get !== 'function') {
    throw fail('session_transcription_unavailable')
  }

  let disposed = false
  let disposePromise = null
  let generation = 0
  let binding = null
  let inFlight = null
  const handles = new WeakMap()

  function current(target) {
    if (disposed || !target || binding !== target) return false
    try {
      return ctx.agents.get(target.agentId) === target.agent
        && target.agent.session === target.session
        && target.agent.session?.id === target.sessionId
    } catch { return false }
  }

  function serviceNow() {
    let service
    try { service = ctx.get('speechToText') } catch { service = undefined }
    if (!service || typeof service.snapshot !== 'function' || typeof service.resolve !== 'function'
      || typeof service.transcribe !== 'function') throw fail('session_transcription_service_unavailable')
    return { service, identity: original(service) }
  }

  function sameService(target) {
    try { return original(ctx.get('speechToText')) === target.serviceIdentity }
    catch { return false }
  }

  function cancelJob(job, code) {
    if (job.cancelCode) return
    job.cancelCode = code
    job.controller.abort(fail(code))
    job.rejectCancellation(fail(code))
  }

  function bindAgent(agentId) {
    if (disposed) throw fail('session_transcription_closed')
    if (typeof agentId !== 'string' || !agentId) throw fail('session_transcription_invalid_arguments')
    if (inFlight) cancelJob(inFlight, 'session_transcription_target_changed')
    binding = null
    const live = liveAgent(ctx, agentId)
    const target = { agentId, agent: live.agent, session: live.session, sessionId: live.sessionId, generation: ++generation }
    binding = target
    const handle = Object.freeze({ agentId, sessionId: target.sessionId, generation: target.generation })
    handles.set(handle, target)
    return handle
  }

  function getReadiness(providerId) {
    try { return readinessOf(serviceNow().service, providerId) }
    catch { return Object.freeze({ status: 'unavailable', ...(providerId ? { providerId } : {}), phase: 'unknown' }) }
  }

  function transcribe({ binding: handle, audio, providerId, language, signal } = {}) {
    if (disposed) return Promise.reject(fail('session_transcription_closed'))
    const target = handles.get(handle)
    if (!target || target !== binding || !current(target)
      || handle.generation !== target.generation || handle.sessionId !== target.sessionId) {
      return Promise.reject(fail('session_transcription_target_changed'))
    }
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0
      || (providerId !== undefined && (typeof providerId !== 'string' || !providerId))
      || (language !== undefined && (typeof language !== 'string' || !language))
      || (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'
        || typeof signal?.aborted !== 'boolean'))) {
      return Promise.reject(fail('session_transcription_invalid_arguments'))
    }
    if (signal?.aborted) return Promise.reject(fail('session_transcription_cancelled'))
    if (inFlight) return Promise.reject(fail('session_transcription_busy'))

    let serviceRecord
    try { serviceRecord = serviceNow() }
    catch (error) { return Promise.reject(error) }
    const ready = readinessOf(serviceRecord.service, providerId)
    if (ready.failure) {
      const code = providerFailureCode(ready.failure)
      if (code) return Promise.reject(fail(code, { providerFailure: ready.failure, readiness: ready }))
    }
    if (ready.status !== 'ready') {
      return Promise.reject(fail(ready.status === 'unavailable'
        ? 'session_transcription_provider_unavailable'
        : ready.status === 'unknown' ? 'session_transcription_readiness_unknown' : 'session_transcription_not_ready',
      { readiness: ready }))
    }
    let selectedLanguage = language
    if (selectedLanguage === undefined) {
      try { selectedLanguage = serviceRecord.service.snapshot()?.selection?.language } catch {}
    }
    const languages = languagesFor(serviceRecord.service, ready.providerId)
    if (typeof selectedLanguage === 'string' && Array.isArray(languages) && !languages.includes(selectedLanguage)) {
      return Promise.reject(fail('session_transcription_language_unsupported'))
    }
    if (!current(target)) return Promise.reject(fail('session_transcription_target_changed'))
    let spec
    const audioCopy = Uint8Array.from(audio)
    try {
      spec = serviceRecord.service.resolve({ audio: audioCopy, ...(providerId ? { providerId } : {}), ...(language ? { language } : {}) })
    } catch {
      return Promise.reject(fail('session_transcription_provider_unavailable'))
    }
    if (!isRecord(spec) || !isRecord(spec.provider) || !isRecord(spec.provider.info)
      || typeof spec.provider.info.id !== 'string' || !spec.provider.info.id
      || !(spec.audio instanceof Uint8Array) || typeof spec.language !== 'string' || !spec.language) {
      return Promise.reject(fail('session_transcription_service_unavailable'))
    }
    if (!current(target)) return Promise.reject(fail('session_transcription_target_changed'))
    if (!sameService({ serviceIdentity: serviceRecord.identity })) return Promise.reject(fail('session_transcription_service_changed'))

    const job = { target, serviceIdentity: serviceRecord.identity, controller: new AbortController(), cancelCode: null,
      rejectCancellation: () => {}, task: null, abortListener: null }
    const cancelled = new Promise((_, reject) => { job.rejectCancellation = reject })
    if (signal) {
      job.abortListener = () => cancelJob(job, 'session_transcription_cancelled')
      signal.addEventListener('abort', job.abortListener, { once: true })
      if (signal.aborted) job.abortListener()
    }
    inFlight = job

    const task = Promise.resolve().then(async () => {
      if (job.cancelCode) throw fail(job.cancelCode)
      if (!current(target)) throw fail('session_transcription_target_changed')
      if (!sameService(job)) throw fail('session_transcription_service_changed')
      let admittedSpec
      try { admittedSpec = serviceRecord.service.resolve({ audio: audioCopy, providerId: spec.provider.info.id, language: spec.language }) }
      catch { throw fail('session_transcription_service_changed') }
      if (admittedSpec?.provider !== spec.provider) throw fail('session_transcription_service_changed')
      let value
      try { value = await serviceRecord.service.transcribe(spec, job.controller.signal) }
      catch (error) {
        if (job.cancelCode) throw fail(job.cancelCode)
        if (!current(target)) throw fail('session_transcription_target_changed')
        if (!sameService(job)) throw fail('session_transcription_service_changed')
        let currentSpec
        try { currentSpec = serviceRecord.service.resolve({ audio: audioCopy, providerId: spec.provider.info.id, language: spec.language }) }
        catch { throw fail('session_transcription_service_changed') }
        if (currentSpec?.provider !== spec.provider) throw fail('session_transcription_service_changed')
        const providerFailure = describedProviderFailure(serviceRecord.service, error)
        const code = providerFailureCode(providerFailure)
        if (code) throw fail(code, { providerFailure })
        throw fail('session_transcription_failed')
      }
      if (job.cancelCode) throw fail(job.cancelCode)
      if (!current(target)) throw fail('session_transcription_target_changed')
      if (!sameService(job)) throw fail('session_transcription_service_changed')
      // Re-resolve against the current registry so provider replacement under the same id is detected.
      let currentSpec
      try { currentSpec = serviceRecord.service.resolve({ audio: audioCopy, providerId: spec.provider.info.id, language: spec.language }) }
      catch { throw fail('session_transcription_service_changed') }
      if (currentSpec?.provider !== spec.provider) throw fail('session_transcription_service_changed')
      if (!validTranscript(value)) throw fail('session_transcription_result_invalid')
      return Object.freeze({ agentId: target.agentId, sessionId: target.sessionId, generation: target.generation,
        providerId: spec.provider.info.id, language: spec.language, text: value.text,
        audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds })
    })
    job.task = task
    void task.then(
      () => { if (inFlight === job) inFlight = null; signal?.removeEventListener('abort', job.abortListener) },
      () => { if (inFlight === job) inFlight = null; signal?.removeEventListener('abort', job.abortListener) },
    )
    return Promise.race([task, cancelled])
  }

  function cancel() {
    if (inFlight) cancelJob(inFlight, 'session_transcription_cancelled')
    return Promise.resolve(Object.freeze({ status: inFlight ? 'cancelling' : 'idle' }))
  }

  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    binding = null
    generation++
    if (inFlight) cancelJob(inFlight, 'session_transcription_cancelled')
    const task = inFlight?.task
    disposePromise = (async () => { if (task) await task.catch(() => {}) })()
    return disposePromise
  }

  return Object.freeze({ bindAgent, getReadiness, getCurrentTarget: () => current(binding)
    ? Object.freeze({ agentId: binding.agentId, sessionId: binding.sessionId, generation: binding.generation }) : null,
  transcribe, cancel, dispose, getInFlight: () => inFlight !== null })
}
