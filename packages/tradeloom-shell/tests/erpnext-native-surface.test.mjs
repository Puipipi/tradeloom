import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { validateSceneConfig } from '../scene-layout.js'

const clientUrl = new URL('../client.js', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

test('ERPNext native scene component renders outside the hidden generic DSH root', async () => {
  const source = await readFile(clientUrl, 'utf8')
  const start = source.indexOf("if (descriptor.kind === 'scene-component') {")
  const end = source.indexOf("if (descriptor.kind === 'role') reportRoleGuestPhase", start)
  assert.ok(start >= 0 && end > start, 'scene component registration branch is present')
  const sceneComponentBranch = source.slice(start, end)

  assert.match(sceneComponentBranch, /descriptor\.componentKey === 'erpnext-status-native'[\s\S]*?descriptor\.sceneId === 'erpnext'[\s\S]*?descriptor\.panelId === 'business-main'[\s\S]*?SourceErpNextStatus/)
  assert.match(sceneComponentBranch, /descriptor\.componentKey === 'workflow-canvas-native'[\s\S]*?descriptor\.sceneId === 'agent-center'[\s\S]*?descriptor\.panelId === 'business-main'[\s\S]*?SourceWorkflowCanvas/,
    'the shared portal wrapper still serves the existing standalone workflow pane')
  assert.match(sceneComponentBranch, /ctx\.slots\.inject\('root'/,
    'the native child must render a root presenter instead of retaining the generic DSH shell')
  assert.match(sceneComponentBranch, /data-source-owned-scene-component/)
  assert.match(sceneComponentBranch, /body:has\(\[data-source-owned-scene-component\]\) \.dshwv-root\s*\{\s*display:\s*none !important;\s*\}/)
  assert.match(sceneComponentBranch, /ReactDOM\.createPortal\([\s\S]*?portalHost/,
    'the native presenter is rendered in an external host before the generic root is hidden')
  assert.match(sceneComponentBranch, /window\.document\.body\.append\(host\)/)
  assert.match(sceneComponentBranch, /h\(SourceSceneComponent,\s*\{\s*renderFactorySlot\s*\}\)/)
})

test('ERPNext status UI chunk is included and dynamically loadable by the business shell', async () => {
  const [source, packageJson] = await Promise.all([
    readFile(clientUrl, 'utf8'),
    readFile(packageUrl, 'utf8').then(JSON.parse),
  ])
  assert.ok(packageJson.files.includes('client.scenes.js'))
  assert.match(source, /require\.async\('\.\/client\.scenes\.js'\)/)
})

test('ERPNext scene uses the renderer and bridge that are actually loaded by the installed shell', async () => {
  const base = '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/'
  const [indexSource, templatesSource, rendererSource, bridgeSource, hostConfig] = await Promise.all([
    readFile(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/source-entry.html', import.meta.url), 'utf8'),
    readFile(new URL(base + 'scenes-data.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'renderer.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'business-bridge.js', import.meta.url), 'utf8'),
    readFile(new URL('../scenes.json', import.meta.url), 'utf8').then(JSON.parse),
  ])
  assert.match(indexSource, /<script src="replica-ui\/business-bridge\.js"><\/script>[\s\S]*?<script src="replica-ui\/renderer\.js"><\/script>/)
  assert.doesNotMatch(indexSource, /<script src="replica-ui\/replica-adapter\.js"><\/script>/,
    'the status renderer must not depend on the packaged but unloaded adapter')
  validateSceneConfig(hostConfig)
  const hostErpScene = hostConfig.scenes.find(value => value.id === 'erpnext')
  assert.equal(hostErpScene.panels.find(panel => panel.id === 'native-chat')?.type, 'native-chat',
    'the real default Host configuration retains its required assistant panel')
  assert.equal(hostErpScene.panels.find(panel => panel.id === 'business-main')?.type, 'erpnext-status')
  const data = { window: {} }
  runInNewContext(templatesSource, data)
  const ids = data.window.__SCENES__.scenes.map(scene => scene.id)
  for (const id of ['center', 'products', 'order-production', 'agent-center', 'deliverables', 'runs']) {
    assert.ok(ids.includes(id), `the accepted scene template ${id} remains available`)
  }
  assert.ok(ids.includes('erpnext'), 'the tools scene has a matching visible template')

  const projection = { configurationTemplates: data.window.__SCENES__.scenes }
  const start = rendererSource.indexOf('const visibleConfiguredScenes')
  const end = rendererSource.indexOf('function applyTrustedSceneConfiguration', start)
  assert.ok(start >= 0 && end > start)
  runInNewContext(rendererSource.slice(start, end) + '\nglobalThis.visibleConfiguredScenes = visibleConfiguredScenes; globalThis.projectTrustedScene = projectTrustedScene;', projection)
  const scene = hostConfig.scenes.find(value => value.id === 'erpnext')
  const visible = projection.visibleConfiguredScenes(hostConfig)
  const projected = projection.projectTrustedScene(scene)
  assert.ok(visible.some(value => value.id === 'erpnext'), 'ERPNext survives installed scene eligibility')
  assert.equal(projected.panels.find(panel => panel.id === 'business-main')?.type, 'erpnext-status',
    'the visible scene retains the authorized native ERPNext surface')
  assert.equal(projected.panels.length, 1, 'ERPNext scene projects no unsupported filler panels')
  assert.deepEqual(
    ['col', 'row', 'w', 'h'].map(key => projected.panels[0][key]),
    [1, 1, 4, 4],
    'the native status panel fills the scene regardless of stale auxiliary panel geometry',
  )

  const registryStart = rendererSource.indexOf('const rendererRegistry = {')
  const registryEnd = rendererSource.indexOf('\n}\nconst unsupportedRenderer', registryStart) + 2
  assert.ok(registryStart >= 0 && registryEnd > registryStart, 'renderer registry boundary is present')
  const registryContext = {
    window: { businessBridge: { renderErpNextStatusPanel(panel, content) { return { panel, content, native: true } } } },
  }
  runInNewContext(rendererSource.slice(registryStart, registryEnd)
    + '\nglobalThis.testRendererRegistry = rendererRegistry;', registryContext)
  const content = {}
  const rendered = registryContext.testRendererRegistry['erpnext-status'](projected.panels[0], content)
  assert.equal(rendered.native, true, 'ERPNext registry dispatches to the accepted native renderer adapter')
  assert.equal(rendered.panel.type, 'erpnext-status')

  assert.match(bridgeSource, /renderErpNextStatusPanel\(panel, content\)/)
  assert.match(bridgeSource, /window\.fetch\(path,\s*\{\s*method: 'GET', credentials: 'same-origin'/)
  assert.match(bridgeSource, /\/business-api\/erpnext\/status/)
  assert.match(bridgeSource, /\/business-api\/erpnext\/records\?/)
  assert.match(bridgeSource, /\/business-api\/erpnext\/record\?/)
})

test('loaded business bridge renders status, safe ERP entry, and read-only record flow', async () => {
  const bridgeSource = await readFile(new URL(
    '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/business-bridge.js',
    import.meta.url,
  ), 'utf8')
  const start = bridgeSource.indexOf('  const erpNextDoctypes = Object.freeze(')
  const end = bridgeSource.indexOf('  async function openErpNextStatus()', start)
  assert.ok(start >= 0 && end > start)

  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.style = {} }
    append(...items) { for (const item of items) { if (item && typeof item === 'object') item.parent = this; this.children.push(item) } }
    prepend(item) { if (item && typeof item === 'object') item.parent = this; this.children.unshift(item) }
    replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items) }
    set textContent(value) { this._text = String(value); this.children = [] }
    get textContent() { return this._text || this.children.map(item => item?.textContent ?? '').join('') }
    setAttribute(key, value) { this.attributes[key] = String(value) }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
    querySelector() { return undefined }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this) }
  }
  const calls = []
  const externalOpenCalls = []
  const fixtures = {
    '/business-api/erpnext/status': { configured: true, connected: true, status: 'connected', site_url: 'https://erp.example.test/site' },
  }
  const itemRecord = { doctype: 'Item', data: { name: 'QA-ITEM-001', item_code: 'QA-ITEM-001', item_name: '合成商品' },
    external_ref: { system: 'erpnext', doctype: 'Item', name: 'QA-ITEM-001' } }
  const context = {
    URL, URLSearchParams, Promise,
    document: { createElement: tag => new Element(tag) },
    app: { async openErpNextWorkbench(...args) { externalOpenCalls.push(args); return { opened: true } } },
    window: { fetch: async (path, options) => {
      calls.push({ path: String(path), options })
      const result = path.startsWith('/business-api/erpnext/records?')
        ? { doctype: 'Item', records: [itemRecord], next_offset: null }
          : path.startsWith('/business-api/erpnext/record?') ? itemRecord : fixtures[path]
      return { ok: Boolean(result), async json() { return result } }
    } },
  }
  runInNewContext(bridgeSource.slice(start, end) + '\nglobalThis.renderStatus = renderErpNextStatusPanel;', context)
  const content = new Element('div')
  const cleanup = context.renderStatus({ id: 'business-main', sceneId: 'erpnext', type: 'erpnext-status' }, content)
  await new Promise(resolve => setImmediate(resolve))
  const visit = (node, out = []) => { if (!node || typeof node !== 'object') return out; out.push(node); node.children.forEach(child => visit(child, out)); return out }
  let nodes = visit(content)
  assert.ok(nodes.some(node => node.textContent.includes('ERPNext 已连接')))
  const openWorkbench = nodes.find(node => node.tagName === 'button' && node.textContent === '打开 ERPNext 工作台')
  assert.ok(openWorkbench)
  await openWorkbench.listeners.click[0]()
  assert.deepEqual(externalOpenCalls, [[]], 'renderer sends no destination to Main')
  assert.ok(nodes.some(node => node.textContent.includes('合成商品')))
  const details = nodes.find(node => node.tagName === 'button' && node.textContent === '详情')
  details.listeners.click[0]()
  await new Promise(resolve => setImmediate(resolve))
  nodes = visit(content)
  assert.ok(nodes.some(node => node.tagName === 'pre' && node.textContent.includes('QA-ITEM-001')))
  assert.ok(calls.length >= 3)
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin'))
  cleanup()
  assert.equal(content.children.length, 0)

  const recordCallsBeforeUnconfigured = calls.filter(call => call.path.startsWith('/business-api/erpnext/records?')).length
  fixtures['/business-api/erpnext/status'] = {
    configured: false, connected: false, status: 'not_configured', site_url: '', error_code: '',
  }
  const unconfiguredCleanup = context.renderStatus({ id: 'business-main', sceneId: 'erpnext', type: 'erpnext-status' }, content)
  await new Promise(resolve => setImmediate(resolve))
  nodes = visit(content)
  assert.ok(nodes.some(node => node.textContent.includes('ERPNext 尚未配置')))
  assert.equal(nodes.some(node => node.tagName === 'button' && node.textContent === '打开 ERPNext 工作台'), false)
  assert.equal(calls.filter(call => call.path.startsWith('/business-api/erpnext/records?')).length, recordCallsBeforeUnconfigured)
  unconfiguredCleanup()
})

test('ERPNext menu opens the configured operational scene instead of a blank native popup', async () => {
  const source = await readFile(new URL(
    '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/business-bridge.js',
    import.meta.url,
  ), 'utf8')
  const start = source.indexOf('  async function openErpNextStatus()')
  const end = source.indexOf('  async function openNativeConversation()', start)
  assert.ok(start >= 0 && end > start)
  const calls = []
  const context = {
    state: { config: { scenes: new Map([['erpnext', { panelMap: new Map([['business-main', { type: 'erpnext-status' }]]) }]]) } },
    isDesktop: () => true,
    app: { win: { async openScene(sceneId) { calls.push(sceneId) } } },
  }
  runInNewContext(source.slice(start, end) + '\nglobalThis.openStatusScene = openErpNextStatus;', context)
  const opened = await context.openStatusScene()
  assert.equal(opened.ok, true)
  assert.equal(opened.value.sceneId, 'erpnext')
  assert.equal(opened.value.panelId, 'business-main')
  assert.deepEqual(calls, ['erpnext'])
})

test('ERPNext external entry resolves the configured URL through trusted Main status', async () => {
  const main = await readFile(new URL(
    '../../../apps/tradeloom-launcher/stage5-source06/asar/lib/main.js',
    import.meta.url,
  ), 'utf8')
  const start = main.indexOf('const openConfiguredErpNextWorkbench = async () => {')
  const end = main.indexOf('\n\tconst createSourceSceneConfigLoader', start)
  assert.ok(start >= 0 && end > start)
  const operation = main.slice(start, end)
  assert.match(operation, /sourceRequest\("\/business-api\/erpnext\/status"\)/u)
  assert.match(operation, /status\.configured !== true/u)
  assert.match(operation, /shell\.openExternal\(new URL\("app", site\)\.href\)/u)
  assert.doesNotMatch(operation, /\(url\)|site_url\s*=\s*url/u)
})

test('ERPNext status component renders the unconfigured and connected states', async () => {
  const source = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')

  for (const status of [
    { configured: false, connected: false, status: 'not_configured', error_code: '', site_url: '' },
    { configured: true, connected: true, status: 'connected', error_code: '', site_url: 'https://erp.example.test/site' },
    { configured: true, connected: false, status: 'unavailable', error_code: 'unavailable', site_url: 'https://erp.example.test/site' },
  ]) {
    let registration
    let state
    let dependencies
    const React = {
      Fragment: Symbol.for('react.fragment'),
      createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
      useState(initial) {
        if (state === undefined) state = typeof initial === 'function' ? initial() : initial
        return [state, next => { state = typeof next === 'function' ? next(state) : next }]
      },
      useEffect(effect, nextDependencies) {
        if (!dependencies || nextDependencies.some((value, index) => value !== dependencies[index])) {
          dependencies = [...nextDependencies]
          effect()
        }
      },
    }
    runInNewContext(source, {
      React,
      URL,
      URLSearchParams,
      fetch: async path => {
        assert.equal(path, '/business-api/erpnext/status')
        return { ok: true, async json() { return status } }
      },
      window: { __ModuleLoader__: { load(value) { registration = value } } },
    })

    const component = registration.factory(() => React).ERPNextStatus
    component({ refreshKey: 0 })
    await new Promise(resolve => setImmediate(resolve))
    const tree = component({ refreshKey: 0 })
    const nodes = []
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      nodes.push(node)
      visit(node.children)
    }
    visit(tree)
    if (status.connected) {
      assert.ok(nodes.some(node => node.type === 'h3' && node.children.includes('ERPNext 已连接')))
    } else if (status.status === 'not_configured') {
      const paneState = nodes.find(node => node.type?.name === 'PaneState')
      assert.equal(paneState?.props.title, 'ERPNext 尚未配置')
      assert.equal(paneState?.props.action.label, '检查连接')
    } else {
      const paneState = nodes.find(node => node.type?.name === 'PaneState')
      assert.equal(paneState?.props.title, 'ERPNext 暂时无法连接')
      assert.equal(paneState?.props.action.label, '检查连接')
    }
    const entry = nodes.find(node => node.type === 'a' && node.children.includes('打开 ERPNext 工作台'))
    assert.equal(Boolean(entry), status.configured, 'configured ERPNext exposes a direct workbench entry even while offline')
    if (entry) assert.equal(entry.props.href, 'https://erp.example.test/site/app')
  }
})

test('standalone ERPNext native window gives its disconnected state bounded icon and panel styles', async () => {
  const source = await readFile(clientUrl, 'utf8')
  const start = source.indexOf('function SourceErpNextStatus()')
  const end = source.indexOf('function SourceRoleFilesPanel', start)
  assert.ok(start >= 0 && end > start)
  const component = source.slice(start, end)
  assert.match(component, /\.tl-pane-state-icon\s*\{[^}]*width:34px; height:34px;/)
  assert.match(component, /\.tl-pane-state-icon\s*>\s*svg\s*\{[^}]*width:100%; height:100%;/)
  assert.match(component, /\.tl-erpnext-entry-actions/)
  assert.match(component, /flexDirection: 'column'/)
})

test('ERPNext status pop-out suppresses the duplicate application menu on its auxiliary window', async () => {
  const source = await readFile(new URL(
    '../../../apps/tradeloom-launcher/stage5-source06/asar/lib/tradeloom-source-shell/source-shell-controller.mjs',
    import.meta.url,
  ), 'utf8')
  const start = source.indexOf("const erpNextStatus = componentKey === 'erpnext-status-native'")
  const end = source.indexOf("child.webContents.setZoomFactor(uiScale)", start)
  assert.ok(start >= 0 && end > start)
  const popout = source.slice(start, end)
  assert.match(popout, /autoHideMenuBar:true/)
  assert.match(popout, /if\(erpNextStatus\)child\.setMenuBarVisibility\?\.\(false\)/)
})
