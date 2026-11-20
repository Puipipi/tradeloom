// Specific identity-chain fixture: real Host handlers, final controller, real
// surface-owner, Main/preload fragments; Electron and persistence are controlled.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cpus, totalmem, freemem } from 'node:os'
const R = new URL('../../../../', import.meta.url)
const pin = value => ({ bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') })

export async function sourceRoleIdentity(t, { sessionId = 'one', onNativeDescriptorChanged } = {}) {
  assert.ok(process.env.TL_SEVEN_DESKTOP_INPUTS && process.env.TL_SEVEN_SDK_RUNTIME && process.env.TL_SEVEN_TEST_ROOT, 'explicit final desktop inputs, matching SDK and owned test root required')
  const require = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  const sdk = require('./package.json')
  assert.equal(sdk.name, '@deepseek-ai/dsh-desktop-runtime')
  assert.ok(['0.2.2-rc.2', '0.2.2-rc.3'].includes(sdk.version), 'unsupported SDK identity')
  const isRc3 = sdk.version === '0.2.2-rc.3'
  const inputs = JSON.parse(await readFile(process.env.TL_SEVEN_DESKTOP_INPUTS, 'utf8'))
  const recipe = JSON.parse(await readFile(new URL(`apps/tradeloom-launcher/dsh-upgrades/${sdk.version}/desktop-recipe.json`, R), 'utf8'))
  assert.equal(recipe.version, sdk.version)
  async function input(name, entry) {
    const data = await readFile(inputs[name].path)
    const actualPin = pin(data)
    assert.deepEqual(actualPin, { bytes: inputs[name].bytes, sha256: inputs[name].sha256 }, name)
    const recipePin = isRc3 && name !== 'main' ? recipe.sources[entry].preimage : recipe.finalOverlay.postimages[entry]
    assert.deepEqual(actualPin, recipePin, entry)
    return data.toString('utf8')
  }
  const controllerSource = await input('controller', 'lib/tradeloom-source-shell/source-shell-controller.mjs')
  const mainSource = await input('main', 'lib/main.js'), preload = await input('preload', 'lib/preload-app.cjs')
  const ownerRow = recipe.sources['lib/tradeloom-source-shell/surface-owner.mjs']
  const ownerPath = isRc3
    ? new URL('./surface-owner.mjs', pathToFileURL(inputs.controller.path))
    : new URL(ownerRow.source, R)
  const ownerBytes = await readFile(ownerPath)
  assert.deepEqual(pin(ownerBytes), ownerRow.preimage)
  const { createSurfaceOwner } = await import(ownerPath.href)
  let resolving = false
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (!resolving && (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@modelcontextprotocol/'))) {
      resolving = true; try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } } finally { resolving = false }
    }
    return next(specifier, context)
  } }); t.after(() => hook.deregister())
  const { createScenesHandler, createSourceShellBindingHandler } = await import('../../host.js')
  const { ROLE_PRESETS } = await import('../../roles.js')
  const defaults = JSON.parse(await readFile(new URL('../../scenes.json', import.meta.url), 'utf8'))
  const selectedScene = defaults.scenes.find(scene => (scene.roleId === 'center' || scene.panels.some(panel => panel.roleId === 'center')) && scene.panels.some(panel => panel.type === 'native-chat'))
  assert.ok(selectedScene)
  const selectedPanel = selectedScene.panels.find(panel => panel.type === 'native-chat' && (panel.roleId ?? selectedScene.roleId) === 'center')
  assert.ok(selectedPanel)
  const sceneId = selectedScene.id, panelId = selectedPanel.id
  const workspace = { id: 'controlled', path: join(process.env.TL_SEVEN_TEST_ROOT, 'identity-workspace'), sessionIds: [sessionId, 'two'] }
  let state = { roles: { center: { sessionId, workspaceId: workspace.id, workspacePath: workspace.path, agentPreset: ROLE_PRESETS.center }, product: { sessionId: 'two', workspaceId: workspace.id, workspacePath: workspace.path, agentPreset: ROLE_PRESETS.product } }, roleBindingRevisions: { center: '1', product: '7' } }
  const store = { read: async () => structuredClone(state), async transact(action) { const next = structuredClone(state), result = await action(next); state = next; return result } }
  const persistence = { identity: {}, async flush() {}, async stat(id) { const role = Object.keys(state.roles).find(role => state.roles[role].sessionId === id); return { header: { id, cwd: workspace.path, agentPreset: ROLE_PRESETS[role] } } } }
  const ctx = { connection: { requestRejection: () => undefined }, webServer: { getOrigin: () => 'http://127.0.0.1:12345' }, agents: new Map(),
    workspaceRegistry: { get: id => id === workspace.id ? workspace : undefined, archivedSessionIds: [] }, get: name => name === 'sessionPersistence' ? persistence : undefined }
  const dependencies = { createStateStore: async () => store, readScenes: async () => JSON.stringify(defaults), roleWorkspacePath: async () => workspace.path }
  async function request(handler, method, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method
    let value
    const res = { statusCode: 200, setHeader() {}, end(text) { value = text ? JSON.parse(text) : undefined } }
    await handler(req, res); assert.equal(res.statusCode, 200, JSON.stringify(value)); return value
  }
  const scenes = createScenesHandler(ctx, dependencies), bindings = createSourceShellBindingHandler(ctx, dependencies)
  const handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }
  let nextId = 100
  class Contents extends EventEmitter {
    constructor() { super(); this.id = ++nextId; this.mainFrame = { url: 'about:blank' }; this.renderer = new EventEmitter(); this.messages = []; this.destroyed = false; this.zoom = 1 }
    isDestroyed() { return this.destroyed }
    async loadURL(url) { this.mainFrame.url = url; this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url }); this.emit('did-finish-load') }
    getURL() { return this.mainFrame.url }
    setZoomFactor(value) { this.zoom = value }
    getZoomFactor() { return this.zoom }
    send(channel, ...args) { this.messages.push({ channel, args }); this.renderer.emit(channel, {}, ...args); if (channel === 'source-shell:draft-flush-request') void handlers.get('source-shell:draftFlushResult')({ sender: this, senderFrame: this.mainFrame }, { requestId: args[0].requestId, saved: true }) }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('destroyed') }
    close() { this.destroy() }
    isFocused() { return false }
  }
  class Window extends EventEmitter {
    constructor() { super(); this.id = ++nextId; this.webContents = new Contents(); this.destroyed = false; this.contentView = { children: [], addChildView: view => { this.contentView.children = this.contentView.children.filter(value => value !== view); this.contentView.children.push(view) }, removeChildView: view => { this.contentView.children = this.contentView.children.filter(value => value !== view) } } }
    isDestroyed() { return this.destroyed }
    getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 } }
    isMinimized() { return false }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroy(); this.emit('closed') }
    close() { this.destroy() }
    focus() {}
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); this.bounds = { x: 0, y: 0, width: 500, height: 500 } }
    setVisible(value) { this.visible = value }
    setBounds(value) { this.bounds = value }
    getBounds() { return this.bounds }
  }
  // Import rebinding is only the controlled Electron/filesystem boundary.
  // The full actual constructor/body and real surface-owner execute unchanged;
  // this read-only hook exposes its actual stored item for notification tests.
  let internals
  assert.equal(controllerSource.split('\n  return controller').length, 2)
  const body = controllerSource.replace(/^import .*\r?\n/gm, '').replace('export function createSourceShellController', 'function createSourceShellController')
    .replace('\n  return controller', '\n  observeInternals({ notifyLayout: (s,p)=>notifyRoleLayout(views.get(key(s,p))) });return controller')
  const factory = new Function('appendFile', 'mkdir', 'statfs', 'join', 'randomUUID', 'createSurfaceOwner', 'cpus', 'totalmem', 'freemem', 'observeInternals', `${body};return createSourceShellController`)(
    async () => {}, async () => {}, async () => ({}), join, randomUUID, createSurfaceOwner, cpus, totalmem, freemem, value => { internals = value })
  const primary = new Window(), mainEvent = () => ({ sender: primary.webContents, senderFrame: primary.webContents.mainFrame })
  let rotationResult
  const controller = factory({ BrowserWindow: Window, WebContentsView: View, ipcMain, appPreload: 'controlled-app-preload', sourcePreload: 'controlled-source-preload', ownedPartition: 'persist:controlled', primaryWindow: primary,
    resolveNativeTheme: preference => preference === 'dark' ? 'dark' : 'light', subscribeNativeTheme: () => () => {},
    getConfig: () => request(scenes, 'GET'), resolveBinding: input => request(bindings, 'POST', input), installProtocol: async () => {}, writeUi18Diagnostic: async () => {},
    saveConfig: input => request(scenes, 'PUT', input), confirmConfigurationChange: async () => true, sceneRotationStatus: async () => rotationResult, onNativeDescriptorChanged })
  const started = controller.start(); started.catch(() => {})
  t.after(async () => { controller.destroy(); await started.catch(() => {}) })
  for (let n = 0; n < 100 && !handlers.has('source-shell:create'); n++) await Promise.resolve()
  assert.ok(handlers.has('source-shell:create'))
  await handlers.get('source-shell:initialPaintReady')(mainEvent(), { status: 'ready' }); await started
  await handlers.get('source-shell:accountCreate')(mainEvent())
  const accountView = controller.getAccountGuest()
  const accountDescriptor = controller.nativeDescriptor(accountView.webContents, accountView.webContents.mainFrame)
  controller.nativeMounted(accountView.webContents, accountView.webContents.mainFrame, accountDescriptor)
  await handlers.get('source-shell:create')(mainEvent(), sceneId, panelId)
  await handlers.get('source-shell:visible')(mainEvent(), sceneId, panelId, true)
  const view = () => controller.getGuest(sceneId, panelId)
  const roleEvent = () => ({ sender: view().webContents, senderFrame: view().webContents.mainFrame })
  const DESKTOP_IPC = { nativeSurfaceDescriptor: 'dsh-desktop:native-surface-descriptor', nativeSurfaceMounted: 'dsh-desktop:native-surface-mounted', nativeSurfaceChanged: 'dsh-desktop:native-surface-changed', accountSidebarCommand: 'dsh-desktop:account-sidebar-command' }
  const assertDesktopSender = event => { if (event.sender !== view().webContents || event.senderFrame !== view().webContents.mainFrame) throw Error('controlled unowned sender') }
  const begin = mainSource.indexOf('\tipcMain.handle(DESKTOP_IPC.nativeSurfaceDescriptor,'), mounted = mainSource.indexOf('\tipcMain.handle(DESKTOP_IPC.nativeSurfaceMounted,', begin)
  const roleEnd = mainSource.indexOf('\n\t\tconst contents = event.sender;', mounted)
  assert.ok(begin > 0 && mounted > begin && roleEnd > mounted)
  new Function('ipcMain', 'DESKTOP_IPC', 'assertDesktopSender', 'sourceMode', 'sourceController', 'assertProductSender', mainSource.slice(begin, mounted) + mainSource.slice(mounted, roleEnd) + '\n\t});')(ipcMain, DESKTOP_IPC, assertDesktopSender, true, controller, () => assert.fail('unexpected non-source branch'))
  const navBegin = mainSource.indexOf('function registerAccountSidebarCommandHandler('), navEnd = mainSource.indexOf('\nconst DESKTOP_PANE_POPOUT_URL', navBegin)
  new Function('assertDesktopSender', `${mainSource.slice(navBegin, navEnd)};return registerAccountSidebarCommandHandler`)(assertDesktopSender)(ipcMain, DESKTOP_IPC.accountSidebarCommand, () => ({ sourceMode: true, controller }))
  const changed = preload.indexOf('onNativeSurfaceChanged(listener) {'), changedEnd = preload.indexOf('\n\t\t},', changed) + '\n\t\t},'.length
  const action = name => { const match = preload.match(new RegExp(`^${name}: \\(.*=>.*$`, 'm')); assert.ok(match, `actual preload callable ${name}`); return match[0] }
  const electron = { ipcRenderer: view().webContents.renderer }
  const bridgeEvent = roleEvent()
  electron.ipcRenderer.invoke = (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)(bridgeEvent, ...args))
  const bridge = new Function('electron', 'DESKTOP_IPC', `return ({${action('nativeSurfaceDescriptor')}${action('nativeSurfaceMounted')}${action('accountSidebarCommand')}${preload.slice(changed, changedEnd)}})`)(electron, DESKTOP_IPC)
  const descriptor = () => bridge.nativeSurfaceDescriptor()
  return { bridge, descriptor, controller, accountDescriptor, view, primary, sceneId, panelId, mainSource, roleEvent, handlers,
    async rotateSameSession() { state.roleBindingRevisions.center = String(BigInt(state.roleBindingRevisions.center) + 1n); rotationResult = { roleId: 'center', sessionId, status: 'bound' }; await handlers.get('source-shell:sceneRotationStatus')(mainEvent(), {}); return descriptor() },
    notifyLayout() { internals.notifyLayout(sceneId, panelId) },
    async changeRole() { const current = await request(scenes, 'GET'), configuration = structuredClone(defaults); configuration.scenes.find(scene => scene.id === sceneId).panels.find(panel => panel.id === panelId).roleId = 'product'; await handlers.get('source-shell:configurationSave')(mainEvent(), { expectedRevision: current.configurationRevision, configuration }); await handlers.get('source-shell:create')(mainEvent(), sceneId, panelId); return controller.nativeDescriptor(view().webContents, view().webContents.mainFrame) },
  }
}
