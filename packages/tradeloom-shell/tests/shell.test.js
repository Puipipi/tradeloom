import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { BUSINESS_ALIASES, BUSINESS_MENUS, ROLE_LABELS, ROLE_PRESETS } from '../roles.js'
import { apply as applyHost, createDockLayoutsHandler, createProfileHandler, createSceneLayoutsHandler, createSessionHandler } from '../host.js'
import { apply as applyBudgetGate, BUDGET_LIMITS, chargeToolAttempt } from '../policy.js'
import { registerProfileTool } from '../profile-tool.js'
import { apply as applyStepLimit, MAX_STEPS_PER_TURN } from '../step-policy.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE, resolveOwnedHome, roleWorkspacePath } from '../state.js'

const auditRoot = fileURLToPath(new URL('../../../../workspace/testing/dsh-composite-shell/', import.meta.url))
await mkdir(auditRoot, { recursive: true })

async function fixtureHome(t) {
  const home = await mkdtemp(join(auditRoot, 'home-'))
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  return { home, env: { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home } }
}

test('package allowlist includes every relative host import required at runtime', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const hostSource = await readFile(new URL('../host.js', import.meta.url), 'utf8')
  const hostImports = [...hostSource.matchAll(/^import\s+.+?\s+from\s+['"](\.\/[^'"]+)['"]/gm)]
    .map(match => match[1].slice(2))

  assert.deepEqual(hostImports.filter(path => !packageJson.files.includes(path)), [],
    'the DSH bundle allowlist must include modules imported by host.js')
})

function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: 'localhost:3088', origin: 'http://localhost:3088' }
  return req
}

function response() {
  return {
    headers: {}, statusCode: 200, body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value = '') { this.body = value },
  }
}

function agent(id, agentPreset, parentSession) {
  return { id, session: { header: { id, agentPreset, ...(parentSession ? { parentSession, delegationDepth: 1 } : {}) } } }
}

test('explicit marked app home is mandatory and path mismatch refuses before creating state', async t => {
  const { home, env } = await fixtureHome(t)
  await assert.rejects(resolveOwnedHome({ DSH_HOME: home }), /explicit TRADELOOM_DSH_APP_HOME/)
  await assert.rejects(resolveOwnedHome({ ...env, TRADELOOM_DSH_APP_HOME: join(home, 'other') }), /must equal DSH_HOME/)
  const missingMarkerHome = await mkdtemp(join(auditRoot, 'unmarked-'))
  t.after(async () => { await rm(missingMarkerHome, { recursive: true, force: true }) })
  await assert.rejects(createStateStore({ env: { DSH_HOME: missingMarkerHome, TRADELOOM_DSH_APP_HOME: missingMarkerHome } }), /marker is missing/)
  await assert.rejects(readFile(join(missingMarkerHome, 'tradeloom-state', 'state.json')), { code: 'ENOENT' })
})

test('atomic state survives store recreation and serializes concurrent updates', async t => {
  const { home, env } = await fixtureHome(t)
  const first = await createStateStore({ env })
  await first.transact(state => { state.roles.center = { sessionId: 'tl-stable-center', workspaceId: 'ws-center' } })
  await Promise.all(Array.from({ length: 32 }, () => first.transact(state => {
    const budget = state.budgets.root ??= { delegations: 0, messages: 0 }
    budget.messages++
  })))
  const reopened = await createStateStore({ env })
  const saved = await reopened.read()
  assert.equal(saved.roles.center.sessionId, 'tl-stable-center')
  assert.equal(saved.budgets.root.messages, 32)
  assert.equal(saved.userProfile.displayName, '演示资料（待配置）')
  assert.ok(saved && first.paths.statePath.startsWith(home))
  assert.equal(await readFile(join(home, 'tradeloom-state', 'state.lock')).catch(error => error.code), 'ENOENT')
})

test('legacy app state without dock layouts remains readable and receives an empty v2 namespace', async t => {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  await store.transact(state => {
    state.roles.center = { sessionId: 'legacy-session' }
    state.sceneWorkbench = { version: 1, layouts: { center: { expandedPanel: '', panels: {} } } }
  })
  const legacy = JSON.parse(await readFile(store.paths.statePath, 'utf8'))
  delete legacy.dockLayouts
  await writeFile(store.paths.statePath, `${JSON.stringify(legacy)}\n`, 'utf8')

  const reopened = await createStateStore({ env })
  const state = await reopened.read()
  assert.equal(state.roles.center.sessionId, 'legacy-session')
  assert.deepEqual(state.sceneWorkbench, legacy.sceneWorkbench)
  assert.deepEqual(state.dockLayouts, { version: 2, scenes: {} })
})

test('state writes from multiple store instances serialize and remain writable after recreation', async t => {
  const { env } = await fixtureHome(t)
  const [first, second] = await Promise.all([createStateStore({ env }), createStateStore({ env })])
  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).transact(state => {
    const budget = state.budgets.root ??= { delegations: 0, messages: 0 }
    budget.messages++
  })))
  const restarted = await createStateStore({ env })
  assert.equal((await restarted.read()).budgets.root.messages, 40)
  await restarted.transact(state => { state.roles.center = { sessionId: 'after-reopen' } })
  assert.equal((await first.read()).roles.center.sessionId, 'after-reopen')
})

test('marker, state, and role workspace paths reject links before following them', async t => {
  const { home, env } = await fixtureHome(t)
  const outside = join(auditRoot, `sentinel-${Date.now()}-${Math.random()}.txt`)
  await writeFile(outside, 'outside sentinel')
  t.after(async () => { await rm(outside, { force: true }) })
  await rm(join(home, HOME_MARKER))
  try { await symlink(outside, join(home, HOME_MARKER), 'file') } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`symlink creation unavailable: ${error.code}`)
    throw error
  }
  await assert.rejects(resolveOwnedHome(env), /reparse points are not allowed/)
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel')
  await rm(join(home, HOME_MARKER))
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const stateDirectory = join(home, 'tradeloom-state')
  await mkdir(stateDirectory)
  await symlink(outside, join(stateDirectory, 'state.json'), 'file')
  const store = await createStateStore({ env })
  await assert.rejects(store.read(), /reparse points are not allowed/)
  await rm(join(stateDirectory, 'state.json'))
  const parent = join(home, 'tradeloom-workspaces')
  await mkdir(parent)
  await symlink(outside, join(parent, 'center'), 'file')
  await assert.rejects(roleWorkspacePath('center', env), /reparse points are not allowed/)
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel')
})

test('role workspace creation is contained and role mapping is closed', async t => {
  const { home, env } = await fixtureHome(t)
  const path = await roleWorkspacePath('center', env)
  assert.equal(path, join(home, 'tradeloom-workspaces', 'center'))
  await assert.rejects(roleWorkspacePath('../outside', env), /unknown TradeLoom role/)
  assert.deepEqual(Object.keys(ROLE_PRESETS), Object.keys(ROLE_LABELS))
  assert.equal(BUSINESS_MENUS.length, 5)
  assert.deepEqual(BUSINESS_MENUS.map(menu => menu.path), ['/home', '/products', '/agent-center', '/artifacts', '/runs'])
  assert.deepEqual(Object.keys(BUSINESS_ALIASES), ['business', 'business-api', 'business-static', 'business-media'])
})

test('shell role IDs, presets, and labels are derived from the single stable registry', async () => {
  const roles = await import('../roles.js')
  const state = await import('../state.js')
  assert.deepEqual(roles.ROLE_DEFINITIONS, [
    { id: 'center', preset: 'tradeloom-center', label: '中心', assistantLabel: '中心助手' },
    { id: 'product', preset: 'tradeloom-product', label: '商品专家', assistantLabel: '商品助手' },
    { id: 'market', preset: 'tradeloom-market-placeholder', label: '市场研究（占位）', assistantLabel: '市场助手' },
    { id: 'quote', preset: 'tradeloom-quote-placeholder', label: '询报价（占位）', assistantLabel: '询报价助手' },
    { id: 'delivery', preset: 'tradeloom-delivery', label: '交付协同', assistantLabel: '交付助手' },
    { id: 'user-profile', preset: 'tradeloom-user-profile-demo', label: '用户资料（演示）', assistantLabel: '资料助手' },
  ])
  assert.deepEqual(roles.ROLE_IDS, ['center', 'product', 'market', 'quote', 'delivery', 'user-profile'])
  assert.strictEqual(state.ROLE_IDS, roles.ROLE_IDS, 'state keeps the compatibility export as the same registry binding')
  assert.deepEqual(ROLE_PRESETS, Object.fromEntries(roles.ROLE_DEFINITIONS.map(role => [role.id, role.preset])))
  assert.deepEqual(ROLE_LABELS, Object.fromEntries(roles.ROLE_DEFINITIONS.map(role => [role.id, role.label])))
})

test('five business panels embed Django pages through the same-origin alias and keep the Agent Center handoff route', async () => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  for (const path of ['/home', '/products', '/agent-center', '/artifacts', '/runs']) {
    assert.ok(clientSource.includes(`'${path}'`), `missing business panel path ${path}`)
  }
  assert.match(clientSource, /panelKey === 'business-agent-center' \? agentCenterHref : `\/business\$\{path\}`/)
  assert.match(clientSource, /agentCenterHrefListeners\.add\(listener\)/)
  assert.match(clientSource, /h\('iframe'/)
  assert.doesNotMatch(clientSource, /此页面的业务内容尚未准备好/)
})

test('business iframe theme bridge sends only the current enum to owned same-origin frames', async () => {
  const entrySource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entryRegistration
  const themeListeners = new Map()
  const messageListeners = new Map()
  const documentListeners = new Map()
  const sent = []
  const frames = []
  const frameSrc = '/business/home'
  const frame = {
    src: frameSrc,
    contentWindow: { postMessage(data, origin) { sent.push({ data, origin }) } },
    matches(selector) { return selector === 'iframe[data-tradeloom-business-frame]' },
  }
  const document = {
    querySelectorAll(selector) { return selector === 'iframe[data-tradeloom-business-frame]' ? frames : [] },
    addEventListener(name, listener) { documentListeners.set(name, listener) },
    removeEventListener(name) { documentListeners.delete(name) },
  }
  const window = {
    document, location: { origin: 'http://localhost:3088' },
    addEventListener(name, listener) { messageListeners.set(name, listener) },
    removeEventListener(name) { messageListeners.delete(name) },
    __ModuleLoader__: { load(value) { entryRegistration = value } },
  }
  runInNewContext(entrySource, { window, URL, URLSearchParams })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const clientRequire = name => { assert.equal(name, 'react'); return React }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    return { register() {}, SceneTabs() {}, ModelDirectoryRail() {} }
  }
  const plugin = entryRegistration.factory(clientRequire)
  const slots = { inject(_name, register) { register() }, register() { return () => {} } }
  const effects = []
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: {}, theme: {
    getTheme: () => ({ active: { colorScheme: 'dark' } }),
  }, on(name, listener) {
    themeListeners.set(name, listener)
    return () => themeListeners.delete(name)
  },
  effect(callback) { effects.push(callback) } })

  frames.push(frame)
  const originalFrameWindow = frame.contentWindow
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request' },
  })
  assert.equal(JSON.stringify(sent), JSON.stringify([{ data: { type: 'tradeloom:theme', colorScheme: 'dark' }, origin: 'http://localhost:3088' }]))
  documentListeners.get('load')({ target: frame })
  assert.equal(JSON.stringify(sent.at(-1)), JSON.stringify({ data: { type: 'tradeloom:theme', colorScheme: 'dark' }, origin: 'http://localhost:3088' }))
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'https://other.example', data: { type: 'tradeloom:theme:request' },
  })
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request', token: 'ignored' },
  })
  assert.equal(sent.length, 2, 'foreign origins and unexpected request fields are ignored')
  themeListeners.get('theme/change')({ active: { colorScheme: 'light' } })
  assert.equal(JSON.stringify(sent.at(-1)), JSON.stringify({ data: { type: 'tradeloom:theme', colorScheme: 'light' }, origin: 'http://localhost:3088' }))
  assert.strictEqual(frames[0], frame)
  assert.strictEqual(frame.contentWindow, originalFrameWindow)
  assert.equal(frame.src, frameSrc, 'theme updates never navigate or remount the business document')
  for (const cleanup of effects) cleanup()()
  assert.equal(messageListeners.has('message'), false)
  assert.equal(documentListeners.has('load'), false)
})

test('business-shell supplies TradeLoom identity to the existing sidebar and blank-session slots', async () => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let definition
  runInNewContext(clientSource, { window: { __ModuleLoader__: { load(value) { definition = value } } } })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const clientRequire = name => {
    assert.equal(name, 'react')
    return React
  }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    let chunk
    runInNewContext(await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { chunk = value } } } })
    return chunk.factory(clientRequire)
  }
  const module = definition.factory(clientRequire)
  const registrations = []
  const slots = {
    inject(_name, register) {
      const result = register()
      if (result && typeof result[Symbol.iterator] === 'function') for (const item of result) void item
    },
    register(spec, component) { registrations.push({ spec, component }); return () => {} },
  }
  await module.apply({ slots, layout: {}, uiWorkspace: {} })
  const brandSlots = registrations.map(item => item.spec.name).filter(name => name.includes('brand'))
  assert.deepEqual(brandSlots.sort(), ['conversation.hero.brand.mark', 'sidebar.brand.mark', 'sidebar.brand.name'].sort())
  const mark = registrations.find(item => item.spec.name === 'sidebar.brand.mark').component({ size: 24, className: 'hero-slot', style: { color: 'red' } })
  assert.equal(mark.type, 'svg')
  assert.equal(mark.props.viewBox, '0 0 1024 1024')
  assert.equal(mark.props.width, 24)
  assert.equal(mark.props.className, 'hero-slot')
  assert.deepEqual(mark.props.style, { color: 'red' })
  const assetSource = await readFile(new URL('../assets/tradeloom-mark.svg', import.meta.url), 'utf8')
  const assetPaths = [...assetSource.matchAll(/<path d="([^"]+)"/g)].map(match => match[1])
  const slotPaths = mark.children.filter(child => child.type === 'path').map(child => child.props.d)
  assert.deepEqual(slotPaths, assetPaths, 'sidebar and hero use the source asset geometry')
  const wordmark = registrations.find(item => item.spec.name === 'sidebar.brand.name').component()
  assert.match(wordmark.children.map(item => item.children?.[0]).join(' '), /织贸助手/)
  assert.match(wordmark.children.map(item => item.children?.[0]).join(' '), /TradeLoom/)
})

test('pinned Cordis Loader unwrap keeps all business plugin namespaces and inject contracts', { skip: !process.env.TRADELOOM_CORDIS_LOADER_LIBRARY }, async () => {
  const loaderPath = process.env.TRADELOOM_CORDIS_LOADER_LIBRARY.replaceAll('\\', '/')
  const { default: Loader } = await import(new URL(`file:///${loaderPath}`))
  const loader = Object.create(Loader.prototype)
  const plugins = [
    ['../host.js', '@tradeloom/dsh-business-shell', ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'tools', 'agents']],
    ['../proxy.js', '@tradeloom/dsh-business-shell/proxy', ['connection', 'webServer']],
    ['../policy.js', '@tradeloom/dsh-business-shell/policy', ['tools', 'agents']],
    ['../profile-tool.js', '@tradeloom/dsh-business-shell/profile', ['tools']],
    ['../business-tools.js', '@tradeloom/dsh-business-shell/business-tools', ['tools', 'webServer']],
    ['../step-policy.js', '@tradeloom/dsh-business-shell/step-policy', []],
  ]
  for (const [specifier, expectedName, expectedInject] of plugins) {
    const namespace = await import(specifier)
    assert.equal('default' in namespace, false, `${specifier} must remain a named Cordis plugin namespace`)
    const unwrapped = loader.unwrapExports(namespace)
    assert.strictEqual(unwrapped, namespace, `${specifier} must survive the pinned Loader's normal unwrap path`)
    assert.equal(unwrapped.name, expectedName)
    assert.deepEqual(unwrapped.inject, expectedInject)
    assert.equal(typeof unwrapped.apply, 'function')
  }
})

test('budget policy is installed once from the top-level Host plugin', async () => {
  const cordis = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(cordis, /- id: tradeloom-business-shell-host\s+name: '@tradeloom\/dsh-business-shell'/)
  assert.doesNotMatch(cordis, /name: '@tradeloom\/dsh-business-shell\/policy'/)
  const registrations = []
  const routes = []
  const ctx = {
    tools: {}, agents: { get() { return undefined } },
    connection: { requestRejection() {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    workspaceRegistry: {}, sessionController: {},
    on(name, callback, options) { registrations.push({ name, callback, options }) },
    effect(register) { this.cleanup = register() },
  }
  applyHost(ctx)
  assert.ok(routes.some(route => route.path === '/tradeloom/agent-capabilities' && route.kind === 'exact'),
    'the read-only capability endpoint uses a fixed protected route')
  for (const name of ['agent/pre-step', 'agent/created', 'tools/pre-execute', 'agent/disposed']) {
    assert.equal(registrations.filter(item => item.name === name && item.options?.global === true).length, 1, `${name} must be installed once globally`)
  }
  ctx.cleanup()
})

test('authorized role route creates one mapped native session and reuses it after reload', async t => {
  const { env } = await fixtureHome(t)
  const workspaces = []
  const calls = []
  const ctx = {
    connection: { requestRejection: () => undefined },
    workspaceRegistry: {
      list: () => workspaces,
      async create(path, title) { const workspace = { id: `workspace-${workspaces.length}`, path, title }; workspaces.push(workspace); return workspace },
    },
    sessionController: { async create(input) { calls.push(input); return { sessionId: input.sessionId } } },
  }
  const deps = {
    createStateStore: () => createStateStore({ env }),
    resolveOwnedHome: () => resolveOwnedHome(env),
    roleWorkspacePath: role => roleWorkspacePath(role, env),
  }
  const handler = createSessionHandler(ctx, deps)
  const first = response()
  await handler(request('POST', { role: 'center' }), first)
  const session = JSON.parse(first.body)
  assert.equal(first.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agentPreset, 'tradeloom-center')
  assert.equal(calls[0].workspaceId, 'workspace-0')
  const second = response()
  await handler(request('POST', { role: 'center' }), second)
  assert.deepEqual(JSON.parse(second.body), session)
  assert.equal(calls.length, 1)
})

test('protected scene layout API persists allowlisted panel state without changing role or profile data', async t => {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  await store.transact(state => {
    state.roles.center = { sessionId: 'stable-center-session', workspaceId: 'center-workspace' }
    state.userProfile = { displayName: 'synthetic demo', notes: 'keep this value' }
  })
  const ctx = { connection: { requestRejection: () => undefined } }
  const handler = createSceneLayoutsHandler(ctx, { createStateStore: () => store })
  const initial = response()
  await handler(request('GET'), initial)
  const defaults = JSON.parse(initial.body)
  assert.equal(initial.statusCode, 200)
  assert.equal(defaults.version, 1)
  assert.equal(defaults.activeSceneId, 'center')
  assert.deepEqual(defaults.layouts.center.panels['native-chat'], { col: 2, row: 3, w: 3, h: 2, visible: true })

  const next = structuredClone(defaults)
  next.activeSceneId = 'user-profile'
  next.roleByScene['user-profile'] = 'user-profile'
  next.businessPath = '/artifacts'
  next.layouts.center.expandedPanel = 'native-chat'
  next.layouts.center.panels['business-main'].visible = false
  const saved = response()
  await handler(request('PUT', next), saved)
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(JSON.parse(saved.body), next)

  const reopened = await createStateStore({ env })
  const persisted = await reopened.read()
  assert.equal(persisted.sceneWorkbench.activeSceneId, 'user-profile')
  assert.equal(persisted.sceneWorkbench.layouts.center.panels['business-main'].visible, false)
  assert.equal(persisted.roles.center.sessionId, 'stable-center-session')
  assert.deepEqual(persisted.userProfile, { displayName: 'synthetic demo', notes: 'keep this value' })

  const invalid = structuredClone(next)
  invalid.layouts.center.panels['business-main'].col = 4
  const rejected = response()
  await handler(request('PUT', invalid), rejected)
  assert.equal(rejected.statusCode, 400)
  assert.equal((await reopened.read()).sceneWorkbench.activeSceneId, 'user-profile')
})

test('protected dock layout API persists v2 separately and preserves the first v1 migration snapshot', async t => {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  const ctx = { connection: { requestRejection: () => undefined } }
  const v1Handler = createSceneLayoutsHandler(ctx, { createStateStore: () => store })
  const v1Initial = response()
  await v1Handler(request('GET'), v1Initial)
  const initialV1 = JSON.parse(v1Initial.body)
  const old = {
    expandedPanel: '',
    panels: {
      'business-main': { col: 1, row: 1, w: 3, h: 2, visible: true },
      auxiliary: { col: 4, row: 1, w: 1, h: 2, visible: true },
      reference: { col: 1, row: 3, w: 1, h: 2, visible: true },
      'native-chat': { col: 2, row: 3, w: 3, h: 2, visible: true },
    },
  }
  await store.transact(state => {
    initialV1.layouts.center = structuredClone(old)
    state.sceneWorkbench = initialV1
  })
  const dockHandler = createDockLayoutsHandler(ctx, { createStateStore: () => store })
  const initial = response()
  await dockHandler(request('GET'), initial)
  const dock = JSON.parse(initial.body)
  assert.equal(initial.statusCode, 200)
  assert.equal(dock.version, 2)
  assert.equal(dock.scenes.center.migration.status, 'default_upgrade')
  assert.deepEqual(dock.scenes.center.legacyV1Snapshot, old)
  assert.deepEqual(dock.scenes.center.dockview.grid.root.data[0].data.views, ['business-main', 'auxiliary', 'reference'])

  const savedDock = structuredClone(dock)
  savedDock.scenes.center.dockview.activeGroup = '2'
  const savedResponse = response()
  await dockHandler(request('PUT', savedDock), savedResponse)
  assert.equal(savedResponse.statusCode, 200)
  assert.equal(JSON.parse(savedResponse.body).scenes.center.dockview.activeGroup, '2')

  const v1Get = response()
  await v1Handler(request('GET'), v1Get)
  const v1 = JSON.parse(v1Get.body)
  v1.layouts.center.panels['business-main'].visible = false
  const v1Put = response()
  await v1Handler(request('PUT', v1), v1Put)
  assert.equal(v1Put.statusCode, 200)
  const reopened = await createStateStore({ env })
  const state = await reopened.read()
  assert.equal(state.sceneWorkbench.layouts.center.panels['business-main'].visible, false)
  assert.equal(state.dockLayouts.scenes.center.dockview.activeGroup, '2')
  assert.deepEqual(state.dockLayouts.scenes.center.legacyV1Snapshot, old)
})

test('dock layout API authorizes before reading state and rejects unknown serialized panels', async t => {
  let reads = 0
  const denied = createDockLayoutsHandler({ connection: { requestRejection: () => 401 } }, {
    createStateStore() { reads++; throw new Error('must not read state') },
  })
  const deniedResponse = response()
  await denied(request('GET'), deniedResponse)
  assert.equal(deniedResponse.statusCode, 401)
  assert.equal(reads, 0)

  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  const handler = createDockLayoutsHandler({ connection: { requestRejection: () => undefined } }, { createStateStore: () => store })
  const initial = response()
  await handler(request('GET'), initial)
  const invalid = JSON.parse(initial.body)
  invalid.scenes.center.dockview.panels.rogue = { id: 'rogue', contentComponent: 'business-iframe', title: 'Rogue', renderer: 'always' }
  const rejected = response()
  await handler(request('PUT', invalid), rejected)
  assert.equal(rejected.statusCode, 400)
  assert.deepEqual(Object.keys((await store.read()).dockLayouts.scenes.center.dockview.panels).sort(), ['auxiliary', 'business-main', 'native-chat', 'reference'])

  const oversizedRequest = Readable.from([Buffer.from(JSON.stringify({ version: 2, scenes: {}, padding: 'x'.repeat(130 * 1024) }))])
  oversizedRequest.method = 'PUT'
  oversizedRequest.headers = { host: 'localhost:3088', origin: 'http://localhost:3088' }
  const tooLarge = response()
  await handler(oversizedRequest, tooLarge)
  assert.equal(tooLarge.statusCode, 413)
  assert.deepEqual(Object.keys((await store.read()).dockLayouts.scenes.center.dockview.panels).sort(), ['auxiliary', 'business-main', 'native-chat', 'reference'])
})

test('scene layout API rejects unauthorized requests before reading app state', async () => {
  const handler = createSceneLayoutsHandler({ connection: { requestRejection: () => 401 } }, {
    createStateStore() { throw new Error('state must not be read before authorization') },
  })
  const res = response()
  await handler(request('GET'), res)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
})

test('concurrent role opens through separate store instances create one workspace and session', async t => {
  const { env } = await fixtureHome(t)
  const workspaces = []
  const calls = []
  const ctx = {
    connection: { requestRejection: () => undefined },
    workspaceRegistry: {
      list: () => workspaces,
      async create(path, title) { const workspace = { id: `workspace-${workspaces.length}`, path, title }; workspaces.push(workspace); return workspace },
    },
    sessionController: { async create(input) { calls.push(input); return { sessionId: input.sessionId } } },
  }
  const dependencies = { createStateStore: () => createStateStore({ env }), resolveOwnedHome: () => resolveOwnedHome(env), roleWorkspacePath: role => roleWorkspacePath(role, env) }
  const handlers = [createSessionHandler(ctx, dependencies), createSessionHandler(ctx, dependencies)]
  const responses = await Promise.all(handlers.map(handler => { const res = response(); return handler(request('POST', { role: 'product' }), res).then(() => JSON.parse(res.body)) }))
  assert.equal(responses[0].sessionId, responses[1].sessionId)
  assert.equal(workspaces.length, 1)
  assert.equal(calls.length, 1)
})

test('unauthenticated route rejects before body processing or app-home access', async () => {
  let storeCalls = 0
  const ctx = { connection: { requestRejection: () => 401 } }
  const handler = createSessionHandler(ctx, { createStateStore: async () => { storeCalls++; throw new Error('must not run') } })
  const res = response()
  await handler(request('POST', { role: 'center' }), res)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
  assert.equal(storeCalls, 0)
})

test('protected user-profile route changes only the editable demo profile', async t => {
  const { env } = await fixtureHome(t)
  const ctx = { connection: { requestRejection: () => undefined }, logger: { error() {} } }
  const deps = { createStateStore: () => createStateStore({ env }), resolveOwnedHome: () => resolveOwnedHome(env) }
  const handler = createProfileHandler(ctx, deps)
  const initial = response()
  await handler(request('GET'), initial)
  assert.equal(JSON.parse(initial.body).displayName, '演示资料（待配置）')
  const update = response()
  await handler(request('POST', { displayName: '演示联系人', notes: '仅为演示内容' }), update)
  assert.deepEqual(JSON.parse(update.body), { displayName: '演示联系人', notes: '仅为演示内容' })
  const reopened = response()
  await handler(request('GET'), reopened)
  assert.equal(JSON.parse(reopened.body).displayName, '演示联系人')
  const rejected = response()
  await handler(request('POST', { displayName: 'x'.repeat(121), notes: '' }), rejected)
  assert.equal(rejected.statusCode, 400)
})

test('user-profile tool reads the latest editable profile from the owned state store', async t => {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  await store.transact(state => { state.userProfile = { displayName: '演示联系人', notes: '由用户编辑' } })
  let definition
  registerProfileTool({ tools: { register(value) { definition = value; return () => {} } } }, { createStateStore: async () => store })
  assert.equal(definition.name, 'tradeloom_user_profile_read')
  assert.deepEqual(definition.output.schema, {
    type: 'object',
    additionalProperties: false,
    required: ['displayName', 'notes'],
    properties: {
      displayName: { type: 'string', description: 'Current profile display name.' },
      notes: { type: 'string', description: 'Current user-provided profile notes.' },
    },
  })
  const toolsLibrary = process.env.TRADELOOM_DSH_TOOLS_LIBRARY
  if (toolsLibrary) {
    const { ToolRuntime, assertSupportedJsonSchema } = await import(new URL(`file:///${toolsLibrary.replaceAll('\\', '/')}`))
    assertSupportedJsonSchema(definition.output.schema)
    const registrations = []
    const officialRuntime = {
      ctx: {},
      layers: { effect(_ctx, install) { return install({ tools: { insert(name, value) { registrations.push({ name, value }); return () => {} } } }) } },
    }
    assert.equal(typeof ToolRuntime.prototype.register.call(officialRuntime, definition), 'function')
    assert.deepEqual(registrations, [{ name: definition.name, value: definition }])
    const invalid = { ...definition, output: { ...definition.output, schema: { type: 'object', properties: { name: { type: 'string', required: true } } } } }
    assert.throws(() => ToolRuntime.prototype.register.call(officialRuntime, invalid), /unsupported JSON schema/)
    assert.equal(registrations.length, 1, 'the official register contract rejects invalid schema before dispatching insertion')
  }
  assert.deepEqual(await definition.execute({}, { agent: {} }), { displayName: '演示联系人', notes: '由用户编辑' })
  await assert.rejects(definition.execute({}, {}), /Agent-backed session/)
})

test('profile-read tool sends an object parameter schema in the pinned OpenAI wire payload', async t => {
  const toolsLibrary = process.env.TRADELOOM_DSH_TOOLS_LIBRARY
  if (!toolsLibrary) return t.skip('requires the pinned compiled DSH tools library')

  let definition
  const { ToolRuntime } = await import(pathToFileURL(toolsLibrary).href)
  const officialRuntime = {
    ctx: {},
    layers: { effect(_ctx, install) { return install({ tools: { insert(_name, value) { definition = value; return () => {} } } }) } },
  }
  registerProfileTool({ tools: { register(value) { return ToolRuntime.prototype.register.call(officialRuntime, value) } } })

  const packagesRoot = resolve(dirname(toolsLibrary), '../../../llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist')
  const [{ stream }, { getBuiltinModels }, { normalizeContext }] = await Promise.all([
    import(pathToFileURL(resolve(packagesRoot, 'api/openai-completions.js')).href),
    import(pathToFileURL(resolve(packagesRoot, 'providers/all.js')).href),
    import(pathToFileURL(resolve(packagesRoot, 'utils/transcript.js')).href),
  ])
  const model = getBuiltinModels('deepseek').find(candidate => candidate.api === 'openai-completions')
  assert.ok(model, 'the pinned DeepSeek route uses the OpenAI-compatible chat-completions serializer')

  let wirePayload
  const context = normalizeContext({
    systemPrompt: 'Test only.',
    tools: [definition],
    messages: [{ role: 'user', content: 'Read my profile.' }],
  })
  const events = stream(model, context, {
    apiKey: 'fixture-only-not-a-secret',
    fetch: async () => { throw new Error('the test must stop before network dispatch') },
    onPayload(payload) {
      wirePayload = payload
      throw new Error('captured before dispatch')
    },
  })
  for await (const _event of events) { /* drain local serializer only */ }

  const wireTool = wirePayload?.tools?.find(tool => tool.function?.name === 'tradeloom_user_profile_read')
  assert.equal(wireTool?.function?.parameters?.type, 'object', JSON.stringify(wirePayload?.tools))
})

test('pre-execution budget counts failed attempts across a root and direct child after restart', async t => {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  let allowed = 0
  const root = agent('center-session', ROLE_PRESETS.center)
  const scopes = [JSON.stringify(['human-rpc', root.id, 'existing-contract-test'])]
  for (let i = 0; i < BUDGET_LIMITS.delegations + 1; i++) {
    const decision = await chargeToolAttempt(store, { name: 'subagent', agent: root }, scopes)
    if (decision === null) allowed++
  }
  assert.equal(allowed, 4)
  const child = agent('child-session', ROLE_PRESETS.product, 'center-session')
  for (let i = 0; i < 10; i++) assert.equal(await chargeToolAttempt(store, { name: 'send_message', agent: i % 2 ? root : child }, scopes), null)
  const reopened = await createStateStore({ env })
  const state = await reopened.read()
  assert.equal(state.budgets[scopes[0]].delegations, 5)
  assert.equal(state.budgets[scopes[0]].messages, 10)
  assert.deepEqual(await chargeToolAttempt(reopened, { name: 'tool-fs', agent: root }, scopes), null)
  assert.deepEqual(await chargeToolAttempt(reopened, { name: 'subagent', agent: child }, scopes), { kind: 'deny', reason: 'Only the TradeLoom center session may delegate.' })
})

test('message budget denies overflow and state failure cannot bypass the gate', async () => {
  const root = agent('root-id', ROLE_PRESETS.center)
  const scopes = [JSON.stringify(['human-rpc', root.id, 'message-contract-test'])]
  const store = { async transact(fn) { const state = this.state ??= { budgets: {} }; return await fn(state) } }
  for (let i = 0; i < BUDGET_LIMITS.messages; i++) assert.equal(await chargeToolAttempt(store, { name: 'send_message', agent: root }, scopes), null)
  assert.equal((await chargeToolAttempt(store, { name: 'send_message', agent: root }, scopes)).kind, 'deny')
  assert.equal((await chargeToolAttempt({ transact: async () => { throw new Error('disk unavailable') } }, { name: 'subagent', agent: root }, scopes)).kind, 'deny')
})

test('budget overflow cancels the native execution, keeps its inbox, and denies the tool call', async () => {
  const root = agent('root-cancel-id', ROLE_PRESETS.center)
  const rpcId = 'cancel-existing-request'
  const scope = JSON.stringify(['human-rpc', root.id, rpcId])
  const store = { async transact(fn) { const state = this.state ??= { budgets: {} }; return await fn(state) } }
  await store.transact(state => { state.budgets[scope] = { delegations: 0, messages: BUDGET_LIMITS.messages } })
  const hooks = new Map()
  const cancellations = []
  applyBudgetGate({ on(event, handler) { hooks.set(event, handler) } }, { createStateStore: async () => store })
  const exec = { name: 'send_message', agent: { ...root, cancel: (...args) => cancellations.push(args) } }
  await hooks.get('agent/pre-step')({ agent: exec.agent, turn: 1, messages: [{ id: 'cancel-message', source: { kind: 'user', rpcId } }] }, async () => ({ kind: 'enter', messages: [] }))
  let toolDispatched = false
  const result = await hooks.get('tools/pre-execute')(exec, async () => { toolDispatched = true })
  assert.deepEqual(result, { kind: 'deny', reason: `TradeLoom human request messages budget (${BUDGET_LIMITS.messages}) is exhausted.` })
  assert.equal(toolDispatched, false)
  assert.deepEqual(cancellations, [[{ kind: 'hook', reason: 'execution budget exhausted' }, { keepInbox: true }]])
})

test('business presets reject only the 25th step within a turn', async () => {
  let hook
  applyStepLimit({ on(event, handler) { assert.equal(event, 'agent/pre-step'); hook = handler } })
  assert.equal(MAX_STEPS_PER_TURN, 24)
  const continuation = { kind: 'enter', messages: [] }
  const next = () => continuation
  for (const agentPreset of Object.values(ROLE_PRESETS)) {
    assert.equal(await hook({ agent: agent(`step-${agentPreset}`, agentPreset), step: 24 }, next), continuation)
    assert.deepEqual(await hook({ agent: agent(`step-${agentPreset}`, agentPreset), step: 25 }, next), { kind: 'reject' })
  }
  assert.equal(await hook({ agent: agent('step-standard', 'standard'), step: 25 }, next), continuation)
})

test('business step guard continues allowed steps and stops rejected steps', async () => {
  let hook
  applyStepLimit({ on(event, handler) { assert.equal(event, 'agent/pre-step'); hook = handler } })
  const allowed = Object.freeze({ kind: 'enter', messages: [] })
  let nextCalls = 0
  const next = () => { nextCalls++; return allowed }
  const pass = await hook({ agent: agent('center', ROLE_PRESETS.center), step: MAX_STEPS_PER_TURN }, next)
  assert.equal(pass, allowed)
  assert.equal(nextCalls, 1)
  const rejected = await hook({ agent: agent('center', ROLE_PRESETS.center), step: MAX_STEPS_PER_TURN + 1 }, next)
  assert.deepEqual(rejected, { kind: 'reject' })
  assert.equal(nextCalls, 1)
})

test('official DSH patch composer applies the real web bundle then TradeLoom overlay', async t => {
  const source = process.env.TRADELOOM_DSH_PINNED_SOURCE
  const appBootLibrary = process.env.TRADELOOM_DSH_APP_BOOT_LIBRARY
  const includeLibrary = process.env.TRADELOOM_CORDIS_INCLUDE_LIBRARY
  if (!source || !appBootLibrary || !includeLibrary) return t.skip('set pinned source and compiled app-boot/include libraries for official profile composition verification')
  const { composeEntries, loadProfile } = await import(new URL(`file:///${appBootLibrary.replaceAll('\\', '/')}`))
  const { entryListSchema } = await import(new URL(`file:///${includeLibrary.replaceAll('\\', '/')}`))
  const requireFromInclude = createRequire(new URL(`file:///${includeLibrary.replaceAll('\\', '/')}`))
  const yaml = requireFromInclude('js-yaml')
  const { home } = await fixtureHome(t)
  const anchorRoot = await mkdtemp(join(auditRoot, 'composer-install-anchor-'))
  t.after(() => rm(anchorRoot, { recursive: true, force: true }))
  const namespaceDir = join(anchorRoot, 'node_modules', '@deepseek-ai')
  await mkdir(namespaceDir, { recursive: true })
  for (const [packageName, bundleName] of [['dsh-base', 'base'], ['dsh-web-app', 'web-app']]) {
    await cp(join(source, 'packages', 'bundle', bundleName), join(namespaceDir, packageName), { recursive: true })
  }
  const installAnchor = join(anchorRoot, 'package.json')
  await writeFile(installAnchor, JSON.stringify({ name: 'tradeloom-composer-test-anchor', private: true }) + '\n')
  const profileHome = join(home, 'isolated-profile-home')
  const profile = loadProfile('app', 'web', installAnchor, profileHome)
  const sourceBundleNames = [
    JSON.parse(await readFile(join(source, 'packages/bundle/base/package.json'), 'utf8')).name,
    JSON.parse(await readFile(join(source, 'packages/bundle/web-app/package.json'), 'utf8')).name,
  ]
  assert.deepEqual(profile.layers.map(layer => layer.packageName), sourceBundleNames)
  const warnings = []
  const overlay = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
  const entries = composeEntries([
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    overlay,
  ], message => warnings.push(message))
  assert.deepEqual(warnings, [])
  const ids = entries.map(entry => entry.id).filter(Boolean)
  assert.equal(new Set(ids).size, ids.length, 'the composed root must not contain duplicate plugin ids')
  const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset')
  const businessPresetIds = Object.values(ROLE_PRESETS)
  const businessPresets = presets.filter(entry => businessPresetIds.includes(entry.config?.id))
  assert.deepEqual(businessPresets.map(entry => entry.config.id).sort(), [...businessPresetIds].sort())
  const centerPreset = businessPresets.find(entry => entry.config.id === ROLE_PRESETS.center)
  const delegation = centerPreset.config.plugins.find(plugin => plugin.id === 'delegation')
  assert.deepEqual(delegation.isolate, { subagents: true, workflowEngine: true }, 'the native delegation group must isolate every service required by its real providers')
  for (const disabledId of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.equal(entries.find(entry => entry.id === disabledId)?.disabled, true, `${disabledId} must be disabled by an update patch`)
  }
  for (const disabledId of ['deepseek-account', 'llm-deepseek-account', 'account-controller', 'ui-settings-account', 'product-analytics']) {
    assert.equal(entries.find(entry => entry.id === disabledId)?.disabled, true, `${disabledId} account login must be disabled in the product profile`)
  }
  for (const retainedId of ['authorization', 'credentials', 'llm-pi-ai', 'llm-deepseek']) {
    assert.ok(entries.some(entry => entry.id === retainedId && entry.disabled !== true), `${retainedId} must remain available for API-key/custom-provider configuration`)
  }
  assert.equal(entries.find(entry => entry.id === 'agent-preset-registry')?.config?.default, ROLE_PRESETS.center)
  assert.ok(entries.some(entry => entry.id === 'tradeloom-business-shell-host' && entry.name === '@tradeloom/dsh-business-shell'))
  const profilePreset = businessPresets.find(entry => entry.config.id === ROLE_PRESETS['user-profile'])
  const profilePlugins = profilePreset.config.plugins
  const profilePersona = profilePlugins.find(plugin => plugin.id === 'persona')?.config?.prefix
  assert.equal(typeof profilePersona, 'string')
  assert.match(profilePersona, /tradeloom_user_profile_read/)
  assert.match(profilePersona, /仅依据工具返回/)
  assert.match(profilePersona, /空字段请用户补充/)
  assert.match(profilePersona, /保持演示标记/)
  assert.doesNotMatch(profilePersona, /演示资料（待配置）/)
  assert.ok(profilePlugins.some(plugin => plugin.name === '@tradeloom/dsh-business-shell/profile'))
})
