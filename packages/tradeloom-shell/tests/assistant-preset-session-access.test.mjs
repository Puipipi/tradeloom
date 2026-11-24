import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAssistantPresetSessionAccessHandler } from '../host.js'

function sessionId(presetId) {
  return `tl-assistant-${createHash('sha256').update(`tradeloom:assistant:${presetId}`).digest('hex').slice(0, 28)}`
}

function harness({ presetId = 'qa-custom', archived = false } = {}) {
  const id = sessionId(presetId), workspace = { id: 'qa-workspace', path: 'C:/qa/tradeloom' }
  const attached = { ...workspace, sessionIds: [id] }
  if (archived) attached.sessionIds = []
  const persistence = {
    identity: 'qa-persistence',
    async flush() {},
    async stat(target) { return target === id ? { header: { id, cwd: workspace.path, agentPreset: presetId, createdAt: 42 } } : undefined },
  }
  const ctx = {
    connection: { requestRejection: () => undefined },
    get(key) { return key === 'sessionPersistence' ? persistence : undefined },
    agents: { get: () => undefined },
    workspaceRegistry: {
      list: () => [workspace], get: target => target === workspace.id ? attached : undefined,
      archivedSessionIds: archived ? [id] : [],
    },
  }
  const handler = createAssistantPresetSessionAccessHandler(ctx, {
    getAgentPresets: () => ({ list: async () => [{ id: presetId }] }),
    resolveOwnedHome: async () => {},
    roleWorkspacePath: async () => workspace.path,
  })
  return { handler, id }
}

async function request(handler, value) {
  const req = Readable.from([Buffer.from(JSON.stringify(value))])
  req.method = 'POST'
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body = '') { this.body = body },
  }
  await handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

test('assistant preset access confirms only the durable session belonging to an available preset', async () => {
  const { handler, id } = harness()
  const explicit = await request(handler, { presetId: 'qa-custom', sessionId: id })
  assert.equal(explicit.status, 200)
  assert.deepEqual(explicit.body.summary, { sessionId: id, updatedAt: 42, agentAvailable: false, running: false, blank: false })
  assert.deepEqual(await request(handler, { sessionId: id }), explicit, 'renderer receives the same single-session projection without needing a preset id')
  assert.equal((await request(handler, { presetId: 'invented', sessionId: id })).status, 403)
  assert.equal((await request(handler, { presetId: 'qa-custom', sessionId: 'invented-session' })).status, 403)
  assert.equal((await request(handler, { presetId: 'qa-custom', sessionId: id, workspacePath: 'C:/elsewhere' })).status, 400)
})

test('assistant preset access refuses archived sessions', async () => {
  const { handler, id } = harness({ archived: true })
  assert.deepEqual(await request(handler, { presetId: 'qa-custom', sessionId: id }), { status: 403, body: { authorized: false } })
})
