import assert from 'node:assert/strict'
import test from 'node:test'
import { ROLE_PRESETS } from '../roles.js'
import { createWorkflowNativeBindingResolver } from '../workflow-native-binding.js'

function fixture(overrides = {}) {
  const parent = {
    id: 'center-session',
    session: { id: 'center-session' },
  }
  const state = {
    roles: {
      center: {
        sessionId: 'center-session',
        workspaceId: 'center-workspace',
        workspacePath: 'C:\\fixture\\center',
        agentPreset: ROLE_PRESETS.center,
      },
    },
    roleBindingRevisions: { center: '7' },
  }
  const run = {
    id: 'run-1',
    journalSchema: 'tradeloom.native-run-journal/v1',
    executionMode: 'native_dsh',
    status: 'running',
    requestId: 'submission-request-1',
    parentAgentId: parent.id,
    sessionId: parent.session.id,
    bindingRevision: '7',
    definitionRevision: 'sha256:definition-1',
    document: {
      id: 'workflow-1',
      workspaceId: 'center-workspace',
      confirmed: true,
      nodes: [{ id: 'agent-node', kind: 'agent', agent: 'product', instruction: 'Persisted task prompt' }],
    },
    nodes: {
      'agent-node': { status: 'running', attemptState: 'started', attempt: 1, requestId: 'attempt-request-1' },
    },
  }
  const workspace = {
    id: 'center-workspace',
    path: 'C:\\fixture\\center',
    sessionIds: ['center-session'],
  }
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    workspaceRegistry: {
      archivedSessionIds: [],
      get: id => id === workspace.id ? workspace : undefined,
    },
    sessionQuery: {
      async observeSession(id) {
        assert.equal(id, 'center-session')
        return {
          header: { id, cwd: workspace.path },
          projections: { values: { agentPreset: ROLE_PRESETS.center } },
          [Symbol.dispose]() {},
        }
      },
    },
  }
  const data = { parent, state, run, workspace, ctx, ...overrides }
  data.resolve = createWorkflowNativeBindingResolver({
    ctx: data.ctx,
    readState: async () => data.state,
    loadRun: async id => data.loadRun ? data.loadRun(id) : id === data.run?.id ? data.run : undefined,
  })
  data.exec = { agent: data.parent, callId: 'tool-call-1' }
  data.input = {
    workflowRunId: 'run-1',
    nodeId: 'agent-node',
    attempt: 1,
    bindingRevision: '7',
    definitionRevision: 'sha256:definition-1',
  }
  return data
}

function upstreamFixture() {
  const f = fixture()
  f.run.document.nodes.unshift({ id: 'upstream', kind: 'agent', agent: 'product', instruction: 'First task' })
  f.run.document.edges = [{ from: 'upstream', to: 'agent-node' }]
  f.run.nodes.upstream = { status: 'done', attemptState: 'terminal', attempt: 1, requestId: 'upstream-request',
    toolCallId: 'upstream-call', childId: 'upstream-child', nativeRunId: 'upstream-run',
    output: [{ type: 'text', text: 'Persisted upstream text' }], artifactSource: 'unknown', artifacts: [{ path: 'unverified.txt' }] }
  f.run.events = [{ type: 'node-terminal', source: 'subagent/end', status: 'done', stopReason: 'completed',
    workflowRunId: f.run.id, nodeId: 'upstream', attempt: 1, requestId: 'upstream-request', toolCallId: 'upstream-call',
    childId: 'upstream-child', nativeRunId: 'upstream-run', parentAgentId: f.parent.id, sessionId: f.parent.session.id,
    bindingRevision: f.run.bindingRevision, definitionRevision: f.run.definitionRevision, output: f.run.nodes.upstream.output }]
  return f
}
test('downstream prompt uses persisted same-run terminal text only; unverified artifact paths are excluded', async () => {
  const f = upstreamFixture()
  const resolved = await f.resolve(f.input, f.exec)
  assert.equal(resolved.instruction, 'Persisted task prompt')
  assert.ok(resolved.prompt.includes('Persisted upstream text'))
  assert.ok(resolved.prompt.startsWith('Persisted task prompt'))
  assert.ok(!resolved.prompt.includes('unverified.txt'))
})
test('non-done or mismatched terminal predecessor prevents any binding', async () => {
  for (const change of [f => { f.run.nodes.upstream.status = 'pending' }, f => { f.run.events[0].attempt = 2 }, f => { f.run.events[0].workflowRunId = 'another-run' }]) {
    const f = upstreamFixture(); change(f)
    await assert.rejects(f.resolve(f.input, f.exec), { code: 'upstream_terminal_unverified' })
  }
})
test('complete upstream prompt over 64KiB fails instead of truncating', async () => {
  const f = upstreamFixture(); f.run.nodes.upstream.output = 'x'.repeat(65536); f.run.events[0].output = f.run.nodes.upstream.output
  await assert.rejects(f.resolve(f.input, f.exec), { code: 'native_prompt_too_large' })
})
test('only validated activation-scoped artifact references join prompt, never file bytes', async () => {
  const f = upstreamFixture()
  Object.defineProperty(f.ctx, 'fs', { get() { assert.fail('must not open upstream files') } })
  const range = { childSessionId: 'upstream-child', nativeRunId: 'upstream-run', startInclusive: 10 }
  const evidence = { schema: 'tradeloom.presented-evidence/v1', range: { ...range, endExclusive: 13 },
    declarations: [{ sourceSessionSeq: 11, fileIndex: 0, presentCallId: 'present-1', sourceTurn: 1, path: 'C:/owned-fixture/result.md' }] }
  Object.assign(f.run.nodes.upstream, { artifactRangeStart: range, artifactEvidence: evidence, artifactSource: 'deliverables/presented', artifacts: evidence.declarations })
  f.run.events[0].artifactEvidence = evidence
  assert.ok((await f.resolve(f.input, f.exec)).prompt.includes('C:/owned-fixture/result.md'))
  f.run.events[0].artifactEvidence = { ...evidence, range: { ...evidence.range, nativeRunId: 'stale-activation' } }
  assert.ok(!(await f.resolve(f.input, f.exec)).prompt.includes('C:/owned-fixture/result.md'))
})
test('binding rejects center revision or saved definition changed across loader await', async () => {
  for (const kind of ['binding', 'definition']) {
    const f = fixture()
    f.loadRun = async () => {
      if (kind === 'binding') f.state.roleBindingRevisions.center = '8'
      else f.run.definitionRevision = 'sha256:new-definition'
      return f.run
    }
    await assert.rejects(f.resolve(f.input, f.exec), { code: kind === 'binding' ? 'center_binding_mismatch' : 'run_unavailable_or_stale' })
  }
})
test('same-revision workspace tuple changes while loading cannot authorize a child', async () => {
  const f = fixture()
  f.loadRun = async () => { f.state.roles.center.workspaceId = 'different-workspace'; return f.run }
  await assert.rejects(f.resolve(f.input, f.exec), { code: 'parent_workspace_mismatch' })
})
test('non-text upstream blocks are rejected rather than silently discarded or read as files', async () => {
  const f = upstreamFixture(); f.run.nodes.upstream.output = [{ type: 'image', path: 'not-opened.png' }]
  f.run.events[0].output = f.run.nodes.upstream.output
  await assert.rejects(f.resolve(f.input, f.exec), { code: 'upstream_output_unavailable' })
})
test('persisted model selection is passed as trusted provider/model pair only', async () => {
  const f = fixture(); f.run.document.nodes[0].model = { provider: 'reviewed-provider', model: 'reviewed-model' }
  assert.deepEqual((await f.resolve(f.input, f.exec)).modelRequest, { provider: 'reviewed-provider', model: 'reviewed-model' })
})

test('resolves only a confirmed persisted active node bound to the exact live center parent', async () => {
  const f = fixture()
  const value = await f.resolve(f.input, f.exec)
  assert.deepEqual(value, {
    authorized: true,
    requestId: 'attempt-request-1',
    agentId: 'center-session',
    sessionId: 'center-session',
    workflowRunId: 'run-1',
    nodeId: 'agent-node',
    attempt: 1,
    bindingRevision: '7',
    definitionRevision: 'sha256:definition-1',
    prompt: 'Persisted task prompt',
    agentPreset: ROLE_PRESETS.product,
  })
})

test('rejects missing or non-journal run authority', async () => {
  const missing = fixture()
  missing.run = undefined
  await assert.rejects(missing.resolve(missing.input, missing.exec), { code: 'run_unavailable_or_stale' })

  const wrongSchema = fixture()
  wrongSchema.run.journalSchema = 'fixture-only'
  await assert.rejects(wrongSchema.resolve(wrongSchema.input, wrongSchema.exec), { code: 'run_unavailable_or_stale' })
})

test('rejects replacement Agent objects, non-center callers, or a different bound session', async () => {
  const unregistered = fixture()
  unregistered.exec.agent = { ...unregistered.parent }
  await assert.rejects(unregistered.resolve(unregistered.input, unregistered.exec), { code: 'untrusted_parent' })

  const otherRole = fixture()
  otherRole.run.parentAgentId = 'product-session'
  await assert.rejects(otherRole.resolve(otherRole.input, otherRole.exec), { code: 'run_parent_mismatch' })

  const otherSession = fixture()
  otherSession.state.roles.center.sessionId = 'other-session'
  await assert.rejects(otherSession.resolve(otherSession.input, otherSession.exec), { code: 'center_binding_mismatch' })
})

test('rejects archived or unverifiable archive state and mismatched workspace ownership', async () => {
  const archived = fixture()
  archived.ctx.workspaceRegistry.archivedSessionIds.push('center-session')
  await assert.rejects(archived.resolve(archived.input, archived.exec), { code: 'parent_session_archived_or_archive_state_unknown' })

  const unknownArchive = fixture()
  unknownArchive.ctx.workspaceRegistry.archivedSessionIds = undefined
  await assert.rejects(unknownArchive.resolve(unknownArchive.input, unknownArchive.exec), { code: 'parent_session_archived_or_archive_state_unknown' })

  const wrongWorkspace = fixture()
  wrongWorkspace.workspace.sessionIds = []
  await assert.rejects(wrongWorkspace.resolve(wrongWorkspace.input, wrongWorkspace.exec), { code: 'parent_workspace_mismatch' })
})

test('checks both authoritative revisions independently', async () => {
  const staleBinding = fixture()
  staleBinding.state.roleBindingRevisions.center = '8'
  await assert.rejects(staleBinding.resolve(staleBinding.input, staleBinding.exec), { code: 'center_binding_mismatch' })

  const staleDefinition = fixture()
  staleDefinition.input.definitionRevision = 'sha256:other'
  await assert.rejects(staleDefinition.resolve(staleDefinition.input, staleDefinition.exec), { code: 'run_unavailable_or_stale' })
})

test('rejects caller-supplied authorization, prompt, preset, or request identity fields', async () => {
  const f = fixture()
  for (const field of ['requestId', 'agentId', 'sessionId', 'prompt', 'agentPreset', 'role']) {
    await assert.rejects(f.resolve({ ...f.input, [field]: 'forged' }, f.exec), { code: 'invalid_input' })
  }
})

test('uses persisted attempt requestId and node prompt, never ToolRunContext.callId as authority', async () => {
  const f = fixture()
  f.exec.callId = 'host-tool-call-distinct-from-submission'
  const value = await f.resolve(f.input, f.exec)
  assert.equal(value.requestId, f.run.nodes['agent-node'].requestId)
  assert.notEqual(value.requestId, f.run.requestId)
  assert.notEqual(value.requestId, f.exec.callId)
  assert.equal(value.prompt, f.run.document.nodes[0].instruction)
})

test('rejects a started node without persisted attempt request identity', async () => {
  const f = fixture()
  f.run.nodes['agent-node'].requestId = ''
  await assert.rejects(f.resolve(f.input, f.exec), { code: 'run_node_request_unavailable' })
})

for (const role of ['product', 'market', 'quote', 'delivery', 'user-profile']) {
  test(`derives child preset only from persisted ${role} role`, async () => {
    const f = fixture()
    f.run.document.nodes[0].agent = role
    assert.equal((await f.resolve(f.input, f.exec)).agentPreset, ROLE_PRESETS[role])
  })
}
for (const role of ['center', 'unknown', undefined, 'toString']) {
  test(`rejects disallowed persisted child role ${role}`, async () => {
    const f = fixture()
    f.run.document.nodes[0].agent = role
    await assert.rejects(f.resolve(f.input, f.exec), { code: 'run_node_role_not_allowed' })
  })
}
