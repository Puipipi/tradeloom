import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
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

const waitFor = async (predicate, timeout = 2000) => {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('schema normalizes a valid wf and lays out nodes without positions', () => {
  const doc = validateWorkflow(sample())
  assert.equal(doc.source, 'manual')
  assert.equal(doc.confirmed, true)
  assert.deepEqual(doc.nodes.find(node => node.id === 'a').model, null)
  assert.deepEqual(doc.nodes.map(node => node.position.x), [40, 280, 280, 520, 760], 'columns follow dependency depth')
  assert.equal(validateWorkflow(sample({ source: 'agent' })).confirmed, false, 'agent drafts default to unconfirmed')
})

test('schema reports every issue at once, including cycles', () => {
  let error
  try {
    validateWorkflow({
      version: 1, id: 'Bad Id', title: '', extra: 1,
      nodes: [{ id: 'x', kind: 'agent', agent: 'nobody', title: 'x' }, { id: 'x', kind: 'external', title: 'y' }],
      edges: [{ from: 'x', to: 'missing' }],
    })
  } catch (caught) { error = caught }
  assert.ok(error instanceof WorkflowValidationError)
  const issues = error.issues.join('\n')
  for (const part of ['unknown field "extra"', 'id must match', 'title is required', 'agent must be one of', 'duplicated', 'platform is required', '"missing" is not a node id']) {
    assert.match(issues, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const cyclic = sample({ edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })
  assert.throws(() => validateWorkflow(cyclic), /cycle/)
  assert.throws(() => validateWorkflow(sample({ nodes: [{ id: 'r', kind: 'review', title: 'r', model: { provider: 'p', model: 'm' } }], edges: [] })), /only allowed on agent/)
})

test('catalog gives every kind and role an icon and colour', () => {
  const catalog = workflowCatalog()
  assert.deepEqual(catalog.kinds.map(item => item.kind), ['input', 'agent', 'review', 'external', 'output'])
  assert.ok([...catalog.kinds, ...catalog.agents].every(item => item.icon && /^#[0-9a-f]{6}$/.test(item.color)))
  assert.ok(catalog.agents.some(item => item.id === 'center' && item.label === '中心'))
})

test('runner runs independent nodes in parallel, waits on review, and finishes', async () => {
  const started = []
  const runner = createWorkflowRunner({ delayMs: 1, executors: { agent: async node => { started.push(node.id); return 'ok' } } })
  const run = runner.start(sample())
  await waitFor(() => runner.get(run.id).nodes.check.status === 'waiting')
  let snapshot = runner.get(run.id)
  assert.equal(snapshot.status, 'waiting')
  assert.equal(snapshot.nodes.a.status, 'done')
  assert.equal(snapshot.nodes.b.status, 'done')
  assert.equal(snapshot.nodes.out.status, 'pending')
  assert.deepEqual(started, ['a'])
  assert.equal(runner.decide(run.id, 'check', { approved: true, note: '没问题' }), true)
  await runner.settle(run.id)
  snapshot = runner.get(run.id)
  assert.equal(snapshot.status, 'done')
  // 审核节点把被审核的上游内容和确认意见一起传给下游
  assert.equal(snapshot.nodes.check.output, `${snapshot.nodes.a.output}\n${snapshot.nodes.b.output}\n【人工确认】没问题`)
  assert.equal(snapshot.nodes.out.output, snapshot.nodes.check.output, 'output collects its upstream results')
  assert.equal(snapshot.nodes.a.output, 'ok')
  assert.equal(runner.latestFor('demo').id, run.id)
})

test('rejected review fails the node and skips everything downstream', async () => {
  const runner = createWorkflowRunner({ delayMs: 1 })
  const run = runner.start(sample())
  await waitFor(() => runner.get(run.id).nodes.check.status === 'waiting')
  runner.decide(run.id, 'check', { approved: false, note: '英文名不对' })
  await runner.settle(run.id)
  const snapshot = runner.get(run.id)
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.nodes.check.error, '英文名不对')
  assert.equal(snapshot.nodes.out.status, 'skipped')
})

test('executor errors fail the node; cancel stops a run', async () => {
  const runner = createWorkflowRunner({ delayMs: 1, executors: { agent: async () => { throw new Error('模型不可用') } } })
  const failed = runner.start(sample())
  await runner.settle(failed.id).catch(() => {})
  await waitFor(() => runner.get(failed.id).nodes.b.status === 'done')
  const cancelled = runner.start(sample({ id: 'other' }))
  assert.equal(runner.cancel(cancelled.id), true)
  await runner.settle(cancelled.id)
  assert.equal(runner.get(cancelled.id).status, 'cancelled')
  const snapshot = runner.get(failed.id)
  assert.equal(snapshot.nodes.a.error, '模型不可用')
  assert.equal(snapshot.nodes.check.status, 'skipped')
})

async function call(handler, method, body, query = '') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  Object.assign(req, { method, url: `/tradeloom/workflows${query}` })
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(text) { this.body = text } }
  await handler(req, res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

async function withService(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tl-wf-'))
  try {
    const service = createWorkflowService({ dir, runnerOptions: { delayMs: 1 } })
    await fn(service, dir)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('host route saves, lists, gates agent drafts on confirmation, and runs', async () => withService(async (service, dir) => {
  const ctx = { connection: { requestRejection: () => undefined } }
  const handler = createWorkflowHandler(ctx, service)
  assert.equal((await call(handler, 'POST', { action: 'save', workflow: { ...sample(), title: '' } })).status, 400)
  const saved = await call(handler, 'POST', { action: 'save', workflow: sample({ source: 'agent' }) })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.workflow.confirmed, false)
  assert.equal(JSON.parse(await readFile(join(dir, 'demo.json'), 'utf8')).id, 'demo')
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

test('host route honours connection rejection', async () => withService(async service => {
  const handler = createWorkflowHandler({ connection: { requestRejection: () => 403 } }, service)
  assert.equal((await call(handler, 'GET')).status, 403)
}))

test('center tools propose unconfirmed drafts, return issues, and refuse to run drafts', async () => withService(async service => {
  const registered = new Map()
  registerWorkflowTools({ tools: { register: tool => { registered.set(tool.name, tool); return () => {} } } }, service)
  assert.deepEqual([...registered.keys()], ['tradeloom_wf_propose', 'tradeloom_wf_read', 'tradeloom_wf_run'])
  // DSH 组装 agent 时要求 output 同时有 schema 与 render
  for (const tool of registered.values()) assert.equal(typeof tool.output.render, 'function', `${tool.name} declares output.render`)
  const bad = await registered.get('tradeloom_wf_propose').execute({ workflow: { version: 1 } })
  assert.equal(bad.error_code, 'invalid_workflow')
  assert.ok(JSON.parse(bad.data).issues.length > 0)
  const proposed = await registered.get('tradeloom_wf_propose').execute({ workflow: sample({ confirmed: true }) })
  assert.equal(proposed.ok, true)
  assert.equal(JSON.parse(proposed.data).requires_human_confirmation, true)
  assert.equal((await service.get('demo')).confirmed, false, 'agents cannot self-confirm')
  assert.equal((await registered.get('tradeloom_wf_run').execute({ id: 'demo' })).error_code, 'workflow_not_confirmed')
  const listed = JSON.parse((await registered.get('tradeloom_wf_read').execute({})).data)
  assert.equal(listed.workflows[0].id, 'demo')
}))

test('store skips corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tl-wf-'))
  try {
    const store = createWorkflowStore(dir)
    await store.save(sample())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'broken.json'), '{', 'utf8')
    assert.deepEqual((await store.list()).map(item => item.id), ['demo'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('canvas chunk renders status classes, agent icons and model names', { skip: !process.env.TRADELOOM_REACT_SERVER_LIBRARY }, async () => {
  const { createRequire } = await import('node:module')
  const pinned = createRequire(process.env.TRADELOOM_REACT_SERVER_LIBRARY)
  const React = pinned('react')
  const { renderToStaticMarkup } = pinned('react-dom/server')
  let registration
  runInNewContext(await readFile(new URL('../client.workflow.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { registration = value } } } })
  assert.equal(registration.chunk, 'client.workflow.js')
  const { WorkflowCanvas } = registration.factory(name => { assert.equal(name, 'react'); return React })
  const doc = validateWorkflow(sample({ nodes: sample().nodes.map(node => node.id === 'a' ? { ...node, model: { provider: 'ds', model: 'flash' } } : node) }))
  const run = { id: 'r', status: 'running', finishedAt: null, nodes: { in: { status: 'done' }, a: { status: 'running' }, b: { status: 'failed', error: 'x' }, check: { status: 'pending' }, out: { status: 'pending' } } }
  const modelGroups = [{ provider: 'ds', providerName: 'DeepSeek', models: [{ provider: 'ds', providerName: 'DeepSeek', id: 'flash', name: 'Flash' }] }]
  const html = renderToStaticMarkup(React.createElement(WorkflowCanvas, { modelGroups, initial: { catalog: workflowCatalog(), list: [{ id: 'demo', title: '演示', confirmed: true }], doc, run, selected: 'a' } }))
  assert.match(html, /tl-wf-node is-done/)
  assert.match(html, /tl-wf-node is-running is-selected/)
  assert.match(html, /tl-wf-node is-failed/)
  assert.match(html, /商品专家 · Flash/)
  assert.match(html, /▦/, 'product agent icon is shown')
  assert.match(html, /运行：运行中/)
  assert.match(html, /<optgroup label="DeepSeek">/)
  assert.match(html, />停止</, 'a running wf offers stop instead of run')

  // 审核等待：节点旁出现绿通过/红驳回，检查面板展示待审核的上游内容
  const waitingRun = { ...run, status: 'waiting', nodes: { ...run.nodes, a: { status: 'done', output: '商品资料草稿' }, b: { status: 'done', output: '译文' }, check: { status: 'waiting' } } }
  const waitingHtml = renderToStaticMarkup(React.createElement(WorkflowCanvas, { modelGroups, initial: { catalog: workflowCatalog(), list: [], doc, run: waitingRun, selected: 'check' } }))
  assert.match(waitingHtml, /tl-wf-quick-btn is-approve/)
  assert.match(waitingHtml, /tl-wf-quick-btn is-reject/)
  assert.match(waitingHtml, /待审核内容/)
  assert.match(waitingHtml, /商品资料草稿/)
})
