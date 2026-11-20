import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createWebAiNativeTargets } from '../webai-native-site-adapter.js'

const shell = fileURLToPath(new URL('../', import.meta.url))
const root = new URL('../../../', import.meta.url)
async function actualMain() {
  const patch = await readFile(new URL('apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/seven-features-desktop.patch', root), 'utf8')
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n')
  const start = added.indexOf('\tlet webAiDirectoryPromise'), end = added.indexOf('\n\tipcMain.handle("dsh-desktop:webai-directory"', start)
  assert.ok(start >= 0 && end > start)
  let body = added.slice(start, added.indexOf('\n', end + 1))
  if (process.env.TL_WEB_AI_MAIN_SOURCE) {
    const bytes = await readFile(process.env.TL_WEB_AI_MAIN_SOURCE)
    const recipe = JSON.parse(await readFile(new URL('apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/desktop-recipe.json', root), 'utf8'))
    assert.deepEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, recipe.finalOverlay.postimages['lib/main.js'])
    const source = bytes.toString('utf8'), begin = source.indexOf('\tlet webAiDirectoryPromise'), finish = source.indexOf('\n\tlet sourceStartup;', begin)
    assert.ok(begin > 0 && finish > begin)
    const actual = source.slice(begin, finish)
    assert.ok(actual.replace(/\r/g, '').includes(body.replace(/\r/g, '')), 'author patch caller must be present in the actual applied Main entry')
    body = actual
  }
  const handlers = new Map(), app = new EventEmitter(), windows = new Map()
  const owner = { isDestroyed: () => false }
  const makeWindow = () => { const w = new EventEmitter(); w.dead = false; w.isDestroyed = () => w.dead; w.webContents = new EventEmitter(); w.webContents.id = Math.random(); w.webContents.isDestroyed = () => w.dead; return w }
  for (const provider of ['deepseek', 'doubao']) {
    const site = { owner, window: makeWindow(), liveWindow() { return this.window?.dead ? undefined : this.window }, requireWindow() { return this.liveWindow() }, authStateFor() { return { provider, authState: 'authenticated' } } }
    windows.set(provider, site)
  }
  const source = { id: 33, mainFrame: {} }, descriptor = { kind: 'role', surface: 'chat', generation: 4, sceneId: 'synthetic-scene', panelId: 'synthetic-panel', roleId: 'center', sessionId: 'synthetic-session', bindingRevision: '3' }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const compile = new AsyncFunction('join', 'process', 'pathToFileURL', 'app', 'randomUUID', 'backend', 'aiWebWindows', 'webContents', 'dialog', 'ordinaryMessageBox', 'ipcMain', 'assertDesktopSender', 'sourceController', 'console', body + ';return webAiDirectory();')
  const main = await compile((...p) => p[0] === 'controlled-resources' ? process.env.TL_WEB_AI_BUSINESS_STAGE || shell : join(...p), { resourcesPath: 'controlled-resources' }, pathToFileURL, app, randomUUID, {}, { windows }, {}, {}, async () => {}, { handle: (name, fn) => handlers.set(name, fn) }, event => { if (event.sender !== source) throw Error('rejected sender') }, { nativeDescriptor: () => descriptor }, console)
  return { main, app, windows, makeWindow, status: () => handlers.get('dsh-desktop:webai-directory')({ sender: source, senderFrame: source.mainFrame }, { action: 'status' }) }
}

test('actual Main registers both windows and disposes/reopens; unverified site protocol is never marked ready', async () => {
  const f = await actualMain()
  try {
    const rows = await f.status()
    assert.deepEqual(rows.map(row => [row.providerId, row.registered, row.transportReady, row.reason]), [['deepseek', true, false, 'webai_site_protocol_unverified'], ['doubao', true, false, 'webai_site_protocol_unverified']], 'actual Main registers itself; registration does not prove the site protocol')
    const previous = f.windows.get('deepseek').window
    previous.dead = true; previous.emit('closed')
    assert.equal(f.main.targets.status().find(row => row.providerId === 'deepseek').registered, false)
    f.windows.get('deepseek').window = f.makeWindow()
    assert.equal((await f.status()).find(row => row.providerId === 'deepseek').registered, true)
    assert.notEqual(f.windows.get('deepseek').window, previous)
    const current = f.windows.get('deepseek').window
    current.webContents.emit('did-start-navigation', {}, { isMainFrame: false, isSameDocument: false })
    assert.equal(f.main.targets.status().find(row => row.providerId === 'deepseek').registered, true, 'iframe navigation is not a conversation change')
    current.webContents.emit('did-start-navigation', {}, { isMainFrame: true, isSameDocument: true })
    assert.equal(f.main.targets.status().find(row => row.providerId === 'deepseek').registered, false, 'main route change disposes the previous registration')
    assert.equal(current.webContents.listenerCount('did-start-navigation'), 0)
    assert.equal((await f.status()).find(row => row.providerId === 'deepseek').registered, true)
    await assert.rejects(f.main.targets.beginOperation('deepseek', { guestId: 1, generation: 1, sceneId: 's', panelId: 'p', roleId: 'r', sessionId: 'one', bindingRevision: '1', operationId: 'o' }), { code: 'webai_site_protocol_unverified' })
  } finally { f.app.emit('will-quit') }
})

test('Main transport timeout/observation error rejects the actual target loop and cleans subscriptions once', async () => {
  for (const code of ['webai_reply_timeout', 'webai_site_observation_failed']) {
    const window = new EventEmitter(), contents = new EventEmitter()
    window.webContents = contents; window.isDestroyed = contents.isDestroyed = () => false; contents.id = 7
    const targets = createWebAiNativeTargets({ findWindow: () => window, revokeTarget() {} })
    let receive, stop = 0, cancelled = 0, sent
    const submitted = new Promise(resolve => { sent = resolve })
    targets.register('deepseek', { inspect: async () => ({ conversationId: 'controlled-existing-conversation', observedAt: Date.now() }),
      send: async () => sent(), onAssistantMessage: (_contents, listener) => { receive = listener; return () => { stop++ } }, onConversationChange: () => () => {} })
    const owner = { guestId: 1, generation: 1, sceneId: 'synthetic', panelId: 'p', roleId: 'center', sessionId: 's', bindingRevision: '1', operationId: 'o' }
    const run = targets.runFileTask({ providerId: 'deepseek', owner, prompt: 'synthetic', taskId: 't', taskNonce: 'n', manifest: {} }, { authorize: async () => {}, observe: async () => { throw Error('error must not reach an assistant-message consumer') }, cancel: async () => { cancelled++ } })
    const rejected = assert.rejects(run, error => error.code === code)
    await submitted; receive({ errorCode: code }); await rejected
    assert.equal(stop, 1); assert.equal(cancelled, 1)
    assert.equal(targets.status()[0].available, false)
    targets.dispose()
  }
})
