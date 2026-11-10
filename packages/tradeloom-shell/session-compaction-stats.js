export const SESSION_COMPACTION_STATS_KEY = 'tradeloomCompactionStats'
export const SESSION_COMPACTION_STATS_STATE_VERSION = 1
const KEY = SESSION_COMPACTION_STATS_KEY
const STATE_VERSION = SESSION_COMPACTION_STATS_STATE_VERSION
const COUNT_FIELDS = Object.freeze(['attempts', 'summaryApplied', 'completed', 'failed'])

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function sequence(value) { return Number.isSafeInteger(value) && value >= 0 }
function count(value) { return Number.isSafeInteger(value) && value >= 0 }
function sameKeys(value, expected) {
  return record(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function cleanRange(value) {
  return record(value) && sameKeys(value, ['start', 'end']) && sequence(value.start) && sequence(value.end) && value.start <= value.end
}

function parseState(value) {
  if (!sameKeys(value, [...COUNT_FIELDS, 'openAttempts', 'stats'])
    || !COUNT_FIELDS.every(field => count(value[field])) || !Array.isArray(value.openAttempts)
    || !sameKeys(value.stats, [...COUNT_FIELDS, 'inflight'])
    || !COUNT_FIELDS.every(field => value.stats[field] === value[field])
    || value.stats.inflight !== value.openAttempts.length || !count(value.stats.inflight)) {
    throw new TypeError('invalid compaction stats projection state')
  }
  const ids = new Set()
  for (const attempt of value.openAttempts) {
    if (!sameKeys(attempt, ['compactionId', 'startSeq', 'turn', 'sourceCommandId', 'summarySeq', 'shadowedRange', 'summaryApplied'])
      || typeof attempt.compactionId !== 'string' || !attempt.compactionId || !sequence(attempt.startSeq)
      || !(attempt.turn === null || sequence(attempt.turn))
      || !(attempt.sourceCommandId === null || (typeof attempt.sourceCommandId === 'string' && attempt.sourceCommandId.length > 0))
      || !(attempt.summarySeq === null || sequence(attempt.summarySeq))
      || !(attempt.shadowedRange === null || cleanRange(attempt.shadowedRange))
      || typeof attempt.summaryApplied !== 'boolean'
      || (attempt.summarySeq === null) !== (attempt.shadowedRange === null)
      || ids.has(attempt.compactionId)) throw new TypeError('invalid compaction stats projection state')
    ids.add(attempt.compactionId)
  }
  return value
}

function validState(value) {
  try { parseState(value); return true } catch { return false }
}

function emptyState() {
  const stats = Object.freeze({ attempts: 0, summaryApplied: 0, completed: 0, failed: 0, inflight: 0 })
  return Object.freeze({ attempts: 0, summaryApplied: 0, completed: 0, failed: 0, openAttempts: Object.freeze([]), stats })
}

function nextState(previous, changes = {}) {
  const counts = Object.fromEntries(COUNT_FIELDS.map(field => [field, changes[field] ?? previous[field]]))
  const openAttempts = changes.openAttempts ?? previous.openAttempts
  const sameCounts = COUNT_FIELDS.every(field => counts[field] === previous[field]) && openAttempts === previous.openAttempts
  if (sameCounts) return previous
  const stats = COUNT_FIELDS.every(field => counts[field] === previous[field])
    && openAttempts.length === previous.openAttempts.length
    ? previous.stats
    : Object.freeze({ ...counts, inflight: openAttempts.length })
  return Object.freeze({ ...counts, openAttempts, stats })
}

function sameOwner(attempt, data) {
  return attempt.turn === data.turn
    && attempt.sourceCommandId === (data.sourceCommandId ?? null)
}

function replacementMatches(attempt, event) {
  const candidate = attempt.summarySeq
  if (candidate === null || event.type !== 'user/message' || event.seq !== candidate + 1
    || !record(event.data) || event.data.role !== 'user'
    || !record(event.surfaceOp) || event.surfaceOp.op !== 'replace'
    || event.surfaceOp.startSeq !== attempt.shadowedRange.start
    || event.surfaceOp.endSeq !== attempt.shadowedRange.end
    || !Array.isArray(event.sourceEventSeqs)) return false
  return event.sourceEventSeqs.includes(attempt.startSeq) && event.sourceEventSeqs.includes(candidate)
}

function validLifecycleData(attempt, data) {
  return record(data) && data.compactionId === attempt.compactionId && sameOwner(attempt, data)
}

function validSummaryData(attempt, data) {
  return record(data) && data.compactionId === attempt.compactionId
    && attempt.sourceCommandId === (data.sourceCommandId ?? null)
}

function apply(state, event) {
  if (!record(event) || !sequence(event.seq) || typeof event.type !== 'string') return state

  let openAttempts = state.openAttempts
  let summaryApplied = state.summaryApplied
  let candidateChanged = false

  // A summary is applied only by the immediately following matching surface replacement.
  openAttempts = openAttempts.map(attempt => {
    if (attempt.summarySeq === null) return attempt
    if (replacementMatches(attempt, event)) {
      candidateChanged = true
      summaryApplied++
      return { ...attempt, summarySeq: null, shadowedRange: null, summaryApplied: true }
    }
    candidateChanged = true
    return { ...attempt, summarySeq: null, shadowedRange: null }
  })

  const data = event.data
  if (event.type === 'compaction/start' && record(data) && typeof data.compactionId === 'string'
    && data.compactionId.length > 0 && (data.turn === null || sequence(data.turn))
    && (data.sourceCommandId === undefined || (typeof data.sourceCommandId === 'string' && data.sourceCommandId.length > 0))
    && !openAttempts.some(attempt => attempt.compactionId === data.compactionId)) {
    const attempt = {
      compactionId: data.compactionId,
      startSeq: event.seq,
      turn: data.turn,
      sourceCommandId: data.sourceCommandId ?? null,
      summarySeq: null,
      shadowedRange: null,
      summaryApplied: false,
    }
    openAttempts = [...openAttempts, attempt]
    return nextState(state, { attempts: state.attempts + 1, openAttempts })
  }

  if (event.type === 'compaction/summary' && record(data)) {
    const index = openAttempts.findIndex(attempt => validSummaryData(attempt, data))
    if (index >= 0 && cleanRange(data.shadowedRange) && event.seq > openAttempts[index].startSeq) {
      openAttempts = openAttempts.map((attempt, item) => item === index
        ? { ...attempt, summarySeq: event.seq, shadowedRange: { start: data.shadowedRange.start, end: data.shadowedRange.end } }
        : attempt)
      return nextState(state, { summaryApplied, openAttempts })
    }
  }

  if (event.type === 'compaction/end' && record(data)) {
    const index = openAttempts.findIndex(attempt => validLifecycleData(attempt, data))
    if (index >= 0) {
      const failed = Object.hasOwn(data, 'error')
      openAttempts = openAttempts.filter((_, item) => item !== index)
      return nextState(state, {
        summaryApplied,
        completed: failed ? state.completed : state.completed + 1,
        failed: failed ? state.failed + 1 : state.failed,
        openAttempts,
      })
    }
  }

  if (candidateChanged) return nextState(state, { summaryApplied, openAttempts })
  return state
}

function viewSchemaParse(value) {
  if (!sameKeys(value, [...COUNT_FIELDS, 'inflight']) || !COUNT_FIELDS.every(field => count(value[field])) || !count(value.inflight)) {
    throw new TypeError('invalid compaction stats projection view')
  }
  return value
}

function validView(value) {
  try { viewSchemaParse(value); return true } catch { return false }
}

/** Create the SDK projection unit using the Host's Zod schema primitives. */
export function createSessionCompactionStatsProjection({ z } = {}) {
  if (!z || typeof z.custom !== 'function') {
    const error = new Error('session_compaction_stats_schema_unavailable')
    error.code = 'session_compaction_stats_schema_unavailable'
    throw error
  }
  return Object.freeze({
    key: KEY,
    stateSchema: z.custom(validState),
    init: () => emptyState(),
    apply,
    stateVersion: STATE_VERSION,
    wire: Object.freeze({ viewSchema: z.custom(validView), view: state => state.stats }),
  })
}

/** Register in the current Cordis fiber; unloading that fiber removes the key. */
export function registerSessionCompactionStatsProjection(ctx, { z } = {}) {
  if (!ctx?.sessionProjections || typeof ctx.sessionProjections.register !== 'function') {
    const error = new Error('session_compaction_stats_unavailable')
    error.code = 'session_compaction_stats_unavailable'
    throw error
  }
  return ctx.sessionProjections.register(createSessionCompactionStatsProjection({ z }))
}
