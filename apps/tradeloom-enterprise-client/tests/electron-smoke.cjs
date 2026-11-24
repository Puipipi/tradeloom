// Synthetic-account acceptance through the production Electron main process.
const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeServerOrigin } = require('../security.cjs')

const args = process.argv.slice(process.argv.indexOf('--') + 1)
function arg(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const origin = normalizeServerOrigin(arg('--server-origin') || '')
const entryPath = '/enterprise/'
const credentialsFile = arg('--credentials-file')
const label = arg('--account') || 'registrar'
const evidenceFile = arg('--result-file')
if (!credentialsFile || !evidenceFile) throw new Error('smoke requires credentials-file and result-file paths')

app.setName('TradeLoom Enterprise Client Smoke')
app.setPath('userData', path.join(path.dirname(path.resolve(evidenceFile)), 'electron-user-data'))
require('../main.cjs')

function waitForLoad(contents, stage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`${stage} timeout`)), 30000)
    const done = () => finish(resolve)
    const failed = (_event, code, description) => finish(reject, new Error(`${stage} failed ${code}: ${description}`))
    const finish = (fn, value) => {
      clearTimeout(timer)
      contents.removeListener('did-finish-load', done)
      contents.removeListener('did-fail-load', failed)
      fn(value)
    }
    contents.once('did-finish-load', done)
    contents.once('did-fail-load', failed)
  })
}

app.whenReady().then(async () => {
  const data = JSON.parse(fs.readFileSync(path.resolve(credentialsFile), 'utf8'))
  const credential = data.accounts?.[label] || data[label]
  if (!credential || typeof credential.username !== 'string' || typeof credential.password !== 'string') throw new Error(`synthetic account ${label} missing`)
  let remote
  try {
    const settings = await waitForSettingsWindow()
    const initialConfig = await settings.webContents.executeJavaScript('window.tradeloomEnterprise.getConfig()')
    if (initialConfig.serverOrigin !== '') throw new Error('fresh client contains a preconfigured server')
    const workbenchMenu = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items || []).find((item) => item.label === '打开本地完整工作台')
    if (!workbenchMenu) throw new Error('local workbench menu is missing')
    const initial = await settings.webContents.executeJavaScript(`({ fields: document.querySelectorAll('input').length, username: document.querySelector('#username').value, password: document.querySelector('#password').value })`)
    if (initial.fields !== 3 || initial.username || initial.password) throw new Error('three-field local login must start with empty credentials')
    await settings.webContents.executeJavaScript(`window.tradeloomEnterprise.signIn(${JSON.stringify({ serverOrigin: origin, username: credential.username, password: credential.password })})`)
    remote = BrowserWindow.getAllWindows().find((win) => win !== settings && !win.isDestroyed())
    if (!remote) throw new Error('production main did not open the enterprise window')
    const after = await remote.webContents.executeJavaScript(`({ url: location.href, title: document.title, loginStillPresent: Boolean(document.querySelector('input[type="password"]')), preloadVisible: typeof window.tradeloomEnterprise !== 'undefined', nodeVisible: typeof require !== 'undefined' })`)
    if (after.loginStillPresent || new URL(after.url).origin !== origin || new URL(after.url).pathname !== '/enterprise/' || /server error/i.test(after.title)) throw new Error('local login did not render the authenticated enterprise page')
    const result = { client: 'TradeLoom Enterprise Electron smoke', accountLabel: label, origin, entryPath, initialOriginEmpty: true, localWorkbenchMenuPresent: true, localWorkbenchMenuEnabled: workbenchMenu.enabled, threeFieldLocalLogin: true, loggedIn: true, sameOrigin: true, remotePreloadAbsent: !after.preloadVisible, remoteNodeAbsent: !after.nodeVisible, title: after.title, finalPath: new URL(after.url).pathname }
    fs.writeFileSync(path.resolve(evidenceFile), JSON.stringify(result, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ status: 'ok', ...result }))
    app.exit(0)
  } catch (error) {
    fs.writeFileSync(path.resolve(evidenceFile), JSON.stringify({ status: 'failed', message: error.message }), { mode: 0o600 })
    console.error(JSON.stringify({ status: 'failed', message: error.message }))
    app.exit(1)
  } finally {
    if (remote && !remote.isDestroyed()) remote.destroy()
  }
}).catch((error) => {
  fs.mkdirSync(path.dirname(path.resolve(evidenceFile)), { recursive: true })
  fs.writeFileSync(path.resolve(evidenceFile), JSON.stringify({ status: 'failed', message: error.message }), { mode: 0o600 })
  console.error(JSON.stringify({ status: 'failed', message: error.message }))
  app.exit(1)
})

function waitForSettingsWindow() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('settings window timeout')), 10000)
    const poll = setInterval(() => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && !candidate.webContents.isLoadingMainFrame())
      if (win) finish(resolve, win)
    }, 25)
    function finish(fn, value) { clearTimeout(timer); clearInterval(poll); fn(value) }
  })
}
