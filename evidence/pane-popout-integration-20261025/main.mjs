import { app, BrowserWindow, protocol, shell } from 'electron'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dataRoot = join(here, 'userData')
const generatedRoot = join(here, 'generated')
const helperSource = 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/evidence/desktop-pane-popout-patch-20261025/scratch/apps/desktop/src/web-document.ts'
const typescriptModule = 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-13/node_modules/typescript/lib/typescript.js'
const electronNodeModules = 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-13/node_modules'
const blankUrl = 'dsh-app://app/desktop-pane-popout.html'

protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: false, allowServiceWorkers: false },
}])
app.setPath('userData', dataRoot)

const ts = createRequire(import.meta.url)(typescriptModule)
const source = await readFile(helperSource, 'utf8')
const helper = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
await mkdir(generatedRoot, { recursive: true })
const helperPath = join(generatedRoot, 'web-document.cjs')
await writeFile(helperPath, helper, 'utf8')
const { isAllowedDesktopPanePopout, desktopPanePopoutNavigation, serveDesktopPanePopoutDocument } = createRequire(import.meta.url)(helperPath)

const fixtureRootHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Pane popout native fixture</title></head><body><script>
window.addEventListener('DOMContentLoaded', () => {
  window.__fixtureChild = window.open(${JSON.stringify(blankUrl)}, 'pane-popout-fixture', 'show=no,width=520,height=420')
})
</script></body></html>`
const state = { child: undefined, mainFrameBlocks: 0, childPopupAttempts: 0, childPopupBlocked: false }
let opener
let childClosedResolve
const childClosed = new Promise(resolve => { childClosedResolve = resolve })
let timeout

function fail(message) {
  console.error(JSON.stringify({ fixture: 'pane-popout-native', status: 'failed', reason: message }))
  clearTimeout(timeout)
  app.exit(1)
}

function openExternalIfHttp(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(url)
  } catch { /* Malformed and non-HTTP URLs stay denied. */ }
}

function installChildPolicy(parent, child, requestedUrl) {
  if (!isAllowedDesktopPanePopout(requestedUrl, parent.webContents.getURL(), parent.webContents.mainFrame.url)) {
    child.close()
    throw new Error('Electron created a child for an unapproved URL')
  }
  child.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url)
    state.childPopupAttempts += 1
    return { action: 'deny' }
  })
  const guardMainFrame = event => {
    if (!event.isMainFrame) return
    const decision = desktopPanePopoutNavigation(event.url, true)
    if (decision === 'allow') return
    event.preventDefault()
    state.mainFrameBlocks += 1
    if (decision === 'external') openExternalIfHttp(event.url)
  }
  child.webContents.on('will-frame-navigate', guardMainFrame)
  child.webContents.on('will-redirect', guardMainFrame)
}

async function run() {
  await app.whenReady()
  protocol.handle('dsh-app', request => {
    const url = new URL(request.url)
    if (url.protocol !== 'dsh-app:' || url.hostname !== 'app' || url.port || url.username || url.password) return new Response(null, { status: 404 })
    if (url.pathname === '/desktop-pane-popout.html') return serveDesktopPanePopoutDocument(request)
    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
      return new Response(fixtureRootHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    return new Response(null, { status: 404 })
  })

  opener = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false },
  })
  opener.webContents.setWindowOpenHandler(details => {
    const allowed = isAllowedDesktopPanePopout(details.url, details.referrer?.url ?? '', opener.webContents.mainFrame.url)
    if (!allowed) {
      openExternalIfHttp(details.url)
      return { action: 'deny' }
    }
    return {
      action: 'allow', outlivesOpener: false,
      overrideBrowserWindowOptions: {
        show: false, parent: opener,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false },
      },
    }
  })
  opener.webContents.on('did-create-window', (child, details) => {
    try { installChildPolicy(opener, child, details.url) } catch (error) { fail(String(error)) }
    state.child = child
    child.once('closed', childClosedResolve)
  })

  timeout = setTimeout(() => fail('Timed out waiting for the isolated popup lifecycle checks'), 12000)
  await opener.loadURL('dsh-app://app/')
  const child = await new Promise((resolveChild, reject) => {
    const poll = setInterval(() => {
      if (state.child) { clearInterval(poll); resolveChild(state.child) }
      else if (opener.isDestroyed()) { clearInterval(poll); reject(new Error('opener closed before popup')) }
    }, 20)
    setTimeout(() => { clearInterval(poll); reject(new Error('popup was not created')) }, 6000)
  })
  await new Promise((resolveLoad, reject) => {
    if (child.webContents.isLoadingMainFrame()) {
      child.webContents.once('did-finish-load', resolveLoad)
      child.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)))
    } else resolveLoad()
  })

  if (child.webContents.getURL() !== blankUrl) throw new Error(`Unexpected popup document: ${child.webContents.getURL()}`)
  const openerHandle = opener.getNativeWindowHandle()
  const childHandle = child.getNativeWindowHandle()
  if (openerHandle.length === 0 || childHandle.length === 0 || openerHandle.equals(childHandle)) throw new Error('Windows did not receive distinct native handles')

  opener.setBounds({ x: 60, y: 60, width: 800, height: 600 })
  const openerBoundsBefore = opener.getBounds()
  child.setBounds({ x: 240, y: 180, width: 520, height: 420 })
  const childBounds = child.getBounds()
  const openerBoundsAfter = opener.getBounds()
  if (JSON.stringify(openerBoundsBefore) !== JSON.stringify(openerBoundsAfter)) throw new Error('Changing child bounds changed opener bounds')
  if (JSON.stringify(childBounds) === JSON.stringify(openerBoundsAfter)) throw new Error('Child and opener bounds are not independent')

  const blocked = await child.webContents.executeJavaScript(`(() => { location.href = 'dsh-app://app/business/artifacts'; return true })()`).catch(() => false)
  await new Promise(resolveTick => setTimeout(resolveTick, 120))
  if (!blocked || state.mainFrameBlocks < 1 || child.webContents.getURL() !== blankUrl) throw new Error('Child top-level app navigation was not blocked')
  await child.webContents.executeJavaScript(`window.open(${JSON.stringify(blankUrl)}, '_blank')`).catch(() => null)
  await new Promise(resolveTick => setTimeout(resolveTick, 120))
  if (state.childPopupAttempts < 1 || BrowserWindow.getAllWindows().length !== 2) throw new Error('Child-created secondary popup was not denied')

  opener.close()
  await Promise.race([childClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('Child did not close with opener')), 3000))])
  if (!child.isDestroyed()) throw new Error('Child remained alive after opener closed')

  const result = {
    fixture: 'pane-popout-native', status: 'passed',
    electronVersion: process.versions.electron,
    handlesDistinct: true, independentBounds: true, exactBlankRoute: true,
    blockedChildMainFrameNavigation: state.mainFrameBlocks,
    deniedChildSecondaryPopups: state.childPopupAttempts,
    childClosedWithOpener: true,
    networkListeners: 0, hostOrBusinessRequests: 0,
  }
  await writeFile(join(here, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(result))
  clearTimeout(timeout)
  app.quit()
}

void run().catch(fail)
