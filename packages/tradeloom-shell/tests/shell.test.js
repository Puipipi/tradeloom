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
import * as hostExports from '../host.js'
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

// Offline persistence/Agent facade for the role-creation checkpoint, not Host proof.
function durableRoleCreation(ctx) {
  const agents = new Map()
  const persistence = { identity: Symbol('test-persistence'), async flush() {}, async stat(id) { return { header: agents.get(id).session.header } } }
  ctx.get = () => persistence
  ctx.agents = { get: id => agents.get(id) }
  ctx.workspaceRegistry.get = id => ctx.workspaceRegistry.list().find(row => row.id === id)
  const create = ctx.sessionController.create.bind(ctx.sessionController)
  ctx.sessionController.create = async input => {
    const result = await create(input), workspace = ctx.workspaceRegistry.get(input.workspaceId)
    workspace.sessionIds ??= []; workspace.sessionIds.push(result.sessionId)
    agents.set(result.sessionId, { id: result.sessionId, session: { id: result.sessionId,
      header: { id: result.sessionId, cwd: workspace.path, agentPreset: input.agentPreset } }, ctx: { get: () => persistence } })
    return result
  }
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
  const queuedFrames = []
  let deferFrames = false
  const rootThemeVariables = {}
  const body = { appendChild() {} }
  const frameSrc = '/business/home'
  const frame = {
    src: frameSrc,
    contentWindow: { postMessage(data, origin) { sent.push({ data, origin }) } },
    matches(selector) { return selector === 'iframe[data-tradeloom-business-frame]' },
  }
  const document = {
    querySelectorAll(selector) { return selector === 'iframe[data-tradeloom-business-frame]' ? frames : [] },
    querySelector() { return null }, body, createElement() { return { style: {}, remove() {} } },
    documentElement: { style: { setProperty(name, value) { rootThemeVariables[name] = value } } },
    addEventListener(name, listener) { documentListeners.set(name, listener) },
    removeEventListener(name) { documentListeners.delete(name) },
  }
  let computedScheme = 'dark'
  const aliasColors = {
    light: {
      '--dsw-alias-bg-base': 'rgb(244, 247, 251)', '--dsw-alias-bg-layer-1': 'rgb(255, 255, 255)',
      '--dsw-alias-bg-layer-2': 'rgb(233, 238, 246)', '--dsw-alias-border-l1': 'rgba(32, 43, 58, 0.12)',
      '--dsw-alias-label-primary': 'rgb(32, 43, 58)', '--dsw-alias-label-secondary': 'rgb(104, 119, 140)',
      '--dsw-alias-brand-primary': 'rgb(53, 111, 196)',
    },
    dark: {
      '--dsw-alias-bg-base': 'rgb(12, 16, 23)', '--dsw-alias-bg-layer-1': 'rgb(19, 25, 37)',
      '--dsw-alias-bg-layer-2': 'rgb(23, 31, 44)', '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.08)',
      '--dsw-alias-label-primary': 'rgb(223, 231, 243)', '--dsw-alias-label-secondary': 'rgb(139, 151, 171)',
      '--dsw-alias-brand-primary': 'rgb(77, 131, 221)',
    },
  }
  const darkAliasColors = aliasColors.dark
  aliasColors.dark = {}
  let computedStyleAvailable = false
  const window = {
    document, location: { origin: 'http://localhost:3088' },
    getComputedStyle(element) {
      if (!computedStyleAvailable) return null
      if (element === body) return { getPropertyValue(name) { return aliasColors[computedScheme][name] ?? '' } }
      return { color: 'rgb(223, 231, 243)', getPropertyValue() { return '' } }
    },
    requestAnimationFrame(callback) { if (deferFrames) queuedFrames.push(callback); else callback() },
    addEventListener(name, listener) { messageListeners.set(name, listener) },
    removeEventListener(name) { messageListeners.delete(name) },
    __ModuleLoader__: { load(value) { entryRegistration = value } },
  }
  runInNewContext(entrySource, { window, URL, URLSearchParams })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const sceneSource = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  let sceneRegistration
  runInNewContext(sceneSource, { window: { __ModuleLoader__: { load(value) { sceneRegistration = value } } } })
  const sceneContract = sceneRegistration.factory(() => React)
  let sharedUiTokens
  const sceneStyleSnapshots = []
  const scenePaletteSnapshots = []
  const clientRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  clientRequire.async = async name => {
    assert.equal(name, './client.scenes.js')
    return { register(ctx, _origin, _roles, _palette, uiTokens) {
      sharedUiTokens = uiTokens
      // Match the real chunk's listener ordering and inline style builder: the
      // shell registers first, then this listener observes the shared tokens.
      ctx.on('theme/change', () => {
        sceneStyleSnapshots.push(sceneContract.workbenchUiStyles(sharedUiTokens))
        scenePaletteSnapshots.push(_palette())
      })
    }, SceneTabs() {}, ModelDirectoryRail() {} }
  }
  const plugin = entryRegistration.factory(clientRequire)
  const slots = { inject(_name, register) { register() }, register() { return () => {} } }
  const effects = []
  let fontSize = 14
  const theme = {
    getTheme: () => ({ active: { colorScheme: 'dark' }, fontSizes: { text: fontSize, code: 11, terminal: 13 } }),
    setFontSize(role, value) {
      assert.equal(role, 'text')
      fontSize = value
      for (const listener of themeListeners.get('theme/change') ?? []) listener({ active: { colorScheme: 'dark' }, fontSizes: { text: fontSize, code: 11, terminal: 13 } })
    },
  }
  await plugin.apply({ slots, layout: { selectPanel() {} }, uiWorkspace: {}, theme, on(name, listener) {
    if (!themeListeners.has(name)) themeListeners.set(name, new Set())
    themeListeners.get(name).add(listener)
    return () => themeListeners.get(name)?.delete(listener)
  },
  effect(callback) { effects.push(callback) } })

  frames.push(frame)
  const originalFrameWindow = frame.contentWindow
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request' },
  })
  const initialMessage = sent[0]?.data
  assert.equal(initialMessage.colorScheme, 'dark')
  assert.equal(initialMessage.palette.canvas, '#0c0e14', 'missing early aliases use the approved near-black reference canvas palette')
  assert.ok(Object.values(initialMessage.palette).every(color => /^#[0-9a-f]{6}$/i.test(color)), 'early theme values never leave undefined color variables')
  assert.equal(rootThemeVariables['--tl-theme-canvas'], '#0c0e14', 'the reference canvas reaches shell portals before computed DSH aliases are available')
  assert.equal(rootThemeVariables['--tl-font-body'], '14px', 'shell portals use the persisted native default body size')
  computedStyleAvailable = true
  aliasColors.dark = {}
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request' },
  })
  const missingAliasesMessage = sent.at(-1)?.data
  assert.equal(missingAliasesMessage.palette.canvas, '#0c0e14', 'dark theme stays on the reference palette when CSS aliases are absent')
  assert.equal(missingAliasesMessage.palette.accent, '#6b9bf5', 'the dark reference palette uses blue selection emphasis')
  assert.ok(Object.values(missingAliasesMessage.palette).every(color => /^#[0-9a-f]{6}$/i.test(color)))
  aliasColors.dark = darkAliasColors
  const originalAccentAlias = darkAliasColors['--dsw-alias-brand-primary']
  darkAliasColors['--dsw-alias-brand-primary'] = 'rgb(50% 0% 100%)'
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request' },
  })
  const percentageMessage = sent.at(-1)?.data
  assert.equal(percentageMessage.palette.accent, '#8000ff', 'dark mode honors the same native theme aliases as light mode')
  assert.ok(Object.values(percentageMessage.palette).every(color => /^#[0-9a-f]{6}$/i.test(color)), 'dark reference tokens always resolve to valid colors')
  assert.equal(rootThemeVariables['--tl-theme-accent-soft'], percentageMessage.palette.accentSoft, 'the shell root uses the exact canonical accent-soft value sent to the iframe')
  assert.equal(rootThemeVariables['--tl-shell-accent-soft'], percentageMessage.palette.accentSoft, 'portal styling inherits that same accent-soft value')
  darkAliasColors['--dsw-alias-brand-primary'] = originalAccentAlias
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request' },
  })
  const darkMessage = sent.at(-1)?.data
  assert.equal(darkMessage.type, 'tradeloom:theme')
  assert.equal(darkMessage.colorScheme, 'dark')
  assert.deepEqual(Object.keys(darkMessage.palette).sort(), ['accent', 'accentSoft', 'accentStrong', 'border', 'buttonInk', 'canvas', 'danger', 'dangerBackground', 'dangerBorder', 'header', 'muted', 'panel', 'success', 'successBackground', 'teal', 'text', 'warning', 'warningBackground', 'warningBorder'])
  assert.equal(darkMessage.palette.canvas, '#0c1017')
  assert.equal(darkMessage.palette.panel, '#131925')
  assert.equal(darkMessage.palette.header, '#171f2c')
  assert.equal(darkMessage.palette.border, '#262b36')
  assert.equal(darkMessage.palette.accent, '#4d83dd')
  assert.equal(darkMessage.palette.teal, '#74cec6', 'floating emphasis keeps its semantic token instead of inheriting selected blue')
  assert.equal(rootThemeVariables['--tl-theme-accent-soft'], darkMessage.palette.accentSoft)
  assert.equal(rootThemeVariables['--tl-shell-accent-soft'], darkMessage.palette.accentSoft)
  const scenesSource = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  assert.doesNotMatch(entrySource, /--tl-shell-accent-soft:\s*color-mix/)
  assert.doesNotMatch(scenesSource, /--tl-shell-accent-soft:\s*color-mix/)
  assert.deepEqual(JSON.parse(JSON.stringify(darkMessage.ui)), {
    fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif', fontBody: 14, fontCompact: 12, lineHeight: 1.45,
    topRowHeight: 48, navHeight: 38, modelControl: 31, sceneTabHeight: 28, dockTabHeight: 28, controlHeight: 28, toolbarHeight: 30, iconSize: 15, cornerRadius: 8,
  })
  assert.equal(sent.at(-1).origin, 'http://localhost:3088')
  documentListeners.get('load')({ target: frame })
  assert.equal(sent.at(-1).data.colorScheme, 'dark')
  assert.equal(sent.at(-1).origin, 'http://localhost:3088')
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'https://other.example', data: { type: 'tradeloom:theme:request' },
  })
  messageListeners.get('message')({
    source: frame.contentWindow, origin: 'http://localhost:3088', data: { type: 'tradeloom:theme:request', token: 'ignored' },
  })
  assert.equal(sent.length, 5, 'foreign origins and unexpected request fields are ignored')
  deferFrames = true
  theme.setFontSize('text', 16)
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-font-body'], '16px', 'the scene listener sees the updated inline body token before the queued palette frame')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-font-compact'], '14px', 'the scene listener sees the updated compact token before repaint')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-dock-tab-height'], '32px', 'dock tab inline geometry is generated from the latest size')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-control-height'], '32px', 'toolbar/composer controls get the latest inline geometry')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-ui-scale'], String(16 / 14), 'composer density uses the newly selected local scale before RAF')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-space-3'], '9px', 'local panel and composer spacing follows the new scale')
  theme.setFontSize('text', 14)
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-font-body'], '14px', 'resetting before RAF flush updates workbench body styles immediately')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-font-compact'], '12px')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-dock-tab-height'], '28px')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-control-height'], '28px')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-ui-scale'], '1', 'reset returns local density to reference size synchronously')
  assert.equal(sceneStyleSnapshots.at(-1)['--tl-space-3'], '8px')
  assert.match(sceneSource, /--dv-tab-font-size:\s*var\(--tl-font-compact\)/, 'Dockview tabs inherit the latest local compact token')
  assert.match(sceneSource, /\.tl-native-conversation\s*\{[^}]*--dsh-content-font-size:\s*var\(--tl-font-body\)/s,
    'native chat body inherits the current workbench body token')
  assert.match(sceneSource, /\.tl-native-conversation \{ container-type: size; \}/,
    'native short-pane density queries resolve against the actual embedded pane')
  for (const callback of queuedFrames.splice(0)) callback()
  deferFrames = false
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rootThemeVariables['--tl-font-body'], '14px', 'the deferred root palette refresh does not restore a stale 16px value')
  assert.equal(sent.at(-1).data.ui.fontBody, 14, 'iframe bridge receives the latest size after queued frames flush')
  theme.setFontSize('text', 16)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rootThemeVariables['--tl-font-body'], '16px', 'a persisted native font preference updates shell typography')
  assert.equal(sent.at(-1).data.ui.fontBody, 16, 'the same theme change updates business iframe font tokens')
  assert.equal(sent.at(-1).data.ui.fontCompact, 14, 'the iframe compact token follows the selected native text size')
  assert.equal(sent.at(-1).data.ui.controlHeight, 32, 'the 16px size also scales control geometry from the 14px baseline')
  assert.equal(sent.at(-1).data.ui.iconSize, 17, 'icons scale with the same interface density')
  assert.equal(sent.at(-1).data.ui.topRowHeight, 55, 'navigation geometry scales without changing layout proportions')
  assert.equal(rootThemeVariables['--tl-space-3'], '9px', 'shell spacing scales alongside button and icon geometry')
  assert.equal(rootThemeVariables['--tl-ui-scale'], '1.1428571428571428', 'the shell exposes the same scale to scoped density rules')
  theme.setFontSize('text', 10)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.at(-1).data.ui.fontBody, 10)
  assert.equal(sent.at(-1).data.ui.controlHeight, 20, 'minimum native size produces compact but valid controls')
  assert.equal(sent.at(-1).data.ui.iconSize, 11)
  assert.equal(sent.at(-1).data.ui.cornerRadius, 6)
  theme.setFontSize('text', 22)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.at(-1).data.ui.fontBody, 22)
  assert.equal(sent.at(-1).data.ui.controlHeight, 44, 'maximum native size expands controls')
  assert.equal(sent.at(-1).data.ui.iconSize, 24)
  assert.equal(sent.at(-1).data.ui.topRowHeight, 75)
  theme.setFontSize('text', 16)
  await new Promise(resolve => setImmediate(resolve))
  computedScheme = 'light'
  deferFrames = true
  for (const listener of themeListeners.get('theme/change') ?? []) listener({ active: { colorScheme: 'light' } })
  assert.equal(scenePaletteSnapshots.at(-1).canvas, '#f4f7fb',
    'the synchronous popout listener must resolve the new palette before the deferred root refresh')
  for (const callback of queuedFrames.splice(0)) callback()
  deferFrames = false
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.at(-1).data.colorScheme, 'light')
  assert.equal(sent.at(-1).data.palette.canvas, '#f4f7fb')
  assert.equal(sent.at(-1).data.palette.teal, '#177d78', 'light floating emphasis comes from the same canonical palette')
  assert.equal(sent.at(-1).data.ui.fontBody, 16, 'color-scheme changes preserve the persisted text size')
  assert.equal(sent.at(-1).origin, 'http://localhost:3088')
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
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
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
    ['../host.js', '@tradeloom/dsh-business-shell', ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'tools', 'agents']],
    ['../proxy.js', '@tradeloom/dsh-business-shell/proxy', ['connection', 'webServer']],
    ['../policy.js', '@tradeloom/dsh-business-shell/policy', ['tools', 'agents']],
    ['../profile-tool.js', '@tradeloom/dsh-business-shell/profile', ['tools']],
    ['../business-tools.js', '@tradeloom/dsh-business-shell/business-tools', ['tools', 'webServer', 'agents']],
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
  durableRoleCreation(ctx)
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

test('the protected host registers the explicit create-new-session route', async () => {
  const routes = []
  const ctx = {
    tools: {}, agents: { get() { return undefined } },
    connection: { requestRejection() {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    workspaceRegistry: {}, sessionController: {},
    on() {}, effect(register) { this.cleanup = register() },
  }
  applyHost(ctx)
  try {
    assert.ok(routes.some(route => route.kind === 'exact' && route.path === '/tradeloom/session/new'),
      'creating a configured new conversation must use a protected exact route')
    assert.equal(typeof hostExports.createNewSessionHandler, 'function')
  } finally { ctx.cleanup() }
})

async function newSessionFixture(t, options = {}) {
  const { env } = await fixtureHome(t)
  const store = await createStateStore({ env })
  const workspaces = []
  const archivedSessionIds = []
  const observations = new Map()
  const calls = []
  const ctx = {
    connection: { requestRejection: () => undefined },
    workspaceRegistry: {
      list: () => workspaces,
      get(id) { return workspaces.find(item => item.id === id) },
      archivedSessionIds,
      async create(path, title) {
        const workspace = { id: `workspace-${workspaces.length}`, path, title, sessionIds: [] }
        workspaces.push(workspace)
        return workspace
      },
    },
    sessionQuery: {
      async observeSession(sessionId) {
        const saved = observations.get(sessionId)
        if (!saved) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { ...saved, cursor: saved.cursor ?? (saved.events ?? []).length - 1, [Symbol.dispose]() {} }
      },
    },
    sessionController: {
      async create(input) {
        calls.push(input)
        if (options.create) return await options.create(input, { workspaces, observations })
        const workspace = workspaces.find(item => item.id === input.workspaceId)
        if (!workspace.sessionIds.includes(input.sessionId)) workspace.sessionIds.push(input.sessionId)
        observations.set(input.sessionId, {
          header: { id: input.sessionId, cwd: workspace.path },
          projections: { values: { agentPreset: input.agentPreset } }, events: [],
        })
        return { sessionId: input.sessionId, agentPreset: input.agentPreset }
      },
    },
  }
  const agents = new Map()
  const persistence = { identity: Symbol('offline-new-session-persistence'), async flush() {}, async stat(id) {
    const observed = observations.get(id)
    return observed ? { header: { ...observed.header, agentPreset: observed.projections.values.agentPreset } } : undefined
  } }
  ctx.get = () => persistence
  ctx.agents = { get: id => agents.get(id) }
  const create = ctx.sessionController.create.bind(ctx.sessionController)
  ctx.sessionController.create = async input => {
    const result = await create(input)
    agents.set(result.sessionId, { id: result.sessionId, session: { id: result.sessionId, seq: (observations.get(result.sessionId)?.events ?? []).length }, ctx: { get: () => persistence } })
    return result
  }
  const handler = hostExports.createNewSessionHandler(ctx, {
    createStateStore: () => store,
    resolveOwnedHome: () => resolveOwnedHome(env),
    roleWorkspacePath: role => roleWorkspacePath(role, env),
  })
  return { env, store, workspaces, archivedSessionIds, observations, calls, handler }
}

test('new-session operation creates a separate native session and replays the durable result', async t => {
  const fixture = await newSessionFixture(t)
  await fixture.store.transact(state => { state.roles.center = { sessionId: 'old-center-session', workspaceId: 'old-workspace' } })
  const input = { role: 'center', expectedSessionId: 'old-center-session', operationId: '7b0d46e9-90e0-4bf3-a04b-551a85cb8788' }
  const created = response()
  await fixture.handler(request('POST', input), created)
  const result = JSON.parse(created.body)
  assert.equal(created.statusCode, 201)
  assert.equal(result.sessionId, `session-${input.operationId}`)
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].agentPreset, 'tradeloom-center')
  const stateAfterCreate = await fixture.store.read()
  assert.equal(stateAfterCreate.roles.center.sessionId, result.sessionId)
  assert.equal(stateAfterCreate.sessionCreateOperations[input.operationId].status, 'completed')

  const replay = response()
  await fixture.handler(request('POST', input), replay)
  assert.equal(replay.statusCode, 200)
  assert.equal(JSON.parse(replay.body).sessionId, result.sessionId)
  assert.equal(JSON.parse(replay.body).replayed, true)
  assert.equal(fixture.calls.length, 1, 'a completed operation is replayed from persistent state')
  assert.equal(stateAfterCreate.roles.center.sessionId, result.sessionId, 'the old session identity is not rewritten or deleted')
})

test('new-session operation rejects changed payloads, concurrent different operations, and non-reusable native IDs', async t => {
  let releaseCreate
  let createEntered
  const gate = new Promise(resolve => { releaseCreate = resolve })
  const entered = new Promise(resolve => { createEntered = resolve })
  const fixture = await newSessionFixture(t, { create: async (input, state) => {
    createEntered()
    await gate
    const workspace = state.workspaces.find(item => item.id === input.workspaceId)
    workspace.sessionIds.push(input.sessionId)
    state.observations.set(input.sessionId, {
      header: { id: input.sessionId, cwd: workspace.path },
      projections: { values: { agentPreset: input.agentPreset } }, events: [],
    })
    return { sessionId: input.sessionId, agentPreset: input.agentPreset }
  } })
  await fixture.store.transact(state => { state.roles.center = { sessionId: 'prior-session' } })
  const first = { role: 'center', expectedSessionId: 'prior-session', operationId: 'fd02e8a4-62f8-42e1-856b-58b1c32d72ee' }
  const firstResponse = response()
  const firstPending = fixture.handler(request('POST', first), firstResponse)
  await entered
  const duplicateResponse = response()
  const duplicatePending = fixture.handler(request('POST', first), duplicateResponse)
  const competing = response()
  await fixture.handler(request('POST', { ...first, operationId: 'ccad4805-8fd2-41e8-9b5f-514cb0a289ed' }), competing)
  assert.equal(competing.statusCode, 409)
  const changed = response()
  await fixture.handler(request('POST', { ...first, expectedSessionId: 'different-session' }), changed)
  assert.equal(changed.statusCode, 409)
  releaseCreate()
  await Promise.all([firstPending, duplicatePending])
  assert.equal(firstResponse.statusCode, 201)
  assert.equal(duplicateResponse.statusCode, 201, 'a concurrent retry of the same operation receives the same created session')
  assert.equal(JSON.parse(duplicateResponse.body).sessionId, JSON.parse(firstResponse.body).sessionId)
  assert.equal(fixture.calls.length, 1, 'the persisted role reservation admits only one different create at a time')

  const mismatchedFixture = await newSessionFixture(t, { create: async input => ({ sessionId: 'session-native-minted-instead', agentPreset: input.agentPreset }) })
  await mismatchedFixture.store.transact(state => { state.roles.center = { sessionId: 'prior-session' } })
  const mismatch = response()
  await mismatchedFixture.handler(request('POST', { ...first, operationId: '203d6a6e-0189-4495-b442-3ad6f07a26e4' }), mismatch)
  assert.equal(mismatch.statusCode, 409)
  assert.equal((await mismatchedFixture.store.read()).roles.center.sessionId, 'prior-session', 'a minted replacement is never bound')
  assert.equal((await mismatchedFixture.store.read()).sessionCreateOperations['203d6a6e-0189-4495-b442-3ad6f07a26e4'].status, 'outcome_unknown')
})

test('a lost create response replays the committed operation, while an attempted unknown result is never retried blindly', async t => {
  const fixture = await newSessionFixture(t)
  const input = { role: 'product', expectedSessionId: null, operationId: '8a75b2f0-935c-4826-a675-c583c62bc173' }
  const lostResponse = response()
  lostResponse.end = () => { throw new Error('synthetic client disconnect') }
  await assert.rejects(fixture.handler(request('POST', input), lostResponse), /synthetic client disconnect/)
  const replay = response()
  await fixture.handler(request('POST', input), replay)
  assert.equal(replay.statusCode, 200)
  assert.equal(JSON.parse(replay.body).replayed, true)
  assert.equal(fixture.calls.length, 1, 'response loss after commit does not create another session')

  let unknownCalls = 0
  const unknown = await newSessionFixture(t, { create: async () => { unknownCalls++; throw new Error('synthetic unknown create outcome') } })
  const uncertainInput = { role: 'delivery', expectedSessionId: null, operationId: '6292a5ef-902b-46fa-ae93-12f0846a5bca' }
  const firstUnknown = response()
  await unknown.handler(request('POST', uncertainInput), firstUnknown)
  assert.equal(firstUnknown.statusCode, 503)
  const retryUnknown = response()
  await unknown.handler(request('POST', uncertainInput), retryUnknown)
  assert.equal(retryUnknown.statusCode, 409)
  assert.equal(unknownCalls, 1, 'a pending operation with no queryable native result is not re-created')
  assert.equal((await unknown.store.read()).sessionCreateOperations[uncertainInput.operationId].status, 'attempted')
})

test('an attempted create is recovered only when the native session matches its durable intent', async t => {
  const fixture = await newSessionFixture(t)
  const operationId = '7da48a92-174d-4793-9f8e-70d94703cd0a'
  const sessionId = `session-${operationId}`
  const workspacePath = await roleWorkspacePath('center', fixture.env)
  const workspace = { id: 'workspace-existing', path: workspacePath, title: 'TradeLoom center', sessionIds: [sessionId] }
  fixture.workspaces.push(workspace)
  fixture.observations.set(sessionId, {
    header: { id: sessionId, cwd: workspacePath },
    projections: { values: { agentPreset: 'tradeloom-center' } }, events: [],
  })
  await fixture.store.transact(state => {
    state.roles.center = { sessionId: 'old-center' }
    state.sessionCreateOperations[operationId] = {
      operationId, fingerprint: JSON.stringify(['center', 'old-center']), role: 'center',
      expectedSessionId: 'old-center', sessionId, workspacePath, workspaceId: workspace.id,
      agentPreset: 'tradeloom-center', status: 'attempted',
    }
    state.pendingSessionCreateByRole.center = operationId
  })
  const recovered = response()
  await fixture.handler(request('POST', { role: 'center', expectedSessionId: 'old-center', operationId }), recovered)
  assert.equal(recovered.statusCode, 201)
  assert.equal(JSON.parse(recovered.body).sessionId, sessionId)
  assert.equal(fixture.calls.length, 0, 'a matching persisted native session is observed and bound without a second create call')
  assert.equal((await fixture.store.read()).roles.center.sessionId, sessionId)

  const mismatch = await newSessionFixture(t)
  const mismatchWorkspacePath = await roleWorkspacePath('center', mismatch.env)
  const mismatchWorkspace = { id: 'workspace-existing', path: mismatchWorkspacePath, title: 'TradeLoom center', sessionIds: [sessionId] }
  mismatch.workspaces.push(mismatchWorkspace)
  mismatch.observations.set(sessionId, {
    header: { id: sessionId, cwd: 'wrong-workspace-path' },
    projections: { values: { agentPreset: 'tradeloom-product' } }, events: [],
  })
  await mismatch.store.transact(state => {
    state.roles.center = { sessionId: 'old-center' }
    state.sessionCreateOperations[operationId] = {
      operationId, fingerprint: JSON.stringify(['center', 'old-center']), role: 'center',
      expectedSessionId: 'old-center', sessionId, workspacePath: mismatchWorkspacePath, workspaceId: mismatchWorkspace.id,
      agentPreset: 'tradeloom-center', status: 'attempted',
    }
    state.pendingSessionCreateByRole.center = operationId
  })
  const refused = response()
  await mismatch.handler(request('POST', { role: 'center', expectedSessionId: 'old-center', operationId }), refused)
  assert.equal(refused.statusCode, 409)
  assert.equal(mismatch.calls.length, 0)
  assert.equal((await mismatch.store.read()).roles.center.sessionId, 'old-center')

  const archived = await newSessionFixture(t)
  const archivedWorkspacePath = await roleWorkspacePath('center', archived.env)
  archived.workspaces.push({ id: 'workspace-existing', path: archivedWorkspacePath, title: 'TradeLoom center', sessionIds: [sessionId] })
  archived.archivedSessionIds.push(sessionId)
  archived.observations.set(sessionId, {
    header: { id: sessionId, cwd: archivedWorkspacePath },
    projections: { values: { agentPreset: 'tradeloom-center' } }, events: [],
  })
  await archived.store.transact(state => {
    state.roles.center = { sessionId: 'old-center' }
    state.sessionCreateOperations[operationId] = {
      operationId, fingerprint: JSON.stringify(['center', 'old-center']), role: 'center',
      expectedSessionId: 'old-center', sessionId, workspacePath: archivedWorkspacePath, workspaceId: 'workspace-existing',
      agentPreset: 'tradeloom-center', status: 'attempted',
    }
    state.pendingSessionCreateByRole.center = operationId
  })
  const archivedResponse = response()
  await archived.handler(request('POST', { role: 'center', expectedSessionId: 'old-center', operationId }), archivedResponse)
  assert.equal(archivedResponse.statusCode, 409, 'an archived session is never treated as reusable blank state')
  assert.equal(archived.calls.length, 0)
  assert.equal((await archived.store.read()).roles.center.sessionId, 'old-center')

  const initialized = await newSessionFixture(t)
  const initializedWorkspacePath = await roleWorkspacePath('center', initialized.env)
  initialized.workspaces.push({ id: 'workspace-existing', path: initializedWorkspacePath, title: 'TradeLoom center', sessionIds: [sessionId] })
  initialized.observations.set(sessionId, {
    header: { id: sessionId, cwd: initializedWorkspacePath },
    projections: { values: { agentPreset: 'tradeloom-center', turnBoundary: { openTurnStartSeq: null, lastTurn: 0 } } },
    events: [{ type: 'session/created' }, { type: 'agent-preset/selected' }],
  })
  await initialized.store.transact(state => {
    state.roles.center = { sessionId: 'old-center' }
    state.sessionCreateOperations[operationId] = {
      operationId, fingerprint: JSON.stringify(['center', 'old-center']), role: 'center',
      expectedSessionId: 'old-center', sessionId, workspacePath: initializedWorkspacePath, workspaceId: 'workspace-existing',
      agentPreset: 'tradeloom-center', status: 'attempted',
    }
    state.pendingSessionCreateByRole.center = operationId
  })
  const initializedRecovery = response()
  await initialized.handler(request('POST', { role: 'center', expectedSessionId: 'old-center', operationId }), initializedRecovery)
  assert.equal(initializedRecovery.statusCode, 201,
    'non-turn initialization events remain blank when the official turnBoundary says no turn has started')
  assert.equal(initialized.calls.length, 0)
  assert.equal((await initialized.store.read()).roles.center.sessionId, sessionId)

  const started = await newSessionFixture(t)
  const startedWorkspacePath = await roleWorkspacePath('center', started.env)
  started.workspaces.push({ id: 'workspace-existing', path: startedWorkspacePath, title: 'TradeLoom center', sessionIds: [sessionId] })
  started.observations.set(sessionId, {
    header: { id: sessionId, cwd: startedWorkspacePath },
    projections: { values: { agentPreset: 'tradeloom-center', turnBoundary: { openTurnStartSeq: 18, lastTurn: 1 } } },
    events: [{ type: 'message/created' }],
  })
  await started.store.transact(state => {
    state.roles.center = { sessionId: 'old-center' }
    state.sessionCreateOperations[operationId] = {
      operationId, fingerprint: JSON.stringify(['center', 'old-center']), role: 'center',
      expectedSessionId: 'old-center', sessionId, workspacePath: startedWorkspacePath, workspaceId: 'workspace-existing',
      agentPreset: 'tradeloom-center', status: 'attempted',
    }
    state.pendingSessionCreateByRole.center = operationId
  })
  const startedRecovery = response()
  await started.handler(request('POST', { role: 'center', expectedSessionId: 'old-center', operationId }), startedRecovery)
  assert.equal(startedRecovery.statusCode, 409, 'a started turn can never be rebound as the blank session')
  assert.equal(started.calls.length, 0)
  assert.equal((await started.store.read()).roles.center.sessionId, 'old-center')
})

test('new-session route rejects unauthorized and non-closed requests before touching state', async t => {
  const fixture = await newSessionFixture(t)
  let authorized = false
  fixture.handler = hostExports.createNewSessionHandler({
    connection: { requestRejection: () => authorized ? undefined : 403 },
  }, {
    createStateStore: () => { throw new Error('state must not be read before authorization and schema validation') },
    resolveOwnedHome: () => 'synthetic-owned-home',
  })
  const denied = response()
  await fixture.handler(request('POST', { role: 'center', expectedSessionId: null, operationId: 'c5f4d5aa-0011-4dd7-b5f9-4aa28c86b9ef' }), denied)
  assert.equal(denied.statusCode, 403)
  authorized = true
  for (const invalid of [
    { role: 'center', expectedSessionId: null, operationId: 'not-a-uuid' },
    { role: 'center', expectedSessionId: null, operationId: 'c5f4d5aa-0011-4dd7-b5f9-4aa28c86b9ef', extra: true },
  ]) {
    const rejected = response()
    await fixture.handler(request('POST', invalid), rejected)
    assert.equal(rejected.statusCode, 400)
  }
  const brokenBody = {
    method: 'POST', headers: {},
    async *[Symbol.asyncIterator]() { throw new Error('synthetic request stream failure') },
  }
  const readFailed = response()
  await fixture.handler(brokenBody, readFailed)
  assert.equal(readFailed.statusCode, 400, 'request stream failure is projected safely instead of escaping the route')
  assert.deepEqual(JSON.parse(readFailed.body), { error: 'request-body-unavailable' })
})

test('same operation UUID in separate owned homes does not share an in-flight result', async t => {
  let started = 0
  let release
  let bothStarted
  const gate = new Promise(resolve => { release = resolve })
  const both = new Promise(resolve => { bothStarted = resolve })
  const create = async (input, { workspaces, observations }) => {
    started++
    if (started === 2) bothStarted()
    await gate
    const workspace = workspaces.find(item => item.id === input.workspaceId)
    workspace.sessionIds.push(input.sessionId)
    observations.set(input.sessionId, {
      header: { id: input.sessionId, cwd: workspace.path },
      projections: { values: { agentPreset: input.agentPreset } }, events: [],
    })
    return { sessionId: input.sessionId, agentPreset: input.agentPreset }
  }
  const left = await newSessionFixture(t, { create })
  const right = await newSessionFixture(t, { create })
  const input = { role: 'center', expectedSessionId: null, operationId: 'f2b25df5-c1fb-411b-8840-0fe1ed470fbf' }
  const leftResponse = response()
  const rightResponse = response()
  const leftPending = left.handler(request('POST', input), leftResponse)
  const rightPending = right.handler(request('POST', input), rightResponse)
  await both
  release()
  await Promise.all([leftPending, rightPending])
  assert.equal(started, 2, 'each owned home has an independent operation namespace')
  assert.equal(leftResponse.statusCode, 201)
  assert.equal(rightResponse.statusCode, 201)
  assert.equal(left.calls.length, 1)
  assert.equal(right.calls.length, 1)
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
  const centerRoot = dock.scenes.center.dockview.grid.root
  assert.equal(centerRoot.type, 'branch')
  assert.equal(centerRoot.data.length, 2, 'the upgraded workbench recommendation contains top and bottom rows')
  assert.deepEqual(centerRoot.data.map(row => row.size), [60, 40])
  assert.deepEqual(centerRoot.data.map(row => row.data.map(column => [column.size, column.data.views])), [
    [[75, ['business-main']], [25, ['files']]],
    [[40, ['preview']], [60, ['native-chat']]],
  ], 'the upgraded default matches the four-panel DSH reference without discarding its v1 snapshot')

  const savedDock = structuredClone(dock)
  savedDock.scenes.center.dockview.activeGroup = 'topb'
  const savedResponse = response()
  await dockHandler(request('PUT', savedDock), savedResponse)
  assert.equal(savedResponse.statusCode, 200)
  assert.equal(JSON.parse(savedResponse.body).scenes.center.dockview.activeGroup, 'topb')

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
  assert.equal(state.dockLayouts.scenes.center.dockview.activeGroup, 'topb')
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
  assert.deepEqual(Object.keys((await store.read()).dockLayouts.scenes.center.dockview.panels).sort(), ['business-main', 'files', 'native-chat', 'preview'])

  const oversizedRequest = Readable.from([Buffer.from(JSON.stringify({ version: 2, scenes: {}, padding: 'x'.repeat(130 * 1024) }))])
  oversizedRequest.method = 'PUT'
  oversizedRequest.headers = { host: 'localhost:3088', origin: 'http://localhost:3088' }
  const tooLarge = response()
  await handler(oversizedRequest, tooLarge)
  assert.equal(tooLarge.statusCode, 413)
  assert.deepEqual(Object.keys((await store.read()).dockLayouts.scenes.center.dockview.panels).sort(), ['business-main', 'files', 'native-chat', 'preview'])
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
  durableRoleCreation(ctx)
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
