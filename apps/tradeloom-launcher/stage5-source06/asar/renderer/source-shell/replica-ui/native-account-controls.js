(() => {
  const WIDTH_KEY = 'ui18.nativeSidebarWidth:v1'
  const WIDTH_MIN_DEFAULT = 280
  const WIDTH_MAX_DEFAULT = 520
  let sidebarCleanup

  function ensureStylesheet(doc) {
    if (doc.querySelector('link[data-ui18-native-account-controls]')) return
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'dsh-app://app/source-shell/renderer/replica-ui/native-account-controls.css'
    link.dataset.ui18NativeAccountControls = 'true'
    doc.head.appendChild(link)
  }

  function readWidth(storage) {
    try {
      const raw = storage?.getItem(WIDTH_KEY)
      if (raw == null || raw.trim() === '') return undefined
      const value = Number(raw)
      return Number.isFinite(value) && value >= 0 && value <= 2000 ? Math.round(value) : undefined
    } catch { return undefined }
  }

  function mountReturnControl() {
    const app = window.app
    const controls = document.getElementById('titlebar-controls')
    const actionGroup = document.getElementById('titlebar-action-controls')
    if (!app?.accountSurface || !controls || !actionGroup) return () => {}
    if (document.getElementById('btn-native-return-workbench')) return () => {}
    const surface = app.accountSurface
    const button = document.createElement('button')
    button.id = 'btn-native-return-workbench'
    button.className = 'tb-btn tb-btn-compact native-account-return'
    button.type = 'button'
    button.textContent = '返回工作台'
    button.title = '关闭原生侧栏或页面并返回工作台'
    button.setAttribute('aria-label', '返回工作台')
    button.hidden = true
    controls.insertBefore(button, actionGroup)
    let sidebarOpen = false
    let globalPanelOpen = false
    let mounted = false
    let disposed = false
    let busy = false
    const paint = () => {
      const active = mounted && (sidebarOpen || globalPanelOpen)
      button.hidden = !active
      button.setAttribute('aria-expanded', String(active))
      document.body.classList.toggle('native-account-navigation-active', active)
    }
    const refresh = async () => {
      try {
        const info = await app.win.info()
        if (disposed || info?.isMain !== true) return
        const [status, opened, panel] = await Promise.all([surface.status(), surface.sidebarOpen(), surface.globalPanelStatus()])
        if (disposed) return
        mounted = status?.status === 'context-mounted'
        sidebarOpen = opened === true
        globalPanelOpen = panel?.open === true
        paint()
      } catch { if (!disposed) { mounted = false; paint() } }
    }
    const stopStatus = surface.onStatus?.(() => { void refresh() })
    const stopSidebar = surface.onSidebarChanged?.(value => { sidebarOpen = value === true; void refresh() })
    const stopPanel = surface.onGlobalPanelChanged?.(value => { globalPanelOpen = value?.open === true; void refresh() })
    const stopFocus = app.onNativeFocus?.(() => { void refresh() })
    const onClick = async () => {
      if (busy || !mounted) return
      busy = true
      button.disabled = true
      try {
        if (globalPanelOpen) await surface.closeGlobalPanel()
        await surface.setSidebarOpen(false)
      } catch {}
      finally {
        button.disabled = false
        busy = false
        await refresh()
      }
    }
    button.addEventListener('click', onClick)
    void refresh()
    return () => {
      disposed = true
      stopStatus?.(); stopSidebar?.(); stopPanel?.(); stopFocus?.()
      button.removeEventListener('click', onClick)
      button.remove()
      document.body.classList.remove('native-account-navigation-active')
    }
  }

  function mountSidebarResize(bridge, descriptor) {
    sidebarCleanup?.()
    if (!bridge?.accountSidebarCommand || descriptor?.kind !== 'account-sidebar') return () => {}
    ensureStylesheet(document)
    const handle = document.createElement('div')
    handle.className = 'tl-native-account-sidebar-resize'
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-label', '调整侧栏宽度')
    handle.setAttribute('tabindex', '0')
    handle.setAttribute('aria-valuemin', String(WIDTH_MIN_DEFAULT))
    handle.setAttribute('aria-valuemax', String(WIDTH_MAX_DEFAULT))
    handle.setAttribute('aria-disabled', 'true')
    const rail = document.createElement('span')
    rail.className = 'tl-native-account-sidebar-resize-rail'
    rail.setAttribute('aria-hidden', 'true')
    handle.appendChild(rail)
    document.body.appendChild(handle)

    const storage = (() => { try { return window.localStorage } catch { return undefined } })()
    let minDip = WIDTH_MIN_DEFAULT
    let maxDip = WIDTH_MAX_DEFAULT
    let width = Math.max(0, Math.round(window.innerWidth || 340))
    let startX = 0
    let startWidth = width
    let activePointer = null
    let pendingWidth = null
    let draining = false
    let live = true
    let ready = false
    const applySnapshot = snapshot => {
      if (!snapshot || !Number.isFinite(snapshot.widthDip) || !Number.isFinite(snapshot.minDip) || !Number.isFinite(snapshot.maxDip)
        || snapshot.minDip < 0 || snapshot.maxDip < snapshot.minDip || snapshot.widthDip < snapshot.minDip || snapshot.widthDip > snapshot.maxDip) return false
      minDip = snapshot.minDip
      maxDip = snapshot.maxDip
      width = Math.round(snapshot.widthDip)
      handle.setAttribute('aria-valuemin', String(minDip))
      handle.setAttribute('aria-valuemax', String(maxDip))
      handle.setAttribute('aria-valuenow', String(width))
      handle.setAttribute('aria-disabled', 'false')
      ready = true
      return true
    }
    const readHostWidth = async () => {
      try {
        const snapshot = await bridge.accountSidebarCommand({
          generation: descriptor.generation,
          accountGeneration: descriptor.accountGeneration,
          command: { action: 'getSidebarWidth' },
        })
        if (live) applySnapshot(snapshot)
      } catch {}
    }
    const setValue = value => {
      if (!ready) return
      const widthDip = Math.max(minDip, Math.min(maxDip, Math.round(value)))
      handle.setAttribute('aria-valuenow', String(widthDip))
      pendingWidth = widthDip
      if (!draining) void drain()
    }
    const drain = async () => {
      draining = true
      while (live && pendingWidth !== null) {
        const requested = pendingWidth
        pendingWidth = null
        try {
          const result = await bridge.accountSidebarCommand({
            generation: descriptor.generation,
            accountGeneration: descriptor.accountGeneration,
            command: { action: 'setSidebarWidth', widthDip: requested },
          })
          if (!live || !applySnapshot(result)) continue
          try { storage?.setItem(WIDTH_KEY, String(width)) } catch {}
        } catch {}
      }
      draining = false
      if (live && pendingWidth !== null) void drain()
    }
    const begin = event => {
      if (!ready || event.button !== 0 || activePointer !== null) return
      event.preventDefault()
      activePointer = event.pointerId
      startX = event.clientX
      startWidth = width
      handle.classList.add('is-resizing')
      try { handle.setPointerCapture(event.pointerId) } catch {}
    }
    const move = event => {
      if (event.pointerId !== activePointer) return
      setValue(startWidth + event.clientX - startX)
    }
    const finish = event => {
      if (activePointer === null || (event.pointerId !== undefined && event.pointerId !== activePointer)) return
      activePointer = null
      handle.classList.remove('is-resizing')
      if (draining && pendingWidth === null) return
      if (pendingWidth !== null && !draining) void drain()
    }
    const keydown = event => {
      if (!ready || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      setValue(width + (event.key === 'ArrowRight' ? 8 : -8) * (event.shiftKey ? 3 : 1))
    }
    handle.addEventListener('pointerdown', begin)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
    handle.addEventListener('lostpointercapture', finish)
    handle.addEventListener('keydown', keydown)
    const onResize = () => { void readHostWidth() }
    window.addEventListener('resize', onResize)
    void readHostWidth().then(() => {
      const saved = readWidth(storage)
      if (live && saved !== undefined) setValue(saved)
    })
    sidebarCleanup = () => {
      live = false
      pendingWidth = null
      handle.classList.remove('is-resizing')
      handle.removeEventListener('pointerdown', begin)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      handle.removeEventListener('lostpointercapture', finish)
      handle.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', onResize)
      handle.remove()
      sidebarCleanup = undefined
    }
    return sidebarCleanup
  }

  window.TradeLoomNativeAccountControls = Object.freeze({ mountReturnControl, mountSidebarResize, unmountSidebarResize: () => sidebarCleanup?.() })
  mountReturnControl()
})()
