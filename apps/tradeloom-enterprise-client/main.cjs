const { app, BrowserWindow, ipcMain, session } = require('electron')
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
if (SMOKE_STANDALONE || SMOKE_ENTERPRISE) app.setPath('userData', path.join(app.getPath('temp'), 'TradeLoomEnterpriseSmoke', String(process.pid)))
let productWindow = null

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

ipcMain.handle('enterprise:get-config', () => readConfig())
ipcMain.handle('enterprise:connect', (event, rawOrigin) => {
  const settingsWindow = BrowserWindow.fromWebContents(event.sender)
  return connect(rawOrigin, settingsWindow)
})

app.whenReady().then(() => {
  localSettingsWindow(!SMOKE_STANDALONE && !SMOKE_ENTERPRISE)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
