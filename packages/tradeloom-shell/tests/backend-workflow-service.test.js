import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createWorkflowRunner, createWorkflowStore } from '../workflow-engine.js'
import { validateWorkflow, workflowCatalog, WorkflowValidationError } from '../workflow-schema.js'
import { createWorkflowHandler, createWorkflowService, registerWorkflowTools } from '../workflow-tools.js'

function sample(overrides = {}) {
  return {
    version: 1, id: 'demo', title: '演示',
    nodes: [
      { id: 'in', kind: 'input', title: '资料' },
      { id: 'a', kind: 'agent', agent: 'product', title: '整理' },
      { id: 'b', kind: 'external', platform: '免费网页模型', title: '初译' },
      { id: 'check', kind: 'review', title: '核对' },
      { id: 'out', kind: 'output', title: '目录' },
    ],
    edges: [{ from: 'in', to: 'a' }, { from: 'in', to: 'b' }, { from: 'a', to: 'check' }, { from: 'b', to: 'check' }, { from: 'check', to: 'out' }],
    ...overrides,
  }
}

const centerExec = { agent: { session: { header: { agentPreset: 'tradeloom-center' } } } }
const OWNED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../recovery/backend-export-closure-20261031/workflow-behavior')
const OWNED_MARKER = 'owner=backend-export-closure-20261031/workflow-behavior'

async function verifiedOwnedRoot() {
  const root = await realpath(OWNED_ROOT)
  const marker = await readFile(join(root, 'OWNER.txt'), 'utf8')
  if (!marker.includes(OWNED_MARKER)) throw new Error('workflow test root ownership marker mismatch')
  return root
}

function assertOwnedChild(root, child) {
  const rel = relative(root, child)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('workflow test cleanup target escaped owned root')
  }
}

async function createOwnedTemp(prefix) {
  const root = await verifiedOwnedRoot()
  const child = await mkdtemp(join(root, prefix))
  const resolvedChild = await realpath(child)
  assertOwnedChild(root, resolvedChild)
  return {
    dir: resolvedChild,
    async cleanup() {
      const currentRoot = await verifiedOwnedRoot()
      if (currentRoot !== root) throw new Error('workflow test root identity changed')
      const currentChild = await realpath(resolvedChild)
      if (currentChild !== resolvedChild) throw new Error('workflow test cleanup target changed')
      assertOwnedChild(root, currentChild)
      await rm(currentChild, { recursive: true })
    },
  }
}

const waitFor = async (predicate, timeout = 2000) => {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function call(handler, method, body, query = '') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  Object.assign(req, { method, url: `/tradeloom/workflows${query}` })
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(text) { this.body = text } }
  await handler(req, res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

async function withService(fn) {
  const owned = await createOwnedTemp('tl-wf-')
  try {
    const dir = owned.dir
    const service = createWorkflowService({ dir, runnerOptions: { delayMs: 1 } })
    await fn(service, dir)
  } finally { await owned.cleanup() }
}

test('host route saves, lists, gates agent drafts on confirmation, and runs', async () => withService(async (service, dir) => {
  const ctx = { connection: { requestRejection: () => undefined } }
  const handler = createWorkflowHandler(ctx, service)
  assert.equal((await call(handler, 'POST', { action: 'save', workflow: { ...sample(), title: '' } })).status, 400)
  const saved = await call(handler, 'POST', { action: 'save', workflow: sample({ source: 'agent' }) })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.workflow.confirmed, false)
  // This branch persists a versioned envelope while keeping the public save result as a legacy document.
  const stored = JSON.parse(await readFile(join(dir, 'demo.json'), 'utf8'))
  assert.equal(stored.formatVersion, 1)
  assert.equal(stored.revision, 1)
  assert.equal(stored.deleted, false)
  assert.equal(stored.document.id, 'demo')
  assert.equal(stored.definitionRevision, null)
  // 画布会把服务端返回的 updatedAt 原样回传，再次保存不能因此失败
  const resaved = await call(handler, 'POST', { action: 'save', workflow: saved.body.workflow })
  assert.equal(resaved.status, 200, JSON.stringify(resaved.body))
  const listed = await call(handler, 'GET')
  assert.equal(listed.body.workflows[0].id, 'demo')
  assert.ok(listed.body.catalog.agents.length >= 6)
  assert.deepEqual((await call(handler, 'POST', { action: 'run', id: 'demo' })).body, { error: 'workflow_not_confirmed' })
  assert.equal((await call(handler, 'POST', { action: 'confirm', id: 'demo' })).body.workflow.confirmed, true)
  const started = await call(handler, 'POST', { action: 'run', id: 'demo' })
  assert.equal(started.status, 200)
  await waitFor(() => service.runner.get(started.body.run.id).nodes.check.status === 'waiting')
  const decided = await call(handler, 'POST', { action: 'decide', run: started.body.run.id, node: 'check', approved: true })
  assert.equal(decided.status, 200)
  await service.runner.settle(started.body.run.id)
  const read = await call(handler, 'GET', null, '?id=demo')
  assert.equal(read.body.run.status, 'done')
  assert.equal((await call(handler, 'GET', null, '?id=../x')).status, 400)
  assert.equal((await call(handler, 'POST', { action: 'delete', id: 'demo' })).status, 200)
  assert.equal((await call(handler, 'GET', null, '?id=demo')).status, 404)
}))

test('center tools propose unconfirmed drafts, return issues, and refuse to run drafts', async () => withService(async service => {
  const registered = new Map()
  registerWorkflowTools({ tools: { register: tool => { registered.set(tool.name, tool); return () => {} } } }, service, { preset: 'tradeloom-center' })
  assert.deepEqual([...registered.keys()], ['tradeloom_wf_propose', 'tradeloom_wf_read', 'tradeloom_wf_run'])
  // DSH 组装 agent 时要求 output 同时有 schema 与 render
  for (const tool of registered.values()) assert.equal(typeof tool.output.render, 'function', `${tool.name} declares output.render`)
  const bad = await registered.get('tradeloom_wf_propose').execute({ workflow: { version: 1 } }, centerExec)
  assert.equal(bad.error_code, 'invalid_workflow')
  assert.ok(JSON.parse(bad.data).issues.length > 0)
  const proposed = await registered.get('tradeloom_wf_propose').execute({ workflow: sample({ confirmed: true }) }, centerExec)
  assert.equal(proposed.ok, true)
  assert.equal(JSON.parse(proposed.data).requires_human_confirmation, true)
  assert.equal((await service.get('demo')).confirmed, false, 'agents cannot self-confirm')
  assert.equal((await registered.get('tradeloom_wf_run').execute({ id: 'demo' }, centerExec)).error_code, 'workflow_not_confirmed')
  const listed = JSON.parse((await registered.get('tradeloom_wf_read').execute({}, centerExec)).data)
  assert.equal(listed.workflows[0].id, 'demo')
}))

test('workflow tools are center scoped and reject execution from experts or unknown roles', async () => withService(async service => {
  const registered = []
  const ctx = { tools: { register: tool => { registered.push(tool); return () => {} } } }
  for (const preset of [undefined, 'tradeloom-product', 'tradeloom-delivery']) registerWorkflowTools(ctx, service, { preset })
  assert.equal(registered.length, 0)
  registerWorkflowTools(ctx, service, { preset: 'tradeloom-center' })
  for (const tool of registered) {
    for (const exec of [undefined, { agent: { session: { header: { agentPreset: 'tradeloom-product' } } } }]) {
      assert.equal((await tool.execute({}, exec)).error_code, 'role_not_authorized')
    }
  }
}))

test('planner skill installation uses the supplied isolated workspace', async () => {
  const { installPlannerSkill } = await import('../workflow-tools.js')
  const owned = await createOwnedTemp('tl-wf-skill-')
  try {
    const workspace = owned.dir
    await installPlannerSkill(async () => workspace)
    const text = await readFile(join(workspace, '.dsh', 'skills', 'wf-planner', 'SKILL.md'), 'utf8')
    assert.match(text, /tradeloom_wf_propose/)
    assert.match(text, /30/)
  } finally { await owned.cleanup() }
})
