const { app, BrowserWindow, protocol, session } = require('electron')
const { readFileSync } = require('node:fs')

app.setPath('userData', process.env.DIAGNOSTICS_USER_DATA)

const safelyCapture = async operation => {
  try { await operation(); return { code: 'unexpected-success' } }
  catch (error) { return { code: String(error?.code ?? 'unknown'), message: String(error?.message ?? '') } }
}

app.whenReady().then(async () => {
  const fixtureHtml = readFileSync(process.env.DIAGNOSTICS_FIXTURE_HTML, 'utf8')
  await protocol.handle('https', () => new Response(fixtureHtml, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'fixture=COOKIE_CANARY; Path=/' },
  }))
  const diagnostics = require(process.env.DIAGNOSTICS_MODULE)
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await window.loadURL('https://www.doubao.com/chat/')
  const cookieCanaryVerified = await window.webContents.executeJavaScript("document.cookie.includes('COOKIE_CANARY')", false)
  const success = await diagnostics.diagnoseNativeAiWebPage(window.webContents, 'doubao')
  const noCanary = !/CANARY/.test(JSON.stringify(success))
  const wrongOrigin = await safelyCapture(() => diagnostics.diagnoseNativeAiWebPage(window.webContents, 'deepseek'))

  const original = window.webContents
  const navigating = {
    isDestroyed: () => original.isDestroyed(),
    getURL: () => original.getURL(),
    get mainFrame() { return original.mainFrame },
    executeJavaScriptInIsolatedWorld: async (worldId, scripts, userGesture) => {
      const result = await original.executeJavaScriptInIsolatedWorld(worldId, scripts, userGesture)
      await original.loadURL('https://chat.deepseek.com/chat/')
      return result
    },
  }
  const navigation = await safelyCapture(() => diagnostics.diagnoseNativeAiWebPage(navigating, 'doubao'))

  const destroyed = new BrowserWindow({ show: false })
  const destroyedContents = destroyed.webContents
  destroyed.destroy()
  const destroyedView = {
    isDestroyed: () => destroyed.isDestroyed() || destroyedContents.isDestroyed(),
    getURL: () => destroyedContents.getURL(),
    get mainFrame() { return destroyedContents.mainFrame },
    executeJavaScriptInIsolatedWorld: destroyedContents.executeJavaScriptInIsolatedWorld.bind(destroyedContents),
  }
  const afterDestroy = await safelyCapture(() => diagnostics.diagnoseNativeAiWebPage(destroyedView, 'doubao'))
  const report = {
    success,
    cookieCanaryVerified,
    noCanary,
    wrongOrigin,
    navigation,
    afterDestroy,
    fixtureOrigin: new URL(window.webContents.getURL()).origin,
  }
  process.stdout.write(`DIAGNOSTICS_RESULT=${JSON.stringify(report)}\n`)
  window.destroy()
  app.quit()
}).catch(error => {
  process.stderr.write(`fixture-error=${String(error?.message ?? 'unknown')}\n`)
  app.exit(2)
})
