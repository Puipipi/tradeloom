import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflowRunJournal, WorkflowRunJournalError } from './workflow-run-journal.js'
import { createConfirmedWorkflowDefinition } from './workflow-definition.js'
import { ARTIFACT_EVIDENCE_SCHEMA } from './workflow-artifact-source.js'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const PARENT = 'parent-agent-1'

test('cancel intent is durable before interruption and replay is zero writes', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal)
  const input = { operationId: 'cancel-op', fingerprint: 'a'.repeat(64) }
  const result = await handle.requestCancel(input)
  assert.equal(result.reused, false)
  assert.equal(handle.getSnapshot().cancelRequested, true)
  assert.equal(handle.getSnapshot().status, 'interrupted')
  const writes = store.writes.length
  assert.equal((await (await journal.open(RUN_ID)).requestCancel(input)).reused, true)
  assert.equal(store.writes.length, writes)
  await assert.rejects(handle.requestCancel({ ...input, fingerprint: 'b'.repeat(64) }), { code: 'operation_conflict' })
  let calls = 0
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async () => { calls++ }), { code: 'run_cancel_requested' })
  assert.equal(calls, 0)
})
test('manual resume claim persists, replays without scheduling, and done/uncertain nodes never retry implicitly', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal)
  await journal.recoverInterruptedRuns()
  const cold = await journal.open(RUN_ID)
  const plan = await cold.inspectResume()
  assert.equal(plan.eligible, true)
  const claim = { operationId: 'resume-op', fingerprint: 'a'.repeat(64), expectedRevision: cold.getSnapshot().revision, nodeIds: plan.eligibleNodeIds }
  const accepted = await cold.claimResume(claim)
  assert.equal(accepted.reused, false)
  const revision = cold.getSnapshot().revision
  assert.equal((await (await journal.open(RUN_ID)).claimResume(claim)).reused, true)
  assert.equal((await journal.open(RUN_ID)).getSnapshot().revision, revision)
  await assert.rejects(cold.claimResume({ ...claim, fingerprint: 'b'.repeat(64) }), { code: 'operation_conflict' })
  await journal.recoverInterruptedRuns() // Crash after claim, before attempt-start.
  const recovered = await journal.open(RUN_ID)
  assert.equal((await recovered.inspectResume()).eligible, true)
  const started = recovered.executeAttempt(attempt(recovered, 'node-a', { confirmResume: true }), async () => new Promise(() => {}))
  await new Promise(resolve => setImmediate(resolve))
  await journal.recoverInterruptedRuns() // Attempt-start committed, no trustworthy child end.
  const blocked = await (await journal.open(RUN_ID)).inspectResume()
  assert.equal(blocked.eligible, false)
  assert.equal(blocked.blocked.find(item => item.nodeId === 'node-a').reason, 'child_terminal_unverified')
  void started
})
test('ack then process crash without a persisted child end remains blocked', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal)
  const running = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'call', childId: 'child', nativeRunId: 'native' })
    return new Promise(() => {})
  })
  await new Promise(resolve => setImmediate(resolve)); await journal.recoverInterruptedRuns()
  const plan = await (await journal.open(RUN_ID)).inspectResume()
  assert.equal(plan.eligible, false)
  assert.equal(plan.blocked.find(item => item.nodeId === 'node-a').reason, 'child_terminal_unverified')
  void running
})
test('crash after a known-ended retry claim preserves a new explicit resume opportunity', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal)
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'call', childId: 'child', nativeRunId: 'native' })
    return { ...terminal(context, 'child', 'native'), status: 'interrupted', stopReason: 'aborted', toolCallId: 'call' }
  })
  const plan = await handle.inspectResume()
  assert.equal(plan.eligible, true)
  await handle.claimResume({ operationId: 'claim-ended', fingerprint: 'a'.repeat(64), expectedRevision: handle.getSnapshot().revision, nodeIds: plan.eligibleNodeIds })
  await journal.recoverInterruptedRuns()
  assert.equal((await (await journal.open(RUN_ID)).inspectResume()).eligible, true)
})

test('DAG blocked descendants persist in CAS and leave independent branch executable', async () => {
  const store = createCasStore(), journal = createJournal(store)
  const document = documentWith('a', 'b', 'c', 'd')
  document.edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]
  const handle = await journal.create({ document, requestId: 'request-1', parentAgentId: PARENT,
    sessionId: 'session-1', bindingRevision: 'binding-r7' })
  await handle.executeAttempt(attempt(handle, 'a'), async context => {
    await context.recordChildAck({ toolCallId: 'failed-call', childId: 'failed-child', nativeRunId: 'failed-run' })
    return { ...terminal(context, 'failed-child', 'failed-run'), toolCallId: 'failed-call', status: 'failed', stopReason: 'failed' }
  })
  await handle.settleBlockedNodes()
  assert.equal(handle.getSnapshot().nodes.b.status, 'skipped')
  assert.equal(handle.getSnapshot().nodes.c.status, 'skipped')
  assert.equal(handle.getSnapshot().nodes.d.status, 'pending')
  const blockedEvents = handle.getSnapshot().events.filter(event => event.type === 'node-blocked')
  assert.deepEqual(blockedEvents.map(({ nodeId, blockedBy }) => ({ nodeId, blockedBy })), [
    { nodeId: 'b', blockedBy: ['a'] }, { nodeId: 'c', blockedBy: ['b'] },
  ])
  assert.deepEqual((await journal.open(RUN_ID)).getSnapshot().events.filter(event => event.type === 'node-blocked'), blockedEvents)
  blockedEvents[0].blockedBy.push('mutated-returned-copy')
  assert.deepEqual((await journal.open(RUN_ID)).getSnapshot().events.find(event => event.type === 'node-blocked').blockedBy, ['a'])
  assert.ok(handle.getSnapshot().events.filter(event => event.type !== 'node-blocked').every(event => !Object.hasOwn(event, 'blockedBy')))
  const revision = handle.getSnapshot().revision
  await handle.settleBlockedNodes()
  assert.equal(handle.getSnapshot().revision, revision)
  await handle.executeAttempt(attempt(handle, 'd'), async context => {
    await context.recordChildAck({ toolCallId: 'ok-call', childId: 'ok-child', nativeRunId: 'ok-run' })
    return { ...terminal(context, 'ok-child', 'ok-run'), toolCallId: 'ok-call' }
  })
  assert.equal(handle.getSnapshot().status, 'failed')
  assert.deepEqual((await journal.open(RUN_ID)).getSnapshot(), handle.getSnapshot())
})

function documentWith(...ids) {
  return {
    version: 1,
    id: 'confirmed-flow',
    title: 'Confirmed flow',
    source: 'manual',
    confirmed: true,
    nodes: ids.map((id, index) => ({ id, kind: 'agent', agent: 'center', model: null, title: `Node ${index + 1}` })),
    edges: [],
  }
}

function clone(value) { return structuredClone(value) }

function createCasStore(seed = []) {
  const rows = new Map(seed.map(snapshot => [snapshot.id, clone(snapshot)]))
  const writes = []
  const saveCalls = []
  let failNext = null
  return {
    rows,
    writes,
    saveCalls,
    failNext(error = new Error('disk unavailable')) { failNext = error },
    async get(id) { return clone(rows.get(id) ?? null) },
    async list({ activeOnly = false } = {}) {
      const values = [...rows.values()]
      return values.filter(item => !activeOnly || ['running', 'waiting', 'interrupted'].includes(item.status))
        .map(({ id, status }) => ({ id, status }))
    },
    async save(snapshot, expectedRevision) {
      const current = rows.get(snapshot.id)
      saveCalls.push({ id: snapshot.id, expectedRevision, revision: snapshot.revision, currentStatus: current?.status ?? null })
      if (failNext) { const error = failNext; failNext = null; throw error }
      if (current && ['done', 'failed', 'cancelled'].includes(current.status)) {
        throw Object.assign(new Error('terminal workflow runs are immutable'), { code: 'terminal_run_immutable', status: 409 })
      }
      if (current ? current.revision !== expectedRevision : expectedRevision !== 0) {
        throw Object.assign(new Error('CAS conflict'), { code: 'revision_conflict' })
      }
      assert.equal(snapshot.revision, expectedRevision + 1)
      assert.ok(Object.keys(snapshot.nodes).length <= 40)
      assert.ok(Buffer.byteLength(JSON.stringify({ snapshot, expectedRevision })) <= 2 * 1024 * 1024)
      rows.set(snapshot.id, clone(snapshot))
      writes.push({ id: snapshot.id, revision: snapshot.revision, expectedRevision })
      return clone(snapshot)
    },
  }
}

function createJournal(store) {
  return createWorkflowRunJournal({
    store,
    now: () => new Date('2026-10-26T00:00:00.000Z'),
    createRunId: () => RUN_ID,
  })
}

async function createRun(journal, ids = ['node-a', 'node-b']) {
  return journal.create({
    document: documentWith(...ids),
    requestId: 'request-1',
    parentAgentId: PARENT,
    sessionId: 'session-1',
    bindingRevision: 'binding-r7',
    definitionRevision: createConfirmedWorkflowDefinition(documentWith(...ids)).definitionRevision,
  })
}

function attempt(handle, nodeId, extra = {}) {
  return {
    nodeId,
    attempt: 1,
    requestId: 'request-1',
    bindingRevision: 'binding-r7',
    definitionRevision: handle.getSnapshot().definitionRevision,
    ...extra,
  }
}

function identityOf(context) {
  return {
    requestId: context.requestId,
    workflowRunId: context.workflowRunId,
    nodeId: context.nodeId,
    attempt: context.attempt,
    bindingRevision: context.bindingRevision,
    definitionRevision: context.definitionRevision,
    parentAgentId: context.parentAgentId,
    sessionId: context.sessionId,
  }
}

function terminal(context, childId, nativeRunId, output = '', extra = {}) {
  return {
    status: 'completed',
    terminalSource: 'subagent/end',
    ...identityOf(context),
    childId,
    nativeRunId,
    output,
    stopReason: 'completed',
    ...extra,
  }
}

const sourceStart = { childSessionId: 'child-source', nativeRunId: 'epoch-source', startInclusive: 10 }
const sourceEvidence = () => ({ schema: ARTIFACT_EVIDENCE_SCHEMA, range: { ...sourceStart, endExclusive: 15 }, declarations: [
  { sourceSessionSeq: 12, fileIndex: 0, presentCallId: 'present-call', sourceTurn: 2, path: 'C:/mutable.txt' },
] })

test('ack start and terminal source evidence use existing serial CAS with no post-terminal writes', async () => {
  const store = createCasStore(), journal = createJournal(store)
  const handle = await createRun(journal, ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'spawn-call', childId: sourceStart.childSessionId, nativeRunId: sourceStart.nativeRunId, artifactRangeStart: sourceStart })
    assert.equal(store.rows.get(RUN_ID).nodes['node-a'].artifactRangeStart.startInclusive, 10)
    return terminal(context, sourceStart.childSessionId, sourceStart.nativeRunId, 'model text ignored', { toolCallId: 'spawn-call', artifactEvidence: sourceEvidence() })
  })
  const saved = store.rows.get(RUN_ID)
  assert.equal(saved.status, 'done')
  assert.equal(saved.revision, 4)
  assert.equal(saved.nodes['node-a'].artifactSource, 'deliverables/presented')
  assert.deepEqual(saved.nodes['node-a'].artifacts, sourceEvidence().declarations)
  assert.deepEqual(saved.events.at(-1).artifactEvidence, sourceEvidence())
  assert.ok(store.saveCalls.every(call => call.currentStatus !== 'done'))
  assert.deepEqual((await journal.open(RUN_ID)).getSnapshot(), saved)
})

test('bad source identity remains unknown without invalidating verified execution terminal', async () => {
  const store = createCasStore(), handle = await createRun(createJournal(store), ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'spawn-call', childId: sourceStart.childSessionId, nativeRunId: sourceStart.nativeRunId, artifactRangeStart: sourceStart })
    const artifactEvidence = sourceEvidence(); artifactEvidence.range.nativeRunId = 'old-epoch'
    return terminal(context, sourceStart.childSessionId, sourceStart.nativeRunId, '', { toolCallId: 'spawn-call', artifactEvidence })
  })
  const node = store.rows.get(RUN_ID).nodes['node-a']
  assert.equal(node.status, 'done')
  assert.equal(node.artifactSource, 'unknown')
  assert.deepEqual(node.artifacts, [])
})

test('artifact terminal CAS failure cannot publish success or evidence, and old v1 remains unknown', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal, ['node-a'])
  assert.equal((await journal.open(RUN_ID)).getSnapshot().nodes['node-a'].artifactSource, 'unknown')
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'spawn-call', childId: sourceStart.childSessionId, nativeRunId: sourceStart.nativeRunId, artifactRangeStart: sourceStart })
    store.failNext()
    return terminal(context, sourceStart.childSessionId, sourceStart.nativeRunId, '', { toolCallId: 'spawn-call', artifactEvidence: sourceEvidence() })
  }))
  const node = store.rows.get(RUN_ID).nodes['node-a']
  assert.equal(node.attemptState, 'acknowledged')
  assert.equal(node.artifactEvidence, undefined)
  assert.equal(node.artifactSource, 'unknown')
})

test('ack source boundary conflicts and tampered v1 evidence are rejected without another write', async () => {
  const store = createCasStore(), journal = createJournal(store), handle = await createRun(journal, ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    const ack = { toolCallId: 'spawn-call', childId: sourceStart.childSessionId, nativeRunId: sourceStart.nativeRunId, artifactRangeStart: sourceStart }
    await context.recordChildAck(ack)
    const count = store.writes.length
    await context.recordChildAck(ack)
    assert.equal(store.writes.length, count)
    await assert.rejects(context.recordChildAck({ ...ack, artifactRangeStart: { ...sourceStart, startInclusive: 11 } }), { code: 'child_ack_conflict' })
    return terminal(context, sourceStart.childSessionId, sourceStart.nativeRunId, '', { toolCallId: 'spawn-call', artifactEvidence: sourceEvidence() })
  })
  const saved = store.rows.get(RUN_ID)
  saved.nodes['node-a'].artifactEvidence.declarations[0].sourceSessionSeq = 15
  await assert.rejects(journal.open(RUN_ID), { code: 'invalid_artifact_evidence' })
})

test('create persists the run before returning a handle or allowing execution', async () => {
  const store = createCasStore()
  const journal = createJournal(store)
  const handle = await createRun(journal, ['node-a'])
  assert.equal(store.writes[0].revision, 1)
  let sideEffectSawPersistedStart = false
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    sideEffectSawPersistedStart = store.rows.get(RUN_ID).nodes['node-a'].attemptState === 'started'
    return terminal(context, 'child-a', 'native-a')
  })
  assert.equal(sideEffectSawPersistedStart, true)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].status, 'done')
})

test('concurrent node attempts serialize CAS updates without losing events', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store))
  let releaseA
  let releaseB
  const gateA = new Promise(resolve => { releaseA = resolve })
  const gateB = new Promise(resolve => { releaseB = resolve })
  const runA = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'tool-a', childId: 'child-a', nativeRunId: 'native-a' })
    await gateA
    return terminal(context, 'child-a', 'native-a', '', { toolCallId: 'tool-a' })
  })
  const runB = handle.executeAttempt(attempt(handle, 'node-b'), async context => {
    await context.recordChildAck({ toolCallId: 'tool-b', childId: 'child-b', nativeRunId: 'native-b' })
    await gateB
    return terminal(context, 'child-b', 'native-b', '', { toolCallId: 'tool-b' })
  })
  await new Promise(resolve => setImmediate(resolve))
  releaseB()
  releaseA()
  await Promise.all([runA, runB])
  const snapshot = await createJournal(store).open(RUN_ID).then(handle => handle.getSnapshot())
  assert.equal(snapshot.nodes['node-a'].status, 'done')
  assert.equal(snapshot.nodes['node-b'].status, 'done')
  assert.equal(snapshot.events.filter(event => event.type === 'attempt-started').length, 2)
  assert.equal(snapshot.events.filter(event => event.type === 'child-ack').length, 2)
  assert.equal(snapshot.events.filter(event => event.type === 'node-terminal').length, 2)
  assert.deepEqual(store.writes.map(write => write.revision), [1, 2, 3, 4, 5, 6, 7])
})

test('concurrent duplicate start is rejected before the second side effect', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const first = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    calls += 1
    await gate
    return terminal(context, 'child-a', 'native-a')
  })
  const second = handle.executeAttempt(attempt(handle, 'node-a'), async context => { calls += 1; return terminal(context, 'child-b', 'native-b') })
  release()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(calls, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1)
  assert.ok(['attempt_sequence_mismatch', 'attempt_already_started'].includes(outcomes[1].reason.code))
})

test('a later attempt cannot start while the prior attempt is active', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  let calls = 0
  const first = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    calls += 1
    markStarted()
    await gate
    return terminal(context, 'child-a', 'native-a')
  })
  await started
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a', { attempt: 2, confirmNewAttempt: true }), async () => {
    calls += 1
    return terminal({}, 'child-b', 'native-b')
  }), error => error.code === 'attempt_still_active')
  release()
  await first
  assert.equal(calls, 1)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].attempt, 1)
})

test('every terminal identity must match the active request and persisted run binding', async t => {
  for (const [field, value] of Object.entries({
    requestId: 'request-other',
    workflowRunId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'node-other',
    attempt: 9,
    bindingRevision: 'binding-other',
    definitionRevision: 'definition-other',
    parentAgentId: 'parent-other',
    sessionId: 'session-other',
  })) {
    await t.test(field, async () => {
      const store = createCasStore()
      const handle = await createRun(createJournal(store), ['node-a'])
      await handle.executeAttempt(attempt(handle, 'node-a'), async context => ({
        ...terminal(context, 'untrusted-child', 'untrusted-native'),
        [field]: value,
      }))
      const snapshot = (await createJournal(store).open(RUN_ID)).getSnapshot()
      assert.equal(snapshot.nodes['node-a'].status, 'unknown')
      assert.equal(snapshot.nodes['node-a'].childId, null)
      const audit = snapshot.events.at(-1)
      assert.equal(audit.type, 'attempt-identity-mismatch')
      assert.ok(audit.identityMismatchFields.includes(field))
      assert.equal(audit.reportedIdentity[field], value)
    })
  }
})

test('terminal result inconsistent with a recorded acknowledgement preserves the acknowledgement', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    await context.recordChildAck({ toolCallId: 'tool-a', childId: 'child-a', nativeRunId: 'native-a' })
    return terminal(context, 'different-child', 'different-native', '', { toolCallId: 'different-tool' })
  })
  const snapshot = (await createJournal(store).open(RUN_ID)).getSnapshot()
  assert.equal(snapshot.nodes['node-a'].status, 'unknown')
  assert.equal(snapshot.nodes['node-a'].toolCallId, 'tool-a')
  assert.equal(snapshot.nodes['node-a'].childId, 'child-a')
  assert.equal(snapshot.nodes['node-a'].nativeRunId, 'native-a')
  assert.deepEqual(new Set(snapshot.events.at(-1).identityMismatchFields), new Set(['toolCallId', 'childId', 'nativeRunId']))
})

test('late result after recovery cannot overwrite a manually resumed attempt', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let releaseOld
  let markOldStarted
  const oldGate = new Promise(resolve => { releaseOld = resolve })
  const oldStarted = new Promise(resolve => { markOldStarted = resolve })
  const oldExecution = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    markOldStarted()
    await oldGate
    return terminal(context, 'old-child', 'old-native')
  })
  await oldStarted
  const recovery = await createJournal(store).recoverInterruptedRuns()
  assert.equal(recovery.recovered.length, 1)
  const resumed = await createJournal(store).open(RUN_ID)
  let releaseNew
  let markNewStarted
  const newGate = new Promise(resolve => { releaseNew = resolve })
  const newStarted = new Promise(resolve => { markNewStarted = resolve })
  const newExecution = resumed.executeAttempt(attempt(resumed, 'node-a', { attempt: 2, confirmNewAttempt: true }), async context => {
    markNewStarted()
    await newGate
    return terminal(context, 'new-child', 'new-native')
  })
  await newStarted
  releaseOld()
  const oldResult = await oldExecution
  assert.equal(oldResult.ignored, true)
  const during = (await createJournal(store).open(RUN_ID)).getSnapshot()
  assert.equal(during.nodes['node-a'].attempt, 2)
  assert.equal(during.nodes['node-a'].status, 'running')
  assert.equal(during.nodes['node-a'].childId, null)
  assert.equal(during.events.at(-1).type, 'late-attempt-result-ignored')
  releaseNew()
  await newExecution
  const final = (await createJournal(store).open(RUN_ID)).getSnapshot()
  assert.equal(final.nodes['node-a'].status, 'done')
  assert.equal(final.nodes['node-a'].childId, 'new-child')
})

test('late result after a run is terminal is reported ignored without attempting a save', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  const oldExecution = handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    markStarted()
    await gate
    return terminal(context, 'late-child', 'late-native')
  })
  await started

  // Represents an authoritative completion by another live observer, persisted via CAS
  // while the original callback is still outstanding.
  const winner = clone(store.rows.get(RUN_ID))
  winner.revision += 1
  winner.status = 'done'
  winner.finishedAt = '2026-10-26T00:00:01.000Z'
  Object.assign(winner.nodes['node-a'], {
    status: 'done', attemptState: 'terminal', childId: 'winning-child', nativeRunId: 'winning-native',
  })
  winner.events.push({ sequence: winner.events.length + 1, type: 'node-terminal', at: winner.finishedAt })
  await store.save(winner, winner.revision - 1)
  const savedCallsBeforeLateResult = store.saveCalls.length
  release()

  const result = await oldExecution
  assert.equal(result.ignored, true)
  assert.equal(result.persisted, false)
  assert.equal(result.ignoreReason, 'run_terminal')
  assert.equal(result.snapshot.nodes['node-a'].childId, 'winning-child')
  assert.equal(store.saveCalls.length, savedCallsBeforeLateResult)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].childId, 'winning-child')
})

test('late callback error after a run is terminal returns a non-persistent ignored diagnostic', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let rejectCallback
  let markStarted
  const callback = new Promise((_, reject) => { rejectCallback = reject })
  const started = new Promise(resolve => { markStarted = resolve })
  const execution = handle.executeAttempt(attempt(handle, 'node-a'), async () => {
    markStarted()
    return callback
  })
  await started

  const winner = clone(store.rows.get(RUN_ID))
  winner.revision += 1
  winner.status = 'done'
  winner.finishedAt = '2026-10-26T00:00:01.000Z'
  Object.assign(winner.nodes['node-a'], { status: 'done', attemptState: 'terminal', childId: 'winner', nativeRunId: 'winner-run' })
  await store.save(winner, winner.revision - 1)
  const saveCallsBeforeLateError = store.saveCalls.length
  rejectCallback(new Error('late timeout from stale callback'))

  await assert.rejects(execution, error => {
    assert.equal(error.code, 'attempt_result_ignored')
    assert.equal(error.journalOutcome.ignored, true)
    assert.equal(error.journalOutcome.persisted, false)
    assert.equal(error.journalOutcome.ignoreReason, 'run_terminal')
    assert.equal(error.journalOutcome.snapshot.nodes['node-a'].childId, 'winner')
    return true
  })
  assert.equal(store.saveCalls.length, saveCallsBeforeLateError)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].childId, 'winner')
})

test('repeating an attempt after run completion neither saves nor invokes the executor again', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  let executorCalls = 0
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    executorCalls += 1
    return terminal(context, 'child-a', 'native-a')
  })
  const saveCallsAfterCompletion = store.saveCalls.length
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async context => {
    executorCalls += 1
    return terminal(context, 'duplicate-child', 'duplicate-native')
  }), error => error.code === 'run_is_terminal')
  assert.equal(executorCalls, 1)
  assert.equal(store.saveCalls.length, saveCallsAfterCompletion)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].childId, 'child-a')
})

test('store failure on attempt-start blocks the external side effect and poisons the handle', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  store.failNext()
  let calls = 0
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async () => { calls += 1 }), error => error.code === 'store_write_failed')
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async () => { calls += 1 }), error => error.code === 'journal_unavailable_after_store_failure')
  assert.equal(calls, 0)
  assert.equal(store.rows.get(RUN_ID).nodes['node-a'].attempt, 0)
})

test('attempt history persists across reopen and cannot be replayed without confirmed new attempt', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async () => ({ status: 'unknown', terminalSource: 'unknown', output: 'maybe started' }))
  const reopened = await createJournal(store).open(RUN_ID)
  let calls = 0
  await assert.rejects(reopened.executeAttempt(attempt(reopened, 'node-a'), async () => { calls += 1 }), error => error.code === 'attempt_sequence_mismatch')
  await assert.rejects(reopened.executeAttempt(attempt(reopened, 'node-a', { attempt: 2 }), async () => { calls += 1 }), error => error.code === 'new_attempt_confirmation_required')
  await reopened.executeAttempt(attempt(reopened, 'node-a', { attempt: 2, confirmNewAttempt: true }), async context => {
    calls += 1
    return terminal(context, 'child-a2', 'native-a2')
  })
  assert.equal(calls, 1)
  const snapshot = (await createJournal(store).open(RUN_ID)).getSnapshot()
  assert.deepEqual(snapshot.events.filter(event => event.type === 'attempt-started').map(event => event.attempt), [1, 2])
})

test('startup recovery preserves done and unknown nodes, interrupts active siblings, and never reruns', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['done-node', 'unknown-node', 'active-node'])
  await handle.executeAttempt(attempt(handle, 'done-node'), async context => terminal(context, 'child-done', 'native-done'))
  await handle.executeAttempt(attempt(handle, 'unknown-node'), async () => ({ status: 'unknown', terminalSource: 'unknown' }))
  const activeStart = handle.executeAttempt(attempt(handle, 'active-node', { confirmResume: true }), () => new Promise(() => {}))
  await new Promise(resolve => setImmediate(resolve))
  const recovery = await createJournal(store).recoverInterruptedRuns()
  const recovered = recovery.recovered
  assert.equal(recovered.length, 1)
  const snapshot = recovered[0]
  assert.equal(snapshot.status, 'interrupted')
  assert.equal(snapshot.nodes['done-node'].status, 'done')
  assert.equal(snapshot.nodes['unknown-node'].status, 'unknown')
  assert.equal(snapshot.nodes['active-node'].status, 'interrupted')
  assert.equal(snapshot.nodes['active-node'].attempt, 1)
  let calls = 0
  const reopened = await createJournal(store).open(RUN_ID)
  await assert.rejects(reopened.executeAttempt(attempt(reopened, 'active-node'), async () => { calls += 1 }), error => error.code === 'attempt_sequence_mismatch')
  assert.equal(calls, 0)
  assert.equal(typeof activeStart.then, 'function')
})

test('startup marks unstarted work interrupted and requires explicit resume', async () => {
  const store = createCasStore()
  await createRun(createJournal(store), ['pending-agent'])
  const recovery = await createJournal(store).recoverInterruptedRuns()
  assert.equal(recovery.recovered[0].nodes['pending-agent'].attempt, 0)
  const reopened = await createJournal(store).open(RUN_ID)
  let calls = 0
  await assert.rejects(reopened.executeAttempt(attempt(reopened, 'pending-agent'), async context => {
    calls += 1
    return terminal(context, 'child', 'native')
  }), error => error.code === 'resume_confirmation_required')
  await reopened.executeAttempt(attempt(reopened, 'pending-agent', { confirmResume: true }), async context => {
    calls += 1
    return terminal(context, 'child', 'native')
  })
  assert.equal(calls, 1)
})

test('unsupported workflow node kinds cannot be reported as native subagent completions', async () => {
  const store = createCasStore()
  const document = documentWith('literal-node')
  document.nodes[0] = { id: 'literal-node', kind: 'input', title: 'Literal input', instruction: '' }
  const journal = createJournal(store)
  const handle = await journal.create({
    document,
    requestId: 'request-1', parentAgentId: PARENT, sessionId: 'session-1',
    bindingRevision: 'binding-r7',
  })
  let calls = 0
  await assert.rejects(handle.executeAttempt(attempt(handle, 'literal-node'), async () => { calls += 1 }),
    error => error.code === 'unsupported_node_kind')
  assert.equal(calls, 0)
})

test('recovery leaves non-journal and legacy snapshots untouched and reports them unmanaged', async () => {
  const local = { id: RUN_ID, status: 'running', executionMode: 'local_mock', revision: 3, nodes: {} }
  const legacy = { id: '22222222-2222-4222-8222-222222222222', status: 'interrupted', executionMode: 'native_dsh', revision: 5, nodes: {} }
  const store = createCasStore([local, legacy])
  const beforeLocal = clone(store.rows.get(RUN_ID))
  const beforeLegacy = clone(store.rows.get(legacy.id))
  const result = await createJournal(store).recoverInterruptedRuns()
  assert.deepEqual(result.recovered, [])
  assert.deepEqual(result.unmanaged.map(row => row.reason), [
    'unsupported_journal_or_execution_mode',
    'unsupported_journal_or_execution_mode',
  ])
  assert.deepEqual(store.rows.get(RUN_ID), beforeLocal)
  assert.deepEqual(store.rows.get(legacy.id), beforeLegacy)
  assert.deepEqual(store.writes, [])
})

test('missing terminal proof remains unknown and artifact references remain empty', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => ({
    ...terminal(context, 'guessed-child', 'guessed-native', 'artifact: https://example.invalid/file'),
    terminalSource: 'unknown',
    artifacts: ['https://example.invalid/file'],
  }))
  const node = (await createJournal(store).open(RUN_ID)).getSnapshot().nodes['node-a']
  assert.equal(node.status, 'unknown')
  assert.deepEqual(node.artifacts, [])
  assert.equal(node.artifactSource, 'unknown')
})

test('more than 40 nodes and oversized event history fail without eviction', async () => {
  const store = createCasStore()
  const journal = createJournal(store)
  const tooMany = documentWith(...Array.from({ length: 41 }, (_, index) => `n-${index}`))
  await assert.rejects(journal.create({
    document: tooMany,
    requestId: 'request-1', parentAgentId: PARENT, sessionId: 'session-1',
    bindingRevision: 'binding-r7',
  }))
  assert.equal(store.writes.length, 0)

  const handle = await createRun(journal, ['node-a'])
  await handle.executeAttempt(attempt(handle, 'node-a'), async context => ({
    ...identityOf(context),
    status: 'tool_error', terminalSource: 'tool-runtime', errorCategory: 'TOOL_ERROR', output: 'x'.repeat(2 * 1024 * 1024),
  })).then(
    () => assert.fail('oversized snapshot should fail'),
    error => assert.equal(error.code, 'snapshot_too_large'),
  )
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a', { attempt: 2, confirmNewAttempt: true }), async () => terminal('child-2', 'native-2')),
    error => error.code === 'journal_unavailable_after_store_failure')
  const persisted = store.rows.get(RUN_ID)
  assert.equal(persisted.events.filter(event => event.type === 'attempt-started').length, 1)
})

test('tool error and cancellation evidence is retained without claiming child completion', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['tool-failed', 'cancelled'])
  await handle.executeAttempt(attempt(handle, 'tool-failed'), async context => ({ ...identityOf(context), status: 'tool_error', terminalSource: 'tool-runtime', errorCategory: 'POLICY_DENIED' }))
  await handle.executeAttempt(attempt(handle, 'cancelled', { confirmResume: true }), async context => ({ ...identityOf(context), status: 'tool_cancelled', terminalSource: 'tool-runtime', errorCategory: 'CANCELLED' }))
  const snapshot = (await createJournal(store).open(RUN_ID)).getSnapshot()
  assert.equal(snapshot.nodes['tool-failed'].status, 'unknown')
  assert.equal(snapshot.nodes.cancelled.status, 'unknown')
  assert.ok(snapshot.events.some(event => event.errorCategory === 'POLICY_DENIED'))
  assert.ok(snapshot.events.some(event => event.type === 'tool-error-unverified'))
  assert.ok(snapshot.events.some(event => event.errorCategory === 'CANCELLED'))
})

test('run schema failure leaves no in-memory success fallback', async () => {
  const store = createCasStore()
  const handle = await createRun(createJournal(store), ['node-a'])
  store.failNext(new Error('CAS unavailable'))
  await assert.rejects(handle.executeAttempt(attempt(handle, 'node-a'), async context => terminal(context, 'child-a', 'native-a')), WorkflowRunJournalError)
  assert.equal((await createJournal(store).open(RUN_ID)).getSnapshot().nodes['node-a'].attempt, 0)
})

test('create derives authoritative definition identity and rejects supplied mismatches', async () => {
  const store = createCasStore()
  const journal = createJournal(store)
  const document = documentWith('node-a')
  const input = { document, requestId: 'request', parentAgentId: PARENT, sessionId: 'session', bindingRevision: 'binding' }
  await assert.rejects(journal.create({ ...input, definitionRevision: 'legacy-revision' }), { code: 'definition_revision_mismatch' })
  assert.equal(store.writes.length, 0)
  const expected = createConfirmedWorkflowDefinition(document)
  const handle = await journal.create(input)
  assert.deepEqual(handle.getSnapshot().document, expected.document)
  assert.equal(handle.getSnapshot().definitionRevision, expected.definitionRevision)
  assert.deepEqual(document, documentWith('node-a'))
})

test('create rejects implicit confirmation before schema defaulting', async () => {
  const store = createCasStore()
  const document = documentWith('node-a')
  delete document.confirmed
  await assert.rejects(createJournal(store).create({ document }), { code: 'workflow_not_confirmed' })
  assert.equal(store.writes.length, 0)
})

test('open and recovery reject tampered or legacy native definitions without rewriting them', async t => {
  for (const corruption of ['document', 'digest', 'legacy', 'unconfirmed']) {
    await t.test(corruption, async () => {
      const store = createCasStore()
      await createRun(createJournal(store), ['node-a'])
      const snapshot = store.rows.get(RUN_ID)
      if (corruption === 'document') snapshot.document.nodes[0].instruction = 'tampered'
      if (corruption === 'digest') snapshot.definitionRevision = `sha256:${'0'.repeat(64)}`
      if (corruption === 'legacy') snapshot.definitionRevision = 'definition-h9'
      if (corruption === 'unconfirmed') delete snapshot.document.confirmed
      const before = clone(snapshot)
      const writes = store.writes.length
      await assert.rejects(createJournal(store).open(RUN_ID), { code: 'invalid_definition_snapshot' })
      await assert.rejects(createJournal(store).recoverInterruptedRuns(), { code: 'invalid_definition_snapshot' })
      assert.deepEqual(store.rows.get(RUN_ID), before)
      assert.equal(store.writes.length, writes)
    })
  }
})

test('terminal invalid historical definitions are never rewritten by recovery', async () => {
  const store = createCasStore()
  await createRun(createJournal(store), ['node-a'])
  const snapshot = store.rows.get(RUN_ID)
  snapshot.status = 'done'
  snapshot.definitionRevision = 'historical-unverified'
  const before = clone(snapshot)
  const writes = store.writes.length
  assert.deepEqual(await createJournal(store).recoverInterruptedRuns(), { recovered: [], unmanaged: [] })
  assert.deepEqual(store.rows.get(RUN_ID), before)
  assert.equal(store.writes.length, writes)
  await assert.rejects(createJournal(store).open(RUN_ID), { code: 'invalid_definition_snapshot' })
})
