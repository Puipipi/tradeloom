const { app, BrowserWindow, ipcMain, session, Menu, dialog, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { normalizeServerOrigin, enterpriseUrl, isSameOriginRequest } = require('./security.cjs')
const { signIn, sessionPolicy } = require('./login.cjs')

app.setName('TradeLoom Enterprise Client')
const SETTINGS_PARTITION = 'persist:tradeloom-enterprise-settings'
const PRODUCT_PARTITION = 'persist:tradeloom-enterprise-web'
const SMOKE_STANDALONE = process.argv.includes('--smoke-standalone')
const SMOKE_ENTERPRISE = process.argv.includes('--smoke-enterprise')
// The edition is a build-time local constant, never a server role assertion.
let edition = 'generic'
try {
  const marker = JSON.parse(fs.readFileSync(path.join(__dirname, 'edition.json'), 'utf8'))
  if (!['owner', 'factory'].includes(marker.edition)) throw new Error('Invalid client edition')
  edition = marker.edition
} catch (error) { if (error.code !== 'ENOENT') throw error }
const qaRootArgument = process.argv.find(value => value.startsWith('--enterprise-qa-root='))
const qaRoot = (SMOKE_STANDALONE || SMOKE_ENTERPRISE) && qaRootArgument ? qaRootArgument.slice('--enterprise-qa-root='.length) : null
if (qaRoot !== null && !path.isAbsolute(qaRoot)) throw new Error('QA root must be absolute')
if (edition !== 'generic') {
  const base = qaRoot || ((SMOKE_STANDALONE || SMOKE_ENTERPRISE) ? path.join(app.getPath('temp'), 'TradeLoomEnterpriseSmoke', String(process.pid)) : app.getPath('appData'))
  const profile = path.join(base, 'TradeLoom', `Enterprise-${edition}`)
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
} else if (SMOKE_STANDALONE || SMOKE_ENTERPRISE) {
  const profile = qaRoot ? path.join(qaRoot, 'TradeLoom Enterprise Client') : path.join(app.getPath('temp'), 'TradeLoomEnterpriseSmoke', String(process.pid))
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
}
let productWindow = null
let connectedOrigin = ''
let authorizationEpoch = 0
const settingsWindows = new Set()
const pendingSignIns = new WeakSet()
let settingsWindow = null

async function authorized(capability = "local_workbench") {
  const win = productWindow
  const origin = connectedOrigin
  const epoch = authorizationEpoch
  if (!win || win.isDestroyed() || !origin) return false
  try {
    if (new URL(win.webContents.getURL()).origin !== origin) return false
    const response = await win.webContents.session.fetch(`${origin}/enterprise/capabilities/`, { redirect: 'error', cache: 'no-store' })
    // Electron net.fetch can return an empty Response.url. The request is fixed
    // to the connected origin and redirects are rejected above.
    if (!response.ok || response.redirected === true || (response.url && response.url !== `${origin}/enterprise/capabilities/`)) return false
    const policy = await response.json()
    return epoch === authorizationEpoch && win === productWindow && !win.isDestroyed()
      && policy.configuration_conflict !== true
      && policy.capabilities?.[capability] === true
      && (capability !== 'local_workbench' || (policy.role === 'owner' && policy.capabilities?.owner_tools === true))
  } catch { return false }
}

async function refreshLocalMenu() {
  const epoch = authorizationEpoch
  const [owner, ops] = await Promise.all([authorized(), authorized("server_ops")])
  if (epoch === authorizationEpoch) installLocalMenu(owner, ops)
}

async function openOwnerPage(relative) {
  if (!await authorized("server_ops")) { installLocalMenu(false); return }
  await productWindow.loadURL(`${connectedOrigin}${relative}`)
}

// Local application menu only. Remote pages cannot supply an executable path.
function installLocalMenu(owner = false, ops = false) {
  const workbench = path.join(path.dirname(app.getPath('exe')), 'Workbench', '启动工作台.exe')
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: '个人端',
    submenu: [
      { label: '连接台账服务', click: () => localSettingsWindow() },
      { label: '打开本地完整工作台', enabled: owner && fs.existsSync(workbench), click: async () => {
        if (!await authorized()) { installLocalMenu(false); return }
        shell.openPath(workbench).then((error) => {
          if (error) dialog.showErrorBox('无法打开本地完整工作台', '请确认个人端目录中的 Workbench 程序完整。')
        })
      } },
      { label: '服务端管理', enabled: ops, click: () => openOwnerPage('/enterprise/console/') },
      { label: '服务端助手', enabled: ops, click: () => openOwnerPage('/enterprise/console/#assistant') },
      { type: 'separator' },
      { role: 'quit', label: '退出个人端' },
    ],
  }]))
}

function configPath() {
  return path.join(app.getPath('userData'), 'enterprise-client.json')
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return { serverOrigin: normalizeServerOrigin(parsed.serverOrigin) }
  } catch {
    return { serverOrigin: '' }
  }
}

function saveConfig(raw) {
  const serverOrigin = normalizeServerOrigin(raw)
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  const tempPath = `${configPath()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify({ serverOrigin }, null, 2), { mode: 0o600 })
  fs.renameSync(tempPath, configPath())
  return serverOrigin
}

function localSettingsWindow(show = true) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (show) { settingsWindow.show(); settingsWindow.focus() }
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 500,
    height: 600,
    show,
    minWidth: 430,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session: session.fromPartition(SETTINGS_PARTITION),
    },
  })
  settingsWindow = win
  const contents = win.webContents
  settingsWindows.add(contents)
  win.on('closed', () => { settingsWindows.delete(contents); if (settingsWindow === win) settingsWindow = null })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== pathToFileURL(path.join(__dirname, 'index.html')).href) event.preventDefault()
  })
  const loaded = win.loadFile(path.join(__dirname, 'index.html'))
  if (SMOKE_STANDALONE) loaded.then(() => { console.log('standalone-settings-loaded'); app.exit(0) }, (error) => { console.error(error.message); app.exit(1) })
  return win
}

function installSameOriginFence(ses, serverOrigin) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isSameOriginRequest(details.url, serverOrigin) })
  })
}

function serverSession(serverOrigin) {
  const serverKey = createHash('sha256').update(serverOrigin).digest('hex').slice(0, 16)
  const ses = session.fromPartition(`${PRODUCT_PARTITION}-${serverKey}`)
  installSameOriginFence(ses, serverOrigin)
  return ses
}

async function connect(rawOrigin, settingsWindow) {
  const serverOrigin = normalizeServerOrigin(rawOrigin)
  const ses = serverSession(serverOrigin)
  const previous = productWindow
  const candidate = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session: ses,
    },
  })
  candidate.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame && candidate === productWindow) { authorizationEpoch += 1; installLocalMenu(false) }
  })
  candidate.webContents.on('did-finish-load', async () => {
    if (candidate !== productWindow) return
    const url = new URL(candidate.webContents.getURL())
    if (url.pathname === '/accounts/login/') {
      authorizationEpoch += 1
      installLocalMenu(false)
      localSettingsWindow()
      candidate.close()
      return
    }
    await refreshLocalMenu()
  })
  candidate.on('closed', () => {
    if (candidate === productWindow) { productWindow = null; authorizationEpoch += 1; installLocalMenu(false) }
  })
  const targetUrl = enterpriseUrl(serverOrigin)
  const permitTarget = target => {
    try { return new URL(target).origin === serverOrigin } catch { return false }
  }
  candidate.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const name of ['will-navigate', 'will-redirect']) candidate.webContents.on(name, (event, target) => {
    if (!permitTarget(target)) event.preventDefault()
  })
  try {
    await candidate.loadURL(targetUrl)
    if (candidate.webContents.getURL() !== targetUrl) throw new Error('登录会话已失效，请重新登录。')
    saveConfig(serverOrigin)
    authorizationEpoch += 1
    connectedOrigin = serverOrigin
    productWindow = candidate
    if (!SMOKE_ENTERPRISE) candidate.show()
    if (previous && !previous.isDestroyed()) previous.close()
    await refreshLocalMenu()
    if (settingsWindow && !settingsWindow.isDestroyed()) setTimeout(() => {
      if (!settingsWindow.isDestroyed()) settingsWindow.close()
    }, 250)
    return { serverOrigin, targetUrl }
  } catch {
    if (!candidate.isDestroyed()) candidate.destroy()
    throw new Error('无法打开已验证的企业会话，请重新登录。')
  }
}

function requireSettingsSender(event) {
  const expected = pathToFileURL(path.join(__dirname, 'index.html')).href
  if (!settingsWindows.has(event.sender) || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== expected || event.sender.getURL() !== expected) throw new Error('仅本地连接设置可调用此操作。')
}

ipcMain.handle('enterprise:get-config', (event) => { requireSettingsSender(event); return { ...readConfig(), edition } })
ipcMain.handle('enterprise:sign-in', async (event, credentials) => {
  requireSettingsSender(event)
  if (pendingSignIns.has(event.sender)) throw new Error('正在登录，请稍候。')
  pendingSignIns.add(event.sender)
  try {
    const { serverOrigin, username, password } = credentials || {}
    const origin = normalizeServerOrigin(serverOrigin)
    await signIn(serverSession(origin), origin, username, password)
    return await connect(origin, BrowserWindow.fromWebContents(event.sender))
  } finally { pendingSignIns.delete(event.sender) }
})

app.whenReady().then(async () => {
  installLocalMenu()
  const { serverOrigin } = readConfig()
  if (serverOrigin && !SMOKE_STANDALONE) {
    try {
      if (await sessionPolicy(serverSession(serverOrigin), serverOrigin)) {
        await connect(serverOrigin)
        return
      }
    } catch { /* Expired or unreachable: return to the same three-field entry. */ }
  }
  localSettingsWindow(!SMOKE_STANDALONE && !SMOKE_ENTERPRISE)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
