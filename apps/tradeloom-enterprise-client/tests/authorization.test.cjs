const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
const flush = () => new Promise(resolve => setImmediate(resolve))
async function harness(edition, argv = []) {
  const paths = {}; let ready = false
  const handlers = {}; const windows = []; let menu; let opened = 0; let policy = null
  const ses = { webRequest: { onBeforeRequest() {} }, async fetch(url) {
    if (policy instanceof Error) throw policy
    return { ok: !!policy, url, json: async () => policy }
  } }
  class Window extends EventEmitter {
    constructor() { super(); this.url = ''; this.webContents = new EventEmitter(); this.webContents.session = ses; this.webContents.getURL = () => this.url; this.webContents.mainFrame = {};  this.webContents.setWindowOpenHandler = () => {}; windows.push(this) }
    loadFile(file) { this.url = require('node:url').pathToFileURL(file).href; return Promise.resolve() }
    loadURL(url) { this.url = url; this.webContents.emit('did-finish-load'); return Promise.resolve() }
    isDestroyed() { return false }
    show() {}
    focus() {}
    destroy() {}
    close() {}
    static fromWebContents(contents) { return windows.find(w => w.webContents === contents) }
  }
  const electron = {
    app: Object.assign(new EventEmitter(), { setName() {}, getPath: name => paths[name] || 'C:/synthetic', setPath(name, value) { assert.equal(ready, false); paths[name] = value }, whenReady: () => { ready = true; return Promise.resolve() } }),
    BrowserWindow: Window, ipcMain: { handle(name, fn) { handlers[name] = fn } }, session: { fromPartition: () => ses },
    Menu: { buildFromTemplate: x => x, setApplicationMenu: x => { menu = x } }, dialog: { showErrorBox() {} }, shell: { openPath: async () => { opened++; return '' } },
  }
  const fakeFs = { existsSync: () => true, readFileSync: file => { if (edition && file.endsWith('edition.json')) return JSON.stringify({ edition }); throw Object.assign(Error('empty config'), { code: 'ENOENT' }) }, mkdirSync() {}, writeFileSync() {}, renameSync() {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name === 'node:fs' ? fakeFs : name === './security.cjs' ? require('../security.cjs') : name === './login.cjs' ? { signIn: async () => ({ step: 'email_code' }), verifyCode: async () => true, resendCode: async () => true, sessionPolicy: async () => null } : require(name),
    __dirname: root, process: { argv, platform: 'win32' }, setTimeout: () => 0, console, URL,
  })
  await flush()
  const settings = windows[0]
  settings.webContents.mainFrame.url = settings.url;
  const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame }
  const item = label => menu[0].submenu.find(x => x.label === label)
  return { paths, item, opened: () => opened, setPolicy: value => { policy = value }, async connect() { await handlers['enterprise:sign-in'](event, { serverOrigin: 'https://example.invalid', username: 'synthetic', password: 'synthetic' }); await handlers['enterprise:verify-code'](event, '123456'); await flush() }, handlers, event }
}

test('packaged editions select distinct profile and session paths before ready; generic unchanged', async () => {
  const owner = await harness('owner'); const factory = await harness('factory'); const generic = await harness()
  assert.notEqual(owner.paths.userData, factory.paths.userData)
  for (const h of [owner, factory]) assert.equal(h.paths.userData, h.paths.sessionData)
  assert.deepEqual(generic.paths, {})
  assert.match(owner.paths.userData, /Enterprise-owner$/)
  assert.match(factory.paths.userData, /Enterprise-factory$/)
  await assert.rejects(harness('remote-role'), /Invalid client edition/)
  const shared = ['--smoke-enterprise', '--enterprise-qa-root=C:/same-test-base']
  const qaOwner = await harness('owner', shared); const qaFactory = await harness('factory', shared)
  assert.match(qaOwner.paths.userData, /same-test-base/)
  assert.match(qaFactory.paths.userData, /same-test-base/)
  assert.notEqual(qaOwner.paths.userData, qaFactory.paths.userData)
  await assert.rejects(harness('owner', ['--smoke-enterprise', '--enterprise-qa-root=']), /QA root must be absolute/)
  await assert.rejects(harness('owner', ['--smoke-enterprise', '--enterprise-qa-root=relative']), /QA root must be absolute/)
  assert.match((await harness('owner', ['--smoke-enterprise'])).paths.userData, /TradeLoomEnterpriseSmoke/)
})

test('Workbench denied before login, registrar, server failure and revoked owner; rechecked on click', async () => {
  const h = await harness()
  assert.equal(h.item('打开本地完整工作台').enabled, false)
  h.setPolicy({ role: 'registrar', capabilities: { local_workbench: false, server_ops: false } })
  await h.connect()
  await h.item('打开本地完整工作台').click()
  assert.equal(h.opened(), 0)
  h.setPolicy({ role: 'owner', capabilities: { local_workbench: true, owner_tools: true, server_ops: true } })
  await h.connect()
  assert.equal(h.item('打开本地完整工作台').enabled, true)
  h.setPolicy(new Error('offline'))
  await h.item('打开本地完整工作台').click()
  assert.equal(h.opened(), 0)
  assert.equal(h.item('打开本地完整工作台').enabled, false)
  h.setPolicy({ role: 'owner', capabilities: { local_workbench: true, owner_tools: true, server_ops: true } })
  await h.connect(); await h.item('打开本地完整工作台').click()
  assert.equal(h.opened(), 1)
})

test('technician ops menus do not grant local Workbench and remote settings IPC fails', async () => {
  const h = await harness()
  h.setPolicy({ role: 'member', capabilities: { local_workbench: false, server_ops: true } })
  await h.connect()
  assert.equal(h.item('服务端管理').enabled, true)
  assert.equal(h.item('服务端助手').enabled, true)
  assert.equal(h.item('打开本地完整工作台').enabled, false)
  assert.throws(() => h.handlers['enterprise:get-config']({ ...h.event, senderFrame: { url: 'https://example.invalid/enterprise/' } }))
  const unknown = { getURL: () => h.event.sender.getURL(), mainFrame: h.event.senderFrame }
  assert.throws(() => h.handlers['enterprise:get-config']({ sender: unknown, senderFrame: unknown.mainFrame }))
  assert.throws(() => h.handlers['enterprise:get-config']({ ...h.event, senderFrame: { url: h.event.sender.getURL() } }))
})
