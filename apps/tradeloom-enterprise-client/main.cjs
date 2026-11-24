const { app, BrowserWindow, ipcMain, session, Menu, dialog, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { normalizeServerOrigin, enterpriseUrl, isSameOriginRequest } = require('./security.cjs')

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
  const win = new BrowserWindow({
    width: 500,
    height: 300,
    show,
    minWidth: 430,
    minHeight: 260,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session: session.fromPartition(SETTINGS_PARTITION),
    },
  })
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

function connect(rawOrigin, settingsWindow) {
  const serverOrigin = saveConfig(rawOrigin)
  authorizationEpoch += 1
  connectedOrigin = serverOrigin
  installLocalMenu(false)
  if (productWindow && !productWindow.isDestroyed()) productWindow.close()
  const serverKey = createHash('sha256').update(serverOrigin).digest('hex').slice(0, 16)
  const ses = session.fromPartition(`${PRODUCT_PARTITION}-${serverKey}`)
  installSameOriginFence(ses, serverOrigin)
  productWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: !SMOKE_ENTERPRISE,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session: ses,
    },
  })
  productWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { authorizationEpoch += 1; installLocalMenu(false) }
  })
  productWindow.webContents.on('did-finish-load', () => refreshLocalMenu())
  productWindow.on('closed', () => { authorizationEpoch += 1; installLocalMenu(false) })
  const targetUrl = enterpriseUrl(serverOrigin)
  const permitTarget = (target) => {
    try { return new URL(target).origin === serverOrigin } catch { return false }
  }
  productWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  productWindow.webContents.on('will-navigate', (event, target) => {
    if (!permitTarget(target)) event.preventDefault()
  })
  productWindow.webContents.on('will-redirect', (event, target) => {
    if (!permitTarget(target)) event.preventDefault()
  })
  return productWindow.loadURL(targetUrl).then(() => {
    if (settingsWindow && !settingsWindow.isDestroyed()) setTimeout(() => {
      if (!settingsWindow.isDestroyed()) settingsWindow.close()
    }, 250)
    return { serverOrigin, targetUrl }
  }).catch((error) => {
    if (productWindow && !productWindow.isDestroyed()) productWindow.destroy()
    productWindow = null
    throw new Error(`无法连接企业服务器：${error.message}`)
  })
}

function requireSettingsSender(event) {
  const expected = pathToFileURL(path.join(__dirname, 'index.html')).href
  if (event.senderFrame?.url !== expected || event.sender.getURL() !== expected) throw new Error('仅本地连接设置可调用此操作。')
}

ipcMain.handle('enterprise:get-config', (event) => { requireSettingsSender(event); return { ...readConfig(), edition } })
ipcMain.handle('enterprise:connect', (event, rawOrigin) => {
  requireSettingsSender(event)
  const settingsWindow = BrowserWindow.fromWebContents(event.sender)
  return connect(rawOrigin, settingsWindow)
})

app.whenReady().then(() => {
  installLocalMenu()
  localSettingsWindow(!SMOKE_STANDALONE && !SMOKE_ENTERPRISE)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
