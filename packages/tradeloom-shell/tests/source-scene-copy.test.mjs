import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { SCENE_COMPONENT_CATALOG, validateSceneComponentCatalog } from '../scene-layout.js'

async function openConfiguration(defaults, app) {
  const source = await readFile(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/renderer.js', import.meta.url), 'utf8')
  const modal = node('div')
  const saves = []
  let focused
  function node(tag, children = []) {
    const listeners = {}
    return { tag, children, value: '', hidden: false, append(...values) { this.children.push(...values) },
      replaceChildren(...values) { this.children = values }, focus() { focused = this },
      addEventListener(event, handler) { listeners[event] = handler }, click() { return listeners.click?.() },
      change() { return listeners.change?.() } }
  }
  const make = (tag, _class, label) => node(tag, label ? [label] : [])
  const context = { make, el: (tag, _class, ...children) => node(tag, children), structuredClone, crypto: { randomUUID },
    currentTab: 'runs', visibleConfiguredScenes: config => config.scenes, openModal: (_name, build) => build(modal),
    window: { prompt() { throw Error('window.prompt unsupported') }, app: {
      sourceConfig: async () => ({ ...defaults, configurationRevision: 'unchanged-revision', roles: [{ id: 'center' }] }),
      saveSceneConfiguration: async value => { saves.push(value); return { applied: true } },
      ...app,
    } },
  }
  const start = source.indexOf('async function showSceneConfiguration(')
  const end = source.indexOf('async function showEngineGenerations(', start)
  const helper = source.slice(source.indexOf('const isComponentInstance'), source.indexOf('function projectTrustedScene'))
  await runInNewContext(helper + source.slice(start, end) + '\nshowSceneConfiguration()', context)
  const find = (parent, predicate) => predicate(parent) ? parent
    : parent.children?.map(child => find(child, predicate)).find(Boolean)
  const byText = (tag, label) => find(modal, element => element.tag === tag && element.children.includes(label))
  return { modal, find, byText, saves, focused: () => focused }
}

const defaults = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))

test('Windows source maps the order scene to explicit Host panels and the /orders route', async () => {
  const base = '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/'
  const [shell, renderer, bridge, fallback] = await Promise.all([
    readFile(new URL(base + 'scenes-data.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'renderer.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'business-bridge.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'scenes.json', import.meta.url), 'utf8'),
  ])
  const context = { window: {} }
  runInNewContext(shell, context)
  const templates = context.window.__SCENES__
  assert.deepEqual(JSON.parse(JSON.stringify(templates)), JSON.parse(fallback))
  const orderTemplate = templates.scenes.find(scene => scene.id === 'order-production')
  assert.ok(orderTemplate)
  assert.equal(orderTemplate.panels.find(panel => panel.id === 'orders-chat').roleId, 'order-production')
  assert.equal(orderTemplate.panels.find(panel => panel.id === 'orders-main').path, '/orders')
  assert.deepEqual(JSON.parse(JSON.stringify(orderTemplate.panels.map(panel => [panel.id, panel.hostPanelId]))), [
    ['orders-main', 'business-main'], ['files', 'files'], ['preview', 'preview'], ['orders-chat', 'native-chat'],
  ])
  context.configurationTemplates = templates.scenes
  const projection = renderer.slice(renderer.indexOf('const hostPanelFor'), renderer.indexOf('function applyTrustedSceneConfiguration'))
  runInNewContext(projection, context)
  const hostOrder = defaults.scenes.find(scene => scene.id === 'order-production')
  assert.equal(hostOrder.roleId, 'order-production')
  const projected = context.projectTrustedScene(hostOrder)
  assert.equal(projected.id, 'order-production')
  assert.equal(projected.panels.find(panel => panel.id === 'orders-main').hostPanelId, 'business-main')
  assert.equal(projected.panels.find(panel => panel.id === 'orders-main').path, '/orders')
  const dimensions = id => Object.fromEntries(defaults.scenes.find(scene => scene.id === id).panels.map(panel => [panel.id, [panel.col, panel.row, panel.w, panel.h]]))
  assert.deepEqual(dimensions('products')['business-main'], [1, 1, 3, 3])
  assert.deepEqual(dimensions('order-production')['business-main'], [1, 1, 3, 3])
  assert.deepEqual(dimensions('agent-center')['business-main'], [1, 1, 3, 2])
  assert.deepEqual(dimensions('deliverables').preview, [3, 1, 2, 4])

  const routeStart = bridge.indexOf('function routeForPath(path) {')
  const routeEnd = bridge.indexOf('function workflowTemplateRoute(', routeStart)
  const routeContext = {
    allowedRoutes: new Set(['/orders']),
    state: { config: {
      raw: { businessRoutes: defaults.businessRoutes },
      scenes: new Map([[hostOrder.id, { ...hostOrder, panelMap: new Map(hostOrder.panels.map(panel => [panel.id, panel])) }]]),
    } },
  }
  const routeForPath = runInNewContext(`(${bridge.slice(routeStart, routeEnd).trim()})`, routeContext)
  const resolved = routeForPath('/orders')
  assert.equal(resolved.scene.id, 'order-production')
  assert.equal(resolved.panel.id, 'business-main')
  assert.match(bridge, /'order-production': 'order-production'/)
  assert.match(bridge, /'\/orders': 'orders'/)
})

test('component registration rejects ambiguous or unrenderable declarations', () => {
  const files = SCENE_COMPONENT_CATALOG[0]
  const deliverables = { ...files, id: 'artifact-deliverables', label: '交付物', path: '/artifacts#deliverables' }
  assert.deepEqual(validateSceneComponentCatalog([files, deliverables], defaults), [files, deliverables])
  for (const invalid of [
    { ...deliverables, id: files.id },
    { ...deliverables, id: 'Bad ID' },
    { ...deliverables, path: files.path },
    { ...deliverables, path: '/artifacts#sources' },
    { ...deliverables, path: 'https://example.invalid/' },
    { ...deliverables, path: files.defaultPath },
    { ...deliverables, defaultLabel: '另一种默认' },
    { ...deliverables, defaultPath: '/home' },
    { ...deliverables, panelId: 'auxiliary' },
    { ...deliverables, type: 'native-chat' },
    { ...deliverables, category: 'other' },
    { ...deliverables, data: {} },
  ]) assert.throws(() => validateSceneComponentCatalog([files, invalid], defaults), /component catalog/)
})

test('the current desktop selector and both projections accept a second catalog option', async () => {
  const files = SCENE_COMPONENT_CATALOG[0]
  const deliverables = { ...files, id: 'artifact-deliverables', label: '交付物', path: '/artifacts#deliverables' }
  const copy = structuredClone(defaults.scenes.find(scene => scene.id === 'runs'))
  copy.id = 'runs-extension-fixture'; copy.templateSceneId = 'runs'
  delete copy.defaultBusinessRoute
  const product = SCENE_COMPONENT_CATALOG.find(value => value.id === 'product-catalog')
  const config = { ...defaults, scenes: [copy, ...defaults.scenes], componentCatalog: validateSceneComponentCatalog([files, deliverables, product], defaults) }
  const { modal, find, byText, saves } = await openConfiguration(config)
  const scenes = modal.children.find(element => element.tag === 'select')
  scenes.value = copy.id; scenes.change()
  const componentInput = id => find(modal, element => element.tag === 'select' && element.children.some(option => option.value === id))
  const options = componentInput(files.id).children.map(option => option.value)
  assert.deepEqual(Array.from(options), ['', files.id, deliverables.id])
  const choice = componentInput(files.id)
  choice.value = deliverables.id; choice.change()
  const productChoice = componentInput(product.id)
  productChoice.value = product.id; productChoice.change()
  byText('button', '保存并应用').click()
  const selected = saves[0].configuration.scenes[0]
  const panel = selected.panels.find(value => value.id === files.panelId)
  assert.equal(panel.componentId, deliverables.id)
  assert.equal(panel.path, deliverables.path)
  const base = '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/'
  const [renderer, shell, web] = await Promise.all([
    readFile(new URL(base + 'renderer.js', import.meta.url), 'utf8'),
    readFile(new URL(base + 'scenes-data.js', import.meta.url), 'utf8'),
    readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'),
  ])
  const context = { window: {}, h: (tag, props) => ({ tag, props }) }
  runInNewContext(shell, context)
  context.configurationTemplates = context.window.__SCENES__.scenes
  runInNewContext(renderer.slice(renderer.indexOf('const hostPanelFor'), renderer.indexOf('function applyTrustedSceneConfiguration')), context)
  const desktop = context.projectTrustedScene(selected).panels.find(value => value.hostPanelId === panel.id)
  assert.equal(desktop.path, deliverables.path)
  assert.equal(desktop.componentId, deliverables.id)
  runInNewContext(web.slice(web.indexOf('function BusinessFrame('), web.indexOf('const CATALOG_MARKDOWN_IMAGE')), context)
  const frame = context.BusinessFrame({ panel, path: panel.path })
  assert.equal(frame.tag, 'iframe')
  assert.equal(frame.props.src, '/business/artifacts#deliverables')
  assert.equal(frame.props['data-tradeloom-panel-id'], panel.id)
  const productPanel = selected.panels.find(value => value.id === product.panelId)
  const productDesktop = context.projectTrustedScene(selected).panels.find(value => value.hostPanelId === product.panelId)
  assert.equal(productDesktop.path, product.path)
  assert.equal(productDesktop.componentId, product.id)
  assert.equal(context.BusinessFrame({ panel: productPanel, path: productPanel.path }).props.src, '/business/products')
  const reopened = await openConfiguration(config, { sourceConfig: async () => ({
    ...config, scenes: saves[0].configuration.scenes, configurationRevision: 'readback', roles: [{ id: 'center' }],
  }) })
  const reopenedSelector = reopened.modal.children.find(element => element.tag === 'select')
  reopenedSelector.value = copy.id; reopenedSelector.change()
  for (const [id, expected] of [[files.id, deliverables.id], [product.id, product.id]]) {
    const input = reopened.find(reopened.modal, element => element.tag === 'select' && element.children.some(option => option.value === id))
    assert.equal(input.value, expected)
  }
  const restore = componentInput(files.id)
  restore.value = ''; restore.change()
  assert.equal(panel.path, files.defaultPath)
  assert.equal(Object.hasOwn(panel, 'componentId'), false)
  const restoreProduct = componentInput(product.id)
  restoreProduct.value = ''; restoreProduct.change()
  assert.equal(productPanel.path, product.defaultPath)
  assert.equal(Object.hasOwn(productPanel, 'componentId'), false)
})

test('copying a scene uses the configuration form and saves only on explicit apply', async () => {
  const { modal, find, byText, saves, focused } = await openConfiguration(defaults)
  const trigger = byText('button', '复制为新场景')
  trigger.click()
  const label = find(modal, element => element.tag === 'label' && element.children[0].children?.includes('新场景标识'))
  const input = label.children[1]
  assert.equal(input.maxLength, 48)
  assert.equal(modal.children.find(element => element.children.includes(label)).hidden, false)
  assert.equal(focused(), input)
  const confirm = byText('button', '确认复制')
  const selector = modal.children.find(element => element.tag === 'select')
  input.value = 'runs'; confirm.click()
  assert.equal(selector.value, 'runs')
  input.value = 'Invalid'; confirm.click()
  assert.equal(selector.value, 'runs')
  input.value = 'a'.repeat(49); confirm.click()
  assert.equal(selector.value, 'runs')
  input.value = 'abandoned'; byText('button', '取消复制').click()
  assert.equal(focused(), trigger)
  assert.equal(input.value, '')
  assert.equal(modal.children.find(element => element.children.includes(label)).hidden, true)
  assert.equal(selector.children.some(option => option.value === 'abandoned'), false)
  trigger.click()
  input.value = 'runs-copy'; confirm.click()
  assert.equal(selector.value, 'runs-copy')
  assert.equal(saves.length, 0)
  byText('button', '保存并应用').click()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].expectedRevision, 'unchanged-revision')
  const copy = saves[0].configuration.scenes.at(-1)
  assert.equal(copy.id, 'runs-copy')
  assert.equal(copy.templateSceneId, 'runs')
  assert.equal(copy.defaultBusinessRoute, undefined)
  assert.deepEqual(copy.panels, defaults.scenes.find(scene => scene.id === 'runs').panels)
  selector.value = 'agent-center'; selector.change()
  trigger.click()
  input.value = 'workflow-copy-form'; confirm.click()
  byText('button', '保存并应用').click()
  const workflow = saves.at(-1).configuration.scenes.at(-1)
  assert.equal(workflow.templateSceneId, 'agent-center')
  assert.equal(workflow.defaultBusinessRoute, undefined)
  for (const [id, path] of [['business-main', '/agent-center'], ['files', '/artifacts#files'], ['preview', '/artifacts#preview']]) {
    assert.ok(workflow.panels.some(panel => panel.id === id && panel.type === 'business-iframe' && panel.path === path))
  }
})

test('a full custom template prompts for space, then adds and moves two independent instances', async () => {
  const copy = structuredClone(defaults.scenes.find(scene => scene.id === 'runs'))
  copy.id = 'runs-instance-fixture'; copy.templateSceneId = 'runs'
  delete copy.defaultBusinessRoute
  const { modal, find, byText, saves } = await openConfiguration({
    ...defaults, scenes: [...defaults.scenes, copy], componentCatalog: SCENE_COMPONENT_CATALOG,
  })
  const scenePicker = modal.children.find(element => element.tag === 'select')
  scenePicker.value = copy.id; scenePicker.change()
  byText('button', '添加组件').click()
  assert.match(JSON.stringify(modal), /没有可用位置/)
  const fields = modal.children[2]
  const inputInPanel = (panelId, label) => {
    const begin = fields.children.findIndex(item => item.tag === 'strong' && item.children[0] === panelId)
    const tail = fields.children.slice(begin + 1)
    const next = tail.findIndex(item => item.tag === 'strong')
    return (next < 0 ? tail : tail.slice(0, next)).find(item => item.tag === 'label' && item.children[0].children.includes(label)).children[1]
  }
  const height = inputInPanel('business-main', '高度（格）')
  height.value = '1'; height.change()
  byText('button', '添加组件').click()
  byText('button', '添加组件').click()
  const dynamic = fields.children.filter(item => item.tag === 'strong' && item.children[0].startsWith('component-'))
  assert.equal(dynamic.length, 2)
  const id = dynamic[1].children[0]
  const column = inputInPanel(id, '起始列')
  column.value = '3'; column.change()
  byText('button', '保存并应用').click()
  const draft = saves[0].configuration.scenes.find(scene => scene.id === copy.id)
  assert.deepEqual(Array.from(draft.panels.filter(panel => panel.id.startsWith('component-')), panel => [panel.componentId, panel.col, panel.row]),
    [['artifact-files', 1, 2], ['product-catalog', 3, 2]])
  const web = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  const context = { h: (tag, props) => ({ tag, props }) }
  runInNewContext(web.slice(web.indexOf('function BusinessFrame('), web.indexOf('const CATALOG_MARKDOWN_IMAGE')), context)
  const frames = draft.panels.filter(panel => panel.id.startsWith('component-')).map(panel => context.BusinessFrame({ panel, path: panel.path }))
  assert.deepEqual(Array.from(frames, frame => frame.props.src), ['/business/artifacts#files', '/business/products'])
  byText('button', '移除组件：文件').click()
  assert.equal(find(fields, item => item.tag === 'strong' && item.children[0] === id).children[0], id)
  assert.equal(draft.panels.some(panel => panel.componentId === 'artifact-files'), false)
})

test('desktop saved preset keeps geometry, tracks and the right-click projection across instance edits', async () => {
  const source = await readFile(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/panel-interactions.js', import.meta.url), 'utf8')
  const extract = (first, last) => source.slice(source.indexOf(`function ${first}(`), source.indexOf(`function ${last}(`))
  const storage = { version: 2, scenes: {} }
  const context = { window: {}, readSplitTrees: () => storage, closedPanelStore: () => ({}), closedPanelIdsFor: () => [],
    resizeTrees: new Map(), localStorage: { setItem() {} }, SPLIT_TREE_STORAGE_KEY: 'fixture' }
  runInNewContext(extract('projectVisiblePanels', 'compactVisiblePanelTree')
    + extract('updateConfiguredGeometry', 'validPresetGeometry')
    + extract('validPresetGeometry', 'applyPresetGeometry')
    + extract('validSplitTree', 'saveSplitTree'), context)
  const prior = [
    { id: 'left', col: 1, row: 1, w: 1, h: 4 },
    { id: 'right', col: 3, row: 1, w: 2, h: 4 },
  ]
  const added = { id: 'component-demo', col: 2, row: 1, w: 1, h: 1 }
  const info = geometry => ({ geometry, columns: 4, rows: 4, panels: geometry.map(item => ({ dataset: { panelId: item.id } })) })
  const leaf = id => ({ kind: 'leaf', id })
  const tree = { kind: 'split', axis: 'x', ratio: 0.61, boundary: 2, path: 'r', first: leaf('left'), second: leaf('right') }
  const preset = { geometry: prior, tracks: { columns: [20, 10, 36, 34], rows: [25, 25, 25, 25] }, closedPanelIds: [], tree }
  const adapted = JSON.parse(JSON.stringify(context.reconcileComponentPreset(info([...prior, added]), preset)))
  assert.deepEqual(adapted.geometry, [...prior, added])
  assert.deepEqual(adapted.tracks, preset.tracks)
  assert.deepEqual(adapted.closedPanelIds, [added.id])
  assert.deepEqual(adapted.projection, tree)
  const removed = JSON.parse(JSON.stringify(context.reconcileComponentPreset(info(prior), adapted)))
  assert.deepEqual(removed.geometry, prior)
  assert.deepEqual(removed.tracks, preset.tracks)
  assert.deepEqual(removed.projection, tree)
  assert.deepEqual(removed.closedPanelIds, [])
  storage.scenes.fixture = { tree, geometry: [{ ...prior[0], h: 3 }, prior[1], added] }
  const moved = { ...added, row: 2 }
  context.updateConfiguredGeometry({ detail: [{ sceneId: 'fixture', before: [...prior, added], after: [...prior, moved] }] })
  assert.deepEqual(JSON.parse(JSON.stringify(storage.scenes.fixture.geometry)), [{ ...prior[0], h: 3 }, prior[1], moved])
  assert.equal(storage.scenes.fixture.configurationGeometryUpdated, true)
})

test('two saves in one dialog persist, and an external write still conflicts', async () => {
  const { createScenesHandler } = await import('../host.js')
  const { Readable } = await import('node:stream')
  let state = {}
  let externalBeforeResponse
  const store = { read: async () => structuredClone(state), transact: async action => {
    const saved = action(state)
    if (saved && externalBeforeResponse) {
      const external = structuredClone(state.sceneConfiguration.value)
      external.scenes[0].label = '外部修改'
      state.sceneConfiguration.value = external
    }
    return saved
  } }
  const handler = createScenesHandler({ connection: { requestRejection() {} },
    webServer: { getOrigin: () => 'http://localhost' }, workspaceRegistry: {} },
  { createStateStore: async () => store, readScenes: async () => JSON.stringify(defaults) })
  const request = async (method, input) => {
    const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : [])
    req.method = method
    const res = { statusCode: 200, setHeader() {}, end(value) { this.body = JSON.parse(value) } }
    await handler(req, res)
    return res
  }
  let disposition = 'applied'
  const receipts = []
  const ui = await openConfiguration(defaults, {
    sourceConfig: async () => (await request('GET')).body,
    applySceneConfiguration: async () => ({ saved: true, applied: true, configurationRevision: (await request('GET')).body.configurationRevision }),
    saveSceneConfiguration: async input => {
      if (disposition === 'cancelled') return { cancelled: true, saved: false, configurationRevision: 'ignored' }
      const result = await request('PUT', input)
      receipts.push(result)
      if (result.statusCode !== 200) throw Error('conflict')
      return { saved: true, applied: disposition === 'applied', configurationRevision: result.body.configurationRevision }
    },
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const save = async () => { ui.byText('button', '保存并应用').click(); await tick() }
  const name = ui.find(ui.modal, element => element.tag === 'label' && element.children[0].children?.includes('场景名称')).children[1]
  const rename = value => { name.value = value; name.change() }
  const runsLabel = async () => (await request('GET')).body.scenes.find(scene => scene.id === 'runs').label
  rename('首次保存'); await save(); assert.equal(await runsLabel(), '首次保存')
  disposition = 'cancelled'
  rename('第二次保存'); await save(); assert.equal(await runsLabel(), '首次保存')
  disposition = 'saved-not-applied'
  await save(); assert.equal(await runsLabel(), '第二次保存')
  externalBeforeResponse = true
  rename('自己提交'); await save(); assert.equal(receipts.at(-1).body.scenes[0].label, defaults.scenes[0].label)
  externalBeforeResponse = false
  ui.byText('button', '应用已保存配置').click(); await tick()
  rename('不能覆盖他人'); await save()
  assert.equal(receipts.at(-1).statusCode, 409)
  assert.equal(await runsLabel(), '自己提交')
  assert.equal((await request('GET')).body.scenes[0].label, '外部修改')
})
