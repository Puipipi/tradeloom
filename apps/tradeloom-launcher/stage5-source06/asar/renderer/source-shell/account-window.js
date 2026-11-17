(() => {
  'use strict'

  const app = window.app
  const surface = app?.accountSurface
  const viewport = document.getElementById('account-viewport')
  const statusNode = document.getElementById('account-status')
  const state = { disposed:false, status:'unbound', placement:'docked', revision:0, syncRevision:0, maximizeRevision:0, queue:Promise.resolve(), lastBounds:'', visible:false, observer:undefined, offStatus:undefined, frame:undefined, framePending:false }
  const statusText = value => {
    if (state.status === 'error') return '原生账号工作区暂不可用。'
    if (value === 'docked') return '等待主窗口切换账号工作区…'
    if (value === 'popout' && state.status !== 'context-mounted') return '正在连接原生账号工作区…'
    return state.status === 'context-mounted' ? '原生账号工作区已连接。' : '等待原生账号工作区挂载…'
  }

  function updateStatus(value) {
    if (state.disposed || !value || typeof value !== 'object') return
    state.revision++
    if (typeof value.status === 'string') state.status = value.status
    const nextPlacement = value.placement === 'popout' || value.placement === 'docked' ? value.placement : state.placement
    if (nextPlacement !== state.placement) {
      state.placement = nextPlacement
      state.syncRevision++
      state.lastBounds = ''
      if (nextPlacement === 'docked') {
        cancelBoundsFrame()
        state.observer?.disconnect()
        state.observer = undefined
        window.removeEventListener('resize', scheduleBounds)
        state.visible = false
      } else startTracking()
    }
    statusNode.textContent = statusText(state.placement)
    document.getElementById('btn-return').disabled = state.placement !== 'popout'
  }

  function flushBounds() {
    if (state.disposed || state.placement !== 'popout') return
    const revision = ++state.syncRevision
    state.queue = state.queue.then(async () => {
      if (state.disposed || state.placement !== 'popout' || revision !== state.syncRevision) return
      const rect = viewport.getBoundingClientRect()
      if (![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return
      const bounds = { x:rect.x, y:rect.y, width:rect.width, height:rect.height }
      const key = JSON.stringify(bounds)
      if (key !== state.lastBounds) {
        await surface.setBounds(bounds)
        state.lastBounds = key
      }
      if (state.disposed || state.placement !== 'popout' || revision !== state.syncRevision) return
      if (!state.visible) { await surface.setVisible(true); state.visible = true }
    }).catch(() => {
      if (!state.disposed && state.placement === 'popout') statusNode.textContent = '原生账号工作区暂不可用。'
    })
  }

  function scheduleBounds() {
    if (state.disposed || state.placement !== 'popout' || state.framePending) return
    state.framePending = true
    const callback = () => { state.framePending=false;state.frame=undefined;flushBounds() }
    if (typeof window.requestAnimationFrame === 'function') state.frame=window.requestAnimationFrame(callback)
    else state.frame=setTimeout(callback,16)
  }

  function cancelBoundsFrame() {
    if (!state.framePending) return
    state.framePending=false
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(state.frame)
    else clearTimeout(state.frame)
    state.frame=undefined
  }

  function startTracking() {
    if (state.disposed || state.placement !== 'popout') return
    window.addEventListener('resize', scheduleBounds)
    if (!state.observer && typeof window.ResizeObserver === 'function') {
      state.observer = new window.ResizeObserver(scheduleBounds)
      state.observer.observe(viewport)
    }
    scheduleBounds()
  }

  async function returnToDock() {
    if (state.disposed || state.placement !== 'popout' || typeof surface?.returnToDock !== 'function') return
    const beforeRevision = state.revision
    try {
      const result = await surface.returnToDock()
      if (!state.disposed && state.revision === beforeRevision) updateStatus(result)
    } catch { if (!state.disposed) statusNode.textContent = '无法收回账号窗口。' }
  }

  function trustedAppOrigin() {
    return location.protocol === 'dsh-app:' && location.hostname === 'app' && !location.port && !location.username && !location.password
  }

  async function openNativeMenu(name, button) {
    if (!trustedAppOrigin() || !['application','edit'].includes(name) || typeof app?.openWindowsMenu !== 'function') return
    const rect = button.getBoundingClientRect()
    if (![rect.left,rect.bottom].every(Number.isFinite) || rect.left < 0 || rect.bottom < 0) return
    try { await app.openWindowsMenu(name, rect.left, rect.bottom, false) }
    catch { statusNode.textContent = '原生菜单暂不可用。' }
  }

  function applyTheme(mode) {
    const resolvedMode = mode === 'light' || mode === 'system' ? mode : 'dark'
    const light = window.matchMedia('(prefers-color-scheme: light)').matches
    const resolved = resolvedMode === 'system' ? (light ? 'light' : 'dark') : resolvedMode
    document.documentElement.dataset.theme = resolved
  }

  const sourceThemePaletteVars = Object.freeze({
    canvas:['--bg'], panel:['--bg-panel','--card'], header:['--titlebar','--scenebar','--panel-header'],
    border:['--border','--line'], text:['--text'], muted:['--text-2','--text-dim','--text-mute'],
    accent:['--accent'], accentStrong:['--accent-strong'], accentSoft:['--accent-soft'], teal:['--cyan'],
    buttonInk:['--accent-ink'], danger:['--red','--err'], dangerBackground:['--danger-background'],
    dangerBorder:['--danger-border'], warning:['--warn','--amber'], warningBackground:['--warning-background'],
    warningBorder:['--warning-border'], success:['--ok','--green'], successBackground:['--success-background'],
  })
  const sourceThemePaletteKeys = Object.keys(sourceThemePaletteVars)
  const sourceThemeUiKeys = ['fontFamily','fontBody','fontCompact','lineHeight','topRowHeight','navHeight','modelControl','sceneTabHeight','dockTabHeight','controlHeight','toolbarHeight','iconSize','cornerRadius']
  function hasExactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  }
  function applyThemeSnapshot(snapshot) {
    if (!snapshot || !['light','dark','system'].includes(snapshot.preference)
      || !['light','dark'].includes(snapshot.colorScheme)
      || !hasExactKeys(snapshot.palette, sourceThemePaletteKeys)
      || !hasExactKeys(snapshot.ui, sourceThemeUiKeys)
      || sourceThemePaletteKeys.some(key => typeof snapshot.palette[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(snapshot.palette[key]))) return false
    document.documentElement.dataset.theme = snapshot.colorScheme
    for (const [key, names] of Object.entries(sourceThemePaletteVars)) {
      for (const name of names) document.documentElement.style.setProperty(name, snapshot.palette[key])
    }
    return true
  }

  function initTheme() {
    const sourceTheme = app?.sourceTheme
    if (typeof sourceTheme?.getSnapshot === 'function' && typeof sourceTheme?.onChanged === 'function') {
      let changeRevision = 0
      try {
        state.offTheme = sourceTheme.onChanged(snapshot => {
          changeRevision++
          applyThemeSnapshot(snapshot)
        })
      } catch { return true }
      const readRevision = changeRevision
      Promise.resolve().then(() => sourceTheme.getSnapshot()).then(snapshot => {
        if (!state.disposed && readRevision === changeRevision) applyThemeSnapshot(snapshot)
      }).catch(() => {})
      return true
    }
    applyTheme(currentThemeMode())
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const onSystemTheme = () => { if (currentThemeMode() === 'system') applyTheme('system') }
    if (media.addEventListener) media.addEventListener('change',onSystemTheme)
    else if (media.addListener) media.addListener(onSystemTheme)
    const onThemeStorage = event => { if(event.key==='guiTheme')applyTheme(event.newValue) }
    window.addEventListener('storage',onThemeStorage)
    state.offTheme = () => {
      window.removeEventListener('storage',onThemeStorage)
      media.removeEventListener?.('change',onSystemTheme)
      media.removeListener?.(onSystemTheme)
    }
    return false
  }

  async function applyNativeCaptionMode() {
    if (typeof app?.win?.info !== 'function') return
    try {
      const info = await app.win.info()
      if (!state.disposed && info?.nativeCaption === true) document.body.classList.add('native-caption-overlay')
    } catch { /* Keep the compatible HTML controls unless the host confirms native caption ownership. */ }
  }

  function currentThemeMode() {
    const value = localStorage.getItem('guiTheme')
    return value === 'light' || value === 'system' ? value : 'dark'
  }

  async function updateMaximizeState() {
    if (state.disposed || typeof app?.isMaximized !== 'function') return
    const revision = ++state.maximizeRevision
    try {
      const maximized = await app.isMaximized()
      if (state.disposed || revision !== state.maximizeRevision) return
      document.getElementById('btn-max').textContent = maximized ? '❐' : '□'
    } catch { if (!state.disposed) statusNode.textContent = '窗口操作暂不可用。' }
  }

  document.getElementById('btn-min').addEventListener('click', () => { void app?.minimize?.().catch?.(() => { statusNode.textContent='窗口操作暂不可用。' }) })
  document.getElementById('btn-max').addEventListener('click', async () => {
    try { await app?.toggleMaximize?.(); await updateMaximizeState() }
    catch { statusNode.textContent='窗口操作暂不可用。' }
  })
  document.getElementById('btn-close').addEventListener('click', () => { void app?.close?.().catch?.(() => { statusNode.textContent='窗口操作暂不可用。' }) })
  document.getElementById('btn-return').addEventListener('click', () => { void returnToDock() })
  document.getElementById('btn-app').addEventListener('pointerdown', event => { event.preventDefault() })
  document.getElementById('btn-app').addEventListener('click', event => { void openNativeMenu('application',event.currentTarget) })
  document.getElementById('btn-edit').addEventListener('pointerdown', event => { event.preventDefault() })
  document.getElementById('btn-edit').addEventListener('click', event => { void openNativeMenu('edit',event.currentTarget) })
  window.addEventListener('resize',updateMaximizeState)
  initTheme()
  void applyNativeCaptionMode()

  if (surface && typeof surface.onStatus === 'function') {
    const beforeSnapshotRevision = state.revision
    state.offStatus = surface.onStatus(updateStatus)
    Promise.resolve().then(() => surface.status()).then(snapshot => {
      if (!state.disposed && beforeSnapshotRevision === state.revision) updateStatus(snapshot)
    }).catch(() => { if (!state.disposed) statusNode.textContent='原生账号工作区暂不可用。' })
  }

  window.addEventListener('pagehide', () => {
    if (state.disposed) return
    state.disposed=true
    state.syncRevision++
    state.maximizeRevision++
    cancelBoundsFrame()
    state.observer?.disconnect()
    state.offStatus?.()
    state.offTheme?.()
    window.removeEventListener('resize',scheduleBounds)
    window.removeEventListener('resize',updateMaximizeState)
  },{once:true})
  void updateMaximizeState()
})()
