import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ROLE_IDS } from '../state.js'
import { createScenesHandler } from '../host.js'
import { defaultSceneWorkbench } from '../scene-layout.js'
import { normalizeDockLayouts } from '../dock-layout.js'
import { pathToFileURL } from 'node:url'
import { publicRoleMetadata } from '../roles.js'

const sceneConfigUrl = new URL('../scenes.json', import.meta.url)
const sceneChunkUrl = new URL('../client.scenes.js', import.meta.url)

async function readClientSceneConfig() {
  return { ...JSON.parse(await readFile(sceneConfigUrl, 'utf8')), roles: publicRoleMetadata() }
}

test('scene JSON defines role-bound 4x4 grids and maps all known business routes', async () => {
  const config = await readClientSceneConfig()
  const { validateSceneConfig, normalizeSceneWorkbench } = await import('../scene-layout.js')
  assert.strictEqual(validateSceneConfig(config), config)
  assert.equal(config.version, 1)
  assert.deepEqual(config.grid, { cols: 4, rows: 4 })
  assert.deepEqual(config.scenes.map(scene => [scene.id, scene.label, scene.roleId]), [
    ['center', '工作总览', 'center'],
    ['products', '商品', 'product'],
    ['agent-center', '任务', 'center'],
    ['deliverables', '交付物', 'delivery'],
    ['runs', '运行记录', 'center'],
    ['user-profile', '资料整理', 'user-profile'],
    ['erpnext', 'ERPNext', 'center'],
    ['workflow', '工作流', 'center'],
  ])
  assert.deepEqual(config.scenes.map(scene => scene.icon), ['⌂', '▦', '◉', '⇩', '≋', '◈', '▤', '⛓'],
    'each scene has a compact, accessible glyph for the unified navigation rail')
  assert.deepEqual(config.scenes.map(scene => [scene.id, scene.layoutProfile.kind, scene.layoutProfile.minimumWidth, scene.layoutProfile.minimumHeight]), [
    ['center', 'assistant_lead', 1000, 360],
    ['products', 'collaboration_grid', 960, 560],
    ['agent-center', 'collaboration_grid', 960, 560],
    ['deliverables', 'collaboration_grid', 960, 560],
    ['runs', 'business_lead', 1143, 360],
    ['user-profile', 'business_lead', 1143, 360],
    ['erpnext', 'business_lead', 1143, 360],
    ['workflow', 'business_lead', 1143, 360],
  ], 'every scene uses the reviewed split profile and canvas fit threshold')
  const invalidProfile = structuredClone(config)
  invalidProfile.scenes[0].layoutProfile.minimumWidth++
  assert.throws(() => validateSceneConfig(invalidProfile), /dock layout profile/)
  const erpScene = config.scenes.find(scene => scene.id === 'erpnext')
  assert.equal(erpScene.panels.find(panel => panel.id === 'auxiliary').text, '在此添加与当前业务相关的资料与任务。')
  assert.equal(erpScene.panels.find(panel => panel.id === 'reference').text, '在此配置当前业务的参考资料来源。')
  assert.ok(config.scenes.every(scene => ROLE_IDS.includes(scene.roleId)))
  assert.deepEqual(Object.keys(config.businessRoutes).sort(), ['/agent-center', '/artifacts', '/home', '/products', '/runs'])
  assert.deepEqual(config.businessRoutes['/agent-center'], { sceneId: 'agent-center', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/products'], { sceneId: 'products', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/artifacts'], { sceneId: 'deliverables', panelId: 'business-main' })
  assert.deepEqual(config.businessRoutes['/runs'], { sceneId: 'runs', panelId: 'business-main' })
  for (const scene of config.scenes) {
    assert.deepEqual(new Set(scene.panels.map(panel => panel.id)).size, scene.panels.length)
    const business = scene.panels.find(panel => panel.id === 'business-main')
    const auxiliary = scene.panels.find(panel => panel.id === 'auxiliary')
    const reference = scene.panels.find(panel => panel.id === 'reference')
    const chat = scene.panels.find(panel => panel.id === 'native-chat')
    assert.deepEqual([business, auxiliary, reference, chat].map(({ col, row, w, h }) => ({ col, row, w, h })), [
      { col: 1, row: 1, w: 3, h: 2 },
      { col: 4, row: 1, w: 1, h: 2 },
      { col: 1, row: 3, w: 1, h: 2 },
      { col: 2, row: 3, w: 3, h: 2 },
    ])
    assert.equal(chat.type, 'native-chat')
    assert.ok(['business-iframe', 'erpnext-status', 'workflow-canvas'].includes(business.type))
    if (scene.id !== 'erpnext') {
      assert.equal(auxiliary.type, 'business-iframe', `${scene.id} uses an existing business page in its auxiliary panel`)
      assert.equal(reference.type, 'business-iframe', `${scene.id} uses an existing business page in its reference panel`)
    }
  }
  const added = structuredClone(config)
  added.scenes.push({
    id: 'generic-extension', label: '通用场景', roleId: 'center', panels: [
      { id: 'business-main', type: 'business-iframe', title: '总览', path: '/home', col: 1, row: 1, w: 3, h: 2 },
      { id: 'auxiliary', type: 'placeholder', title: '辅助资料', text: '未配置', col: 4, row: 1, w: 1, h: 2 },
      { id: 'reference', type: 'placeholder', title: '参考资料', text: '未配置', col: 1, row: 3, w: 1, h: 2 },
      { id: 'native-chat', type: 'native-chat', title: '中心助手', col: 2, row: 3, w: 3, h: 2 },
    ],
  })
  assert.strictEqual(validateSceneConfig(added), added, 'a new scene using registered panels needs no renderer change')
  for (const mutate of [
    value => { value.scenes[0].panels[0].type = 'arbitrary-module' },
    value => { value.scenes[0].panels[1].id = value.scenes[0].panels[0].id },
    value => { value.scenes[0].panels[0].col = 4 },
    value => { value.scenes = [] },
  ]) {
    const invalid = structuredClone(config)
    mutate(invalid)
    assert.throws(() => validateSceneConfig(invalid), /scene|panel|grid|route/i)
  }
  const state = normalizeSceneWorkbench(config, {
    version: 1,
    activeSceneId: 'user-profile', roleByScene: { center: 'product', 'user-profile': 'delivery', erpnext: 'center' }, businessPath: '/artifacts',
    layouts: { center: { expandedPanel: 'native-chat', panels: { 'business-main': { visible: false } } } },
  })
  assert.equal(state.activeSceneId, 'user-profile')
  assert.equal(state.roleByScene['user-profile'], 'delivery')
  assert.equal(state.roleByScene.center, 'product')
  assert.equal(state.layouts.center.panels['business-main'].visible, false)
  assert.equal(state.layouts.center.panels['native-chat'].col, 2)
  assert.equal(state.layouts.center.expandedPanel, 'native-chat')
})

test('scene client chunk exposes independent layout state and scene-to-role mapping', async () => {
  const source = await readFile(sceneChunkUrl, 'utf8')
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  assert.equal(registration.id, '@tradeloom/dsh-business-shell')
  assert.equal(registration.chunk, 'client.scenes.js')
  const exports = registration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {} }
  })
  const config = await readClientSceneConfig()
  const center = config.scenes.find(scene => scene.id === 'center')
  const profile = config.scenes.find(scene => scene.id === 'user-profile')
  const states = exports.rememberLayout({}, center.id, { expandedPanel: 'session' })
  const bothStates = exports.rememberLayout(states, profile.id, { expandedPanel: 'business' })
  assert.equal(JSON.stringify(bothStates), JSON.stringify({
    center: { expandedPanel: 'session' },
    'user-profile': { expandedPanel: 'business' },
  }))
  assert.equal(exports.roleForScene(config, 'center'), 'center')
  assert.equal(exports.roleForScene(config, 'user-profile'), 'user-profile')
  assert.equal(exports.roleForScene(config, 'unknown'), undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(exports.sceneNavigationItems(config))), [
    { id: 'center', label: '工作总览', icon: '⌂', route: '/home' },
    { id: 'products', label: '商品', icon: '▦', route: '/products' },
    { id: 'agent-center', label: '任务', icon: '◉', route: '/agent-center' },
    { id: 'deliverables', label: '交付物', icon: '⇩', route: '/artifacts' },
    { id: 'runs', label: '运行记录', icon: '≋', route: '/runs' },
    { id: 'user-profile', label: '资料整理', icon: '◈', route: null },
    { id: 'erpnext', label: 'ERPNext', icon: '▤', route: null },
    { id: 'workflow', label: '工作流', icon: '⛓', route: null },
  ])
  const current = { config, activeSceneId: 'center', businessPath: '/home', layouts: bothStates }
  const selectedProfile = exports.selectScene(current, 'user-profile')
  assert.equal(selectedProfile.activeSceneId, 'user-profile')
  assert.equal(selectedProfile.businessPath, '/artifacts', 'a scene without a menu default opens its configured main business panel')
  assert.equal(selectedProfile.layouts.center.expandedPanel, 'session')
  assert.equal(selectedProfile.layouts['user-profile'].expandedPanel, 'business')
  assert.strictEqual(exports.selectScene(selectedProfile, 'unknown'), selectedProfile)
  const expanded = exports.updatePanelLayout({}, 'overview-notes', 'expand')
  const refreshed = exports.updatePanelLayout(expanded, 'business-home', 'refresh')
  assert.equal(refreshed.expandedPanel, 'overview-notes')
  assert.equal(refreshed.refreshCounts['business-home'], 1)
  const bindings = exports.bindSession({}, exports.roleForScene(config, 'center'), 'session-center', config)
  const nextBindings = exports.bindSession(bindings, exports.roleForScene(config, 'user-profile'), 'session-profile', config)
  assert.equal(JSON.stringify(nextBindings), JSON.stringify({ center: 'session-center', 'user-profile': 'session-profile' }))
  assert.equal(typeof exports.PANEL_REGISTRY['business-iframe'], 'function')
  assert.equal(typeof exports.PANEL_REGISTRY.placeholder, 'function')
  assert.equal(typeof exports.PANEL_REGISTRY['native-chat'], 'function')
})

test('native chat panel uses the pinned conversation factory', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      addEventListener() {}, removeEventListener() {},
    },
  })
  const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props, children }) }
  const exports = registration.factory(() => React)
  let factoryCall
  const node = exports.SceneChatPanel({
    sessionId: 'session-center',
    renderFactorySlot(...args) { factoryCall = args; return { conversation: true } },
  })
  assert.deepEqual(node, { conversation: true })
  assert.equal(factoryCall[0], 'conversation.content')
  assert.deepEqual(JSON.parse(JSON.stringify(factoryCall[1])), { variant: 'embedded', phase: 'active', hero: false })
  assert.equal(typeof factoryCall[2].slots.views, 'function')
  const renderedView = factoryCall[2].slots.views({ renderSlot(name, owner) { return { name, owner } } })
  assert.deepEqual(JSON.parse(JSON.stringify(renderedView)), { type: 'Fragment', props: null, children: [{ name: 'conversation.session', owner: { view: 'chat' } }] })

})

test('ERPNext status panel reads Django status on entry and rechecks when its panel refresh key changes', async () => {
  let registration
  let state
  let dependencies
  let cleanup
  const requests = []
  let connectedStatus = true
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
    useEffect(effect, nextDependencies) {
      if (!dependencies || nextDependencies.some((value, index) => value !== dependencies[index])) {
        cleanup?.()
        cleanup = effect()
        dependencies = [...nextDependencies]
      }
    },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    URL,
    URLSearchParams,
    fetch: async url => {
      requests.push(url)
      return { ok: true, async json() { return {
        configured: true, connected: connectedStatus, status: connectedStatus ? 'connected' : 'unavailable', error_code: '', site_url: 'https://erp.example.test/tenant',
        apiKey: 'must-not-render', apiSecret: 'must-not-render',
      } } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const component = registration.factory(() => React).ERPNextStatus
  const flatten = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ') : node?.children?.map(flatten).join(' ') ?? ''
  const findNodes = (node, predicate, matches = []) => {
    if (Array.isArray(node)) for (const item of node) findNodes(item, predicate, matches)
    else if (node && typeof node === 'object') {
      if (predicate(node)) matches.push(node)
      findNodes(node.children, predicate, matches)
    }
    return matches
  }

  component({ refreshKey: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const connectedTree = component({ refreshKey: 0 })
  const connected = flatten(connectedTree)
  assert.equal(connected.includes('ERPNext 已连接'), true)
  assert.equal(connected.includes('must-not-render'), false)
  assert.equal(findNodes(connectedTree, node => node.type?.name === 'ERPNextQuotationDraft').length, 1,
    'the bounded Quotation editor is part of the existing connected ERPNext panel')
  const links = findNodes(connectedTree, node => node.type === 'a')
  assert.deepEqual(links.map(link => [link.props.href, link.props.target, link.props.rel]), [
    ['https://erp.example.test/tenant', '_blank', 'noopener noreferrer'],
  ])
  const connectedDraft = findNodes(connectedTree, node => node.type?.name === 'ERPNextQuotationDraft')[0]
  assert.equal(connectedDraft.props.enabled, true)
  assert.deepEqual(requests, ['/business-api/erpnext/status'])

  component({ refreshKey: 1 })
  await new Promise(resolve => setImmediate(resolve))
  const afterRefresh = component({ refreshKey: 1 })
  assert.deepEqual(requests, ['/business-api/erpnext/status', '/business-api/erpnext/status'])
  connectedStatus = false
  component({ refreshKey: 2 })
  await new Promise(resolve => setImmediate(resolve))
  const unavailableTree = component({ refreshKey: 2 })
  const retainedDraft = findNodes(unavailableTree, node => node.type?.name === 'ERPNextQuotationDraft')[0]
  assert.ok(retainedDraft, 'a transient disconnect must not unmount and discard operation keys/readback IDs')
  assert.equal(retainedDraft.props.enabled, false)
  assert.equal(retainedDraft.type, connectedDraft.type)
  assert.ok(afterRefresh)
  assert.deepEqual(requests, ['/business-api/erpnext/status', '/business-api/erpnext/status', '/business-api/erpnext/status'])
})

test('Quotation editor treats 202 as unknown and only a GET readback can confirm success', async () => {
  let registration
  let state
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const unknown = {
    ok: true, operation_id: 'a'.repeat(32), action: 'create', doctype: 'Quotation', status: 'outcome_unknown',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: null, remote_modified: null,
    payload_sha256: 'b'.repeat(64), error_code: 'unavailable', receipt: null, remote_current: null, remote_error_code: 'unavailable',
  }
  const succeeded = {
    ...unknown, status: 'succeeded', remote_name: 'QTN-1', remote_modified: '2026-10-21 12:30:00.000000', error_code: '', remote_error_code: '',
    receipt: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:30:00.000000', docstatus: 0,
      quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
      currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:30:00.000000' }, truncated_children: [] },
    remote_current: { doctype: 'Quotation', data: { name: 'QTN-1', modified: '2026-10-21 12:30:00.000000', docstatus: 0,
      quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
      currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '2', rate: '5.25', uom: 'Nos' }] },
      external_ref: { system: 'erpnext', instance_id: 'local', doctype: 'Quotation', name: 'QTN-1', modified: '2026-10-21 12:30:00.000000' }, truncated_children: [] },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body, headers: options.headers })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST') return { ok: true, status: 202, async json() { return unknown } }
      return { ok: true, status: 200, async json() { return succeeded } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  assert.equal(typeof DraftEditor, 'function')
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  const flatten = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join(' ') : node?.children?.map(flatten).join(' ') ?? ''
  const fill = tree => {
    const fields = {
      '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD',
      '商品编码 1': 'ITEM-1', '数量 1': '2', '单价 1': '5.25', '单位 1': 'Nos',
    }
    for (const [key, value] of Object.entries(fields)) {
      tree = component()
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === key)[0]
      input.props.onChange({ target: { value } })
    }
    return tree
  }
  let tree = fill(component())
  tree = component()
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  assert.match(flatten(tree), /结果待核对/)
  assert.doesNotMatch(flatten(tree), /已确认保存草稿/)
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', '/business-api/'], ['POST', '/business-api/erpnext/quotation-drafts'],
  ])
  const postCall = calls[1]
  const posted = JSON.parse(postCall.body)
  assert.equal(posted.idempotency_key, '11111111-1111-4111-8111-111111111111')
  assert.equal('role' in posted, false)
  assert.equal('actor' in posted, false)
  assert.equal(postCall.headers['X-CSRFToken'], 'fixture-csrf-token')
  const check = find(tree, node => node.type === 'button' && node.children.includes('读取操作状态'))[0]
  await check.props.onClick()
  tree = component()
  assert.match(flatten(tree), /已确认保存草稿/)
  assert.match(flatten(tree), /QTN-1/)
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET'])
})

test('Quotation editor recovers a lost response by reusing the identical request key and body', async () => {
  let registration
  let state
  let nextKey = 0
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const operation = {
    ok: true, operation_id: 'c'.repeat(32), action: 'create', doctype: 'Quotation', status: 'outcome_unknown',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: 'QTN-2',
    remote_modified: null, payload_sha256: 'd'.repeat(64), error_code: 'unavailable', receipt: null,
    remote_current: null, remote_error_code: 'unavailable',
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => `22222222-2222-4222-8222-${String(++nextKey).padStart(12, '0')}` },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST' && calls.filter(call => call.method === 'POST').length === 1) throw new Error('fixture network interruption')
      return { ok: true, status: 202, async json() { return operation } }
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  assert.equal(typeof DraftEditor, 'function')
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  let initialTree = component()
  const maxLengths = {
    '公司': 140, '客户': 140, '交易日期': 10, '有效日期': 10, '币种': 3,
    '商品编码 1': 140, '数量 1': 32, '单价 1': 32, '单位 1': 140,
  }
  for (const [label, maxLength] of Object.entries(maxLengths)) {
    assert.equal(find(initialTree, node => node.type === 'input' && node.props['aria-label'] === label)[0].props.maxLength, maxLength)
  }
  find(initialTree, node => node.type === 'input' && node.props['aria-label'] === '公司')[0]
    .props.onChange({ target: { value: 'x'.repeat(141) } })
  initialTree = component()
  await find(initialTree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  assert.deepEqual(calls, [], 'the form rejects overlong text before requesting Django')
  assert.match(JSON.stringify(component()), /请填写有效的公司、客户、日期、币种和报价行/)
  const fillRequired = tree => {
    const fields = { '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD', '商品编码 1': 'ITEM-1', '数量 1': '1', '单价 1': '3', '单位 1': 'Nos' }
    for (const [key, value] of Object.entries(fields)) {
      tree = component()
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === key)[0]
      input.props.onChange({ target: { value } })
    }
    return tree
  }
  let tree = fillRequired(component())
  tree = component()
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  const firstPost = calls.find(call => call.method === 'POST')
  const firstBody = firstPost.body
  assert.match(tree.children ? JSON.stringify(tree) : '', /暂未收到操作回执/)
  await find(tree, node => node.type === 'button' && node.children.includes('用原请求键恢复回执'))[0].props.onClick()
  const posts = calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body, firstBody)
  assert.equal(JSON.parse(posts[1].body).idempotency_key, '22222222-2222-4222-8222-000000000001')
})

test('Quotation editor sends each explicit update as a new operation against the exact readback version', async () => {
  let registration
  let state
  let nextKey = 0
  const calls = []
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial
      return [state, next => { state = typeof next === 'function' ? next(state) : next }]
    },
  }
  const record = modified => ({ doctype: 'Quotation', data: { name: 'QTN-3', modified, docstatus: 0,
    quotation_to: 'Customer', company: 'Demo Company', party_name: 'Customer-1', transaction_date: '2026-10-21',
    currency: 'USD', items: [{ item_code: 'ITEM-1', qty: '1', rate: '3', uom: 'Nos' }] },
    external_ref: { system: 'erpnext', instance_id: 'erp-demo', doctype: 'Quotation', name: 'QTN-3', modified }, truncated_children: [] })
  const created = { ok: true, operation_id: '3'.repeat(32), action: 'create', doctype: 'Quotation', status: 'succeeded',
    source: 'local_workbench', workflow_id: null, target_operation_id: null, remote_name: 'QTN-3', remote_modified: '2026-10-21 12:00:00.000000',
    payload_sha256: 'e'.repeat(64), error_code: '', receipt: record('2026-10-21 12:00:00.000000'),
    remote_current: record('2026-10-21 12:00:00.000000'), remote_error_code: '' }
  const conflict = { ...created, operation_id: '4'.repeat(32), action: 'update', status: 'conflict',
    target_operation_id: created.operation_id, remote_current: null, error_code: 'conflict' }
  const conflictRead = { ...conflict, remote_current: record('2026-10-21 12:30:00.000000') }
  const updated = { ...created, operation_id: '5'.repeat(32), action: 'update', status: 'succeeded',
    target_operation_id: created.operation_id, remote_modified: '2026-10-21 13:00:00.000000',
    receipt: record('2026-10-21 13:00:00.000000'), remote_current: record('2026-10-21 13:00:00.000000') }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React, URLSearchParams, document: { cookie: 'csrftoken=fixture-csrf-token;' },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextKey).padStart(12, '0')}` },
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body, headers: options.headers })
      if (url === '/business-api/') return { ok: true, status: 200 }
      if (options.method === 'POST') return { ok: true, status: 201, async json() { return created } }
      if (options.method === 'PUT' && calls.filter(call => call.method === 'PUT').length === 1) {
        return { ok: false, status: 409, async json() { return conflict } }
      }
      if (options.method === 'PUT') return { ok: true, status: 200, async json() { return updated } }
      if (options.method === 'GET' && url.endsWith(`/quotation-drafts/${conflict.operation_id}`)) {
        return { ok: true, status: 200, async json() { return conflictRead } }
      }
      throw new Error('unexpected request')
    },
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const DraftEditor = registration.factory(() => React).ERPNextQuotationDraft
  const component = props => DraftEditor({ enabled: true, ...props })
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => find(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...find(node.children, predicate)]
  }
  const fillFields = async fields => {
    let tree = component()
    for (const [label, value] of Object.entries(fields)) {
      const input = find(tree, node => node.type === 'input' && node.props['aria-label'] === label)[0]
      input.props.onChange({ target: { value } })
      tree = component()
    }
    return tree
  }
  let tree = await fillFields({
    '公司': 'Demo Company', '客户': 'Customer-1', '交易日期': '2026-10-21', '币种': 'USD',
    '商品编码 1': 'ITEM-1', '数量 1': '1', '单价 1': '3', '单位 1': 'Nos',
  })
  await find(tree, node => node.type === 'button' && node.children.includes('创建报价草稿'))[0].props.onClick()
  tree = component()
  assert.match(tree.children ? JSON.stringify(tree) : '', /已确认保存草稿/)
  tree = await fillFields({ '客户': 'Customer-2' })
  await find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /版本冲突/)
  const blockedUpdate = find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0]
  assert.equal(blockedUpdate.props.disabled, true)
  await find(tree, node => node.type === 'button' && node.children.includes('刷新冲突版本'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /已读取冲突时的当前版本/)
  assert.equal(find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.disabled, false)
  await find(tree, node => node.type === 'button' && node.children.includes('保存为新修改操作'))[0].props.onClick()
  tree = component()
  assert.match(JSON.stringify(tree), /已确认保存草稿/)
  const post = calls.find(call => call.method === 'POST')
  const puts = calls.filter(call => call.method === 'PUT')
  assert.ok(post && puts.length === 2)
  const createBody = JSON.parse(post.body)
  const firstUpdate = JSON.parse(puts[0].body)
  const secondUpdate = JSON.parse(puts[1].body)
  assert.ok(puts.every(put => put.url === `/business-api/erpnext/quotation-drafts/${created.operation_id}`))
  assert.equal(firstUpdate.expected_modified, '2026-10-21 12:00:00.000000')
  assert.equal(secondUpdate.expected_modified, '2026-10-21 12:30:00.000000')
  assert.notEqual(firstUpdate.idempotency_key, createBody.idempotency_key)
  assert.notEqual(secondUpdate.idempotency_key, firstUpdate.idempotency_key)
  assert.equal(secondUpdate.payload.party_name, 'Customer-2')
  assert.equal('role' in secondUpdate, false)
  assert.equal('actor' in secondUpdate, false)
  assert.ok(puts.every(put => put.headers['X-CSRFToken'] === 'fixture-csrf-token'))
  assert.deepEqual(calls.filter(call => call.method === 'GET').map(call => call.url), [
    '/business-api/', '/business-api/', `/business-api/erpnext/quotation-drafts/${conflict.operation_id}`, '/business-api/',
  ])
})

test('scene chat renders the pinned conversation factory inside its retained role SessionProvider', async () => {
  let registration
  const sceneConfig = await readClientSceneConfig()
  sceneConfig.roles.find(role => role.id === 'center').assistantLabel = '当前中心助手'
  const componentStates = new WeakMap()
  let activeComponent
  let hookIndex = 0
  const fetchCalls = []
  let dockActionRefreshes = 0
  let resizeViewport = { width: 2000, height: 800 }
  const sceneDockHost = {
    getBoundingClientRect: () => resizeViewport,
    addEventListener() {}, removeEventListener() {},
  }
  let resizeCallback
  const legacyState = defaultSceneWorkbench(sceneConfig)
  const dockLayouts = normalizeDockLayouts(sceneConfig, { version: 2, scenes: {} }, legacyState.layouts)
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useRef(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = { current: activeComponent?.name === 'SceneDock' && index === 1 && initial === null ? sceneDockHost : initial }
      return state[index]
    },
    useState(initial) {
      let state = componentStates.get(activeComponent)
      if (!state) { state = []; componentStates.set(activeComponent, state) }
      const index = hookIndex++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      const owner = activeComponent
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
        if (owner?.name === 'DockGroupActions') dockActionRefreshes++
      }]
    },
    useEffect(effect) { effect() },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    fetch: async (url, options = {}) => {
      fetchCalls.push([url, options.method ?? 'GET'])
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return sceneConfig } }
      if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return {
        ok: true, async json() { return legacyState },
      }
      if (url === '/tradeloom/scene-layouts') return { ok: true }
      if (url === '/tradeloom/dock-layouts' && (options.method ?? 'GET') === 'GET') return {
        ok: true, async json() { return dockLayouts },
      }
      throw new Error(`unexpected request ${url}`)
    },
    requestAnimationFrame(callback) { callback(); return 1 },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback }
      observe(target) { resizeCallback([{ target, contentRect: resizeViewport }]) }
      disconnect() {}
    },
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      addEventListener() {}, removeEventListener() {},
    },
    document: { getElementById() { return null } },
  })
  const createDockPanel = panel => {
    const group = { id: 'test-group' }
    const api = {
      id: panel.id, group,
      setActive() { activatedPanels.push(panel.id) }, setTitle() {}, close() {},
      isMaximized(...args) {
        assert.equal(args.length, 0, 'IDockviewPanelApi.isMaximized() takes no panel or group argument')
        return maximizedGroup && maximizedPanelId === panel.id
      },
      maximize() { maximizeCalls.push(['maximize', panel.id]); maximizedGroup = true; maximizedPanelId = panel.id; maximizeListener?.() },
      exitMaximized() {
        if (!this.isMaximized()) return
        maximizeCalls.push(['restore']); maximizedGroup = false; maximizedPanelId = ''; maximizeListener?.()
      },
    }
    return { id: panel.id, group, api }
  }
  const activatedPanels = []
  const dockPanels = new Map(sceneConfig.scenes[0].panels.map(panel => [panel.id, createDockPanel(panel)]))
  let maximizedGroup = false
  let maximizedPanelId = ''
  let maximizeListener
  let activePanelListener
  let layoutListener
  const maximizeCalls = []
  const loadedDockLayouts = []
  const dockApi = {
    panels: [...dockPanels.values()],
    activePanel: dockPanels.get('native-chat'),
    fromJSON(layout) {
      loadedDockLayouts.push(layout)
      for (const panel of sceneConfig.scenes[0].panels) {
        if (layout.panels?.[panel.id] && !dockPanels.has(panel.id)) dockPanels.set(panel.id, createDockPanel(panel))
      }
      layoutListener?.()
    }, toJSON() { return dockLayouts.scenes.center.dockview }, layout() {}, hasMaximizedGroup() { return maximizedGroup },
    maximizeGroup(panel) { panel.api.maximize() },
    exitMaximizedGroup() { maximizeCalls.push(['restore']); maximizedGroup = false; maximizedPanelId = ''; maximizeListener?.() },
    addPanel(panel) { const created = createDockPanel(panel); dockPanels.set(panel.id, created); layoutListener?.(); return created },
    getPanel(id) { return dockPanels.get(id) }, getPanels() { return [...dockPanels.values()] },
    onDidLayoutChange(listener) { layoutListener = listener; return { dispose() {} } },
    onDidActivePanelChange(listener) { activePanelListener = listener; return { dispose() {} } },
    onDidMaximizedGroupChange(listener) { maximizeListener = listener; return { dispose() {} } },
    onWillDragPanel() { return { dispose() {} } },
    onWillShowOverlay() { return { dispose() {} } },
    onWillDrop() { return { dispose() {} } },
  }
  let dockReady = false
  let dockRenderProps
  const dockviewModule = {
    dockviewCss: '',
    DockviewReact({ components, onReady, ...props }) {
      dockRenderProps = props
      if (!dockReady) { dockReady = true; onReady({ api: dockApi }) }
      if (!dockApi.getPanel('native-chat')) return null
      return React.createElement(components['native-chat'], {
        id: 'native-chat', sceneId: 'center', params: { panelId: 'native-chat' }, api: dockApi.getPanel('native-chat').api,
      })
    },
  }
  const sceneRequire = Object.assign(() => React, { async: async () => dockviewModule })
  const exports = registration.factory(sceneRequire)
  const reference = { ready: Promise.resolve(), release() {} }
  let sessionRetains = 0
  let sidebarSuppressionCalls = 0
  let sidebarToggleCalls = 0
  const invoke = (Component, props = {}) => {
    const previous = activeComponent
    activeComponent = Component
    hookIndex = 0
    try { return Component(props) } finally { activeComponent = previous }
  }
  exports.register({
    layout: {
      selectPanel() {},
      suppressSidebar() { sidebarSuppressionCalls++; return () => {} },
      toggleSidebar() { sidebarToggleCalls++ },
    },
    sessions: { retain(sessionId, options) { sessionRetains++; assert.equal(sessionId, 'native-center-session'); assert.deepEqual(JSON.parse(JSON.stringify(options)), { source: 'mainView' }); return reference } },
    modelDirectories: { directoryFor() { throw new Error('not used in this test') } },
    slots: { inject(_name, register) { register() }, register() { return () => {} } },
    effect() {},
  })
  invoke(exports.SceneTabs)
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  invoke(exports.SceneTabs)
  assert.equal(await exports.selectRole('center', 'native-center-session'), true)
  assert.equal(exports.getSnapshot().config?.scenes.length, 8, JSON.stringify({ error: exports.getSnapshot().configError, fetchCalls }))
  assert.equal(exports.getSnapshot().sessionBindings.center, 'native-center-session')
  for (const scene of sceneConfig.scenes) {
    assert.equal(JSON.stringify(exports.getSnapshot().dockDefaults[scene.id].dockview), JSON.stringify(dockLayouts.scenes[scene.id].dockview),
      `${scene.id} default and recommended-reset JSON use the same configured recommendation`)
  }
  const factoryCalls = []
  const providedSessions = []
  const providedViewKeys = []
  const SessionProvider = ({ session, children }) => {
    assert.strictEqual(session, reference)
    providedSessions.push(session)
    providedViewKeys.push(children?.props?.key)
    return children
  }
  const sceneProps = {
    SessionProvider,
    renderSlot(name) {
      assert.equal(name, 'scene.workbench.chat')
      return invoke(exports.SceneChatPanel, {
        renderFactorySlot(...args) {
          factoryCalls.push(args)
          return React.createElement('actual-pinned-conversation-factory', { props: args[1] })
        },
      })
    },
  }
  const resolve = node => {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return resolve(invoke(node.type, { ...node.props, children: node.children.length <= 1 ? node.children[0] : node.children }))
    return { ...node, children: node.children.map(resolve) }
  }
  const renderWorkbench = () => resolve(invoke(exports.SceneWorkbench, sceneProps))
  renderWorkbench()
  await new Promise(resolve => setImmediate(resolve))
  let mounted = renderWorkbench()
  assert.equal(dockRenderProps.theme?.gap, 10,
    'the default Dockview theme configures a real inter-group gap rather than outer padding or sash styling')
  assert.equal(sidebarSuppressionCalls, 0, 'rendering a workbench never claims to hide the native sidebar')
  assert.equal(sidebarToggleCalls, 0, 'entering and rendering a workbench never toggles the native sidebar')
  await new Promise(resolve => setImmediate(resolve))
  mounted = renderWorkbench()
  assert.equal(sidebarSuppressionCalls, 0, 'workbench updates never claim temporary sidebar suppression')
  assert.equal(sidebarToggleCalls, 0, 'scene updates never mutate the native sidebar preference')
  assert.ok(factoryCalls.length >= 1)
  assert.ok(factoryCalls.every(call => call[0] === 'conversation.content'
    && JSON.stringify(call[1]) === JSON.stringify({ variant: 'embedded', phase: 'active', hero: false })))
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (found) return found
    }
  }
  const dockThemeStyles = find(mounted, node => node.type === 'style' && node.children?.some(child => typeof child === 'string' && child.includes('--dv-spacing-padding: 0px;')))
  assert.ok(dockThemeStyles, 'Dockview spacing padding is zero so the canvas padding does not duplicate the split gap')
  assert.ok(dockThemeStyles.children.some(child => typeof child === 'string' && child.includes('background: var(--tl-canvas);')),
    'the official split gap exposes the workbench canvas behind surface-colored groups')
  const standaloneNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: false }))
  assert.equal(find(standaloneNavigation, node => node.props?.className === 'tl-scene-tab' && node.props?.['aria-current']), undefined,
    'standalone conversation mode does not leave the previous business scene selected')
  const workbenchNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  assert.equal(find(workbenchNavigation, node => node.props?.className === 'tl-scene-tab' && node.props?.['aria-current'] === 'page')?.props?.['aria-label'], '工作总览',
    'the active workbench scene is selected in the scene navigation')
  const panel = find(mounted, node => node.props?.['data-panel-id'] === 'native-chat')
  assert.ok(panel, 'Dockview mounts the registered native-chat panel')
  assert.equal(find(panel, node => node.props?.className === 'tl-dock-panel-actions'), undefined,
    'panel actions no longer add a second control row below Dockview tabs')
  assert.equal(find(mounted, node => node.props?.className === 'tl-workbench-heading'), undefined,
    'the duplicated current-assistant heading is removed')
  assert.equal(find(mounted, node => node.props?.className === 'tl-dock-active-panel-actions'), undefined,
    'the old outer action toolbar is removed')
  assert.equal(find(mounted, node => node.props?.className === 'tl-dock-toolbar'), undefined,
    'wide scenes do not leave an empty external toolbar row')
  const groupActions = () => resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel(dockApi.activePanel?.id), isGroupActive: true,
  }))
  let groupTree = groupActions()
  let toolbarRefresh = find(groupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新当前中心助手')
  let toolbarMaximize = find(groupTree, node => node.type === 'button' && node.props?.['aria-label'] === '展开当前中心助手')
  assert.ok(toolbarRefresh, 'the active Dockview group header owns refresh')
  assert.ok(toolbarMaximize, 'the active Dockview group header owns maximize')
  const inactiveGroupTree = resolve(dockRenderProps.rightHeaderActionsComponent({
    activePanel: dockApi.getPanel('business-main'), isGroupActive: false,
  }))
  assert.ok(find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览'),
    'an inactive group retains its own refresh action without changing focus')
  assert.ok(find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '展开总览'),
    'an inactive group retains its own maximize action')
  const inactiveRefresh = find(inactiveGroupTree, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  const activeBeforeInactiveAction = [...activatedPanels]
  let stoppedPointerDown = false
  inactiveRefresh.props.onPointerDown({ stopPropagation() { stoppedPointerDown = true } })
  inactiveRefresh.props.onClick({ stopPropagation() {} })
  assert.equal(stoppedPointerDown, true, 'group action pointer-down does not activate the inactive Dockview group')
  assert.deepEqual(activatedPanels, activeBeforeInactiveAction, 'running an inactive group action does not change the active panel')
  const navTree = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  const layoutTrigger = find(navTree, node => node.type === 'button' && node.props?.['aria-label'] === '工作区布局')
  assert.ok(layoutTrigger, 'the global navigation keeps layout access independent of Dockview groups')
  const layoutMenu = find(navTree, node => node.props?.id === 'tl-scene-layout-menu')
  const recommendLayout = find(layoutMenu, node => node.type === 'button' && node.children?.includes('应用推荐布局'))
  assert.ok(recommendLayout, 'the user can explicitly apply the configured recommendation after changing a saved layout')
  recommendLayout.props.onClick()
  assert.equal(JSON.stringify(loadedDockLayouts.at(-1)), JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview),
    'applying the recommendation restores the exact scene-specific Dockview tree')
  assert.strictEqual(providedSessions.at(-1), reference)
  assert.equal(providedViewKeys.at(-1), 'native-center-session:0')
  toolbarRefresh.props.onClick()
  const refreshed = renderWorkbench()
  assert.strictEqual(providedSessions.at(-1), reference, 'refresh keeps the existing native SessionProvider reference')
  assert.equal(providedViewKeys.at(-1), 'native-center-session:1', 'refresh remounts only the conversation view subtree')
  assert.equal(sessionRetains, 1, 'refresh does not create or retain another native session')
  assert.equal(fetchCalls.some(([, method]) => method === 'POST'), false, 'refresh sends no model/session request')
  toolbarMaximize.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat']], 'maximize uses the pinned Dockview public API for the selected panel')
  assert.ok(dockActionRefreshes > 0, 'the official maximize event notifies stable group header renderers to refresh their labels')
  renderWorkbench()
  const toolbarRestore = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '还原当前中心助手')
  assert.ok(toolbarRestore, 'the toolbar label follows Dockview maximized state')
  toolbarRestore.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat'], ['restore']])
  renderWorkbench()
  const toolbarExpandAgain = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '展开当前中心助手')
  assert.ok(toolbarExpandAgain, 'the button returns to Expand after the group is restored')
  toolbarExpandAgain.props.onClick()
  assert.deepEqual(maximizeCalls, [['maximize', 'native-chat'], ['restore'], ['maximize', 'native-chat']],
    'the same public panel API can expand the group again after a restore')
  renderWorkbench()
  assert.ok(find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '还原当前中心助手'),
    'the second maximize updates the stable header action back to Restore')
  dockApi.activePanel = dockPanels.get('business-main')
  activePanelListener({ panel: dockApi.activePanel, origin: 'user' })
  renderWorkbench()
  const businessRefresh = find(groupActions(), node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  assert.ok(businessRefresh, 'the group header follows Dockview active-panel changes')
  businessRefresh.props.onClick()
  assert.equal(exports.getSnapshot().panelRefreshKeys.center['business-main'], 2,
    'refresh targets the active business panel rather than the previously active chat')
  const centerLayoutBeforeNarrow = JSON.stringify(dockLayouts.scenes.center)
  resizeViewport = { width: 900, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  const narrowTree = renderWorkbench()
  assert.ok(find(narrowTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'),
    'the actual Dockview canvas below the assistant-led width threshold switches to the single-panel picker')
  assert.ok(find(narrowTree, node => node.props?.className === 'tl-dock-toolbar'),
    'narrow mode renders the compact panel selector toolbar')
  const narrowGroupActions = find(groupActions(), node => node.props?.className === 'tl-dock-group-actions')
  const narrowRefresh = find(narrowGroupActions, node => node.type === 'button' && node.props?.['aria-label'] === '刷新总览')
  assert.ok(narrowRefresh, 'narrow mode keeps per-group refresh reachable while tab dragging is disabled')
  narrowRefresh.props.onClick({ stopPropagation() {} })
  assert.equal(exports.getSnapshot().panelRefreshKeys.center['business-main'], 3,
    'narrow-mode group refresh still targets its own panel')
  assert.equal(dockRenderProps.disableDnd, true, 'narrow mode disables layout dragging so responsive geometry stays transient')
  assert.equal(JSON.stringify(dockLayouts.scenes.center), centerLayoutBeforeNarrow,
    'narrow mode keeps the serialized saved layout unchanged')
  resizeViewport = { width: 2000, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  const wideTree = renderWorkbench()
  assert.equal(find(wideTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'), undefined,
    'the full recommended layout returns when the same canvas widens')
  assert.equal(dockRenderProps.disableDnd, false)
  assert.deepEqual(maximizeCalls.slice(-2), [['maximize', 'business-main'], ['restore']], 'responsive maximize restores without replacing the saved tree')
  resizeViewport = { width: 2000, height: 300 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  assert.ok(find(renderWorkbench(), node => node.type === 'select' && node.props?.['aria-label'] === '选择当前面板'),
    'a canvas below the minimum row height also uses the single-panel mode')
  resizeViewport = { width: 2000, height: 800 }
  resizeCallback([{ target: sceneDockHost, contentRect: resizeViewport }])
  renderWorkbench()
  assert.deepEqual(maximizeCalls.slice(-2), [['maximize', 'business-main'], ['restore']])

  for (const panelId of [...dockPanels.keys()]) dockPanels.delete(panelId)
  dockApi.activePanel = undefined
  layoutListener()
  renderWorkbench()
  const noPanelsNavigation = resolve(invoke(exports.SceneTabs, { workbenchActive: true }))
  const noPanelsMenu = find(noPanelsNavigation, node => node.props?.id === 'tl-scene-layout-menu')
  const noPanelsRecommendation = find(noPanelsMenu, node => node.type === 'button' && node.children?.includes('应用推荐布局'))
  assert.ok(noPanelsRecommendation, 'the global layout menu remains reachable after every Dockview panel is closed')
  noPanelsRecommendation.props.onClick()
  assert.equal(JSON.stringify(loadedDockLayouts.at(-1)), JSON.stringify(exports.getSnapshot().dockDefaults.center.dockview),
    'the global recovery action restores the configured recommendation when no group header exists')
  assert.equal(dockPanels.size, sceneConfig.scenes[0].panels.length, 'recommended reset recreates the closed panels')
})

test('narrow scene navigation focuses the requested panel when mounting an unvisited scene in real React DOM', { skip: !process.env.TRADELOOM_REACT_LIBRARY || !process.env.TRADELOOM_REACT_SERVER_LIBRARY || !process.env.TRADELOOM_DOM_MODULE }, async t => {
  const { createRequire } = await import('node:module')
  const nodeRequire = createRequire(import.meta.url)
  const React = nodeRequire(process.env.TRADELOOM_REACT_LIBRARY)
  const pinnedRequire = createRequire(process.env.TRADELOOM_REACT_SERVER_LIBRARY)
  const { createRoot } = pinnedRequire('react-dom/client')
  const act = React.act ?? pinnedRequire('react-dom/test-utils').act
  const { JSDOM } = nodeRequire(process.env.TRADELOOM_DOM_MODULE)
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://desktop.local/', pretendToBeVisual: true,
  })
  let hostSize = { width: 980, height: 650 }
  let dockResizeCallback
  const globals = ['window', 'document', 'navigator', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  let root
  try {
    const dockWriteCalls = []
    const dockWriteBodies = []
    const fetch = async (url, options = {}) => {
      dockWriteCalls.push([url, options.method ?? 'GET'])
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return { ...config, businessOrigin: 'http://desktop.local' } } }
      if (url === '/tradeloom/scene-layouts' && options.method === 'PUT') return { ok: true, async json() { return {} } }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return savedSceneState } }
      if (url === '/tradeloom/dock-layouts' && options.method === 'PUT') {
        dockWriteBodies.push(JSON.parse(options.body))
        return { ok: true, async json() { return {} } }
      }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return savedDockLayouts } }
      if (url === '/business-api/erpnext/status') return { ok: true, async json() { return { configured: false, connected: false, status: 'not_configured' } } }
      throw new Error(`unexpected synthetic request: ${url}`)
    }
    const installGlobal = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    installGlobal('window', dom.window)
    installGlobal('document', dom.window.document)
    installGlobal('navigator', dom.window.navigator)
    installGlobal('fetch', fetch)
    installGlobal('requestAnimationFrame', callback => dom.window.setTimeout(callback, 0))
    installGlobal('cancelAnimationFrame', id => dom.window.clearTimeout(id))
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

    const config = await readClientSceneConfig()
    const savedSceneState = defaultSceneWorkbench(config)
    savedSceneState.activeSceneId = 'center'
    savedSceneState.businessPath = '/home'
    const savedDockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedSceneState.layouts)
    const productsLayout = savedDockLayouts.scenes.products
    productsLayout.dockview.grid.root.data[0].size = 64
    productsLayout.closedPanelIds = ['auxiliary']
    const savedProductsLayoutBeforeNavigation = structuredClone(productsLayout)
    const centerLeaf = savedDockLayouts.scenes.center.dockview.grid.root.data[0]
    centerLeaf.data.activeView = 'business-main'
    savedDockLayouts.scenes.center.dockview.activeGroup = centerLeaf.data.id
    const erpLeaf = savedDockLayouts.scenes.erpnext.dockview.grid.root.data[0]
    erpLeaf.data.activeView = 'auxiliary'
    savedDockLayouts.scenes.erpnext.dockview.activeGroup = erpLeaf.data.id
    savedDockLayouts.scenes.erpnext.closedPanelIds = ['business-main']

    let registration
    const chunkSource = await readFile(sceneChunkUrl, 'utf8')
    dom.window.__ModuleLoader__ = { load(value) { registration = value } }
    runInNewContext(chunkSource, {
      window: dom.window, document: dom.window.document, React, URLSearchParams, fetch,
      crypto: dom.window.crypto,
      ResizeObserver: class {
        constructor(callback) { dockResizeCallback = callback }
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: callback => dom.window.setTimeout(callback, 0),
      cancelAnimationFrame: id => dom.window.clearTimeout(id),
      setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
    })

    const sceneByComponents = new WeakMap()
    const mountOrder = ['center', 'products', 'erpnext']
    let nextSceneIndex = 0
    const apiForScene = (sceneId, onPanelChange) => {
      const scene = config.scenes.find(item => item.id === sceneId)
    let maximizedPanelId = ''
      const makePanel = panel => ({
        id: panel.id,
        component: panel.type,
        api: {
          id: panel.id,
          setActive() { activePanelId = panel.id; activeListener?.({ panel: panels.get(panel.id), origin: 'user' }); onPanelChange() },
        setTitle() {}, close() {}, isMaximized() { return maximizedPanelId === panel.id },
        maximize() { maximizedPanelId = panel.id; maximizeListener?.() },
        exitMaximized() { maximizedPanelId = ''; maximizeListener?.() },
        },
      })
      const initiallyClosed = new Set(savedDockLayouts.scenes[sceneId].closedPanelIds ?? [])
      const panels = new Map(scene.panels.filter(panel => !initiallyClosed.has(panel.id)).map(panel => [panel.id, makePanel(panel)]))
      let activePanelId = scene.panels[0].id
      let activeListener
      let layoutListener
      let maximizeListener
      let layout = savedDockLayouts.scenes[sceneId].dockview
      const getActiveView = value => {
        const visit = node => {
          if (!node) return undefined
          if (node.type === 'leaf') return node.data.id === value.activeGroup ? node.data.activeView : undefined
          for (const child of node.data ?? []) { const selected = visit(child); if (selected) return selected }
          return undefined
        }
        return visit(value.grid?.root)
      }
      const api = {
        get activePanel() { return panels.get(activePanelId) },
        fromJSON(value) { layout = value; activePanelId = getActiveView(value) ?? scene.panels[0].id; layoutListener?.() },
        toJSON() { return layout }, layout() {},
        getPanel(id) { return panels.get(id) }, getPanels() { return [...panels.values()] },
        addPanel(panel) {
          let result = panels.get(panel.id)
          if (!result) {
            const definition = scene.panels.find(item => item.id === panel.id)
            if (definition) { result = makePanel(definition); panels.set(panel.id, result) }
          }
          activePanelId = panel.id
          onPanelChange()
          return result
        },
        hasMaximizedGroup() { return Boolean(maximizedPanelId) },
        maximizeGroup(panel) { panel.api.maximize() },
        exitMaximizedGroup() { panels.get(maximizedPanelId)?.api.exitMaximized() },
        onDidLayoutChange(listener) { layoutListener = listener; return { dispose() {} } },
        onDidActivePanelChange(listener) { activeListener = listener; return { dispose() {} } },
        onDidMaximizedGroupChange(listener) { maximizeListener = listener; return { dispose() {} } },
        onWillDragPanel() { return { dispose() {} } },
        onWillShowOverlay() { return { dispose() {} } },
        onWillDrop() { return { dispose() {} } },
      }
      return api
    }
    function DockviewReact({ components, onReady, ...props }) {
      let sceneId = sceneByComponents.get(components)
      if (!sceneId) {
        sceneId = mountOrder[nextSceneIndex++]
        sceneByComponents.set(components, sceneId)
      }
      const [, rerender] = React.useReducer(value => value + 1, 0)
      const apiRef = React.useRef(null)
      if (!apiRef.current) apiRef.current = apiForScene(sceneId, rerender)
      React.useEffect(() => { onReady({ api: apiRef.current }) }, [])
      const panel = apiRef.current.activePanel
      const Component = panel && components[panel.component]
      return React.createElement('div', { className: 'test-dockview', 'data-test-scene': sceneId, 'data-disable-dnd': String(props.disableDnd) },
        Component ? React.createElement(Component, { id: panel.id, sceneId, params: { panelId: panel.id }, api: panel.api }) : null)
    }
    const dockviewModule = { DockviewReact, dockviewCss: '' }
    const sceneRequire = Object.assign(name => {
      if (name === 'react') return React
      if (name === 'react-dom') return { createPortal: child => child }
      assert.fail(`unexpected scene dependency: ${name}`)
    }, { async: async () => dockviewModule })
    const sceneExports = registration.factory(sceneRequire)
    sceneExports.register({
      layout: { selectPanel() {} }, sessions: { retain() { return { ready: Promise.resolve(), release() {} } } },
      modelDirectories: { directoryFor() { return undefined } }, slots: { inject(_name, callback) { callback() }, register() { return () => {} } },
      effect() {}, on() {},
    })
    const SessionProvider = ({ children }) => children
    const App = () => React.createElement(React.Fragment, null,
      React.createElement(sceneExports.SceneTabs, { workbenchActive: true }),
      React.createElement(sceneExports.SceneWorkbench, { SessionProvider, renderSlot() { return null } }))
    const host = dom.window.document.getElementById('root')
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains('tl-dockview-host')) return { x: 0, y: 0, left: 0, top: 0, right: hostSize.width, bottom: hostSize.height, width: hostSize.width, height: hostSize.height, toJSON() { return this } }
      return originalRect.call(this)
    }
    root = createRoot(host)
    await act(async () => { root.render(React.createElement(App)); await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.ok(host.querySelector('.tl-dock-scene.is-active[aria-label="工作总览工作区"]'), 'the initial scene is visibly mounted')

    const productsTab = host.querySelector('button.tl-scene-tab[aria-label="商品"]')
    assert.ok(productsTab)
    await act(async () => {
      productsTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const activeProducts = host.querySelector('.tl-dock-scene.is-active[aria-label="商品工作区"]')
    assert.ok(activeProducts, 'clicking Products mounts its visible scene')
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'a 980x650 collaboration-grid host stays in multi-panel mode')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'false')
    assert.equal(activeProducts.querySelector('.tl-dock-panel')?.getAttribute('data-panel-id'), 'business-main')
    assert.deepEqual(savedDockLayouts.scenes.products, savedProductsLayoutBeforeNavigation,
      'scene navigation leaves an existing custom recommendation and its closed-panel list intact')
    const productsHost = activeProducts.querySelector('.tl-dockview-host')
    const productPutCountBeforeNarrow = dockWriteCalls.filter(([url, method]) => url === '/tradeloom/dock-layouts' && method === 'PUT').length
    const resizeProductHost = async size => {
      hostSize = size
      await act(async () => {
        dockResizeCallback([{ target: productsHost, contentRect: size }])
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    await resizeProductHost({ width: 959, height: 650 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      '959px host width is below the collaboration-grid cutoff')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'true')
    await resizeProductHost({ width: 980, height: 559 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      '559px host height is below the collaboration-grid cutoff')
    assert.equal(JSON.stringify(savedDockLayouts.scenes.products), JSON.stringify(savedProductsLayoutBeforeNavigation),
      'responsive single-panel mode does not rewrite user proportions or closed panels')
    assert.equal(dockWriteCalls.filter(([url, method]) => url === '/tradeloom/dock-layouts' && method === 'PUT').length,
      productPutCountBeforeNarrow, 'responsive resizing does not persist a narrow Dockview geometry')
    await resizeProductHost({ width: 960, height: 560 })
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'the recommended grid returns at the exact 960x560 boundary')
    assert.equal(activeProducts.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'false')

    const productsApi = sceneExports.getDockviewApi('products')
    const stableProductsAfterWideRestore = structuredClone(savedDockLayouts.scenes.products)
    const putCountBeforeHostResize = dockWriteBodies.length
    await resizeProductHost({ width: 940, height: 540 })
    assert.ok(activeProducts.querySelector('select[aria-label="选择当前面板"]'),
      'the observed 940x540 host enters single-panel mode')
    assert.equal(productsApi.hasMaximizedGroup(), true, 'narrow mode maximizes the selected panel in memory')
    assert.equal(dockWriteBodies.length, putCountBeforeHostResize,
      'the observed narrow resize does not persist temporary maximized geometry')
    await resizeProductHost({ width: 980, height: 650 })
    assert.equal(activeProducts.querySelector('select[aria-label="选择当前面板"]'), null,
      'the observed 980x650 host restores the multi-panel workbench')
    assert.equal(productsApi.hasMaximizedGroup(), false, 'returning wide exits temporary maximize')
    assert.deepEqual(savedDockLayouts.scenes.products, stableProductsAfterWideRestore,
      'narrow/wide host transitions preserve custom ratios and closed-panel IDs')
    assert.ok(dockWriteBodies.every(body => !Object.hasOwn(body.scenes.products.dockview.grid, 'maximizedNode')),
      'the HTTP queue never persists temporary maximized geometry')

    await resizeProductHost({ width: 959, height: 650 })
    const erpTab = host.querySelector('button.tl-scene-tab[aria-label="ERPNext"]')
    assert.ok(erpTab)
    await act(async () => {
      erpTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const activeScene = host.querySelector('.tl-dock-scene.is-active[aria-label="ERPNext工作区"]')
    assert.ok(activeScene, 'clicking the scene navigator makes ERPNext the active visible workbench')
    assert.equal(activeScene.style.display, 'flex')
    assert.equal(host.querySelector('button.tl-scene-tab[aria-label="ERPNext"]').getAttribute('aria-current'), 'page')
    assert.ok(activeScene.querySelector('select[aria-label="选择当前面板"]'), 'the 959px canvas enters narrow single-pane mode')
    assert.equal(activeScene.querySelector('.test-dockview')?.getAttribute('data-disable-dnd'), 'true')
    const visiblePanel = activeScene.querySelector('.tl-dock-panel')
    assert.equal(visiblePanel?.getAttribute('data-panel-id'), 'business-main',
      'narrow unvisited scenes show the requested main business panel instead of the saved auxiliary placeholder')
    assert.equal(visiblePanel?.getAttribute('data-panel-type'), 'erpnext-status')
    assert.deepEqual(savedDockLayouts.scenes.erpnext.closedPanelIds, ['business-main'], 'the saved closed-panel state is not rewritten by navigation')
    assert.equal(erpLeaf.data.activeView, 'auxiliary', 'the saved group selection remains unchanged while navigation opens the required panel in memory')
  } finally {
    if (root) await act(async () => root.unmount())
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})

test('native role sessions retain composer drafts across scene switches and release at workbench teardown', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))
  const calls = []
  const sessions = { retain(sessionId, options) {
    const reference = { sessionId, release() { calls.push(['release', sessionId]) } }
    calls.push(['retain', sessionId, options])
    return reference
  } }

  const center = exports.retainRoleSession(sessions, 'center', 'session-center')
  const product = exports.retainRoleSession(sessions, 'product', 'session-product')
  const centerAgain = exports.retainRoleSession(sessions, 'center', 'session-center')
  assert.strictEqual(centerAgain, center, 'returning to a scene reuses its live Session scope and composer draft')
  assert.notStrictEqual(product, center, 'each role keeps an independent native Session scope')
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] === 'retain'))), [
    ['retain', 'session-center', { source: 'mainView' }],
    ['retain', 'session-product', { source: 'mainView' }],
  ])
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [], 'scene switches must not dispose another role composer')

  exports.releaseRoleSessions()
  assert.deepEqual(calls.filter(call => call[0] === 'release'), [
    ['release', 'session-center'], ['release', 'session-product'],
  ], 'the bounded role pool is released when the workbench context ends')
})

test('role selection binds the AgentDirectory session response without a duplicate request', async () => {
  let registration
  let sessionPosts = 0
  const source = await readFile(sceneChunkUrl, 'utf8')
  const config = await readClientSceneConfig()
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async (url, options = {}) => {
      if (url === '/tradeloom/scenes') return { ok: true, async json() { return config } }
      if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return savedState } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      if (url === '/tradeloom/scene-layouts') return { ok: true }
      if (url === '/tradeloom/session') { sessionPosts++; return { ok: true, async json() { return { role: 'product', sessionId: 'session-product' } } } }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const React = { createElement(type, props, ...children) { return { type, props, children } }, useState: value => [value, () => {}], useEffect(effect) { effect() } }
  const exports = registration.factory(() => React)
  exports.register({ layout: { selectPanel() {} }, sessions: { retain() {} }, slots: { inject(_name, register) { register() }, register() {} }, effect() {} })
  exports.SceneTabs()
  for (let attempt = 0; attempt < 20 && !exports.getSnapshot().config; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(await exports.selectRole('product', 'session-product'), true)
  assert.equal(sessionPosts, 0, 'the caller already created the session; selecting the role must bind it without another POST')
})

test('model directory entries retain the directory provider/model identity for selection', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: value => [value, () => {}], useEffect() {} }
  const exports = registration.factory(() => React)
  const groups = exports.modelDirectoryEntries([
    { id: 'provider-a', name: '接口 A', models: [{ id: 'model-a', name: '模型 A' }] },
    { id: 'provider-b', name: '接口 B', models: [{ id: 'model-b', name: '模型 B' }] },
  ])
  assert.deepEqual(groups.map(group => [group.provider, group.models.map(model => model.id)]), [
    ['provider-a', ['model-a']], ['provider-b', ['model-b']],
  ])
  assert.deepEqual(['接口 A', '接口 B', 'DeepSeek API', '织贸助手', ''].map(exports.providerBadgeLabel), ['A', 'B', 'D', '织', '模'],
    'provider badges use the first visible ASCII identifier when present and retain a readable Unicode fallback')
  assert.equal(exports.currentModelLabel({ provider: 'provider-a', model: 'model-a' }, groups), '接口 A · 模型 A')
  assert.equal(exports.currentModelLabel({ provider: 'removed-provider', model: 'secret-raw-id' }, groups), '已选择模型',
    'the rail must never fall back to exposing provider or model identifiers')
  const config = await readClientSceneConfig()
  const railSnapshot = { config, activeSceneId: 'center', sessionBindings: { center: 'session-center' } }
  const directoryInfo = {
    key: JSON.stringify(['center', 'session-center']), status: 'ready', snapshot: {
      groups: [{ id: 'provider-a', name: '接口 A', models: [{ id: 'model-a', name: '模型 A' }] }],
      current: { provider: 'provider-a', model: 'model-a' },
    }, error: '',
  }
  let hookIndex = 0
  const railReact = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState() { return [[railSnapshot, directoryInfo, ''][hookIndex++], () => {}] },
    useEffect() {},
  }
  const rail = registration.factory(() => railReact).ModelDirectoryRail()
  const findNodes = (node, predicate, result = []) => {
    if (Array.isArray(node)) for (const child of node) findNodes(child, predicate, result)
    else if (node && typeof node === 'object') {
      if (predicate(node)) result.push(node)
      findNodes(node.children, predicate, result)
    }
    return result
  }
  const providerSummary = findNodes(rail, node => node.type === 'summary')[0]
  const modelOption = findNodes(rail, node => node.type === 'button' && node.props.title === '接口 A · 模型 A')[0]
  assert.equal(providerSummary.children[0], 'A', 'provider controls use a distinguishable ASCII initial instead of a repeated Chinese initial')
  assert.equal(providerSummary.props['aria-label'], '接口 A模型列表')
  assert.equal(providerSummary.props.title, '接口 A')
  assert.equal(findNodes(rail, node => node.type === 'strong')[0].children[0], '接口 A', 'the open provider menu retains the complete provider name')
  assert.equal(modelOption.props['aria-label'], '选择接口 A的模型 A')
  const currentModel = findNodes(rail, node => node.props?.className === 'tl-model-current')[0]
  assert.equal(currentModel.children[0], '接口 A · 模型 A')
  assert.equal(currentModel.props.title, '接口 A · 模型 A')
  assert.deepEqual(config.roles.map(role => [role.id, role.assistantLabel]), [
    ['center', '中心助手'], ['product', '商品助手'], ['market', '市场助手'],
    ['quote', '询报价助手'], ['delivery', '交付助手'], ['user-profile', '资料助手'],
  ], 'role metadata keeps the original native conversation titles as a separate display field')
  assert.equal(exports.assistantLabel('delivery', config), '交付助手')
  assert.deepEqual(JSON.parse(JSON.stringify(exports.bindSession({ product: 'session-product' }, 'delivery', 'session-delivery', config))), {
    product: 'session-product', delivery: 'session-delivery',
  })
})

test('appearance control follows an asynchronous DSH preference update', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  let preference = 'system'
  let colorScheme = 'light'
  const themeListeners = new Map()
  const selected = []
  const theme = {
    getTheme: () => ({ preference, active: { colorScheme } }),
    setTheme(next) {
      selected.push(next)
      setTimeout(() => {
        preference = next
        colorScheme = next === 'dark' ? 'dark' : 'light'
        themeListeners.get('theme/change')?.(theme.getTheme())
      }, 2)
    },
  }
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const values = [
        { config: null, activeSceneId: 'center', sessionBindings: {} },
        { key: '', status: 'idle', snapshot: null, error: '' },
        '',
      ]
      const index = hookIndex++
      if (hookValues[index] === undefined) hookValues[index] = index < values.length ? values[index] : initial
      return [hookValues[index], value => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value }]
    },
    useEffect() {},
  }
  const exports = registration.factory(() => React)
  exports.register({
    theme,
    slots: { inject(_name, register) { register() }, register() {} },
    on(name, listener) { themeListeners.set(name, listener); return () => themeListeners.delete(name) },
    effect() {},
  })
  const findNode = (node, predicate) => {
    if (Array.isArray(node)) return node.map(item => findNode(item, predicate)).find(Boolean)
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    return node.children?.map(child => findNode(child, predicate)).find(Boolean)
  }
  const rail = exports.ModelDirectoryRail()
  const themeButton = findNode(rail, node => node.props?.className === 'tl-theme-cycle')
  themeButton.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.deepEqual(selected, ['dark'])
  assert.equal(preference, 'dark')
  assert.equal(colorScheme, 'dark')
  hookIndex = 0
  const updatedRail = exports.ModelDirectoryRail()
  const updatedThemeButton = findNode(updatedRail, node => node.props?.className === 'tl-theme-cycle')
  assert.equal(updatedThemeButton.props['aria-label'], '当前外观：深色，切换到跟随系统')
  assert.match(findNode(updatedRail, node => node.props?.className?.includes('tl-model-rail'))
    .props.className, /is-dark/)

})

test('model directory diagnostics expose only a safe phase and allowlisted failure category', async () => {
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => ({ createElement() {} }))

  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error('ui-model-selection: session "private-session-id" resolved no scope'),
  ))), {
    phase: 'directoryFor', reason: 'missingScope', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error('ui-model-selection: session "private-session-id" resolved no binding'),
  ))), {
    phase: 'directoryFor', reason: 'missingBinding', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(exports.modelDirectoryDiagnostic(
    'directoryFor', new Error("Cannot read properties of undefined (reading 'directoryFor')"),
  ))), {
    phase: 'directoryFor', reason: 'missingInjected:modelDirectories',
    error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.equal(exports.modelDirectoryDiagnostic('retain', new Error('cannot get property "sessions" without inject')).reason, 'missingInjected:sessions')
  assert.equal(exports.modelDirectoryDiagnostic('ready', new Error('cannot get property "remote.session" without inject')).reason, 'missingInjected:remote.session')
  assert.equal(exports.modelDirectoryDiagnostic('ready', new Error('cannot get property "authorization" without inject')).reason, 'unavailable')
  const remoteFailure = exports.modelDirectoryDiagnostic('load', new Error('secret URL and credential text'))
  assert.deepEqual(JSON.parse(JSON.stringify(remoteFailure)), {
    phase: 'load', reason: 'unavailable', error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
  })
  assert.equal(JSON.stringify(remoteFailure).includes('secret URL'), false)
})

test('model directory failure renders an accessible stage diagnostic without exposing the exception', async t => {
  const reactPath = process.env.TRADELOOM_REACT_LIBRARY
  const serverPath = process.env.TRADELOOM_REACT_SERVER_LIBRARY
  if (!reactPath || !serverPath) return t.skip('set candidate7 React library paths to render the real React component')
  const { createRequire } = await import('node:module')
  const React = createRequire(import.meta.url)(reactPath)
  const renderToStaticMarkup = createRequire(import.meta.url)(serverPath).renderToStaticMarkup
  let registration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    React,
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const exports = registration.factory(() => React)
  const diagnostic = exports.modelDirectoryDiagnostic(
    'ready', new Error('cannot get property "remote.session" without inject'),
  )
  const markup = renderToStaticMarkup(React.createElement(exports.ModelDirectoryFailure, { diagnostic }))
  assert.match(markup, /role="status"/)
  assert.match(markup, /data-model-directory-phase="ready"/)
  assert.match(markup, /data-model-directory-error="missingInjected:remote\.session"/)
  assert.match(markup, /模型目录暂时无法加载，请重新打开工作台或检查模型配置。/)
  assert.doesNotMatch(markup.replace(/<[^>]+>/g, ''), /missingInjected:remote\.session/)
  assert.doesNotMatch(markup, /without inject/)
})

test('client entry loads the registered scene chunk and preserves the existing shell slots', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(name => { assert.equal(name, 'react'); return React })
  const calls = []
  const slots = {
    inject(name, register) { calls.push({ name, result: register() }) },
    register(spec, component) { calls.push({ spec, component }); return () => {} },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => { assert.equal(name, './client.scenes.js'); return chunk }
  const plugin = entryRegistration.factory(entryRequire)
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: { openSession() {} } })
  assert.ok(calls.some(call => call.spec?.name === 'shell.top'), 'business and scene navigation must keep the existing top slot')
  assert.ok(calls.some(call => call.spec?.key === 'scene-workbench'), 'scene grid must register as a native main panel')
  assert.ok(calls.some(call => call.spec?.key === 'business-home'), 'existing business panels must remain registered')
  assert.equal(calls.some(call => call.spec?.name === 'sidebar.agents'), false, 'the Agent list must not occupy the conversation sidebar')
  const top = calls.find(call => call.spec?.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const findAgentSelector = node => {
    if (!node || typeof node !== 'object') return undefined
    if (node.type?.name === 'AgentDirectory') return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(findAgentSelector).find(Boolean) : findAgentSelector(child)
      if (found) return found
    }
  }
  assert.ok(findAgentSelector(top), 'the existing AgentDirectory component must be reused in the top model row')
  const modelRow = (function find(node) {
    if (!node || typeof node !== 'object') return undefined
    if (node.props?.className === 'tl-top-model-row') return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(find).find(Boolean) : find(child)
      if (found) return found
    }
  })(top)
  assert.ok(modelRow, 'the compact helper chooser and model rail share the first top row')
  assert.equal(modelRow.children[0].props.className, 'tl-shell-brand', 'the real TradeLoom identity leads the provider controls')
  assert.equal(modelRow.children[1].type.name, 'AgentDirectory', 'the helper selector stays to the left of model controls')
  assert.equal(modelRow.children[2].type.name, 'ModelDirectoryRail')
  const railStyle = modelRow.children[2].type().children.find(child => child?.props?.['data-tradeloom-navigation-style'])
  assert.match(railStyle.children[0], /\.tl-model-rail\s*\{[\s\S]*display:\s*flex;\s*flex:\s*1 1 0/,
    'the model rail fills remaining space so theme and tools stay aligned at the far right')
  assert.match(railStyle.children[0], /\.tl-theme-toggle\s*\{[^}]*margin-left:\s*auto/)
})

test('client entry passes the real Cordis context through to scene registration', { skip: !process.env.TRADELOOM_CORDIS_LIBRARY }, async () => {
  const cordisPath = process.env.TRADELOOM_CORDIS_LIBRARY.replaceAll('\\', '/')
  const { Context } = await import(pathToFileURL(cordisPath).href)
  const ctx = new Context()
  const registrations = []
  const selectedPanels = []
  const openedSessions = []
  const retainedSessions = []
  const releasedSessions = []
  const sessions = {
    retain(sessionId, options) {
      const reference = { sessionId, ready: Promise.resolve(), release() { releasedSessions.push(sessionId) } }
      retainedSessions.push({ sessionId, options, reference })
      return reference
    },
  }
  const remoteSession = { modelCatalog() { return Promise.resolve({ groups: [] }) } }
  const theme = { getTheme() { return { preference: 'system', active: { colorScheme: 'light' } } }, setTheme() {} }
  const documentListeners = []
  const businessOrigin = 'http://127.0.0.1:3088'
  const layout = { selectPanel(...args) { selectedPanels.push(args) } }
  const uiWorkspace = { openSession(...args) { openedSessions.push(args) } }
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) { registrations.push({ type: 'slot', spec, component }); return () => {} },
  }
  const services = await ctx.registry.plugin({
    name: 'tradeloom-scene-regression-services', inject: [],
    apply(serviceCtx) {
      serviceCtx.reflect.provide('slots', slots)
      serviceCtx.reflect.provide('layout', layout)
      serviceCtx.reflect.provide('uiWorkspace', uiWorkspace)
      serviceCtx.reflect.provide('sessions', sessions)
      serviceCtx.reflect.provide('modelDirectories', { directoryFor() { throw new Error('not used in this test') } })
      serviceCtx.reflect.provide('remote', { session: remoteSession })
      serviceCtx.reflect.provide('remote.session', remoteSession)
      serviceCtx.reflect.provide('theme', theme)
    },
  })

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, value => stateUpdates.push(typeof value === 'function' ? value(initial) : value)],
    useRef: initial => ({ current: initial }),
    useEffect(effect) { effect() },
  }
  const stateUpdates = []
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  let entryRegistration
  runInNewContext(entrySource, {
    URL, URLSearchParams,
    window: { document: { addEventListener(...args) { documentListeners.push(args) }, removeEventListener() {} }, __ModuleLoader__: { load(value) { entryRegistration = value } } },
  })
  let chunkRegistration
  const config = { ...(await readClientSceneConfig()), businessOrigin }
  const layoutState = {
    version: 1, activeSceneId: 'center',
    roleByScene: Object.fromEntries(config.scenes.map(scene => [scene.id, scene.roleId])),
    businessPath: '/home',
    layouts: Object.fromEntries(config.scenes.map(scene => [scene.id, { expandedPanel: '', panels: {} }])),
  }
  const defaultDockState = normalizeDockLayouts(config, { version: 2, scenes: {} }, defaultSceneWorkbench(config).layouts)
  const fetchRequests = []
  const fetch = async (url, options = {}) => {
    fetchRequests.push([url, options.method ?? 'GET', options.body])
    if (url === '/tradeloom/scenes') return { ok: true, async json() { return config } }
    if (url === '/tradeloom/scene-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return layoutState } }
    if (url === '/tradeloom/scene-layouts') return { ok: true }
    if (url === '/tradeloom/dock-layouts' && (options.method ?? 'GET') === 'GET') return { ok: true, async json() { return defaultDockState } }
    if (url === '/tradeloom/dock-layouts' && options.method === 'PUT') return { ok: true, async json() { return defaultDockState } }
    if (url === '/tradeloom/session') {
      const role = JSON.parse(options.body).role
      return { ok: true, async json() { return { role, sessionId: `cordis-${role}-session` } } }
    }
    throw new Error(`unexpected scene request ${url}`)
  }
  runInNewContext(chunkSource, { fetch, window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  let sceneExports
  const clientRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const client = entryRegistration.factory(clientRequire)
  assert.ok(client.inject.includes('remote') && client.inject.includes('remote.session'),
    'the shell root must declare its native model-directory remote dependencies')
  const clientFiber = ctx.registry.plugin({
    name: 'tradeloom-business-shell-client-test',
    inject: client.inject,
    apply(clientContext) {
      assert.strictEqual(clientContext.remote.session, remoteSession,
        'the root shell context can access the native model catalog dependency on first entry')
      return client.apply(clientContext)
    },
  })
  await clientFiber
  assert.deepEqual(selectedPanels, [['scene-workbench']], 'the first client load selects the formal workbench before an old full-screen conversation is restored')

  assert.ok(registrations.some(item => item.type === 'slot' && item.spec.key === 'scene-workbench'),
    'the real scene register must resolve injected ctx.slots and register its panel')
  assert.ok(sceneExports, 'the actual client scene chunk must load through require.async')
  assert.equal(typeof sceneExports.SceneTabs, 'function')
  sceneExports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fetchRequests.slice(0, 2).map(([url]) => url), ['/tradeloom/scenes', '/tradeloom/scene-layouts'], 'the scene tab loads its config and saved layout')
  await sceneExports.retryLoadConfig()
  assert.deepEqual(sceneExports.getSnapshot().config.roles, publicRoleMetadata(), 'the live Cordis scene context loaded safe role metadata')
  const tabs = sceneExports.SceneTabs()
  assert.deepEqual(documentListeners.map(([eventName]) => eventName), ['load', 'click'],
    `the scene chunk must receive the callback after config loads: ${JSON.stringify(tabs)}`)
  assert.ok(registrations.some(item => item.type === 'slot' && item.spec.key === 'business-home'),
    'the existing client entry remains active under the same Cordis service context')

  const visit = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => visit(item, predicate)).find(Boolean) : visit(child, predicate)
      if (found) return found
    }
  }
  const profileTab = visit(tabs, node => node.type === 'button' && node.props?.['aria-label'] === '资料整理')
  profileTab.props.onClick()
  assert.deepEqual(selectedPanels, [['scene-workbench'], ['scene-workbench']], 'the injected layout service selects the existing scene panel')

  assert.equal(registrations.some(item => item.type === 'slot' && item.spec.name === 'sidebar.agents'), false,
    'role selection must leave the original sidebar history area available')
  assert.equal(await sceneExports.selectRole('product'), true, 'the registered scene context can switch the active scene role')
  assert.deepEqual(fetchRequests.filter(([url, method]) => url === '/tradeloom/session' && method === 'POST').map(([, , body]) => JSON.parse(body).role), ['product'], 'scene role selection creates exactly one session')
  assert.deepEqual(selectedPanels, [['scene-workbench'], ['scene-workbench'], ['scene-workbench']], 'scene and Agent navigation keep the workbench selected')
  assert.deepEqual(retainedSessions, [], 'selecting a role does not retain another scope before its scene mounts')
  assert.deepEqual(releasedSessions, [])
  assert.equal(openedSessions.length, 0, 'role selection no longer opens the full-screen conversation panel')

  sceneExports.retainRoleSession(sessions, 'product', 'cordis-product-session')
  sceneExports.retainRoleSession(sessions, 'center', 'cordis-center-session')
  assert.deepEqual(retainedSessions.map(item => item.sessionId), ['cordis-product-session', 'cordis-center-session'])
  assert.ok(clientFiber.ctx.fiber.getEffects().some(effect => effect?.label === 'tradeloom scene workbench role sessions'),
    'Cordis owns the workbench session-release cleanup on the client plugin fiber')

  const themeRevisionBeforeDispose = sceneExports.getSnapshot().themeRevision ?? 0
  await clientFiber.dispose()
  assert.equal(clientFiber.ctx.fiber.uid, null, 'Cordis plugin fiber is disposed')
  clientFiber.ctx.emit('theme/change', { active: { colorScheme: 'dark' } })
  assert.equal(sceneExports.getSnapshot().themeRevision ?? 0, themeRevisionBeforeDispose,
    'Cordis automatically removes theme listeners owned by the disposed plugin fiber')
  assert.deepEqual(releasedSessions, ['cordis-product-session', 'cordis-center-session'], 'disposing the Cordis plugin releases every retained role scope')
  await services.dispose()
})

test('scene client forwards the server-reported business origin only after loading scene config', async () => {
  let registration
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect(effect) { effect() },
  }
  const businessOrigin = 'http://192.168.1.23:3088'
  const config = await readClientSceneConfig()
  config.businessOrigin = businessOrigin
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  runInNewContext(chunkSource, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async url => ({ ok: true, async json() {
      if (url === '/tradeloom/scenes') return config
      if (url === '/tradeloom/scene-layouts') return savedState
      if (url === '/tradeloom/dock-layouts') return dockLayouts
      throw new Error(`unexpected request ${url}`)
    } }),
  })
  const origins = []
  const roleUpdates = []
  const exports = registration.factory(() => React)
  exports.register({
    layout: { selectPanel() {} }, uiWorkspace: { openSession() {} },
    slots: { inject(_name, register) { register() }, register() { return () => {} } },
  }, value => origins.push(value), roles => roleUpdates.push(roles))
  exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(origins, [businessOrigin])
  assert.deepEqual(JSON.parse(JSON.stringify(roleUpdates.at(-1))), {
    status: 'ready', error: '', roles: publicRoleMetadata(),
  }, 'the existing scenes request supplies loading state and safe role display metadata')
})

test('embedded empty-session composer docks below its stable session slot anchor', { skip: !process.env.TRADELOOM_DOM_TEST_ROOT }, async () => {
  const domPath = `${process.env.TRADELOOM_DOM_TEST_ROOT.replaceAll('\\', '/')}/node_modules/jsdom/lib/api.js`
  const { JSDOM } = await import(pathToFileURL(domPath).href)
  const source = await readFile(sceneChunkUrl, 'utf8')
  const rule = source.match(/(\.tl-dock-panel-body\.is-native-chat\s+\[data-content-phase="active"\]\s+\[data-conversation-scroll\]\s*>\s*\[data-slot="conversation\.session"\]:not\(:has\(\[data-slot="conversation\.view"\]\)\)\s*\+\s*\[data-composer-seat\])\s*\{\s*margin-block-start:\s*auto;\s*\}/)
  assert.ok(rule, 'embedded-only styling targets the empty native session slot, not a DOM-only-child assumption')

  const marginFor = viewMarkup => {
    const dom = new JSDOM(`<style>${rule[0]}</style><div class="tl-dock-panel-body is-native-chat"><div data-content-phase="active"><div data-conversation-scroll><div data-slot="conversation.session" style="display:contents">${viewMarkup}</div><div data-composer-seat></div></div></div></div>`)
    const seat = dom.window.document.querySelector('[data-composer-seat]')
    return dom.window.getComputedStyle(seat).marginBlockStart
  }
  assert.equal(marginFor(''), 'auto', 'a blank session keeps its stable empty slot anchor while the composer seat receives the free space')
  assert.notEqual(marginFor('<div data-slot="conversation.view"></div>'), 'auto', 'sessions with a conversation view keep their existing active transcript/composer flow')
})

test('business and scene navigation share the single rendered shell.top occupant', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const topSlotPatch = await readFile(new URL('../../../integrations/dsh/patches/ui-layout-shell-top.patch', import.meta.url), 'utf8')
  assert.match(topSlotPatch, /\+\s+'shell\.top': \{ kind: 'single'; scope: 'root' \}/)
  assert.match(topSlotPatch, /renderSlot\('shell\.top', \{\}\)/)
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], next => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
    },
    useRef(initial) { const index = hookIndex++; return hookValues[index] ??= { current: initial } },
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(() => React)
  const calls = []
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) {
      if (spec.name === 'shell.top' && calls.some(call => call.spec.name === 'shell.top')) {
        throw new Error('single slot shell.top already has an occupant')
      }
      calls.push({ spec, component })
      return () => {}
    },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => { assert.equal(name, './client.scenes.js'); return chunk }
  const plugin = entryRegistration.factory(entryRequire)
  const layoutCalls = []
  const layout = { selectPanel(id) { layoutCalls.push(['panel', id]) }, toggleSidebar() { layoutCalls.push(['sidebar']) } }
  await plugin.apply({ slots, layout, uiWorkspace: { openSession() {} } })

  const top = calls.filter(call => call.spec.name === 'shell.top')
  assert.equal(top.length, 1)
  const tree = top[0].component({ usePanelInfo: () => ({}) })
  const componentNames = []
  const visit = node => { if (!node || typeof node !== 'object') return; if (typeof node.type === 'function') componentNames.push(node.type.name); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child) }
  visit(tree)
  assert.ok(componentNames.includes('BusinessMenu'))
  assert.ok(componentNames.includes('ShellToolsMenu'), 'utility actions live in the compact first row')
  const findNode = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => findNode(item, predicate)).find(Boolean) : findNode(child, predicate)
      if (found) return found
    }
  }
  const toolsElement = findNode(tree, node => node?.type?.name === 'ShellToolsMenu')
  assert.ok(toolsElement)
  hookValues.length = 0
  hookIndex = 0
  let toolsTree = toolsElement.type()
  const trigger = toolsTree.children.find(node => node?.type === 'button')
  assert.equal(trigger.props['aria-label'], '打开工具菜单')
  trigger.props.onClick()
  hookIndex = 0
  toolsTree = toolsElement.type()
  const menu = findNode(toolsTree, node => node?.props?.role === 'group')
  const actions = menu.children.filter(node => node?.type === 'button')
  assert.ok(actions.some(node => node.children.includes('刷新场景配置')), 'scene configuration refresh stays in the utility menu')
  for (const [label, expected] of [['返回工作台', ['panel', 'scene-workbench']], ['插件管理', ['panel', 'plugins']], ['自动化', ['panel', 'schedules']], ['切换会话侧栏', ['sidebar']]]) {
    const action = actions.find(node => node.children.includes(label))
    assert.ok(action, `${label} is present in the shell tools menu`)
    action.props.onClick()
    assert.deepEqual(layoutCalls.at(-1), expected)
  }
  hookIndex = 0
  const workbenchTools = toolsElement.type({ workbenchActive: true })
  workbenchTools.children.find(node => node?.type === 'button').props.onClick()
  hookIndex = 0
  const openedWorkbenchTools = toolsElement.type({ workbenchActive: true })
  const workbenchMenu = findNode(openedWorkbenchTools, node => node?.props?.role === 'group')
  const workbenchSidebarAction = workbenchMenu.children.find(node => node?.type === 'button' && node.children.includes('切换会话侧栏'))
  assert.ok(workbenchSidebarAction, 'the native sidebar toggle stays available in workbench mode')
  workbenchSidebarAction.props.onClick()
  assert.deepEqual(layoutCalls.at(-1), ['sidebar'], 'workbench mode uses the existing Host sidebar toggle contract')
  const menuElement = tree.children.find(node => node?.type?.name === 'BusinessMenu')
  assert.equal(menuElement.props.SceneTabs, chunk.SceneTabs, 'scene controls are rendered inside the existing business navigation owner')
  const menuTree = menuElement.type({ ...menuElement.props, usePanelInfo: () => ({}) })
  const conversationEntry = menuTree.children.find(child => child?.props?.className === 'tl-conversation-entry')
  assert.ok(conversationEntry, 'the native conversation entry is explicit in the secondary navigation row')
  assert.equal(conversationEntry.props.disabled, true, 'an unavailable conversation entry cannot act as an empty button')
  assert.equal(conversationEntry.props['aria-label'], '当前助手尚未连接，无法打开对话', 'the unavailable state is explained to assistive technology')
  const navs = []
  const findNavs = node => { if (!node || typeof node !== 'object') return; if (node.type === 'nav') navs.push(node); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(findNavs) : findNavs(child) }
  findNavs(menuTree)
  assert.equal(navs.length, 1, 'the unified row has one navigation landmark')
  assert.equal(navs[0].props.className, 'tl-navigation')
  assert.ok(navs[0].children.some(child => child?.type === chunk.SceneTabs), 'scene tabs remain in the second navigation row after its scoped style node')
  const navStyle = navs[0].children.find(child => child?.props?.['data-tradeloom-nav-style'])
  assert.match(navStyle.children[0], /\.tl-shell-top\s*\{[^}]*visibility:\s*visible\s*;/,
    'the shell top explicitly remains visible when a collapsed-sidebar plugin rule targets its slot')
  assert.match(navStyle.children[0], /html\[data-meow-smooth-furled\]\s+\.tl-top-model-row\s*\{[^}]*padding-inline-start:\s*66px\s*;/,
    'the first navigation row reserves the 56px collapsed-sidebar FAB plus its existing 10px inset')
  assert.match(navStyle.children[0], /\.tl-navigation \.tl-scene-tab \{ font: inherit; color: inherit; background: transparent; \}/,
    'scene controls inherit the unified navigation typography')
  const toolsStyle = navStyle.children[0]
  assert.match(toolsStyle, /\.tl-shell-tools-menu\s*\{[^}]*position:\s*absolute/s, 'the row-one tools menu is positioned below its trigger')
  assert.ok(navs[0].children.every(child => !(child?.type === 'button' && child.children.includes('连接手机'))),
    'the phone action is moved out of the crowded business navigation row')
})

test('agent selector shows scene-config failure and retries the existing request until role metadata loads', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const chunkSource = await readFile(sceneChunkUrl, 'utf8')
  let entryRegistration
  let chunkRegistration
  let fetch
  let triggerFocusCount = 0
  const persistedOperations = new Map()
  const elements = (type, props, ...children) => {
    const node = { type, props: props ?? {}, children }
    if (props?.ref && typeof props.ref === 'object') {
      props.ref.current = type === 'button' && props['aria-label'] === '打开工具菜单'
        ? { focus() { triggerFocusCount++ } }
        : { contains(target) { return target?.insideShellTools === true } }
    }
    return node
  }
  const hookValues = []
  let hookIndex = 0
  const effectValues = []
  const documentListeners = new Map()
  const testDocument = {
    querySelectorAll: () => [],
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set())
      documentListeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener) },
    dispatch(type, event) { for (const listener of documentListeners.get(type) ?? []) listener({ type, ...event }) },
  }
  const React = {
    createElement: elements, Fragment: 'fragment',
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], next => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = { current: initial }
      return hookValues[index]
    },
    useLayoutEffect(effect, dependencies) {
      const index = hookIndex++
      const previous = effectValues[index]
      if (!previous || !dependencies || dependencies.some((value, item) => value !== previous.dependencies?.[item])) {
        previous?.cleanup?.()
        effectValues[index] = { dependencies, cleanup: effect() }
      }
    },
    useEffect(effect, dependencies) {
      const index = hookIndex++
      const previous = effectValues[index]
      if (!previous || !dependencies || dependencies.some((value, item) => value !== previous.dependencies?.[item])) {
        previous?.cleanup?.()
        effectValues[index] = { dependencies, cleanup: effect() }
      }
    },
  }
  const window = {
    location: { origin: 'http://desktop.local' },
    crypto: { randomUUID: () => '70f31e2d-716a-4d55-a43d-d4f3898ac4d0' },
    localStorage: {
      getItem(key) { return persistedOperations.get(key) ?? null },
      setItem(key, value) { persistedOperations.set(key, value) },
      removeItem(key) { persistedOperations.delete(key) },
    },
    document: testDocument,
    addEventListener() {}, removeEventListener() {},
    __ModuleLoader__: { load(value) { entryRegistration = value } },
  }
  runInNewContext(entrySource, { window, document: testDocument, fetch: (...args) => fetch(...args) })
  runInNewContext(chunkSource, { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } }, document: testDocument, fetch: (...args) => fetch(...args) })

  const config = await readClientSceneConfig()
  const saved = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, saved.layouts)
  let sceneFetches = 0
  const requests = []
  const openedNativeSessions = []
  const selectedShellPanels = []
  const capabilityRequests = new Map()
  const capabilityFetchOptions = []
  const configurationRequests = new Map()
  const configurationGetCount = new Map()
  const configurationFetchOptions = []
  const savedConfigurations = new Map()
  let releaseConfigurationSave
  const configFixture = role => savedConfigurations.get(role) ?? {
    role, preset: `tradeloom-${role}`, revision: 'a'.repeat(64), editable: true,
    mcpServers: role === 'product' ? [{ id: 'tradeloom-mcp-products', transport: 'streamable-http', serverName: 'products',
      url: 'http://127.0.0.1:3090/mcp', headers: { Authorization: { envName: 'PRODUCTS_TOKEN', scheme: 'bearer', present: true } },
      toolCallTimeoutMs: 30000, failOnStartupError: false }] : [],
    skill: { includeDefaultRoots: true, customSkillDirs: role === 'product' ? ['skills/nested'] : [] },
    deniedTools: role === 'product' ? ['offline-legacy-tool'] : [],
  }
  let newSessionCalls = 0
  let releaseNewSession
  const newSessionPayloads = []
  fetch = async (url, options = {}) => {
    requests.push([url, options.method ?? 'GET'])
    if (url.startsWith('/tradeloom/agent-configuration?')) {
      configurationFetchOptions.push(options)
      const role = new URL(url, 'http://desktop.local').searchParams.get('role')
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body)
        savedConfigurations.set(role, { ...configFixture(role), ...body, revision: 'b'.repeat(64), editable: true })
        return await new Promise(resolve => { releaseConfigurationSave = () => resolve({ ok: true, async json() { return { role, preset: `tradeloom-${role}`, revision: 'b'.repeat(64), appliedForNewAgents: true, currentSessionUnchanged: true } } }) })
      }
      const count = (configurationGetCount.get(role) ?? 0) + 1
      configurationGetCount.set(role, count)
      if (count === 1) return await new Promise(resolve => configurationRequests.set(role, resolve))
      return { ok: true, async json() { return configFixture(role) } }
    }
    if (url === '/tradeloom/session/new') {
      newSessionCalls++
      newSessionPayloads.push(JSON.parse(options.body))
      const status = newSessionCalls === 1 ? 503 : 201
      return await new Promise(resolve => { releaseNewSession = () => resolve({ ok: status === 201, status, async json() {
        return status === 201 ? { role: 'product', sessionId: 'session-product-new-config' } : { error: 'session-create-outcome-unknown' }
      } }) })
    }
    if (url.startsWith('/tradeloom/agent-capabilities?')) {
      capabilityFetchOptions.push(options)
      const role = new URL(url, 'http://desktop.local').searchParams.get('role')
      return await new Promise(resolve => capabilityRequests.set(role, resolve))
    }
    if (url === '/tradeloom/scenes') {
      sceneFetches++
      if (sceneFetches <= 2) return { ok: false, async json() { return {} } }
      return { ok: true, async json() { return config } }
    }
    if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return saved } }
    if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
    throw new Error(`unexpected request ${url}`)
  }
  const clientRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  let sceneExports
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    sceneExports = chunkRegistration.factory(clientRequire)
    return sceneExports
  }
  const slots = { registrations: [], inject(_name, callback) { callback() }, register(spec, component) { this.registrations.push({ spec, component }); return () => {} } }
  const client = entryRegistration.factory(clientRequire)
  await client.apply({
    layout: { selectPanel(id) { selectedShellPanels.push(id) } }, uiWorkspace: { openSession(id) { openedNativeSessions.push(id) } },
    sessions: { retain() {} }, modelDirectories: {}, remote: { session: {} }, theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
    on() {}, off() {}, effect() {}, slots,
  })

  function find(node, predicate) {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const result = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (result) return result
    }
  }
  const getTop = () => slots.registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const sceneTabs = find(getTop(), node => node.type?.name === 'BusinessMenu')?.props.SceneTabs
  sceneTabs()
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))

  const agentElement = find(getTop(), node => node.type?.name === 'AgentDirectory')
  const renderAgent = () => { hookIndex = 0; return agentElement.type(agentElement.props) }
  let agentTree = renderAgent()
  const findAll = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(item => findAll(item, predicate, out)) : findAll(child, predicate, out)
    return out
  }
  const error = find(agentTree, node => node.props?.role === 'alert')
  assert.ok(error, 'the selector must stop saying it is loading when the scene configuration request fails')
  assert.match(JSON.stringify(error), /助手列表暂不可用/)
  let retry = find(agentTree, node => node.type === 'button' && node.children?.includes('重试助手列表'))
  assert.ok(retry, 'the visible role-load error provides a retry action')
  const unhandled = []
  const captureUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', captureUnhandled)
  let failedRetry
  try {
    failedRetry = await retry.props.onClick()
    for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  } finally {
    process.removeListener('unhandledRejection', captureUnhandled)
  }
  assert.equal(failedRetry, false, 'an expected offline configuration failure is handled by the click action')
  assert.deepEqual(unhandled, [], 'repeated offline retries do not create unhandled rejections')
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.props?.role === 'alert'), 'a failed retry keeps the actionable error visible')
  retry = find(agentTree, node => node.type === 'button' && node.children?.includes('重试助手列表'))
  assert.ok(retry)
  assert.equal(await retry.props.onClick(), true, 'a later successful retry completes the same configuration request')
  for (let attempt = 0; attempt < 20 && !sceneExports.getSnapshot().config; attempt++) await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.equal(sceneFetches, 3, 'each retry reuses the SceneWorkbench configuration loader instead of making a duplicate request')
  assert.equal(find(agentTree, node => node.props?.role === 'alert'), undefined, 'successful retry clears the role-load error')
  const roles = ['中心', '商品专家', '市场研究（占位）', '询报价（占位）', '交付协同', '用户资料（演示）']
  assert.equal(findAll(agentTree, node => node.type === 'button' && roles.includes(node.props?.['aria-label'])).length, 6,
    'successful retry exposes the current safe role menu')
  assert.deepEqual(requests.filter(([url]) => url === '/tradeloom/scenes').map(([, method]) => method), ['GET', 'GET', 'GET'])

  const capabilityButton = find(agentTree, node => node.type === 'button' && node.children?.includes('查看 MCP 与 Skill 能力'))
  assert.ok(capabilityButton, 'the existing Agent selector exposes capability details without adding a sidebar')
  capabilityButton.props.onClick()
  agentTree = renderAgent()
  const selector = find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
  assert.ok(selector, 'the detail view can inspect each role from the safe role metadata')
  selector.props.onChange({ target: { value: 'product' } })
  assert.deepEqual([...capabilityRequests.keys()].sort(), ['center', 'product'])
  const productResult = {
    role: 'product', status: 'ready', tools: { status: 'available', items: [{ name: 'read_products' }] },
    skills: { status: 'available', complete: true, items: [{ name: 'product-skill', description: 'Product scoped', source: 'runtime', invocation: { modelInvocable: true, userInvocable: false } }] },
    mcp: { status: 'not_configured', visibleTools: null },
  }
  const centerResult = {
    role: 'center', status: 'ready', tools: { status: 'available', items: [] },
    skills: { status: 'available', complete: true, items: [] }, mcp: { status: 'not_configured', visibleTools: null },
  }
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  configurationRequests.get('product')({ ok: true, async json() { return configFixture('product') } })
  await new Promise(resolve => setImmediate(resolve))
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'strong' && node.children?.includes('product-skill')),
    'a late response for the previously selected role cannot replace the current role capability result')
  const savedConfigTab = find(agentTree, node => node.type === 'button' && node.children?.includes('已保存配置'))
  assert.ok(savedConfigTab, 'the existing capability dialog has a separate saved-configuration view')
  savedConfigTab.props.onClick()
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'summary' && node.children?.some?.(child => String(child).includes('products · HTTP'))),
    'MCP server details are collapsed to keep the capability panel compact')
  assert.ok(find(agentTree, node => node.type === 'p' && JSON.stringify(node.children).includes('当前运行中的会话继续使用其原有能力')),
    'saved defaults are distinct from the current running session')
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.value,
    'PRODUCTS_TOKEN', 'the editor shows an environment variable reference, not its resolved value')
  const environmentName = find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')
  environmentName.props.onChange({ target: { value: 'PRODUCTS_TOKEN_NEXT' } })
  const skillDirectories = find(agentTree, node => node.type === 'textarea' && node.props?.value === 'skills/nested')
  assert.ok(skillDirectories, 'the editor exposes role-specific relative Skill directories')
  skillDirectories.props.onChange({ target: { value: 'skills/nested\nskills/new-folder' } })
  const lateCenterConfig = configurationRequests.get('center')
  assert.ok(lateCenterConfig, 'the first center configuration read remains independently pending')
  lateCenterConfig({ ok: true, async json() { return configFixture('center') } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.value,
    'PRODUCTS_TOKEN_NEXT', 'a late previous-role configuration response does not replace the selected role draft')
  assert.equal(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder')
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.notEqual(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder',
    'one role never displays another role’s unsaved Skill text')
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'product' } })
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.equal(find(agentTree, node => node.type === 'textarea')?.props?.value, 'skills/nested\nskills/new-folder',
    'returning to a role restores its unsubmitted Skill draft')
  const saveDefaults = find(agentTree, node => node.type === 'button' && node.children?.includes('保存默认配置'))
  assert.ok(saveDefaults && !saveDefaults.props.disabled, 'changed configuration has an explicit save action')
  saveDefaults.props.onClick()
  saveDefaults.props.onClick()
  agentTree = renderAgent()
  const savingDefaults = find(agentTree, node => node.type === 'button' && node.children?.includes('保存中…'))
  assert.ok(savingDefaults?.props.disabled, 'save submission blocks duplicate mutation while it is in flight')
  assert.equal(find(agentTree, node => node.type === 'input' && node.props?.['aria-label'] === '环境变量名 1')?.props?.disabled,
    true, 'environment reference inputs stay locked while the submitted snapshot is saving')
  assert.equal(find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '引用方式 1')?.props?.disabled,
    true, 'reference scheme cannot drift while the save is in flight')
  assert.equal(configurationFetchOptions.filter(options => options.method === 'PUT').length, 1,
    'a synchronous duplicate click starts only one configuration write')
  await new Promise(resolve => setImmediate(resolve))
  const submittedConfiguration = JSON.parse(configurationFetchOptions.find(options => options.method === 'PUT').body)
  assert.equal(submittedConfiguration.mcpServers[0].headers.Authorization.envName, 'PRODUCTS_TOKEN_NEXT')
  assert.equal('present' in submittedConfiguration.mcpServers[0].headers.Authorization, false,
    'GET presence metadata is never sent back as configuration')
  assert.deepEqual(submittedConfiguration.skill.customSkillDirs, ['skills/nested', 'skills/new-folder'],
    'the latest Skill text is normalized on save without waiting for blur')
  assert.ok(configurationFetchOptions.filter(options => options.method === 'PUT').every(options => options.credentials === 'same-origin'))
  releaseConfigurationSave()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/tradeloom/agent-capabilities?')), [
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
  ], 'the saved-configuration editor uses the current capability reads already in the dialog')
  agentTree = renderAgent()
  const newConversation = find(agentTree, node => node.type === 'button' && node.children?.includes('用已保存配置新建对话'))
  assert.ok(newConversation && !newConversation.props.disabled, 'a clean saved configuration can create a new conversation')
  newConversation.props.onClick()
  newConversation.props.onClick()
  assert.equal(newSessionCalls, 1, 'double click reuses one in-flight operation')
  assert.deepEqual(newSessionPayloads[0], {
    role: 'product', expectedSessionId: null, operationId: '70f31e2d-716a-4d55-a43d-d4f3898ac4d0',
  }, 'the UI sends only role, the expected binding, and a stable operation ID')
  assert.equal(JSON.parse(persistedOperations.get('tradeloom:session-create:product')).operationId,
    newSessionPayloads[0].operationId, 'the same operation ID survives a reload/timeout until its outcome is confirmed')
  releaseNewSession()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(persistedOperations.has('tradeloom:session-create:product'), true,
    'an unknown response keeps the exact operation available for safe retry')
  agentTree = renderAgent()
  assert.match(JSON.stringify(find(agentTree, node => node.props?.role === 'status')),
    /创建结果尚未确认.*旧会话保持不变.*已保留该操作/,
    'an unknown outcome explains the retained operation and does not suggest creating a different session')
  find(agentTree, node => node.type === 'button' && node.children?.includes('用已保存配置新建对话')).props.onClick()
  assert.equal(newSessionCalls, 2, 'retry sends one additional request after the first outcome is unknown')
  assert.deepEqual(newSessionPayloads[1], newSessionPayloads[0], 'retry reuses the identical expected binding and operation UUID')
  agentTree = renderAgent()
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() { return centerResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  releaseNewSession()
  await new Promise(resolve => setImmediate(resolve))
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(sceneExports.getSnapshot().sessionBindings.product, 'session-product-new-config',
    'the returned native session updates its role binding without replacing the previous Session')
  assert.equal(sceneExports.getSnapshot().roleByScene[sceneExports.getSnapshot().activeSceneId], 'center',
    'a late create response does not switch back after the user selected another role')
  assert.equal(persistedOperations.has('tradeloom:session-create:product'), false, 'confirmed success clears the local replay hint')
  assert.deepEqual(requests.filter(([url]) => url.startsWith('/tradeloom/agent-capabilities?')), [
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
    ['/tradeloom/agent-capabilities?role=product', 'GET'],
    ['/tradeloom/agent-capabilities?role=center', 'GET'],
  ], 'the late response does not refresh or replace the newly selected role view')
  agentTree = renderAgent()
  find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
    .props.onChange({ target: { value: 'product' } })
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(capabilityFetchOptions.every(options => options.credentials === 'same-origin' && !('body' in options)),
    'the UI uses authenticated same-origin read requests without session IDs or write payloads')

  agentTree = renderAgent()
  find(agentTree, node => node.type === 'button' && node.children?.includes('当前能力')).props.onClick()
  agentTree = renderAgent()
  let reread = find(agentTree, node => node.type === 'button' && node.children?.includes('重新读取'))
  assert.ok(reread, 'configuration controls remain available after returning to the role')
  reread.props.onClick()
  capabilityRequests.get('product')({ ok: false, async json() { return {} } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  let capabilityError = find(agentTree, node => node.props?.role === 'alert')
  assert.match(JSON.stringify(capabilityError), /能力信息暂时无法读取/)
  const retryCapability = find(capabilityError, node => node.type === 'button' && node.children?.includes('重试'))
  retryCapability.props.onClick()
  capabilityRequests.get('product')({ ok: true, async json() { return productResult } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'strong' && node.children?.includes('product-skill')),
    'the capability error can be retried without changing the bound role or session')

  const currentSelector = find(agentTree, node => node.type === 'select' && node.props?.['aria-label'] === '选择要查看能力的助手')
  currentSelector.props.onChange({ target: { value: 'center' } })
  capabilityRequests.get('center')({ ok: true, async json() {
    return { role: 'center', status: 'not_bound', tools: null, skills: null, mcp: { status: 'declared_only', visibleTools: null } }
  } })
  await new Promise(resolve => setImmediate(resolve))
  agentTree = renderAgent()
  assert.ok(find(agentTree, node => node.type === 'p' && node.children?.includes('该预设声明了 MCP 客户端；这不代表当前会话已连接。')),
    'an unbound role still shows the safe preset MCP declaration without implying a live connection')
  assert.ok(find(agentTree, node => node.type === 'p' && node.children?.includes('该助手当前没有已绑定的原生会话，工具与 Skill 能力未知。')))

  await sceneExports.selectRole('center', 'native-center-session-123')
  const beforeOpen = sceneExports.getSnapshot()
  const toolsElement = find(getTop(), node => node.type?.name === 'ShellToolsMenu')
  assert.ok(toolsElement, 'the shell tools menu is available alongside native chat')
  const openMenuAndFindAction = label => {
    hookValues.length = 0
    hookIndex = 0
    let tree = toolsElement.type()
    find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单').props.onClick()
    hookIndex = 0
    tree = toolsElement.type()
    return find(tree, node => node.type === 'button' && node.children?.includes(label))
  }
  const navigation = find(getTop(), node => node.type?.name === 'BusinessMenu')
  const openCurrentChat = () => navigation.type({ ...navigation.props, usePanelInfo: selector => selector({}) }).children
    .find(node => node?.props?.['aria-label'] === '打开当前对话')
  assert.ok(openCurrentChat(), 'a known active role session exposes the explicit native conversation action')
  assert.equal(openCurrentChat().props['aria-current'], 'page', 'the standalone conversation entry is selected when it is the active main panel')
  openCurrentChat().props.onClick()
  assert.deepEqual(openedNativeSessions, ['native-center-session-123'], 'the current bound session is passed to the host UI workspace API')
  assert.deepEqual(sceneExports.getSnapshot().sessionBindings, beforeOpen.sessionBindings, 'opening chat does not create or change role-to-session bindings')
  assert.equal(sceneExports.getSnapshot().activeSceneId, beforeOpen.activeSceneId, 'opening chat leaves the current scene selected')
  assert.equal(requests.some(([url, method]) => url === '/tradeloom/session' && method === 'POST'), false, 'opening chat does not request a new native session')
  openMenuAndFindAction('返回工作台').props.onClick()
  assert.deepEqual(selectedShellPanels.at(-1), 'scene-workbench', 'return action restores the workbench main panel')
  assert.equal(sceneExports.getSnapshot().activeSceneId, beforeOpen.activeSceneId, 'return action keeps the same scene')

  const staleChatAction = openCurrentChat()
  assert.ok(staleChatAction)
  sceneExports.navigateBusiness('/products')
  assert.equal(sceneExports.getSnapshot().activeSceneId, 'products', 'the test switches scenes while the utility menu is open')
  const openedBeforeStaleClick = openedNativeSessions.length
  staleChatAction.props.onClick()
  assert.equal(openedNativeSessions.length, openedBeforeStaleClick + 1)
  assert.equal(openedNativeSessions.at(-1), 'session-product-new-config',
    'a stale menu action resolves the live scene binding and cannot open the previous scene\'s session')

  hookValues.length = 0
  hookIndex = 0
  effectValues.length = 0
  let toolsTree = toolsElement.type()
  let trigger = find(toolsTree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单')
  trigger.props.onClick()
  hookIndex = 0
  toolsTree = toolsElement.type()
  assert.ok(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), 'opening the disclosure reveals its grouped actions')
  testDocument.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  hookIndex = 0
  toolsTree = toolsElement.type()
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), undefined, 'Escape closes the utility disclosure')
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '打开工具菜单').props['aria-expanded'], false)
  assert.ok(triggerFocusCount > 0, 'Escape returns keyboard focus to the disclosure trigger')

  trigger = find(toolsTree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单')
  trigger.props.onClick()
  hookIndex = 0
  toolsTree = toolsElement.type()
  testDocument.dispatch('click', { target: { insideShellTools: false } })
  hookIndex = 0
  toolsTree = toolsElement.type()
  assert.equal(find(toolsTree, node => node.props?.['aria-label'] === '工作台工具'), undefined, 'a click outside the utility disclosure closes it')

})

test('an asynchronous scene chunk failure leaves business navigation available and can be retried', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entryRegistration
  runInNewContext(entrySource, { window: { __ModuleLoader__: { load(value) { entryRegistration = value } } } })
  let chunkRegistration
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
  }
  const chunk = chunkRegistration.factory(() => React)
  let attempts = 0
  const registrations = []
  const slots = {
    inject(_name, register) { register() },
    register(spec, component) { registrations.push({ spec, component }); return () => {} },
  }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    attempts++
    if (attempts === 1) throw new Error('chunk unavailable')
    return chunk
  }
  const plugin = entryRegistration.factory(entryRequire)
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: { openSession() {} } })
  assert.equal(registrations.some(item => item.spec.name === 'sidebar.agents'), false, 'scene chunk failure does not reserve a sidebar slot for agents')
  let top = registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const findButton = (node, label) => {
    if (!node || typeof node !== 'object') return undefined
    if (node.type === 'button' && node.children.includes(label)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => findButton(item, label)).find(Boolean) : findButton(child, label)
      if (found) return found
    }
  }
  assert.ok(findButton(top, '重试工作场景'))
  await findButton(top, '重试工作场景').props.onClick()
  assert.equal(attempts, 2)
  top = registrations.find(item => item.spec.name === 'shell.top').component({ usePanelInfo: () => ({}) })
  const names = []
  const visit = node => { if (!node || typeof node !== 'object') return; if (typeof node.type === 'function') names.push(node.type.name); for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(visit) : visit(child) }
  visit(top)
  const menu = top.children.find(node => node?.type?.name === 'BusinessMenu')
  assert.equal(menu?.props.SceneTabs, chunk.SceneTabs, 'retry loads scene controls into the existing business navigation')
})

test('scene navigation exposes config reload after a failed request and refreshes edited JSON', async () => {
  let chunkRegistration
  let configFetches = 0
  const config = await readClientSceneConfig()
  config.scenes[0].label = '本地新场景名'
  const savedState = defaultSceneWorkbench(config)
  const dockLayouts = normalizeDockLayouts(config, { version: 2, scenes: {} }, savedState.layouts)
  const source = await readFile(sceneChunkUrl, 'utf8')
  const state = { current: undefined }
  let initialEffects = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { state.current ??= initial; return [state.current, value => { state.current = value }] },
    useEffect(effect) { if (initialEffects++ < 2) effect() },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } },
    fetch: async url => {
      if (url === '/tradeloom/scenes') {
        configFetches++
        if (configFetches === 1) throw new Error('offline')
        return { ok: true, async json() { return config } }
      }
      if (url === '/tradeloom/scene-layouts') return { ok: true, async json() { return savedState } }
      if (url === '/tradeloom/dock-layouts') return { ok: true, async json() { return dockLayouts } }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const exports = chunkRegistration.factory(() => React)
  function buttons(node, found = []) {
    if (!node || typeof node !== 'object') return found
    if (node.type === 'button') found.push(node)
    for (const child of node.children ?? []) Array.isArray(child) ? child.forEach(item => buttons(item, found)) : buttons(child, found)
    return found
  }
  let tree = exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  tree = exports.SceneTabs()
  assert.match(JSON.stringify(tree), /场景配置暂时无法读取|工作场景暂时无法读取|读取场景配置失败|无法读取场景/,
    'the scene strip reports an unavailable config without adding a separate toolbar action')
  await exports.retryLoadConfig()
  await new Promise(resolve => setImmediate(resolve))
  tree = exports.SceneTabs()
  assert.equal(configFetches, 2)
  assert.ok(buttons(tree).some(button => button.props['aria-label'] === '本地新场景名'))
  assert.equal(buttons(tree).some(button => button.children.includes('刷新场景配置')), false,
    'scene config refresh is moved out of the scene tab strip into the shell tools menu')
  const sceneTabButtons = buttons(tree).filter(button => button.props?.className === 'tl-scene-tab')
  assert.equal(sceneTabButtons.length, 8)
  for (const button of sceneTabButtons) {
    assert.equal(button.children[0]?.children?.[0]?.type, 'svg', `${button.props['aria-label']} should use a recognizable inline icon`)
    assert.equal(button.children[1]?.props?.className, 'tl-scene-tab-label')
    assert.equal(button.children[1]?.children?.[0], button.props['aria-label'], 'the compact tab retains its readable label for hover/focus/current styling')
  }
})

test('an empty scene list is rejected and leaves the top navigation retry available', async () => {
  let chunkRegistration
  const state = { current: undefined }
  let effectCount = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) { state.current ??= initial; return [state.current, value => { state.current = value }] },
    useEffect(effect) { if (effectCount++ < 2) effect() },
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), {
    window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } },
    fetch: async url => ({ ok: true, async json() { return url === '/tradeloom/scenes'
      ? { version: 1, scenes: [] }
      : { version: 1, activeSceneId: 'center', roleByScene: { center: 'center' }, layouts: {} } } }),
  })
  const exports = chunkRegistration.factory(() => React)
  exports.SceneTabs()
  await new Promise(resolve => setImmediate(resolve))
  const tree = exports.SceneTabs()
  assert.ok(JSON.stringify(tree).includes('工作场景暂时无法读取'), 'empty configuration must not reach SceneWorkbench')
  assert.ok(tree.children.some(child => child?.props?.role === 'status'), 'the scene row reports the failure while reload stays in the shell tools menu')
})

test('switching scenes keeps each role bound to its own native Session and composer', async () => {
  let chunkRegistration
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect() {},
  }
  runInNewContext(await readFile(sceneChunkUrl, 'utf8'), { window: { __ModuleLoader__: { load(value) { chunkRegistration = value } } } })
  const exports = chunkRegistration.factory(() => React)
  const config = await readClientSceneConfig()
  const center = exports.bindSession({}, 'center', 'center-session', config)
  const product = exports.bindSession(center, 'product', 'product-session', config)
  assert.deepEqual(JSON.parse(JSON.stringify(product)), { center: 'center-session', product: 'product-session' })
  const centerReference = exports.retainRoleSession({ retain: sessionId => ({ sessionId, release() {} }) }, 'center', product.center)
  const productReference = exports.retainRoleSession({ retain: sessionId => ({ sessionId, release() {} }) }, 'product', product.product)
  assert.equal(centerReference.sessionId, 'center-session')
  assert.equal(productReference.sessionId, 'product-session')
  assert.notStrictEqual(centerReference, productReference)
  exports.releaseRoleSessions()
})

test('scene config endpoint returns editable scenes and the live business origin to an authenticated GET', async () => {
  const expected = await readFile(sceneConfigUrl, 'utf8')
  const handler = createScenesHandler({
    connection: { requestRejection: () => undefined },
    webServer: { getOrigin: () => 'http://192.168.1.23:3088' },
  })
  const req = Readable.from([])
  req.method = 'GET'
  const res = { headers: {}, statusCode: 200, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(res.body)
  assert.deepEqual(body, {
    ...JSON.parse(expected), businessOrigin: 'http://192.168.1.23:3088',
    roles: publicRoleMetadata(),
  })
  assert.ok(body.roles.every(role => Object.keys(role).sort().join(',') === 'assistantLabel,id,label'))
  for (const privateField of ['preset', 'prompt', 'tool', 'session', 'workspace']) {
    assert.equal(JSON.stringify(body.roles).toLowerCase().includes(privateField), false, `public role metadata does not expose ${privateField}`)
  }
  const rejected = createScenesHandler({ connection: { requestRejection: () => 401 } }, { readScenes: async () => { throw new Error('must not read') } })
  const deniedReq = Readable.from([]); deniedReq.method = 'GET'
  const deniedRes = { statusCode: 200, end(value = '') { this.body = value } }
  await rejected(deniedReq, deniedRes)
  assert.equal(deniedRes.statusCode, 401)
  assert.equal(deniedRes.body, '')
})

