import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const replay = process.env.TL_WORKFLOW_FILES_REPLAY
const asar = replay ? pathToFileURL(path.resolve(replay, 'desktop') + path.sep)
  : new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/', import.meta.url)
const business = replay ? pathToFileURL(path.resolve(replay, 'business-shell') + path.sep) : new URL('../', import.meta.url)
const { registerBusinessTools } = await import(new URL('business-tools.js', business))
const { ROLE_PRESETS } = await import(new URL('roles.js', business))
const { createWorkflowFileAuthority } = await import(new URL('workflow-files.js', business))
const { createSourceShellController } = await import(new URL('lib/tradeloom-source-shell/source-shell-controller.mjs', asar))
const source = name => readFile(new URL(name, asar), 'utf8')
const defaults = JSON.parse(await readFile(new URL('scenes.json', business), 'utf8'))

test('authorized directory cards share the existing navigation and single-file preview', {
  skip: !process.env.TRADELOOM_DOM_MODULE,
}, async () => {
  const { JSDOM } = await import(pathToFileURL(process.env.TRADELOOM_DOM_MODULE).href)
  const { window } = new JSDOM('<div id="files"></div><div id="preview"></div>')
  const { document } = window
  const bridge = await source('renderer/source-shell/replica-ui/business-bridge.js')
  const root = { path: 'D:/合成工作流/目录', entries: [{ id: 'folder', name: '产物', kind: 'folder' }], truncated: true }
  const child = { path: root.path + '/产物', canGoUp: true, entries: [
    { id: 'text', name: '说明.txt', kind: 'file' }, { id: 'image', name: '预览.png', kind: 'file' },
  ] }
  let releasePick
  const pick = new Promise(resolve => { releasePick = resolve })
  const workflowFileCalls = []
  const app = { async workflowFiles({ operation, id }) {
    workflowFileCalls.push(operation)
    if (operation === 'current') return null
    if (operation === 'pick') return pick
    if (operation === 'enter') { assert.equal(id, 'folder'); return child }
    if (operation === 'up') return root
    if (operation === 'preview') return id === 'text'
      ? { name: '说明.txt', preview: { type: 'text/plain', data: '合成说明' } }
      : { name: '预览.png', preview: { type: 'image/png', data: 'AA==' } }
    if (operation === 'open-directory') return { ok: true }
    assert.fail(operation)
  } }
  const start = bridge.indexOf('  function mountWorkflowFiles(')
  const end = bridge.indexOf('  function mountFileCompanion(', start)
  assert.ok(start >= 0 && end > start)
  const mount = runInNewContext(bridge.slice(start, end) + '\nmountWorkflowFiles', { app, window, document })
  const workflow = { panes: new Set() }
  const files = document.getElementById('files')
  const preview = document.getElementById('preview')
  const cleanup = [files, preview].map(host => mount(workflow, host, host.id))
  const button = (host, label) => [...host.querySelectorAll('button')].find(button => button.textContent === label)
  const settle = () => timeout(() => !workflow.busy)
  try {
    await settle()
    assert.equal(files.querySelector('iframe'), null, 'the local workflow pane does not mount a business iframe')
    assert.equal(files.querySelector('.tl-workflow-directory-body').hidden, false, 'the local-directory pane fills the files area before a folder is selected')
    assert.match(files.querySelector('.tl-workflow-directory-body').textContent, /打开本地目录以查看素材/)
    button(files, '打开').click()
    assert.equal(button(files, '打开').disabled, true)
    assert.equal(files.querySelector('[role="status"]').textContent, '正在读取…')
    releasePick(root)
    await settle()
    assert.equal(files.querySelector('.tl-workflow-directory-path').title, root.path)
    assert.deepEqual([...files.querySelectorAll('.tl-workflow-directory-actions button')].map(node => node.textContent), ['打开', '上一级', '重读', '关闭目录'])
    assert.equal(files.querySelectorAll('.tl-workflow-directory-row').length, 1)
    assert.equal(files.querySelector('.tl-workflow-directory-cards'), null)
    const folder = preview.querySelector('.tl-workflow-directory-card')
    assert.match(folder.textContent, /产物文件夹/)
    assert.match(preview.textContent, /仅显示本目录的部分条目/)
    folder.click()
    await settle()
    assert.equal(files.querySelector('.tl-workflow-directory-path').title, child.path)
    assert.equal(preview.querySelectorAll('.tl-workflow-directory-card').length, 2)
    preview.querySelector('[title="说明.txt"]').click()
    await settle()
    assert.equal(preview.querySelector('pre').textContent, '合成说明')
    assert.equal(preview.querySelector('.tl-workflow-directory-cards'), null)
    assert.match(files.querySelector('[aria-current="true"]').textContent, /说明.txt/)
    button(preview, '📂 用资源管理器打开').click()
    await settle()
    assert.ok(workflowFileCalls.includes('open-directory'))
    assert.equal(preview.querySelector('.tl-workflow-directory').hidden, false)
    button(preview, '关闭预览').click()
    assert.equal(preview.querySelector('.tl-workflow-directory').hidden, true)
    assert.equal(files.querySelector('.tl-workflow-directory-path').title, child.path)
    files.querySelector('[title="预览.png"]').click()
    await settle()
    assert.equal(preview.querySelector('.tl-workflow-directory').hidden, false)
    assert.equal(preview.querySelector('img').alt, '预览.png')
    assert.equal(preview.querySelector('.tl-workflow-directory-cards'), null)
    button(files, '上一级').click()
    await settle()
    assert.equal(preview.querySelectorAll('.tl-workflow-directory-card').length, 1)
  } finally {
    cleanup.forEach(remove => remove())
    window.close()
  }
})
const sdkTools = replay ? await import(pathToFileURL(path.join(replay, 'sdk/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'))) : null
const timeout = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('workflow file state did not settle')
}

async function scope(t) {
  const base = await realpath(tmpdir())
  const owned = await mkdtemp(path.join(base, 'tradeloom-workflow-files-'))
  const root = path.join(owned, 'allowed')
  const nested = path.join(root, 'next')
  const outside = path.join(owned, 'outside')
  t.after(async () => {
    assert.equal(path.dirname(await realpath(owned)), base)
    await rm(owned, { recursive: true, force: true })
  })
  await mkdir(nested, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(nested, 'message.txt'), 'nested test data')
  await writeFile(path.join(nested, 'doc.zip'), Buffer.from([80, 75, 3, 4]))
  await writeFile(path.join(nested, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64'))
  await writeFile(path.join(root, 'top.md'), '# top test data')
  await writeFile(path.join(outside, 'private.txt'), 'outside test data')
  await symlink(outside, path.join(root, 'jump'), process.platform === 'win32' ? 'junction' : 'dir')
  const workspace = { id: 'sample-workspace', path: owned, sessionIds: ['session-a', 'session-b'] }
  const state = { roles: { center: { sessionId: 'session-a', workspaceId: workspace.id, workspacePath: workspace.path,
    agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: '1' } }
  const parent = { id: 'agent-a', session: { id: 'session-a' } }
  const other = { id: 'agent-b', session: { id: 'session-b' } }
  const ctx = {
    agents: new Map([[parent.id, parent], [other.id, other]]),
    workspaceRegistry: { archivedSessionIds: [], get: id => id === workspace.id ? workspace : undefined },
    sessionQuery: { async observeSession(id) { return {
      header: { id, cwd: workspace.path }, projections: { values: { agentPreset: ROLE_PRESETS.center } },
    } } },
  }
  let pendingStateRead
  const authority = createWorkflowFileAuthority(ctx, async () => {
    if (pendingStateRead && --pendingStateRead.remaining === 0) {
      const pause = pendingStateRead
      pendingStateRead = undefined
      pause.entered.resolve()
      await pause.resume.promise
    }
    return structuredClone(state)
  })
  const tools = new Map()
  const addTool = (name, definition) => {
    tools.set(name, definition)
    return () => tools.delete(name)
  }
  const runtime = { ctx: {}, layers: { effect(_ctx, install) {
    return install({ tools: { insert: (name, entry) => addTool(name, entry.definition) } })
  } } }
  const toolsCtx = { tools: { register(definition) {
    if (!sdkTools) return addTool(definition.name, definition)
    if (definition.name === 'tradeloom_workflow_files') {
      const { parameters } = sdkTools.projectToolSchema(definition, true)
      sdkTools.assertSupportedJsonSchema(parameters)
      assert.deepEqual(parameters.properties.operation.enum, ['current', 'enter', 'up'])
      assert.deepEqual(sdkTools.validateJsonSchemaValue(parameters, { operation: 'current' }, ''), [])
      assert.notDeepEqual(sdkTools.validateJsonSchemaValue(parameters, { operation: 'pick', chosen: root }, ''), [])
    }
    return sdkTools.ToolRuntime.prototype.register.call(runtime, definition)
  } }, get: name => name === 'workflowFileAuthority' ? authority : undefined }
  t.after(registerBusinessTools(toolsCtx, { preset: ROLE_PRESETS.center }))
  const tool = (args, agent = parent) => tools.get('tradeloom_workflow_files')
    .execute(args, { callId: 'controlled-tool-call', agent, signal: new AbortController().signal })
  const desktop = request => authority.desktop({
    sessionId: state.roles.center.sessionId, bindingRevision: state.roleBindingRevisions.center, ...request,
  })
  return { owned, root, nested, outside, state, authority, desktop, tool, other,
    holdBindingRead(remaining) {
      const pause = { remaining, entered: Promise.withResolvers(), resume: Promise.withResolvers() }
      pendingStateRead = pause
      return { entered: pause.entered.promise, resume: pause.resume.resolve }
    },
  }
}

class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.classList = new Set()
    this.classList.remove = this.classList.delete.bind(this.classList)
    this.classList.contains = this.classList.has.bind(this.classList)
    this.classList.toggle = (name, enabled) => enabled ? this.classList.add(name) : this.classList.delete(name)
    this.listeners = new Map()
    this.isConnected = true
  }
  set textContent(value) { this.children = []; this.text = value }
  get childElementCount() { return this.children.length }
  get textContent() { return [this.text ?? '', ...this.children.map(child => child.textContent)].join(' ') }
  append(...values) { this.children.push(...values) }
  prepend(value) { this.children.unshift(value) }
  replaceChildren(...values) { this.text = ''; this.children = values }
  querySelector(tag) { return this.children.find(value => value.tag === tag) }
  closest() { return this.panel ?? null }
  getBoundingClientRect() { return { left: 10, top: 20, width: 600, height: 400 } }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, callback) { this.listeners.set(name, callback) }
  removeEventListener(name) { this.listeners.delete(name) }
  click() { if (!this.disabled) this.listeners.get('click')?.() }
}
const nodes = root => [root, ...root.children.flatMap(nodes)]
const button = (pane, label) => nodes(pane).find(node => node.tag === 'button' && (node.title || node.text) === label)
const visibleText = node => node.hidden ? '' : [node.text ?? '', ...node.children.map(visibleText)].join(' ')
async function click(pane, label) {
  await timeout(() => button(pane, label)?.disabled === false)
  button(pane, label).click()
}

function between(input, start, end) {
  const first = input.indexOf(start)
  const last = input.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, start)
  return input.slice(first, last)
}

async function privateControl(mainSource, authority, onChanged) {
  const hostRelative = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
  const hostProgram = replay
    ? await readFile(path.join(replay, 'sdk', hostRelative), 'utf8')
    : (await readFile(new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.3/workflow-files-control.patch', import.meta.url), 'utf8'))
      .split('\n').filter(line => /^[+ ]\t/.test(line)).map(line => line.slice(1)).join('\n')
  const hostMessage = new Function('application', 'send', 'message',
    'const stopping = undefined;\n' + between(hostProgram,
      '\t\tif (message.type === "workflow-files")', '\t\tif (message.type === "scene-memory-origin-grant")'))
  const subscribe = new Function('ctx', 'send', 'return ' + between(hostProgram,
    '\tctx.get("workflowFileAuthority")?.onDirectoryChange(', '\tcontrol.registerSceneMemoryOriginGrant'))
  const ctx = { get: name => name === 'workflowFileAuthority' ? authority : undefined }
  const application = Promise.resolve({ ctx })
  const child = new EventEmitter()
  const send = async message => { child.emit('message', message) }
  child.connected = true
  child.send = (message, callback) => {
    queueMicrotask(() => hostMessage(application, send, message))
    callback(null)
  }
  const methods = new Function('return ({'
    + between(mainSource, '\tasync control(request,', '\t/**')
    + ','
    + between(mainSource, '\tasync workflowFiles(request)', '\tasync issueSceneMemoryOriginGrant')
    + '})')()
  const validator = new Function(between(mainSource, 'function isDesktopHostEvent(', 'async function exitsWithin')
    + ';return isDesktopHostEvent')()
  const main = Object.assign(methods, {
    child, nextControlId: 1, controlRequests: new Map(), operationBridge: {},
    onWorkflowFilesChanged: onChanged, fail: error => assert.fail(error),
  })
  new Function('child', 'isDesktopHostEvent', between(mainSource,
    '\t\tchild.on("message", (message) => {', '\t\tchild.once("error"')).call(main, child, validator)
  const stop = subscribe(ctx, send)
  return { request: main.workflowFiles.bind(main), stop }
}

async function desktop(t, fixture, configuration = defaults) {
  const handlers = new Map()
  const nativeMenus = []
  handlers.set('dsh-desktop:windows-menu', (_event, ...args) => nativeMenus.push(args))
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }
  const contents = new EventEmitter(), primary = new EventEmitter()
  const renderer = new EventEmitter()
  Object.assign(contents, {
    mainFrame: { url: 'about:blank' },
    async loadURL(url) {
      this.mainFrame.url = url
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
    },
    send: (name, ...args) => renderer.emit(name, {}, ...args),
    isDestroyed: () => false, setZoomFactor() {}, getZoomFactor: () => 1,
  })
  Object.assign(primary, {
    webContents: contents, isDestroyed: () => false, isMinimized: () => false, destroy() {}, show() {}, focus() {},
    getContentBounds: () => ({ width: 1000, height: 700 }),
    contentView: {
      children: [],
      addChildView(view) { this.children.push(view) },
      removeChildView(view) { this.children = this.children.filter(child => child !== view) },
    },
  })
  const mainSource = await source('lib/main.js')
  const picker = mainSource.slice(mainSource.indexOf('function installDesktopDirectoryPicker('),
    mainSource.indexOf('//#region lib/types/microphone-permissions.js'))
  let chosen = fixture.root, pendingPicker, chooserCalls = 0
  const pick = new Function('ipcMain', 'DESKTOP_IPC', 'dialog', 'assertDesktopSender',
    picker + '\nreturn installDesktopDirectoryPicker')(ipcMain, { directoryPick: 'picker:existing' }, {
    async showOpenDialog(parent, options) {
      assert.equal(parent, primary)
      assert.match(options.title, /授权工作流中心助手/)
      chooserCalls++
      return pendingPicker ?? { canceled: chosen === null, filePaths: chosen === null ? [] : [chosen] }
    },
  }, () => { throw Error('unowned native picker') })(() => primary, () => undefined, () => true)
  const wire = await privateControl(mainSource, fixture.authority, () => controller.workflowFilesChanged())
  let delayedFileReply
  const openedFiles = []
  const controller = createSourceShellController({
    BrowserWindow: class {},
    WebContentsView: class {
      constructor() {
        this.webContents = Object.assign(new EventEmitter(), {
          mainFrame: { url: 'about:blank' }, isDestroyed: () => false, setZoomFactor() {},
          destroy() { this.emit('destroyed') },
          async loadURL(url) { this.mainFrame.url = url; this.emit('did-finish-load') },
        })
      }
      setVisible(value) { this.visible = value }
      setBounds(value) { this.bounds = value }
    },
    ipcMain, primaryWindow: primary, ownedPartition: 'persist:controlled-test',
    appPreload: 'controlled-app-preload', sourcePreload: 'controlled-source-preload',
    getConfig: async () => structuredClone(configuration), installProtocol: async () => {},
    resolveNativeTheme: () => 'dark', subscribeNativeTheme: () => () => {},
    pickWorkflowDirectory: pick.pickForWorkflow, requestWorkflowFiles: async input => {
      const result = await wire.request(input)
      if (input.operation === delayedFileReply?.operation) {
        const pending = delayedFileReply
        delayedFileReply = undefined
        pending.entered.resolve()
        await pending.resume.promise
      }
      return result
    },
    openWorkflowFile: async (operation, resolved, authorize) => { await authorize(); openedFiles.push({ operation, resolved }) },
    resolveBinding: async ({ sceneId, panelId, expectedSessionId }) => {
      const sessionId = fixture.state.roles.center.sessionId
      if (expectedSessionId && expectedSessionId !== sessionId) throw Error('stale center')
      return { sceneId, panelId, roleId: 'center', bindingStatus: 'bound', sessionId,
        bindingRevision: fixture.state.roleBindingRevisions.center }
    },
  })
  const startup = controller.start()
  startup.catch(() => {})
  t.after(async () => { wire.stop(); controller.destroy(); await startup.catch(() => {}) })
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame })
  await timeout(() => contents.mainFrame.url.endsWith('/source-entry.html'))
  await handlers.get('source-shell:initialPaintReady')(event(), { status: 'ready' })
  await startup
  renderer.invoke = (name, ...args) => Promise.resolve().then(() => handlers.get(name)(event(), ...args))
  let app
  runInNewContext(await source('lib/tradeloom-source-shell/source-preload.cjs'), {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld: (_name, value) => { app = value } }, ipcRenderer: renderer }
    },
  })
  const events = new EventEmitter()
  const window = {
    app, addEventListener: events.on.bind(events), removeEventListener: events.off.bind(events),
    dispatchEvent: event => events.emit(event.type, event),
    TradeLoomBusinessFileBridge: { create: () => Object.assign(() => {}, { requestFileExport() {}, requestFileFocus() {} }) },
  }
  const location = new URL(contents.mainFrame.url)
  const downloads = []
  const document = { body: new Node('body'), addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    currentScript: { src: location.href }, createElement(tag) {
    const node = new Node(tag)
    if (tag === 'a') node.click = () => { downloads.push({ name: node.download, url: node.href }) }
    return node
  } }
  const objectUrls = new Map()
  const urlApi = {
    createObjectURL(blob) {
      const value = 'blob:controlled-' + objectUrls.size
      objectUrls.set(value, blob)
      return value
    },
    revokeObjectURL: value => objectUrls.delete(value),
  }
  const bridge = await source('renderer/source-shell/replica-ui/business-bridge.js')
  const hook = '  window.businessBridge = Object.freeze({'
  assert.ok(bridge.includes(hook))
  runInNewContext(bridge.replace(hook, '  window.testState = state\n' + hook), {
    window, location, document, URL: urlApi, Blob, Uint8Array, atob, setTimeout() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail } },
    getComputedStyle: node => ({ display: node.style.display || 'block' }),
  })
  Object.assign(window.testState, { phase: 'ready', sceneId: 'agent-center', config: {
    raw: configuration, scenes: new Map(configuration.scenes.map(value => [value.id, {
      ...value, panelMap: new Map(value.panels.map(panel => [panel.id, panel])),
    }])),
  } })
  window.testState.configPromise = Promise.resolve(window.testState.config)
  const files = new Node('div'), preview = new Node('div')
  const cleanup = [
    window.businessBridge.renderCompanion({ sceneId: 'agent-center' }, files, 'files'),
    window.businessBridge.renderCompanion({ sceneId: 'agent-center' }, preview, 'preview'),
  ]
  let initialMounted = true
  const disposeInitial = () => {
    if (!initialMounted) return
    cleanup.forEach(dispose => dispose())
    initialMounted = false
  }
  t.after(disposeInitial)
  return { app, files, preview, contents, handlers, downloads, objectUrls, bridge: window.businessBridge,
    disposeInitial, nativeMenus, openedFiles,
    canvasView: () => primary.contentView.children[0],
    delayFileReply(operation) {
      delayedFileReply = { operation, entered: Promise.withResolvers(), resume: Promise.withResolvers() }
      return { entered: delayedFileReply.entered.promise, release: delayedFileReply.resume.resolve }
    },
    acknowledgeCanvas(view) {
      const contents = view.webContents
      const descriptor = controller.nativeDescriptor(contents, contents.mainFrame)
      assert.equal(descriptor.sceneId, 'agent-center')
      assert.equal(descriptor.panelId, 'business-main')
      controller.nativeMounted(contents, contents.mainFrame, descriptor)
    },
    focus: () => events.emit('focus'), chosen: value => { chosen = value },
    chooserCalls: () => chooserCalls, delayChooser: value => { pendingPicker = value } }
}

test('a projected workbench copy uses the existing authorized directory and preview', async t => {
  const fixture = await scope(t)
  const configuration = structuredClone(defaults)
  const copy = structuredClone(configuration.scenes.find(scene => scene.id === 'agent-center'))
  copy.id = 'workflow-copy-test'
  copy.templateSceneId = 'agent-center'
  delete copy.defaultBusinessRoute
  const variant = (id, edit) => { const value = { ...structuredClone(copy), id }; edit(value); return value }
  const unrelated = variant('non-workflow-copy', value => { value.templateSceneId = 'products' })
  const reconfigured = variant('reconfigured-copy', value => { value.panels.find(panel => panel.id === 'files').path = '/artifacts#deliverables' })
  const incomplete = variant('incomplete-copy', value => { value.panels = value.panels.filter(panel => panel.id !== 'preview') })
  const explicit = variant('explicit-copy', value => {
    value.defaultBusinessPath = '/products'
    value.panels.find(panel => panel.id === 'business-main').path = '/products'
  })
  configuration.scenes.push(copy, unrelated, reconfigured, incomplete, explicit)
  const renderer = await source('renderer/source-shell/replica-ui/renderer.js')
  const context = { window: {} }
  runInNewContext(await source('renderer/source-shell/replica-ui/scenes-data.js'), context)
  context.configurationTemplates = context.window.__SCENES__.scenes
  const project = runInNewContext(between(renderer, 'const hostPanelFor', 'function applyTrustedSceneConfiguration')
    + '\nprojectTrustedScene', context)
  const scene = project(copy)
  const d = await desktop(t, fixture, configuration)
  await d.bridge.start()
  d.disposeInitial()
  d.bridge.sceneSelected(scene)
  const mountCompanions = value => {
    const panes = { files: new Node('div'), preview: new Node('div') }
    const cleanup = ['files', 'preview'].map(view => d.bridge.renderCompanion(
      { ...value.panels.find(panel => panel.id === view), sceneId: value.id }, panes[view], view))
    let mounted = true
    const dispose = () => {
      if (!mounted) return
      cleanup.forEach(remove => remove())
      mounted = false
    }
    t.after(dispose)
    return { ...panes, dispose }
  }
  const { files, preview, dispose: disposeCompanions } = mountCompanions(scene)
  assert.equal(nodes(files).find(node => node.tag === 'iframe'), undefined, 'the local workflow files pane mounts no business iframe')
  await click(files, '打开')
  await timeout(() => visibleText(files).includes(fixture.root))
  await click(files, 'top.md')
  await timeout(() => visibleText(preview).includes('# top test data'))
  assert.equal(d.chooserCalls(), 1)
  await assert.rejects(d.app.workflowFiles({ operation: 'pick', chosen: fixture.outside }), /invalid workflow files request/)
  const canvas = new Node('div')
  canvas.panel = new Node('section')
  const mountCanvas = scene => d.bridge.renderWorkflowPanel(
    { ...scene.panels.find(panel => panel.id === 'workflow-main'), sceneId: scene.id }, canvas)
  const dispose = mountCanvas(scene)
  await timeout(() => d.canvasView())
  const nativeCanvas = d.canvasView()
  d.acknowledgeCanvas(nativeCanvas)
  await timeout(() => nativeCanvas.visible === true)
  assert.equal(nativeCanvas.bounds.width, 600)
  assert.equal(nativeCanvas.bounds.height, 400)
  assert.equal((await d.bridge.openNativeMenu('edit', { left: 15, bottom: 25 })).ok, true)
  assert.deepEqual(d.nativeMenus.at(-1).slice(0, 3), ['edit', 15, 25])
  const stalePicker = button(files, '打开')
  const pending = d.delayFileReply('preview')
  await click(files, 'top.md')
  await pending.entered
  assert.equal((await d.bridge.prepareSceneTransition()).ok, true)
  assert.equal(nativeCanvas.visible, false)
  stalePicker.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(d.chooserCalls(), 1, 'a suspended transition cannot start the old pane picker')
  disposeCompanions()
  dispose()
  const original = project(configuration.scenes.find(scene => scene.id === 'agent-center'))
  d.bridge.sceneSelected(original)
  const originalPanes = mountCompanions(original)
  const disposeOriginal = mountCanvas(original)
  await timeout(() => nativeCanvas.visible === true)
  assert.equal(d.canvasView(), nativeCanvas, 'returning reuses the original native guest')
  pending.release()
  stalePicker.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotMatch(visibleText(preview), /top test data/)
  assert.equal(d.chooserCalls(), 1)
  await timeout(() => visibleText(originalPanes.files).includes(fixture.root))
  assert.match(visibleText(originalPanes.preview), /top\.md/)
  await click(originalPanes.files, 'top.md')
  await timeout(() => visibleText(originalPanes.preview).includes('# top test data'))
  disposeOriginal()
  originalPanes.dispose()
  await timeout(() => nativeCanvas.visible === false)

  d.bridge.sceneSelected(scene)
  const reopened = mountCompanions(scene)
  await click(reopened.files, '关闭目录')
  await timeout(() => !button(reopened.files, '关闭目录'))
  assert.equal((await fixture.tool({ operation: 'current' })).ok, false)
  reopened.dispose()
  d.bridge.sceneSelected(original)
  const revoked = mountCompanions(original)
  await timeout(() => button(revoked.files, '打开')?.disabled === false)
  assert.equal(button(revoked.files, '关闭目录'), undefined)
  assert.doesNotMatch(visibleText(revoked.preview), /top\.md|top test data/)
  revoked.dispose()

  const explicitUi = project(explicit)
  d.bridge.sceneSelected(explicitUi)
  const explicitPanes = mountCompanions(explicitUi)
  const explicitFile = nodes(explicitPanes.files).find(node => node.tag === 'iframe')
  assert.equal(explicitFile.src, '/business/artifacts#files')
  assert.equal(explicitFile.dataset.tradeloomBusinessSceneId, 'products')
  assert.equal(button(explicitPanes.files, '打开'), undefined)
  explicitPanes.dispose()

  for (const invalid of [unrelated, reconfigured, incomplete, copy]) {
    d.bridge.sceneSelected({ id: invalid.id })
    const projected = project(invalid)
    const fileMeta = { ...projected.panels.find(panel => panel.id === 'files'), sceneId: invalid.id }
    const canvasMeta = { ...projected.panels.find(panel => panel.id === 'workflow-main'), sceneId: invalid.id }
    if (invalid === copy) {
      fileMeta.hostPanelId = 'preview'
      canvasMeta.hostPanelId = 'business-plan'
    }
    if (invalid === unrelated) {
      Object.assign(fileMeta, { id: 'files', type: 'files', path: '/artifacts#files', hostPanelId: 'files' })
      Object.assign(canvasMeta, { id: 'workflow-main', type: 'canvas', path: '/agent-center', hostPanelId: 'business-main', standaloneCanvas: true })
    }
    const invalidFiles = new Node('div')
    const disposeFiles = d.bridge.renderCompanion(fileMeta, invalidFiles, 'files')
    assert.equal(button(invalidFiles, '打开'), undefined, invalid.id)
    const disposeCanvas = d.bridge.renderWorkflowPanel(canvasMeta, canvas)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(nativeCanvas.visible, false, invalid.id)
    disposeFiles(); disposeCanvas()
  }
  assert.equal(d.chooserCalls(), 1)
})

test('normal workflow panes and the center tool consume one actual temporary-directory grant', async t => {
  const f = await scope(t)
  const d = await desktop(t, f)
  assert.equal(nodes(d.files).find(node => node.tag === 'iframe'), undefined, 'the local files pane mounts directly')
  assert.equal(nodes(d.preview).find(node => node.tag === 'iframe'), undefined, 'the local preview pane mounts directly')
  assert.equal((await f.tool({ operation: 'current' })).ok, false)
  await timeout(() => button(d.files, '打开')?.disabled === false)
  assert.equal(button(d.files, '上一级').disabled, true)
  await click(d.files, '打开')
  await timeout(() => visibleText(d.files).includes(f.root))
  assert.equal(d.chooserCalls(), 1)
  assert.match(visibleText(d.preview), /next/)
  assert.doesNotMatch(visibleText(d.files), /private.txt|jump/)
  assert.equal(button(d.files, '上一级').disabled, true)

  await click(d.files, 'next')
  await timeout(() => visibleText(d.preview).includes('message.txt'))
  assert.match(visibleText(d.files), /next/)
  await click(d.preview, '📂 用资源管理器打开')
  await timeout(() => d.openedFiles.length === 1)
  assert.equal(d.openedFiles[0].operation, 'open-directory')
  assert.equal(d.openedFiles[0].resolved.path, f.nested)
  await click(d.preview, 'message.txt')
  await timeout(() => visibleText(d.preview).includes('nested test data'))
  await click(d.preview, '系统打开')
  await timeout(() => d.openedFiles.length === 2)
  assert.equal(d.openedFiles[1].operation, 'open')
  assert.equal(d.openedFiles[1].resolved.path, path.join(f.nested, 'message.txt'))
  assert.deepEqual(Object.keys(d.openedFiles[1].resolved.identity).sort(), ['birthtimeNs', 'dev', 'ino', 'mtimeNs', 'size'])
  await click(d.preview, '在文件夹中显示')
  await timeout(() => d.openedFiles.length === 3)
  assert.equal(d.openedFiles[2].operation, 'reveal')
  assert.equal(d.openedFiles[2].resolved.path, path.join(f.nested, 'message.txt'))
  const current = await d.app.workflowFiles({ operation: 'current' })
  const message = current.entries.find(item => item.name === 'message.txt')
  const actionResult = await d.app.workflowFiles({ operation: 'open', id: message.id })
  assert.deepEqual(actionResult, { ok: true })
  assert.equal(Object.hasOwn(actionResult, 'path'), false, 'resolved paths stay inside the trusted main process')
  assert.match(visibleText(d.files), /message.txt/)
  await click(d.files, '上一级')
  await timeout(() => visibleText(d.preview).includes('top.md'))
  await click(d.files, 'top.md')
  await timeout(() => visibleText(d.preview).includes('# top test data'))

  const root = JSON.parse((await f.tool({ operation: 'current' })).data)
  const folder = root.entries.find(item => item.name === 'next')
  const nested = await f.tool({ operation: 'enter', id: folder.id })
  assert.equal(nested.ok, true)
  await timeout(() => visibleText(d.files).includes(f.nested) && visibleText(d.preview).includes('message.txt'))
  await timeout(() => button(d.files, '打开')?.disabled === false)
  const text = JSON.parse(nested.data).entries.find(item => item.name === 'message.txt')
  assert.equal((await f.tool({ operation: 'preview', id: text.id })).ok, false)
  await click(d.preview, 'message.txt')
  await timeout(() => visibleText(d.preview).includes('nested test data'))
  await click(d.preview, '下载')
  await timeout(() => d.downloads.length === 1)
  assert.equal(d.downloads[0].name, 'message.txt')
  assert.equal(await d.objectUrls.get(d.downloads[0].url).text(), 'nested test data')
  await click(d.preview, '关闭预览')
  await click(d.files, 'dot.png')
  await timeout(() => nodes(d.preview).some(node => node.tag === 'img' && node.src.startsWith('data:image/png;base64,')))
  await click(d.preview, '关闭预览')
  await click(d.files, 'doc.zip')
  await timeout(() => visibleText(d.preview).includes('此文件暂无可用预览。'))
  const currentFiles = await d.app.workflowFiles({ operation: 'current' })
  const archive = currentFiles.entries.find(item => item.name === 'doc.zip')
  await assert.rejects(d.app.workflowFiles({ operation: 'open', id: archive.id }))
  assert.equal(d.openedFiles.length, 4, 'unsupported file types never reach the system opener')

  assert.equal((await f.tool({ operation: 'current' }, f.other)).ok, false)
  assert.equal((await f.tool({ operation: 'enter', id: f.outside })).ok, false)
  assert.equal((await f.tool({ operation: 'pick', chosen: f.outside })).ok, false)
  await assert.rejects(d.app.workflowFiles({ operation: 'pick', chosen: f.outside }), /invalid workflow files request/)
  await assert.rejects(d.handlers.get('source-shell:workflowFiles')({
    sender: d.contents, senderFrame: { url: d.contents.mainFrame.url },
  }, { operation: 'current' }), /rejected sender/)
  await assert.rejects(d.app.workflowFiles({ operation: 'enter', id: folder.id }))

  await click(d.files, '关闭目录')
  await timeout(() => visibleText(d.files).includes('尚未打开本地目录'))
  await timeout(() => button(d.files, '打开')?.disabled === false)
  assert.equal((await f.tool({ operation: 'current' })).ok, false)
  assert.equal(nodes(d.files).find(node => node.tag === 'iframe'), undefined, 'closing the local directory does not mount the business files iframe')
  assert.equal(nodes(d.preview).find(node => node.tag === 'iframe'), undefined, 'closing the local directory does not mount the business preview iframe')
})

test('authorized PDF previews require the PDF signature and stay within the preview byte limit', async t => {
  const f = await scope(t)
  const validPdf = Buffer.from('%PDF-1.4\n%preview fixture\n%%EOF', 'ascii')
  const oversizedPdf = Buffer.alloc(1024 * 1024 + 1, 0x20)
  Buffer.from('%PDF-').copy(oversizedPdf)
  await writeFile(path.join(f.root, 'valid.pdf'), validPdf)
  await writeFile(path.join(f.root, 'forged.pdf'), Buffer.from('not a PDF', 'ascii'))
  await writeFile(path.join(f.root, 'oversized.pdf'), oversizedPdf)
  const directory = await f.desktop({ operation: 'pick', chosen: f.root })
  const entry = name => directory.entries.find(item => item.name === name)
  const preview = await f.desktop({ operation: 'preview', id: entry('valid.pdf').id })
  assert.equal(preview.preview.type, 'application/pdf')
  assert.deepEqual(Buffer.from(preview.preview.data, 'base64'), validPdf)
  const forged = await f.desktop({ operation: 'preview', id: entry('forged.pdf').id })
  const oversized = await f.desktop({ operation: 'preview', id: entry('oversized.pdf').id })
  assert.equal(forged.preview, null)
  assert.equal(oversized.preview, null)
  const resolved = await f.desktop({ operation: 'open', id: entry('valid.pdf').id })
  assert.equal(resolved.path, path.join(f.root, 'valid.pdf'))
})

test('the main-process opener revalidates the resolved file and current binding', async t => {
  const f = await scope(t)
  const directory = await f.desktop({ operation: 'pick', chosen: f.root })
  const item = directory.entries.find(entry => entry.name === 'top.md')
  const resolved = await f.desktop({ operation: 'open', id: item.id })
  const mainSource = await source('lib/main.js')
  const actionSource = between(mainSource,
    '\t\t\topenWorkflowFile: async (operation, resolved, authorize) => {',
    '\n\t\t\tresolveNativeTheme:')
  const action = new Function('shell', 'fsPromises', 'isAbsolute', 'return ({' + actionSource.trim().replace(/,$/, '') + '}).openWorkflowFile')
  const calls = []
  const shell = { async openPath(value) { calls.push(['open', value]); return '' }, showItemInFolder(value) { calls.push(['reveal', value]) } }
  const open = action(shell, fsPromises, value => path.isAbsolute(value))
  let authorizationChecks = 0
  const authorize = async () => { authorizationChecks++ }
  await open('open', resolved, authorize)
  await open('reveal', resolved, authorize)
  const directoryResolved = await f.desktop({ operation: 'open-directory' })
  assert.equal(directoryResolved.path, f.root)
  await open('open-directory', directoryResolved, authorize)
  assert.deepEqual(calls, [['open', resolved.path], ['reveal', resolved.path], ['open', f.root]])
  assert.equal(authorizationChecks, 3)
  await assert.rejects(open('open', { ...resolved, identity: { ...resolved.identity, ino: '0' } }, authorize), /workflow file changed/)
  await assert.rejects(open('open-directory', resolved, authorize), /workflow file changed/)
  assert.equal(calls.length, 3)
})

test('cancel, root replacement, reparse points and a late picker after role rotation fail closed', async t => {
  const f = await scope(t)
  const d = await desktop(t, f)
  await timeout(() => button(d.files, '打开')?.disabled === false)
  const first = await d.app.workflowFiles({ operation: 'pick' })
  await timeout(() => button(d.files, '关闭目录')?.disabled === false)
  const old = first.entries.find(item => item.name === 'top.md')
  const directory = first.entries.find(item => item.name === 'next')
  await assert.rejects(f.desktop({ operation: 'up' }))
  await rename(f.nested, path.join(f.owned, 'former-child'))
  await symlink(f.outside, f.nested, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.desktop({ operation: 'enter', id: directory.id }))
  d.chosen(null)
  assert.equal(await d.app.workflowFiles({ operation: 'pick' }), null)
  assert.equal((await f.desktop({ operation: 'preview', id: old.id })).preview.data, '# top test data')
  d.chosen(f.outside)
  const second = await d.app.workflowFiles({ operation: 'pick' })
  assert.equal(second.path, f.outside)
  await timeout(() => visibleText(d.files).includes(f.outside) && button(d.files, '打开')?.disabled === false)
  await assert.rejects(f.desktop({ operation: 'preview', id: old.id }))
  const deferred = Promise.withResolvers()
  d.delayChooser(deferred.promise)
  const before = d.chooserCalls()
  const pending = d.app.workflowFiles({ operation: 'pick' })
  pending.catch(() => {})
  await timeout(() => d.chooserCalls() > before)
  f.state.roles.center.sessionId = 'session-b'
  f.state.roleBindingRevisions.center = '2'
  deferred.resolve({ canceled: false, filePaths: [f.root] })
  await assert.rejects(pending, /stale center/)
  assert.equal(await f.desktop({ operation: 'current' }), null)
  assert.equal((await f.tool({ operation: 'current' }, f.other)).ok, false)
  assert.equal((await f.tool({ operation: 'current' })).ok, false)
})

test('closing from the user pane revokes a grant while a center directory transition is pending', async t => {
  const f = await scope(t)
  const d = await desktop(t, f)
  await click(d.files, '打开')
  await timeout(() => button(d.files, '关闭目录')?.disabled === false)
  const listing = JSON.parse((await f.tool({ operation: 'current' })).data)
  const id = listing.entries.find(item => item.name === 'next').id
  // The tool's two session checks and the two admission checks have passed.
  // Pause its final Host binding read while the user revokes the directory.
  const pause = f.holdBindingRead(5)
  const pending = f.tool({ operation: 'enter', id })
  await pause.entered
  try {
    await click(d.files, '关闭目录')
    await timeout(() => visibleText(d.files).includes('尚未打开本地目录'))
  } finally {
    pause.resume()
  }
  assert.equal((await pending).ok, false)
  assert.equal((await f.tool({ operation: 'current' })).ok, false)
  assert.equal(await f.desktop({ operation: 'current' }), null)
})

test('picker cancellation and focus preserve the selected preview during a center directory read', async t => {
  const f = await scope(t)
  const d = await desktop(t, f)
  await click(d.files, '打开')
  await click(d.files, 'top.md')
  await timeout(() => visibleText(d.preview).includes('# top test data') && button(d.files, '打开')?.disabled === false)

  const pause = f.holdBindingRead(5)
  const pending = f.tool({ operation: 'current' })
  await pause.entered
  try {
    const picker = Promise.withResolvers()
    d.delayChooser(picker.promise)
    const before = d.chooserCalls()
    await click(d.files, '打开')
    await timeout(() => d.chooserCalls() === before + 1)
    d.focus()
    picker.resolve({ canceled: true, filePaths: [] })
    await timeout(() => button(d.files, '打开')?.disabled === false)
    assert.ok(visibleText(d.files).includes(f.root))
    assert.match(visibleText(d.preview), /# top test data/)
  } finally {
    pause.resume()
  }
  assert.equal((await pending).ok, true)
  await click(d.preview, '关闭预览')
  await click(d.files, 'top.md')
  await timeout(() => visibleText(d.preview).includes('# top test data'))
})

test('a concurrent directory read returns the new navigation or revoked state', async t => {
  const f = await scope(t)
  const root = await f.desktop({ operation: 'pick', chosen: f.root })
  const child = root.entries.find(item => item.name === 'next')

  const moving = f.holdBindingRead(3)
  const oldListing = f.desktop({ operation: 'current' })
  await moving.entered
  try {
    assert.equal((await f.desktop({ operation: 'enter', id: child.id })).path, f.nested)
  } finally {
    moving.resume()
  }
  assert.equal((await oldListing).path, f.nested)

  const revoking = f.holdBindingRead(3)
  const revokedListing = f.desktop({ operation: 'current' })
  await revoking.entered
  try {
    await f.desktop({ operation: 'revoke' })
  } finally {
    revoking.resume()
  }
  assert.equal(await revokedListing, null)
  assert.equal(await f.desktop({ operation: 'current' }), null)
})
