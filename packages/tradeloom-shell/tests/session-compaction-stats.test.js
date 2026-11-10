import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionCompactionStatsProjection } from '../session-compaction-stats.js'

const testZod = { custom(check) { return { parse(value) {
  if (!check(value)) throw new TypeError('invalid fixture schema')
  return value
} } } }

function event(type, seq, data, extra = {}) { return { type, seq, time: seq, data, ...extra } }
const start = (id, seq = 1) => event('compaction/start', seq, { compactionId: id, turn: null })
const summary = (id, seq = 2, range = { start: 0, end: 1 }) => event('compaction/summary', seq, {
  compactionId: id, summary: [{ type: 'text', text: 'not retained' }], shadowedRange: range,
  shadowedSeqs: [range.start, range.end], shadowedTokenCount: 3, provider: 'fixture', model: 'fixture',
})
const replacement = (seq = 3, range = { start: 0, end: 1 }, refs = [1, 2, 0, 1]) => event('user/message', seq,
  { role: 'user', content: [{ type: 'text', text: 'not retained' }] }, {
    surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end }, sourceEventSeqs: refs,
  })
const end = (id, seq = 4, error) => event('compaction/end', seq, {
  compactionId: id, turn: null, ...(error === undefined ? {} : { error }),
})

function fold(events) {
  const projection = createSessionCompactionStatsProjection({ z: testZod })
  let state = projection.init({}, 0)
  for (const item of events) state = projection.apply(state, item)
  return { projection, state, view: projection.wire.view(state) }
}

test('counts completed summary only after matching adjacent replacement and end', () => {
  const { state, view } = fold([start('c1'), summary('c1'), replacement(), end('c1')])
  assert.deepEqual(view, { attempts: 1, summaryApplied: 1, completed: 1, failed: 0, inflight: 0 })
  assert.deepEqual(state.openAttempts, [])
  assert.equal(JSON.stringify(state).includes('not retained'), false)
})

test('summary without a valid adjacent replacement is not applied', () => {
  const noReplacement = fold([start('c1'), summary('c1'), event('assistant/message', 3, {}), end('c1')])
  assert.deepEqual(noReplacement.view, { attempts: 1, summaryApplied: 0, completed: 1, failed: 0, inflight: 0 })
  const wrongRange = fold([start('c1'), summary('c1'), replacement(3, { start: 0, end: 2 }), end('c1')])
  assert.equal(wrongRange.view.summaryApplied, 0)
  const missingRefs = fold([start('c1'), summary('c1'), replacement(3, { start: 0, end: 1 }, [0, 1]), end('c1')])
  assert.equal(missingRefs.view.summaryApplied, 0)
})

test('failed end and unmatched start are separate from successful summary application', () => {
  const failed = fold([start('c1'), summary('c1'), end('c1', 3, 'private error')])
  assert.deepEqual(failed.view, { attempts: 1, summaryApplied: 0, completed: 0, failed: 1, inflight: 0 })
  const appliedButOpen = fold([start('c-open'), summary('c-open'), replacement()])
  assert.deepEqual(appliedButOpen.view, { attempts: 1, summaryApplied: 1, completed: 0, failed: 0, inflight: 1 })
  const open = fold([start('c2')])
  assert.deepEqual(open.view, { attempts: 1, summaryApplied: 0, completed: 0, failed: 0, inflight: 1 })
})

test('prune is not summarized compaction and unrelated events preserve the state reference', () => {
  const projection = createSessionCompactionStatsProjection({ z: testZod })
  const state = projection.init({}, 0)
  assert.equal(projection.apply(state, event('compaction/prune', 1, { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 2 })), state)
  assert.equal(projection.apply(state, event('user/message', 1, {})), state)
  assert.equal(projection.apply(state, event('compaction/summary', 1, { compactionId: 'missing' })), state)
})
