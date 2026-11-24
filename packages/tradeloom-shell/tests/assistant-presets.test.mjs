import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createAssistantPresetsHandler } from '../host.js'
import { ROLE_PRESETS } from '../roles.js'

function fixture() {
  const rows = [
    { id: 'tradeloom-product', name: '商品专家' },
    { id: 'cordis' },
    { id: 'minimal' },
    { id: 'ptc' },
    { id: 'standard' },
    { id: 'cordis-custom', name: 'Cordis', description: 'Custom assistant with a built-in-looking ID prefix and display name' },
    { id: 'standard-review', name: 'Standard', description: 'Custom assistant sharing a built-in display name' },
    { id: 'qa-review-bot', name: 'QA Review', description: 'Harmless fixture assistant' },
    { id: 'broken-helper', name: 'Broken', broken: 'fixture unavailable' },
  ]
  const workspace = { id: 'workspace-fixture', path: 'C:/fixture/tradeloom', sessionIds: [] }
  const sessions = new Map()
  const created = []
  const ctx = {
    connection: { requestRejection: () => undefined },
    logger: { error() {} },
    get(name) { return name === 'agentPresets' ? { async list() { return rows } } : undefined },
    workspaceRegistry: {
      list: () => [workspace], get: id => id === workspace.id ? workspace : undefined,
      async create() { return workspace }, get archivedSessionIds() { return [] },
    },
    agents: { get: id => sessions.get(id) },
    getService: undefined,
    sessionController: { async create(request) {
      created.push(request)
      if (!sessions.has(request.sessionId)) {
        workspace.sessionIds.push(request.sessionId)
        sessions.set(request.sessionId, { id: request.sessionId, session: { id: request.sessionId }, ctx: { get: name => name === 'sessionPersistence' ? persistence : undefined } })
      }
      return { sessionId: request.sessionId }
    } },
  }
  const persistence = { identity: {}, async flush() {}, async stat(id) { return { header: { id, cwd: workspace.path, agentPreset: 'qa-review-bot' } } } }
  ctx.get = name => name === 'agentPresets' ? { async list() { return rows } } : name === 'sessionPersistence' ? persistence : undefined
  const handler = createAssistantPresetsHandler(ctx, {
    resolveOwnedHome: async () => undefined,
    roleWorkspacePath: async () => workspace.path,
  })
  async function request(method, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method
    let response
    const res = { statusCode: 200, setHeader() {}, end(value) { response = value ? JSON.parse(value) : undefined } }
    await handler(req, res)
    return { status: res.statusCode, body: response }
  }
  return { request, rows, created, sessions }
}

test('catalog excludes exact DSH operation modes and TradeLoom roles while retaining custom matching names', async () => {
  const f = fixture()
  const result = await f.request('GET')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.presets, [
    { id: 'cordis-custom', name: 'Cordis', description: 'Custom assistant with a built-in-looking ID prefix and display name' },
    { id: 'standard-review', name: 'Standard', description: 'Custom assistant sharing a built-in display name' },
    { id: 'qa-review-bot', name: 'QA Review', description: 'Harmless fixture assistant' },
  ])
  assert.deepEqual(result.body.presets.map(row => row.id).filter(id => ['cordis', 'minimal', 'ptc', 'standard'].includes(id)), [])
  assert.ok(Object.values(ROLE_PRESETS).includes('tradeloom-product'))
  assert.equal(f.created.length, 0)
})

test('uninvented preset is rejected; catalog-listed preset creates a reusable native session without a scene binding', async () => {
  const f = fixture()
  assert.equal((await f.request('POST', { presetId: 'invented-id' })).status, 404)
  assert.equal(f.created.length, 0)
  const [first, second] = await Promise.all([
    f.request('POST', { presetId: 'qa-review-bot' }),
    f.request('POST', { presetId: 'qa-review-bot' }),
  ])
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.equal(first.status, 200)
  assert.deepEqual(second.body, first.body)
  assert.equal(first.body.bindingRevision, '0')
  assert.match(first.body.sessionId, /^tl-assistant-[a-f0-9]{28}$/)
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].agentPreset, 'qa-review-bot')
  assert.equal(f.created[0].sessionId, first.body.sessionId)
  assert.equal(f.sessions.size, 1)
})

test('a named custom declaration using a shipped preset ID retains its own identity', async () => {
  const f = fixture()
  f.rows.find(row => row.id === 'minimal').name = '极简审核助手'
  const result = await f.request('GET')
  assert.ok(result.body.presets.some(row => row.id === 'minimal' && row.name === '极简审核助手'))
})
