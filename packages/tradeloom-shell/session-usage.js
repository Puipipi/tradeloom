const fail = code => Object.assign(new Error(code), { code })
const ORIGINAL = Symbol.for('cordis.original')
const PROJECTION_KEYS = Object.freeze(['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown', 'tradeloomCompactionStats'])

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function original(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
  try { return value[ORIGINAL] ?? value } catch { return value }
}

function liveAgent(ctx, agentId) {
  try {
    const agent = ctx.agents.get(agentId)
    const session = agent?.session
    if (!agent || agent.id !== agentId || !session || typeof session.id !== 'string' || !session.id
      || ctx.agents.get(agentId) !== agent || agent.session !== session) throw new Error()
    return { agent, session, sessionId: session.id }
  } catch {
    throw fail('session_usage_agent_unavailable')
  }
}

function validNonnegativeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function validNonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 }
function validProjectionSequence(value) { return Number.isSafeInteger(value) && value >= -1 }

function projectRecord(value, fields, validate) {
  if (!isRecord(value)) throw fail('session_usage_projection_invalid')
  const output = {}
  for (const field of fields) {
    if (!Object.hasOwn(value, field) || !validate(value[field])) throw fail('session_usage_projection_invalid')
    output[field] = value[field]
  }
  return Object.freeze(output)
}

function projectValues(response) {
  if (!isRecord(response)) throw fail('session_usage_projection_invalid')
  if (response.kind === 'migration-required') {
    return { status: 'migration_required', unknownProjections: Object.freeze([...PROJECTION_KEYS]) }
  }
  if (response.kind !== 'sequenced' || !validProjectionSequence(response.asOfSeq) || !isRecord(response.values)) {
    throw fail('session_usage_projection_invalid')
  }

  const values = response.values
  const projections = {}
  const unknownProjections = []
  if (!Object.hasOwn(values, 'sessionStats')) unknownProjections.push('sessionStats')
  else {
    if (!isRecord(values.sessionStats)) throw fail('session_usage_projection_invalid')
    const stats = values.sessionStats
    const projected = {}
    const fields = [
      ['turns', validNonnegativeInteger], ['steps', validNonnegativeInteger],
      ['llmMs', validNonnegativeNumber], ['toolMs', validNonnegativeNumber],
      ['ttftMs', validNonnegativeNumber], ['ttftSteps', validNonnegativeInteger],
      ['decodeMs', validNonnegativeNumber], ['decodeTokens', validNonnegativeNumber],
    ]
    for (const [field, predicate] of fields) {
      if (!Object.hasOwn(stats, field) || !predicate(stats[field])) throw fail('session_usage_projection_invalid')
      projected[field] = stats[field]
    }
    projections.sessionStats = Object.freeze(projected)
  }
  if (!Object.hasOwn(values, 'tokenUsage')) unknownProjections.push('tokenUsage')
  else projections.tokenUsage = projectRecord(values.tokenUsage,
    ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'], validNonnegativeInteger)
  if (!Object.hasOwn(values, 'contextPressure')) unknownProjections.push('contextPressure')
  else {
    const pressure = values.contextPressure
    if (!isRecord(pressure)) throw fail('session_usage_projection_invalid')
    const projected = {}
    for (const [field, predicate] of [
      ['pressureTokens', validNonnegativeInteger],
      ['projectedTokens', validNonnegativeInteger],
      ['contextWindow', value => Number.isSafeInteger(value) && value > 0],
    ]) {
      if (Object.hasOwn(pressure, field)) {
        if (!predicate(pressure[field])) throw fail('session_usage_projection_invalid')
        projected[field] = pressure[field]
      }
    }
    projections.contextPressure = Object.freeze(projected)
  }
  if (!Object.hasOwn(values, 'contextBreakdown')) unknownProjections.push('contextBreakdown')
  else projections.contextBreakdown = projectRecord(values.contextBreakdown,
    ['systemTokens', 'toolsTokens', 'messageTokens'], validNonnegativeInteger)
  if (!Object.hasOwn(values, 'tradeloomCompactionStats')) unknownProjections.push('tradeloomCompactionStats')
  else projections.compactionStats = projectRecord(values.tradeloomCompactionStats,
    ['attempts', 'summaryApplied', 'completed', 'failed', 'inflight'], validNonnegativeInteger)

  return { status: 'available', asOfSeq: response.asOfSeq, projections: Object.freeze(projections),
    unknownProjections: Object.freeze(unknownProjections) }
}

/** Read only the current SDK projection snapshot for one explicitly bound live Agent. */
export function createSessionUsageController({ ctx } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || !ctx.agents || typeof ctx.agents.get !== 'function') {
    throw fail('session_usage_unavailable')
  }

  let disposed = false
  let disposePromise
  let generation = 0
  let binding = null
  const handles = new WeakMap()
  const jobs = new Set()

  function current(target) {
    if (disposed || !target || binding !== target) return false
    try {
      return ctx.agents.get(target.agentId) === target.agent
        && target.agent.session === target.session
        && target.agent.session?.id === target.sessionId
    } catch { return false }
  }

  function readerNow() {
    let reader
    try { reader = ctx.get('sessionController') } catch { reader = undefined }
    if (!reader || typeof reader.projections !== 'function') throw fail('session_usage_unavailable')
    return { reader, identity: original(reader) }
  }

  function sameReader(record) {
    try { return original(ctx.get('sessionController')) === record.identity }
    catch { return false }
  }

  function rejectJob(job, code) {
    if (job.cancelCode) return
    job.cancelCode = code
    job.abort.abort(fail(code))
    job.rejectCancellation(fail(code))
  }

  function bindAgent(agentId) {
    if (disposed) throw fail('session_usage_closed')
    if (typeof agentId !== 'string' || !agentId) throw fail('session_usage_invalid_arguments')
    const previous = binding
    binding = null
    for (const job of jobs) {
      if (job.target === previous) rejectJob(job, 'session_usage_target_changed')
    }
    const live = liveAgent(ctx, agentId)
    const target = { agentId, agent: live.agent, session: live.session, sessionId: live.sessionId, generation: ++generation }
    binding = target
    const handle = Object.freeze({ agentId, sessionId: target.sessionId, generation: target.generation })
    handles.set(handle, target)
    return handle
  }

  function readUsage({ binding: handle, signal } = {}) {
    if (disposed) return Promise.reject(fail('session_usage_closed'))
    const target = handles.get(handle)
    if (!target || target !== binding || !current(target)
      || handle.generation !== target.generation || handle.sessionId !== target.sessionId) {
      return Promise.reject(fail('session_usage_target_changed'))
    }
    if (signal !== undefined && (typeof signal?.addEventListener !== 'function'
      || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) {
      return Promise.reject(fail('session_usage_invalid_arguments'))
    }
    if (signal?.aborted) return Promise.reject(fail('session_usage_cancelled'))

    let source
    try { source = readerNow() } catch (error) { return Promise.reject(error) }
    const job = { target, sourceIdentity: source.identity, abort: new AbortController(), cancelCode: null,
      rejectCancellation: () => {}, task: null, abortListener: null }
    const readSignal = signal ? AbortSignal.any([signal, job.abort.signal]) : job.abort.signal
    const cancelled = new Promise((_, reject) => { job.rejectCancellation = reject })
    if (signal) {
      job.abortListener = () => rejectJob(job, 'session_usage_cancelled')
      signal.addEventListener('abort', job.abortListener, { once: true })
      if (signal.aborted) job.abortListener()
    }
    jobs.add(job)

    const task = Promise.resolve().then(async () => {
      if (job.cancelCode) throw fail(job.cancelCode)
      if (!current(target)) throw fail('session_usage_target_changed')
      if (!sameReader(source)) throw fail('session_usage_source_changed')
      let response
      try { response = await source.reader.projections({ sessionId: target.sessionId }, readSignal) }
      catch {
        if (job.cancelCode || signal?.aborted) throw fail(job.cancelCode ?? 'session_usage_cancelled')
        if (!current(target)) throw fail('session_usage_target_changed')
        if (!sameReader(source)) throw fail('session_usage_source_changed')
        throw fail('session_usage_read_failed')
      }
      if (job.cancelCode) throw fail(job.cancelCode)
      if (!current(target)) throw fail('session_usage_target_changed')
      if (!sameReader(source)) throw fail('session_usage_source_changed')
      if (response === null) return Object.freeze({ status: 'missing', target: publicTarget(target) })
      const projected = projectValues(response)
      return Object.freeze({ ...projected, target: publicTarget(target) })
    })
    job.task = task.then(value => value, error => { throw error }).finally(() => {
      jobs.delete(job)
      signal?.removeEventListener('abort', job.abortListener)
    })
    return Promise.race([job.task, cancelled])
  }

  function cancel() {
    const active = jobs.size > 0
    for (const job of jobs) rejectJob(job, 'session_usage_cancelled')
    return Object.freeze({ status: active ? 'cancelling' : 'idle' })
  }

  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    binding = null
    generation++
    for (const job of jobs) rejectJob(job, 'session_usage_closed')
    const pending = [...jobs].map(job => job.task)
    disposePromise = Promise.allSettled(pending).then(() => undefined)
    return disposePromise
  }

  return Object.freeze({ bindAgent, readUsage, cancel, dispose,
    getCurrentTarget: () => current(binding) ? publicTarget(binding) : null,
    getInFlight: () => jobs.size > 0,
  })
}

function publicTarget(target) {
  return Object.freeze({ agentId: target.agentId, sessionId: target.sessionId, generation: target.generation })
}
