'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { backendConfig, isReady, makeBackend, payloadFor, publicResult, localConsoleOrigin, permitsConsoleRequest } = require('./backend.cjs')

const mainPage = path.join(__dirname, 'index.html')
const pageUrl = pathToFileURL(mainPage).href

function openServerWindow(backend, { show = true, approve } = {}) {
  const win = new BrowserWindow({
    show, width: 940, height: 710, minWidth: 450, minHeight: 500, title: '织贸企业服务器',
    autoHideMenuBar: true, webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: false, devTools: false,
      partition: 'tradeloom-enterprise-server-local',
    },
  })
  let busy = false
  let consoleWindow = null
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.on('will-redirect', (event) => event.preventDefault())
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
  wc.session.setPermissionCheckHandler(() => false)

  ipcMain.handle('tl-server:invoke', async (event, action, input) => {
    if (win.isDestroyed() || event.sender !== wc || event.senderFrame !== wc.mainFrame || event.senderFrame.url !== pageUrl) {
      return { ok: false, message: '当前页面不能管理服务器。' }
    }
    try { payloadFor(action, input) }
    catch { return { ok: false, message: '操作或输入不符合服务器工作台要求。' } }
    if (busy) return { ok: false, message: '已有操作正在进行。' }
    busy = true
    try {
      if (['manage-stop', 'manage-restart'].includes(action)) {
        const confirmed = approve ? await approve(action) : (await dialog.showMessageBox(win, {
          type: 'warning', title: '确认服务操作',
          message: action === 'manage-stop' ? '停止本安装的服务？' : '重新启动本安装的服务？',
          detail: '操作期间，已连接的客户端将暂时无法访问服务。',
          buttons: ['取消', action === 'manage-stop' ? '停止服务' : '重启服务'],
          defaultId: 0, cancelId: 0, noLink: true,
        })).response === 1
        if (!confirmed) return { ok: false, message: '已取消。' }
      }
      if (action === 'open') {
        if (!isReady(publicResult(await backend('status')))) {
          return { ok: false, message: '请先完成 SMTP 和首管理员邮箱验证。' }
        }
        const origin = localConsoleOrigin(await backend.consoleTarget())
        if (origin) {
          if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.focus()
          else consoleWindow = openLocalConsole(origin, show)
          return { ok: true, message: '已打开企业控制台，请完成管理员两步登录。' }
        }
      }
      return publicResult(await backend(action, input))
    } catch { return { ok: false, message: '服务器操作未确认完成。请刷新状态后再试。' } }
    finally { busy = false }
  })
  win.on('close', (event) => { if (busy) event.preventDefault() })
  win.on('closed', () => {
    ipcMain.removeHandler('tl-server:invoke')
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.destroy()
  })
  win.loadFile(mainPage).catch(() => app.exit(1))
  return win
}

function openLocalConsole(origin, show) {
  const consoleUrl = origin + '/enterprise/console/'
  const win = new BrowserWindow({
    show, width: 1050, height: 760, title: '织贸企业控制台', autoHideMenuBar: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      devTools: false, partition: 'tradeloom-server-console-' + randomUUID(),
    },
  })
  const wc = win.webContents
  const allowed = (event, legacyUrl) => {
    if (!permitsConsoleRequest(origin, event.url ?? legacyUrl)) event.preventDefault()
  }
  wc.on('will-navigate', allowed)
  wc.on('will-redirect', allowed)
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !permitsConsoleRequest(origin, details.url) }))
  wc.session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
  wc.session.setPermissionCheckHandler(() => false)
  win.setMenu(Menu.buildFromTemplate([{
    id: 'return-to-enterprise-console',
    label: '返回企业控制台',
    accelerator: 'Alt+Left',
    click: () => { if (!win.isDestroyed()) win.loadURL(consoleUrl).catch(() => {}) },
  }]))
  win.loadURL(consoleUrl).catch(() => { if (!win.isDestroyed()) win.destroy() })
  return win
}

async function start() {
  app.setName('TradeLoom Enterprise Server Workbench')
  app.setPath('userData', path.join(app.getPath('appData'), 'TradeLoom Enterprise Server Workbench'))
  await app.whenReady()
  Menu.setApplicationMenu(null)
  try {
    const packageRoot = app.isPackaged ? path.resolve(path.dirname(app.getPath('exe')), '..') : path.resolve(__dirname, '..', '..')
    const options = backendConfig(process.argv.slice(app.isPackaged ? 1 : 2), packageRoot)
    openServerWindow(makeBackend(packageRoot, options))
  } catch {
    dialog.showErrorBox('无法打开织贸企业服务器', '请确认启动参数和服务器包完整，或使用 WinForms 恢复入口。')
    app.exit(1)
  }
  app.on('window-all-closed', () => app.quit())
}

module.exports = { openServerWindow, start }
