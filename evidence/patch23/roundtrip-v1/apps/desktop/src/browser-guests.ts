/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, BrowserWindow, dialog, Menu, shell, type Session, type WebContents } from 'electron'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC, type DesktopAiWebState, type DesktopAiWebFileResult, type DesktopAiWebProvider } from './ipc.ts'
import { diagnoseNativeAiWebPage, NativeAiWebDiagnosticError, type NativeAiWebDiagnosticProvider } from './ai-web-diagnostics.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}

/** Persistent remote website window, isolated from product documents and personal DSH. */
interface AiWebSite {
  readonly provider: DesktopAiWebProvider
  readonly label: string
  readonly url: string
  readonly host: string
  readonly partition: string
}

const AI_WEB_SITES: Readonly<Record<DesktopAiWebProvider, AiWebSite>> = {
  deepseek: { provider: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', host: 'deepseek.com', partition: 'persist:tradeloom-ai-web-deepseek-v1' },
  doubao: { provider: 'doubao', label: '豆包', url: 'https://www.doubao.com/chat/', host: 'doubao.com', partition: 'persist:tradeloom-ai-web-doubao-v1' },
}

type AiWebChanged = (owner: BrowserWindow, state: DesktopAiWebState) => void

class DesktopAiWebWindow {
  private window: BrowserWindow | undefined
  private owner: BrowserWindow | undefined
  private phase: DesktopAiWebState['phase'] = 'closed'
  private failure: DesktopAiWebState['error'] = null
  private busy = false
  private configured = false
  private revision = 0

  /** @param hostUrl - authenticated application endpoint, never accessible to the website. */
  constructor(private readonly hostUrl: () => string | undefined, private readonly site: AiWebSite, private readonly onChanged?: AiWebChanged) {}

  /** Accept only the fixed website provider; the renderer cannot provide URLs or paths. */
  private validate(request: unknown): void {
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).join(',') !== 'provider'
      || Reflect.get(request, 'provider') !== this.site.provider) throw new Error('ai web: invalid provider request')
  }

  /** Return non-secret window state without opening or focusing it. */
  status(request: unknown): DesktopAiWebState {
    this.validate(request)
    const window = this.liveWindow()
    return {
      provider: this.site.provider, available: true, revision: this.revision, open: window !== undefined,
      visible: window !== undefined && window.isVisible() && !window.isMinimized(),
      phase: window === undefined ? 'closed' : this.phase,
      error: window === undefined ? null : this.failure,
      persistentSession: true,
      origin: window !== undefined && this.allowedNavigation(window.webContents.getURL())
        ? new URL(window.webContents.getURL()).origin : null,
    }
  }

  /** Toggle the fixed real webpage; closing its window does not erase the isolated login. */
  toggle(owner: BrowserWindow, request: unknown): DesktopAiWebState {
    this.validate(request)
    if (owner.isDestroyed()) throw new Error('ai web: owner closed')
    const previous = this.liveWindow()
    if (previous !== undefined) {
      if (this.owner !== owner) throw new Error('ai web: window belongs to another owner')
      if (previous.isVisible() && !previous.isMinimized()) previous.hide()
      else { if (previous.isMinimized()) previous.restore(); previous.show(); previous.focus() }
      return this.status(request)
    }
    const browserSession = session.fromPartition(this.site.partition)
    if (!this.configured) {
      this.configureSession(browserSession)
      this.configured = true
    }
    const window = new BrowserWindow({
      title: `${this.site.label} 网页 · 织贸助手`, width: 1100, height: 780,
      minWidth: 420, minHeight: 360, show: false,
      frame: true, minimizable: true, maximizable: true, closable: true, resizable: true,
      webPreferences: {
        session: browserSession, sandbox: true, contextIsolation: true,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
        navigateOnDragDrop: false, plugins: false,
      },
    })
    this.window = window
    this.owner = owner
    this.phase = 'loading'
    this.failure = null
    const owned = (): boolean => this.window === window && !window.isDestroyed()
    const ownerClosed = (): void => { if (owned()) window.destroy() }
    owner.once('closed', ownerClosed)
    window.once('closed', () => {
      owner.removeListener('closed', ownerClosed)
      if (this.window === window) { this.window = undefined; this.owner = undefined; this.phase = 'closed'; this.failure = null; this.changed(owner) }
    })
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (owned() && mainFrame && !inPlace) { this.phase = 'loading'; this.failure = null; this.changed() }
    })
    window.webContents.on('did-frame-finish-load', (_event, mainFrame) => {
      if (owned() && mainFrame) { this.phase = 'ready'; this.failure = null; this.changed() }
    })
    window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (owned() && mainFrame && code !== -3) { this.phase = 'error'; this.failure = 'page_load_failed'; this.changed() }
    })
    window.webContents.on('render-process-gone', () => {
      if (owned()) { this.phase = 'error'; this.failure = 'page_process_stopped'; this.changed() }
    })
    window.on('show', () => { this.changed() })
    window.on('hide', () => { this.changed() })
    window.on('minimize', () => { this.changed() })
    window.on('restore', () => { this.changed() })
    window.webContents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
    })
    window.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
    })
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (this.allowedExternal(url)) void shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    })
    window.setMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [
        { label: '上传文件到网页…', click: () => { void this.menuAction(() => this.upload(owner, { provider: this.site.provider })) } },
        { label: '保存可见网页文字…', click: () => { void this.menuAction(() => this.saveText(owner, { provider: this.site.provider })) } },
        { type: 'separator' }, { role: 'close' },
      ] },
      { role: 'editMenu' },
      { label: '网页', submenu: [
        { label: '刷新', click: () => { if (owned()) window.webContents.reload() } },
        { label: '导出无内容站点诊断', click: () => { void this.exportDiagnosticsMenu(owner) } },
        { label: '在浏览器打开', click: () => { void shell.openExternal(this.site.url).catch(() => {}) } },
      ] },
    ]))
    void window.loadURL(this.site.url).catch(() => {
      if (owned()) { this.phase = 'error'; this.failure = 'page_load_failed'; this.changed() }
    })
    window.show()
    this.changed()
    return this.status(request)
  }

  /** Let the user pick one local file; deliver it to a uniquely identified website upload input. */
  async upload(owner: BrowserWindow, request: unknown): Promise<DesktopAiWebFileResult> {
    const window = this.requireWindow(owner, request)
    if (this.busy) throw new Error('ai web: file operation busy')
    this.busy = true
    try {
      const choice = await dialog.showOpenDialog(window, { title: `上传文件到 ${this.site.label} 网页`, properties: ['openFile'] })
      if (choice.canceled || choice.filePaths.length !== 1) return { cancelled: true }
      this.requireSameWindow(window)
      const path = choice.filePaths[0]!
      const info = await stat(path)
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error('ai web: select one file no larger than 20 MiB')
      const debuggerApi = window.webContents.debugger
      if (debuggerApi.isAttached()) throw new Error('ai web: website debugger busy')
      debuggerApi.attach('1.3')
      try {
        const document = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } }
        const inputs = await debuggerApi.sendCommand('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: 'input[type="file"]' }) as { nodeIds: number[] }
        if (inputs.nodeIds.length !== 1) throw new Error('ai web: website upload control unavailable; log in and open the website upload control')
        this.requireSameWindow(window)
        await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId: inputs.nodeIds[0], files: [path] })
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach() }
      return { cancelled: false, name: basename(path), bytes: info.size, delivered: true, websiteConfirmed: false }
    } finally { this.busy = false }
  }

  /** Save visible page text through a native dialog; never read input values or expose paths to the webpage. */
  async saveText(owner: BrowserWindow, request: unknown): Promise<DesktopAiWebFileResult> {
    const window = this.requireWindow(owner, request)
    if (this.busy) throw new Error('ai web: file operation busy')
    this.busy = true
    try {
      const text: unknown = await window.webContents.executeJavaScript('document.body.innerText', false)
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('ai web: visible text exceeds 2 MiB')
      const choice = await dialog.showSaveDialog(window, { title: '保存可见网页文字', defaultPath: `${this.site.label}网页文字.txt`, filters: [{ name: '文本', extensions: ['txt'] }] })
      if (choice.canceled || choice.filePath === undefined) return { cancelled: true }
      this.requireSameWindow(window)
      await writeFile(choice.filePath, text, 'utf8')
      return { cancelled: false, name: basename(choice.filePath), bytes: Buffer.byteLength(text, 'utf8'), saved: true }
    } finally { this.busy = false }
  }

  /** Read only the already-owned fixed-origin page; never activates its window. */
  async diagnostics(owner: BrowserWindow, request: unknown) {
    const window = this.requireWindow(owner, request)
    const provider = this.site.provider as NativeAiWebDiagnosticProvider
    return diagnoseNativeAiWebPage({
      isDestroyed: () => owner.isDestroyed() || window.isDestroyed() || window.webContents.isDestroyed(),
      getURL: () => window.webContents.getURL(),
      get mainFrame() {
        const frame = window.webContents.mainFrame
        return { processId: frame.processId, routingId: frame.routingId, url: frame.url }
      },
      executeJavaScriptInIsolatedWorld: (worldId, scripts, userGesture) =>
        window.webContents.executeJavaScriptInIsolatedWorld(worldId, scripts, userGesture),
    }, provider)
  }

  private async exportDiagnosticsMenu(owner: BrowserWindow): Promise<void> {
    const current = this.liveWindow()
    if (current === undefined || current.isDestroyed()) return
    try {
      const result = await this.diagnostics(owner, { provider: this.site.provider })
      if (owner.isDestroyed() || current.isDestroyed() || this.liveWindow() !== current) {
        throw new NativeAiWebDiagnosticError('window-destroyed')
      }
      const directory = join(app.getPath('userData'), 'site-diagnostics')
      await mkdir(directory, { recursive: true })
      const name = `${result.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
      const outputPath = join(directory, name)
      const json = `${JSON.stringify(result, null, 2)}\n`
      if (Buffer.byteLength(json, 'utf8') > 8_192) throw new NativeAiWebDiagnosticError('result-too-large')
      await writeFile(outputPath, json, { encoding: 'utf8', flag: 'wx' })
      if (!owner.isDestroyed()) await dialog.showMessageBox(owner, {
        type: 'info', title: `${this.site.label} 网页诊断`, message: '无内容站点诊断已导出', detail: outputPath,
      })
    } catch (error) {
      if (owner.isDestroyed()) return
      const code = error instanceof NativeAiWebDiagnosticError ? error.code : 'diagnostic-failed'
      await dialog.showMessageBox(owner, {
        type: 'info', title: `${this.site.label} 网页诊断`, message: `诊断未完成（${code}）`,
      })
    }
  }

  private async menuAction(action: () => Promise<unknown>): Promise<void> {
    try { await action() }
    catch (error) {
      const window = this.liveWindow()
      if (window !== undefined) await dialog.showMessageBox(window, {
        type: 'info', title: `${this.site.label} 网页文件操作`,
        message: error instanceof Error ? error.message : '网页文件操作未完成',
      })
    }
  }

  private changed(owner = this.owner): void {
    this.revision++
    if (owner !== undefined && !owner.isDestroyed()) this.onChanged?.(owner, this.status({ provider: this.site.provider }))
  }

  private liveWindow(): BrowserWindow | undefined {
    return this.window !== undefined && !this.window.isDestroyed() ? this.window : undefined
  }

  private requireWindow(owner: BrowserWindow, request: unknown): BrowserWindow {
    this.validate(request)
    const window = this.liveWindow()
    if (window === undefined || this.owner !== owner || owner.isDestroyed()) throw new Error('ai web: open the owned webpage first')
    this.requireSameWindow(window)
    return window
  }

  private requireSameWindow(window: BrowserWindow): void {
    if (this.liveWindow() !== window || (!URL.canParse(window.webContents.getURL()) || new URL(window.webContents.getURL()).origin !== new URL(this.site.url).origin)) throw new Error('ai web: website is not ready')
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === ''
      && (url.hostname === this.site.host || url.hostname.endsWith('.' + this.site.host))
  }

  private allowedExternal(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' && !this.applicationHost(url)
  }

  private applicationHost(url: URL): boolean {
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true
    const host = this.hostUrl()
    return host !== undefined && url.hostname === new URL(host).hostname
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      callback({ cancel: url.username !== '' || url.password !== '' || this.applicationHost(url)
        || !['https:', 'wss:', 'about:', 'data:', 'blob:'].includes(url.protocol) })
    })
    browserSession.on('will-download', (event, item, contents) => {
      if (contents === undefined || contents !== this.liveWindow()?.webContents) { event.preventDefault(); return }
      item.setSaveDialogOptions({ title: `保存 ${this.site.label} 网页下载`, defaultPath: basename(item.getFilename()) })
    })
  }
}

/** Fixed-site registry; each site owns one independently persistent window/session. */
export class DesktopAiWebWindows {
  private readonly windows = new Map<DesktopAiWebProvider, DesktopAiWebWindow>()

  constructor(private readonly hostUrl: () => string | undefined, private readonly onChanged?: AiWebChanged) {}

  private siteWindow(request: unknown): DesktopAiWebWindow {
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).join(',') !== 'provider') throw new Error('ai web: invalid provider request')
    const provider: unknown = Reflect.get(request, 'provider')
    if (provider !== 'deepseek' && provider !== 'doubao') throw new Error('ai web: invalid provider request')
    let window = this.windows.get(provider)
    if (window === undefined) {
      window = new DesktopAiWebWindow(this.hostUrl, AI_WEB_SITES[provider], this.onChanged)
      this.windows.set(provider, window)
    }
    return window
  }

  toggle(owner: BrowserWindow, request: unknown): DesktopAiWebState { return this.siteWindow(request).toggle(owner, request) }
  status(request: unknown): DesktopAiWebState { return this.siteWindow(request).status(request) }
  upload(owner: BrowserWindow, request: unknown): Promise<DesktopAiWebFileResult> { return this.siteWindow(request).upload(owner, request) }
  saveText(owner: BrowserWindow, request: unknown): Promise<DesktopAiWebFileResult> { return this.siteWindow(request).saveText(owner, request) }
  diagnostics(owner: BrowserWindow, request: unknown) { return this.siteWindow(request).diagnostics(owner, request) }
}
