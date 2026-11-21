/* Narrow bridge for the approved scene shell. Host-owned state stays in Main/Host. */
(() => {
  'use strict'

  const app = window.app
  const bridgeScriptUrl = document.currentScript?.src || ''
  const routeByUiScene = Object.freeze({
    center: '/home',
    products: '/products',
    'order-production': '/orders',
    'agent-center': '/agent-center',
    deliverables: '/artifacts',
    runs: '/runs',
  })
  const roleByUiScene = Object.freeze({
    center: 'center',
    products: 'product',
    'order-production': 'order-production',
    'agent-center': 'center',
    deliverables: 'delivery',
    runs: 'center',
  })
  const allowedRoutes = new Set(Object.values(routeByUiScene))
  const nativeScaleValues = [0.85, 0.9, 0.95, 1, 1.1, 1.25]
  const state = {
    phase: 'idle',
    config: undefined,
    error: '',
    configPromise: undefined,
    fileBridgePromise: undefined,
    sceneId: '',
    sceneRevision: 0,
    sceneTransitionPending: false,
    sceneTransitionSequence: 0,
    roleRecord: undefined,
    roleQueue: Promise.resolve(),
    roleStatusOff: undefined,
    roleObserver: undefined,
    workflowRecord: undefined,
    workflowQueue: Promise.resolve(),
    workflowObserver: undefined,
    accountStatus: 'loading',
    accountSidebarOpen: false,
    globalPanelOpen: false,
    themePreference: undefined,
    themeSnapshot: undefined,
    nativeScale: undefined,
    sourceEditor: true,
    offNativeFocus: undefined,
    sourcePointerDown: undefined,
    sourceFocusIn: undefined,
    sourceWindowBlur: undefined,
    listenersInstalled: false,
    tearingDown: false,
    accountStatusOff: undefined,
    sidebarOff: undefined,
    globalPanelOff: undefined,
    workflowStatusOff: undefined,
    themeOff: undefined,
    scaleOff: undefined,
    overlayObserver: undefined,
  }
  const fileBridgeMounts = new Map()

  const isDesktop = () => location.protocol === 'dsh-app:' && location.hostname === 'app'
    && !location.port && !location.username && !location.password
  const byId = id => document.getElementById(id)
  const send = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

  function setMessage(text, error = false) {
    const node = byId('status-text')
    const dot = byId('status-dot')
    if (node) node.textContent = text
    if (dot) dot.className = `status-dot${error ? '' : ' ok'}`
  }

  function validateConfig(config) {
    if (!config || !Array.isArray(config.scenes) || !config.businessRoutes
      || typeof config.businessRoutes !== 'object' || Array.isArray(config.businessRoutes)
      || !Array.isArray(config.roles) || !config.sessionBindings
      || typeof config.sessionBindings !== 'object' || Array.isArray(config.sessionBindings)) {
      throw new Error('invalid source config')
    }
    const scenes = new Map()
    for (const scene of config.scenes) {
      if (!scene || typeof scene.id !== 'string' || !scene.id || scenes.has(scene.id)
        || !Array.isArray(scene.panels)) throw new Error('invalid source scene')
      const panels = new Map()
      for (const panel of scene.panels) {
        if (!panel || typeof panel.id !== 'string' || !panel.id || panels.has(panel.id)) throw new Error('invalid source panel')
        panels.set(panel.id, panel)
      }
      scenes.set(scene.id, { ...scene, panelMap: panels })
    }
    const roles = new Set()
    for (const role of config.roles) {
      if (!role || typeof role.id !== 'string' || !role.id || roles.has(role.id)) throw new Error('invalid source role')
      roles.add(role.id)
    }
    for (const [path, route] of Object.entries(config.businessRoutes)) {
      if (!allowedRoutes.has(path) || !route || typeof route.sceneId !== 'string' || typeof route.panelId !== 'string') continue
      const scene = scenes.get(route.sceneId)
      if (!scene || scene.panelMap.get(route.panelId)?.type !== 'business-iframe') throw new Error('invalid business route target')
    }
    return { raw: config, scenes, roles }
  }

  function retryButton(onClick) {
    const button = document.createElement('button')
    button.className = 'business-runtime-retry'
    button.type = 'button'
    button.textContent = '重试读取配置'
    button.addEventListener('click', onClick)
    return button
  }

  function stateNode(content, text, phase = 'loading', retry) {
    const wrap = document.createElement('div')
    wrap.className = 'business-runtime-state-wrap'
    const note = document.createElement('div')
    note.className = 'business-runtime-state'
    note.dataset.state = phase
    note.textContent = text
    wrap.append(note)
    if (retry) wrap.append(retryButton(retry))
    content.replaceChildren(wrap)
    return note
  }

  const themePaletteKeys = ['canvas','panel','header','border','text','muted','accent','accentStrong','accentSoft','teal','buttonInk','danger','dangerBackground','dangerBorder','warning','warningBackground','warningBorder','success','successBackground']
  const themeUiKeys = ['fontFamily','fontBody','fontCompact','lineHeight','topRowHeight','navHeight','modelControl','sceneTabHeight','dockTabHeight','controlHeight','toolbarHeight','iconSize','cornerRadius']
  const hasExactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')

  let resolveInitialTheme,rejectInitialTheme
  const initialThemeReady=new Promise((resolve,reject)=>{resolveInitialTheme=resolve;rejectInitialTheme=reject})
  initialThemeReady.catch(()=>{})
  function whenInitialThemeReady(){return state.themeSnapshot ? Promise.resolve(state.themeSnapshot) : initialThemeReady}
  function acceptThemeSnapshot(snapshot) {
    if (!snapshot || !['light','dark','system'].includes(snapshot.preference)
      || !['light','dark'].includes(snapshot.colorScheme)
      || !hasExactKeys(snapshot.palette, themePaletteKeys) || !hasExactKeys(snapshot.ui, themeUiKeys)
      || themePaletteKeys.some(key => typeof snapshot.palette[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(snapshot.palette[key]))
      || themeUiKeys.some(key => key === 'fontFamily' ? typeof snapshot.ui[key] !== 'string' : !Number.isFinite(snapshot.ui[key]))
      || snapshot.ui.fontBody < 10 || snapshot.ui.fontBody > 22) return false
    state.themeSnapshot = snapshot
    resolveInitialTheme(snapshot)
    state.themePreference = snapshot.preference
    document.documentElement.dataset.theme = snapshot.colorScheme
    send('business-theme-state', snapshot)
    sendThemeToBusinessFrames()
    return true
  }

  function businessFrameForEvent(event) {
    if (!event || event.origin !== (isDesktop() ? 'dsh-app://app' : location.origin)) return undefined
    return [...document.querySelectorAll('#grid iframe[data-tradeloom-panel-id]')]
      .find(frame => frame.isConnected && frame.contentWindow === event.source
        && state.config?.scenes.get(frame.dataset.tradeloomBusinessSceneId)?.panelMap.has(frame.dataset.tradeloomPanelId))
  }

  function sendThemeToBusinessFrame(frame) {
    if (!frame?.isConnected || !state.themeSnapshot || !frame.matches('iframe[data-tradeloom-panel-id]')) return
    try {
      frame.contentWindow?.postMessage({
        type: 'tradeloom:theme', colorScheme: state.themeSnapshot.colorScheme,
        palette: state.themeSnapshot.palette, ui: state.themeSnapshot.ui,
      }, isDesktop() ? 'dsh-app://app' : location.origin)
    } catch { /* The frame may be navigating; the next load/request retries. */ }
  }

  function sendThemeToBusinessFrames() {
    for (const frame of document.querySelectorAll('#grid iframe[data-tradeloom-panel-id]')) sendThemeToBusinessFrame(frame)
  }

  function onBusinessThemeRequest(event) {
    if (Object.keys(event?.data ?? {}).sort().join(',') !== 'type'
      || event.data.type !== 'tradeloom:theme:request') return
    const frame = businessFrameForEvent(event)
    if (frame) sendThemeToBusinessFrame(frame)
  }

  function installRuntimeListeners() {
    if (state.listenersInstalled) return
    state.listenersInstalled = true
    state.sourcePointerDown = event => {
      if (event.target?.closest?.('#btn-native-workspace, #btn-sidebar-overlay, #btn-global-panel-return, [data-native-action], .pi-more, .pi-menu')) return
      state.sourceEditor = true
    }
    state.sourceFocusIn = event => {
      if (event.target?.matches?.('input,textarea,[contenteditable="true"],iframe')) state.sourceEditor = true
    }
    state.sourceWindowBlur = () => setTimeout(() => {
      if (document.hasFocus?.() && document.activeElement?.tagName === 'IFRAME') state.sourceEditor = true
    }, 0)
    document.addEventListener('pointerdown', state.sourcePointerDown, true)
    document.addEventListener('focusin', state.sourceFocusIn, true)
    window.addEventListener('blur', state.sourceWindowBlur)
    if (typeof app?.onNativeFocus === 'function') {
      try { state.offNativeFocus = app.onNativeFocus(() => { state.sourceEditor = false }) } catch { /* Keep the last known focus source. */ }
    }
    const account = app?.accountSurface
    if (typeof account?.onStatus === 'function') {
      try { state.accountStatusOff = account.onStatus(value => {
        if (value && typeof value.status === 'string') {
          state.accountStatus = value.status
          if(value.status==='error')rejectInitialTheme(Error('initial source theme unavailable'))
          send('business-account-status', value)
        }
      }) } catch { /* The explicit status request remains the fallback. */ }
    }
    if (typeof account?.onSidebarChanged === 'function') {
      try { state.sidebarOff = account.onSidebarChanged(open => {
        state.accountSidebarOpen = open === true
        document.body.classList.toggle('native-sidebar-open', state.accountSidebarOpen)
        send('business-sidebar-state', state.accountSidebarOpen)
        syncNativeVisibility()
      }) } catch { /* The sidebar action will report an unavailable bridge. */ }
    }
    if (typeof account?.onGlobalPanelChanged === 'function') {
      try { state.globalPanelOff = account.onGlobalPanelChanged(value => {
        state.globalPanelOpen = value?.open === true
        send('business-global-panel-state', value)
        syncNativeVisibility()
      }) } catch { /* Global panel state is also reflected by Main's native view. */ }
    }
    if (typeof app?.harnessSurface?.onStatus === 'function') {
      try { state.roleStatusOff = app.harnessSurface.onStatus(onRoleStatus) } catch { /* status() remains authoritative */ }
    }
    if (typeof app?.workflowCanvas?.onStatus === 'function') {
      try { state.workflowStatusOff = app.workflowCanvas.onStatus(onWorkflowStatus) } catch { /* status() remains authoritative */ }
    }
    if (typeof app?.sourceTheme?.onChanged === 'function') {
      try { state.themeOff = app.sourceTheme.onChanged(applyThemeSnapshot) } catch { /* getSnapshot() remains the initial source */ }
    }
    window.addEventListener('message', onBusinessThemeRequest)
    if (typeof app?.onUiScaleChanged === 'function') {
      try { state.scaleOff = app.onUiScaleChanged(applyNativeScale) } catch { /* getUiScale() remains the initial source */ }
    }
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(syncNativeVisibility)
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
      state.overlayObserver = observer
    }
    window.addEventListener('resize', syncNativeVisibility)
    window.addEventListener('pagehide', onPageHide, { once: true })
  }

  function onPageHide() {
    if (state.tearingDown) return
    state.tearingDown = true
    window.removeEventListener('message', onBusinessThemeRequest)
    window.removeEventListener('resize', syncNativeVisibility)
    if (state.sourcePointerDown) document.removeEventListener('pointerdown', state.sourcePointerDown, true)
    if (state.sourceFocusIn) document.removeEventListener('focusin', state.sourceFocusIn, true)
    if (state.sourceWindowBlur) window.removeEventListener('blur', state.sourceWindowBlur)
    state.overlayObserver?.disconnect?.()
    state.roleObserver?.disconnect?.()
    state.workflowRecord?.hostObserver?.disconnect?.()
    for (const unsubscribe of [state.accountStatusOff, state.sidebarOff, state.globalPanelOff,
      state.roleStatusOff, state.workflowStatusOff, state.themeOff, state.scaleOff, state.offNativeFocus]) {
      try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* closing callbacks must not block native cleanup */ }
    }
    const role = state.roleRecord
    if (role?.created && role.target && role.placement !== 'popped-out') {
      role.syncRevision++
      role.visible = undefined
      void Promise.resolve().then(() => app?.harnessSurface?.setVisible(role.target.sceneId, role.target.panelId, false))
        .then(() => { role.visible = false }).catch(() => { role.visible = undefined })
    }
    const workflow = state.workflowRecord
    if (state.workflowMounted && workflow && workflow.placement !== 'popped-out') {
      workflow.revision++
      workflow.visible = undefined
      void Promise.resolve().then(() => app?.workflowCanvas?.setVisible(false)).then(() => { workflow.visible = false })
        .catch(() => { workflow.visible = undefined })
    }
    if (typeof app?.accountSurface?.setVisible === 'function') {
      void Promise.resolve().then(() => app.accountSurface.setVisible(false)).catch(() => {})
    }
    for (const mounted of fileBridgeMounts.values()) {
      window.removeEventListener('message', mounted.handler)
      try { mounted.handler.dispose?.() } catch { /* page is closing */ }
    }
    fileBridgeMounts.clear()
  }

  function start() {
    installRuntimeListeners()
    if (!state.configurationOff && typeof app?.onSceneConfigurationChanged === 'function') state.configurationOff = app.onSceneConfigurationChanged(value => {
      const next = validateConfig(value)
      state.config = next
      state.configPromise = Promise.resolve(next)
      send('business-configuration-applied', value)
    })
    if (state.configPromise) return state.configPromise
    state.phase = isDesktop() ? 'loading' : 'unavailable'
    if (!isDesktop()) {
      state.error = '浏览器预览未连接桌面宿主。'
      state.phase = 'unavailable'
      send('business-config-state', { phase: state.phase })
      return Promise.resolve(undefined)
    }
    if (typeof app?.sourceConfig !== 'function') {
      state.error = '桌面业务配置入口不可用。'
      state.phase = 'error'
      send('business-config-state', { phase: state.phase, error: state.error })
      return Promise.resolve(undefined)
    }

    // Keep the approved geometry on screen immediately; config and account readiness are independent.
    void ensureFileBridge()
    const account = app.accountSurface
    if (typeof account?.create === 'function') {
      void account.create().then(async value => {
        if (state.tearingDown) {
          if (typeof account.setVisible === 'function') await account.setVisible(false).catch(() => {})
          return
        }
        let status = value
        try { status = await account.status() || value } catch { /* keep the create result */ }
        if (state.tearingDown) {
          if (typeof account.setVisible === 'function') await account.setVisible(false).catch(() => {})
          return
        }
        state.accountStatus = status?.status === 'context-mounted' ? 'context-mounted' : 'unavailable'
        send('business-account-status', status)
        if (state.accountStatus === 'context-mounted' && typeof account.sidebarOpen === 'function') {
          try {
            const open = await account.sidebarOpen()
            if (typeof open === 'boolean') {
              state.accountSidebarOpen = open
              document.body.classList.toggle('native-sidebar-open', open)
              send('business-sidebar-state', open)
              syncNativeVisibility()
            }
          } catch { /* Sidebar state remains event-driven until a later toggle. */ }
        }
      }).catch(() => { rejectInitialTheme(Error('initial source theme unavailable')); state.accountStatus = 'unavailable'; send('business-account-status', { status: 'unavailable' }) })
    } else {
      rejectInitialTheme(Error('initial source theme unavailable'))
      state.accountStatus = 'unavailable'
      send('business-account-status', { status: 'unavailable' })
    }
    if (typeof app.getUiScale === 'function') {
      void app.getUiScale().then(applyNativeScale).catch(() => send('business-ui-scale-state', { available: false }))
    }
    if (typeof app.sourceTheme?.getSnapshot === 'function') void app.sourceTheme.getSnapshot().then(applyThemeSnapshot).catch(() => rejectInitialTheme(Error('initial source theme unavailable')))

    state.configPromise = Promise.resolve().then(() => app.sourceConfig()).then(validateConfig).then(value => {
      state.config = value
      state.error = ''
      state.phase = 'ready'
      send('business-config-state', { phase: state.phase })
      send('business-config-ready', { phase: state.phase })
      return value
    }).catch(() => {
      state.error = '无法读取当前业务配置。'
      state.phase = 'error'
      send('business-config-state', { phase: state.phase, error: state.error })
      return undefined
    })
    return state.configPromise
  }

  function pathForScene(sceneId) { return state.config?.scenes.get(sceneId)?.defaultBusinessPath ?? routeByUiScene[sceneId] }
  function routeForPath(path) {
    const basePath = typeof path === 'string' ? path.split('#')[0] : ''
    const hash = typeof path === 'string' && path.includes('#') ? path.slice(path.indexOf('#')) : ''
    if (!state.config || !allowedRoutes.has(basePath) || (hash && !['#files', '#preview', '#deliverables'].includes(hash))) return undefined
    const route = state.config.raw.businessRoutes[basePath]
    if (!route) return undefined
    const scene = state.config.scenes.get(route.sceneId)
    const panel = scene?.panelMap.get(route.panelId)
    if (!panel || panel.type !== 'business-iframe') return undefined
    return { path, basePath, route, scene, panel }
  }

  function workflowTemplateRoute(sceneId) {
    // A copy may display the canonical native surface in the same owned window.
    // The Host configuration, rather than renderer metadata, supplies the binding.
    const target = routeForPath('/agent-center')
    const copy = state.config?.scenes.get(sceneId)
    if (target?.scene.id !== 'agent-center' || target.panel.id !== 'business-main'
      || !copy || copy.id === target.scene.id || copy.templateSceneId !== target.scene.id
      || (copy.defaultBusinessPath && copy.defaultBusinessPath !== '/agent-center')
      || (copy.defaultBusinessRoute && copy.defaultBusinessRoute !== '/agent-center')) return undefined
    const standardPanels = [['business-main', '/agent-center'], ['files', '/artifacts#files'], ['preview', '/artifacts#preview']]
    return [target.scene, copy].every(scene => standardPanels.every(([id, path]) => {
      const panel = scene.panelMap.get(id)
      return panel?.type === 'business-iframe' && panel.path === path && panel.componentId === undefined
    })) ? target : undefined
  }

  function renderBusinessPanel(meta, content, pathOverride, panelOverride) {
    const path = pathOverride || pathForScene(meta?.sceneId)
    if (!path || !allowedRoutes.has(path.split('#')[0])) {
      stateNode(content, '此场景没有对应的受控业务路由。', 'error')
      return () => content.replaceChildren()
    }
    if (state.phase === 'idle') void start()
    if (state.phase === 'loading') {
      const note = stateNode(content, '正在读取业务配置…')
      const onReady = () => {
        window.removeEventListener('business-config-ready', onReady)
        if (content.isConnected) renderBusinessPanel(meta, content, path, panelOverride)
      }
      window.addEventListener('business-config-ready', onReady)
      return () => { window.removeEventListener('business-config-ready', onReady); content.replaceChildren() }
    }
    if (state.phase === 'unavailable') {
      stateNode(content, state.error || '浏览器预览未连接桌面宿主。', 'unavailable')
      return () => content.replaceChildren()
    }
    if (state.phase !== 'ready') {
      stateNode(content, state.error || '业务配置不可用。', 'error', () => {
        state.phase = 'loading'; state.error = ''; state.configPromise = undefined
        stateNode(content, '正在重试读取业务配置…')
        void start().then(() => { if (content.isConnected) renderBusinessPanel(meta, content, path, panelOverride) })
      })
      return () => content.replaceChildren()
    }
    const target = routeForPath(path)
    if (!target) {
      stateNode(content, '此业务页面尚未配置到桌面路由。', 'error')
      return () => content.replaceChildren()
    }
    if (meta?.componentId) {
      const scene = state.config.scenes.get(meta.sceneId)
      const owner = scene?.panelMap.get(meta.hostPanelId)
      if (!owner || owner.componentId !== meta.componentId || owner.type !== 'business-iframe' || owner.path !== path) {
        stateNode(content, '场景组件未配置到此面板。', 'error')
        return () => content.replaceChildren()
      }
      panelOverride = { sceneId: scene.id, panelId: owner.id }
    }
    if (meta?.id === 'workflow-plan') {
      // Resolve only the explicitly registered plan panel. Never borrow canvas owner.
      const planScene = state.config.scenes.get(meta.sceneId)
      const planOwner = planScene?.panelMap.get('business-plan')
      const planRouteMatches = planScene?.id === target.route.sceneId
        || (path === '/agent-center' && workflowTemplateRoute(meta.sceneId)?.scene.id === target.route.sceneId)
      if (meta.hostPanelId !== 'business-plan' || !planOwner || planOwner.type !== 'business-iframe'
        || planOwner.path !== path || !planRouteMatches) {
        stateNode(content, '独立业务计划面板尚未配置。', 'error')
        return () => content.replaceChildren()
      }
      panelOverride = { sceneId: planScene.id, panelId: planOwner.id }
    }
    const panel = content.closest('.panel')
    const routeId = ({ '/home': 'home', '/products': 'products', '/orders': 'orders', '/agent-center': 'agent-center', '/artifacts': 'artifacts', '/runs': 'runs' })[target.basePath]
    if (panel) panel.dataset.businessRoute = routeId
    const frame = document.createElement('iframe')
    frame.title = typeof meta?.title === 'string' ? meta.title : '织贸业务'
    frame.referrerPolicy = 'no-referrer'
    frame.dataset.businessPreview = routeId
    frame.dataset.tradeloomBusinessFrame = 'true'
    frame.dataset.tradeloomPanelId = panelOverride?.panelId || target.route.panelId
    frame.dataset.tradeloomBusinessSceneId = panelOverride?.sceneId || target.route.sceneId
    frame.dataset.tradeloomBusinessPath = path
    frame.classList.add('business-route-frame')
    const expectedEmbedMode = path.includes('#') ? path.slice(path.indexOf('#') + 1) : ''
    const gatedEmbedMode = ['files', 'preview', 'deliverables'].includes(expectedEmbedMode) ? expectedEmbedMode : ''
    frame.style.cssText = `width:100%;height:100%;min-height:0;flex:1;border:0;background:var(--bg)${gatedEmbedMode ? ';visibility:hidden' : ''}`
    let disposed = false
    const frameIsCurrent = () => !disposed && frame.isConnected && content.contains(frame)
    const embedIsReady = () => {
      if (!gatedEmbedMode) return true
      try {
        const frameWindow = frame.contentWindow
        const doc = frame.contentDocument
        if (!frameWindow || !doc?.documentElement || doc.readyState !== 'complete') return false
        const expected = new URL(`/business${path}`, document.baseURI)
        const actual = new URL(frameWindow.location.href)
        const html = doc.documentElement
        const intakeRoot = doc.querySelector('[data-testid="intake-workbench"]')
        const fileBrowser = doc.querySelector('[data-file-browser]')
        const deliverables = doc.querySelector('[data-deliverables-section]')
        const fileList = doc.querySelector('[data-file-list-pane]')
        const filePreview = doc.querySelector('[data-file-preview-pane]')
        return actual.origin === expected.origin && actual.pathname === expected.pathname
          && actual.hash === `#${gatedEmbedMode}`
          && html.dataset.businessEmbed === 'true' && html.dataset.businessIframe === 'true'
          && html.dataset.businessBrowserMode === gatedEmbedMode
          && intakeRoot?.hidden === true && fileBrowser?.hidden === false
          && fileBrowser.dataset.browserMode === gatedEmbedMode && deliverables?.hidden === true
          && fileList?.hidden === (gatedEmbedMode === 'preview')
          && filePreview?.hidden === (gatedEmbedMode === 'files')
      } catch { return false }
    }
    const retryEmbed = () => {
      if (disposed || !content.isConnected) return
      content.replaceChildren(frame)
      frame.style.visibility = 'hidden'
      frame.addEventListener('load', onLoad)
      frame.addEventListener('error', onError, { once: true })
      frame.src = `/business${path}`
    }
    const showEmbedError = () => {
      if (!frameIsCurrent()) return
      frame.removeEventListener('load', onLoad)
      frame.removeEventListener('error', onError)
      const note = stateNode(content, '业务页面未完成嵌入初始化。', 'error')
      const retry = retryButton(retryEmbed)
      retry.textContent = '重试页面'
      note.parentElement?.append(retry)
    }
    const onLoad = () => {
      if (!frameIsCurrent()) return
      if (!embedIsReady()) { showEmbedError(); return }
      sendThemeToBusinessFrame(frame)
      if (gatedEmbedMode) frame.style.visibility = 'visible'
    }
    const onError = () => showEmbedError()
    frame.addEventListener('load', onLoad)
    if (gatedEmbedMode) frame.addEventListener('error', onError, { once: true })
    frame.src = `/business${path}`
    content.replaceChildren(frame)
    return () => {
      disposed = true
      frame.removeEventListener('load', onLoad)
      frame.removeEventListener('error', onError)
      content.replaceChildren()
    }
  }

  function findRoleTarget(roleId, explicitPanelId) {
    if (!state.config || !state.config.roles.has(roleId) || typeof state.config.raw.sessionBindings[roleId] !== 'string'
      || !state.config.raw.sessionBindings[roleId]) return { error: 'unbound' }
    const currentScene = state.config.scenes.get(state.sceneId)
    if (!currentScene) return { error: 'scene-unavailable' }
    const candidates = currentScene.panels.filter(panel => panel.type === 'native-chat' && panel.optional !== true
      && (!explicitPanelId || panel.id === explicitPanelId)
      && (panel.roleId || currentScene.roleId) === roleId)
      .map(panel => ({ sceneId: currentScene.id, panelId: panel.id, roleId }))
    if (candidates.length === 1) return { target: candidates[0] }
    return { error: candidates.length > 1 ? 'ambiguous' : 'unbound' }
  }

  function isCurrentRole(record) {
    return !state.tearingDown && !record.disposed && record.revision === state.sceneRevision && state.sceneId === record.uiSceneId
      && record.content.isConnected && state.roleRecord === record
  }

  function panelExpansionCovers(expandedRect, panelRect) {
    return expandedRect.right > panelRect.left && expandedRect.left < panelRect.right
  }

  function panelExpansionBlocksNativePane(expandedPanels, panel, panelRect) {
    const panelIndex = expandedPanels.indexOf(panel)
    const blockers = panelIndex < 0 ? expandedPanels : expandedPanels.slice(0, panelIndex)
    return blockers.some(expanded => expanded.classList.contains('pi-maximized')
      || panelExpansionCovers(expanded.getBoundingClientRect(), panelRect))
  }

  function sceneHasDraggingPanel(panel) {
    const ownerGrid = panel?.closest?.('#grid') || byId('grid')
    return Boolean(ownerGrid?.querySelector?.('.panel.dragging'))
  }

  function nativePaneVisible(panel) {
    if (!panel?.isConnected || panel.hidden || panel.classList.contains('pi-tab-inactive') || getComputedStyle(panel).display === 'none') return false
    if (sceneHasDraggingPanel(panel)) return false
    // The native account sidebar is a topmost overlay. It covers the left
    // portion of the workspace; hiding an entire chat pane would also remove
    // its visible area to the right of the sidebar.
    if (state.globalPanelOpen) return false
    if (document.body.classList.contains('titlebar-overflow-open')) return false
    const mask = byId('modal-mask')
    if (mask && getComputedStyle(mask).display !== 'none' && !mask.hidden) return false
    if (document.querySelector('body > .theme-menu, body > .mobile-link-popover') || document.querySelector('.pi-menu')) return false
    const expandedPanels = [...document.querySelectorAll('#grid .panel-expanded, #grid .pi-maximized')]
      .filter(candidate => !candidate.hidden && getComputedStyle(candidate).display !== 'none')
      .sort((a, b) => {
        const aZ = Number.parseFloat(getComputedStyle(a).zIndex) || Number.parseFloat(a.style.zIndex) || 0
        const bZ = Number.parseFloat(getComputedStyle(b).zIndex) || Number.parseFloat(b.style.zIndex) || 0
        return bZ - aZ
      })
    const panelRect = panel.getBoundingClientRect()
    return !panelExpansionBlocksNativePane(expandedPanels, panel, panelRect)
  }

  function waitForRoleGeometryResponse(request, timeoutMs) {
    let timer
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer))
  }

  window.addEventListener('tl:panel-geometry-motion', event => {
    const record = state.roleRecord
    const detail = event.detail
    const api = app?.harnessSurface
    if (!record || detail?.panel !== record.panel || !api?.beginRoleGeometryMotion
      || record.uiSceneId !== 'agent-center' || record.target?.sceneId !== 'agent-center'
      || record.target?.panelId !== 'native-chat' || record.geometryMotion) return

    const current = () => isCurrentRole(record) && record.created && !state.sceneTransitionPending
      && !record.placementPending && record.placement === 'docked' && record.status === 'context-mounted'
    if (!current() || record.visible === false || !nativePaneVisible(record.panel)) return

    const { sceneId, panelId } = record.target
    const motion = {}
    detail.hold = record.geometryMotion = motion
    record.syncRevision++
    const startTimeoutMs = 48
    const deadline = Date.now() + startTimeoutMs
    const request = Promise.resolve(record.syncQueue).catch(() => {}).then(() => {
      if (Date.now() < deadline && current() && nativePaneVisible(record.panel)) {
        return api.beginRoleGeometryMotion(sceneId, panelId, deadline)
      }
    }).catch(() => undefined)
    motion.ready = waitForRoleGeometryResponse(request, startTimeoutMs).then(token => {
      if (token) return token
      if (record.geometryMotion === motion) {
        record.geometryMotion = undefined
        if (current()) void syncRole(record)
      }
      // The shell may already be moving when a delayed acknowledgement arrives.
      void request.then(async lateToken => {
        if (!lateToken) return
        await waitForRoleGeometryResponse(api.finishRoleGeometryMotion(sceneId, panelId, lateToken), 120)
        if (current()) void syncRole(record)
      }).catch(() => {})
    })
    let finished = false
    const fallback = setTimeout(() => { void motion.finish(false).catch(() => {}) }, 1000)
    motion.finish = async settled => {
      if (finished) return
      finished = true
      clearTimeout(fallback)
      let revealed = false
      try {
        const token = await motion.ready
        if (!token) return
        let bounds
        if (settled && current() && nativePaneVisible(record.panel)) {
          const { x, y, width, height } = record.content.getBoundingClientRect()
          if (width > 0 && height > 0) bounds = { x, y, width, height }
        }
        revealed = await waitForRoleGeometryResponse(
          api.finishRoleGeometryMotion(sceneId, panelId, token, bounds), 120,
        ) === true
      } finally {
        if (motion.visibilitySync) await waitForRoleGeometryResponse(motion.visibilitySync, 120)
        if (record.geometryMotion === motion) {
          record.geometryMotion = undefined
          if (current()) {
            // A shell overlay can open while Main is acknowledging the reveal.
            // Reuse any ordinary hide already queued for it.
            if (!revealed && record.visible !== false) record.visible = undefined
            if (revealed && record.visible === undefined && !motion.visibilitySync) record.visible = true
            if (!revealed || record.visible !== true || !nativePaneVisible(record.panel)) void syncRole(record)
          }
        }
      }
    }
  })

  async function syncRole(record, { reportError = true } = {}) {
    const motion = record.geometryMotion
    if (motion && nativePaneVisible(record.panel)) return
    if (state.sceneTransitionPending || !record.created || record.placementPending || record.placement === 'popped-out' || !record.target) return
    const revision = ++record.syncRevision
    const isCurrentDock = () => !state.sceneTransitionPending && isCurrentRole(record) && revision === record.syncRevision
      && !record.placementPending && record.placement !== 'popped-out'
    record.syncQueue = Promise.resolve(record.syncQueue).catch(() => {}).then(async () => {
      if (!isCurrentDock()) return
      const paneVisible = nativePaneVisible(record.panel)
      if (record.geometryMotion && paneVisible) return
      const rect = paneVisible ? record.content.getBoundingClientRect() : undefined
      const visible = rect && rect.width > 0 && rect.height > 0
      if (!visible) {
        if (record.visible !== false) {
          try {
            await app.harnessSurface.setVisible(record.target.sceneId, record.target.panelId, false)
            if (isCurrentDock()) record.visible = false
          } catch {
            if (reportError && isCurrentDock()) { record.note.textContent = '原生助手暂时不可用。'; record.note.dataset.state = 'error' }
          }
        }
        return
      }
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      try {
        // Invalidate the cached state before awaiting bounds/visibility IPC. An
        // overlay that opens while setVisible(true) is pending must enqueue false.
        record.visible = undefined
        const applied = await app.harnessSurface.setBounds(record.target.sceneId, record.target.panelId, bounds)
        if (!isCurrentDock() || record.status !== 'context-mounted') return
        if (applied?.alreadyVisible !== true) {
          await app.harnessSurface.setVisible(record.target.sceneId, record.target.panelId, true)
        }
        if (isCurrentDock()) record.visible = true
      } catch {
        if (reportError && isCurrentDock()) {
          record.note.textContent = '原生助手暂时不可用。'
          record.note.dataset.state = 'error'
        }
      }
    })
    if (motion) motion.visibilitySync = record.syncQueue
    return record.syncQueue
  }

  function onRoleStatus(value) {
    const record = state.roleRecord
    if (!record || !record.target || value?.sceneId !== record.target.sceneId || value?.panelId !== record.target.panelId) return
    record.status = value.status
    record.updateSkillsControl?.()
    if (typeof value.placement === 'string') record.placement = value.placement
    if (value.status === 'context-mounted') {
      record.note.textContent = '助手会话已挂载。'
      record.note.dataset.state = 'ready'
      void syncRole(record)
    } else if (value.status === 'unbound') {
      record.note.textContent = '此角色会话尚未绑定；未创建新会话。'
      record.note.dataset.state = 'error'
    } else if (value.status === 'owned-elsewhere') {
      record.note.textContent = record.placement === 'popped-out' ? '此助手已在独立窗口中打开。' : '此助手当前由其他窗口使用。'
      record.note.dataset.state = 'error'
    } else if (value.status === 'error' || value.status === 'unavailable') {
      record.note.textContent = '原生助手暂时不可用。'
      record.note.dataset.state = 'error'
    }
    updatePlacementButton(record)
  }

  function updatePlacementButton(record) {
    const button = record.placementButton
    if (!button) return
    const returning = record.placement === 'popped-out'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.8')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', returning ? 'M18 6 6 18M6 10v8h8' : 'M6 18 18 6M10 6h8v8')
    icon.append(path)
    button.replaceChildren(icon)
    button.title = record.placement === 'popped-out' ? '返回主工作台' : '在独立窗口打开助手'
    button.setAttribute('aria-label', button.title)
    button.hidden = !record.created || record.status === 'unbound' || record.status === 'owned-elsewhere'
  }

  async function requestPlacement(record, intent = 'toggle') {
    if (!isCurrentRole(record) || !record.target || !app.harnessSurface) return { ok: false, reason: 'unavailable' }
    if (record.placementPending) return { ok: false, reason: 'pending' }
    if (intent !== 'toggle' && intent !== 'open') return { ok: false, reason: 'unsupported' }
    record.placementPending = true
    record.syncRevision++
    let resyncOptions
    const button = record.placementButton
    if (button) button.disabled = true
    try {
      const shouldOpen = intent === 'open' || record.placement !== 'popped-out'
      const result = shouldOpen
        ? await app.harnessSurface.popOut(record.target.sceneId, record.target.panelId)
        : await app.harnessSurface.returnToDock(record.target.sceneId, record.target.panelId)
      if (!isCurrentRole(record)) return { ok: false, reason: 'stale' }
      if (result?.placement) record.placement = result.placement
      if (result?.status) record.status = result.status
      if (record.placement === 'popped-out') {
        record.note.textContent = '助手已在独立窗口中打开。'
        record.note.dataset.state = 'ready'
      } else resyncOptions = { reportError: true }
      updatePlacementButton(record)
      return { ok: true, placement: record.placement }
    } catch {
      if (isCurrentRole(record)) {
        if (record.status === 'context-mounted' && record.placement !== 'popped-out') {
          resyncOptions = { reportError: false }
        }
        record.note.textContent = '独立窗口操作暂不可用。'
        record.note.dataset.state = 'error'
      }
      return { ok: false, reason: 'unavailable' }
    } finally {
      record.placementPending = false
      if (resyncOptions) void syncRole(record, resyncOptions)
      if (button?.isConnected) button.disabled = false
    }
  }

  function requestRolePlacement(panel, intent = 'toggle') {
    const record = state.roleRecord
    if (!record || record.panel !== panel || !record.target || !record.created || !isCurrentRole(record)) {
      return Promise.resolve({ ok: false, reason: 'unsupported' })
    }
    return requestPlacement(record, intent)
  }

  function openSceneRotation(panel) {
    const record = state.roleRecord
    const target = record?.target
    const roleId = target?.roleId
    const sessionId = roleId ? state.config?.raw?.sessionBindings?.[roleId] : undefined
    if (!record || record.panel !== panel || !record.created || !target || !sessionId || !isCurrentRole(record)
      || typeof app?.sceneRotation?.preview !== 'function') return undefined
    const captured = Object.freeze({ sceneId: target.sceneId, panelId: target.panelId, roleId, sessionId,
      uiSceneId: record.uiSceneId, revision: record.revision })
    const samePanelOwner = () => isCurrentRole(record) && record.panel === panel
      && record.target?.sceneId === captured.sceneId && record.target?.panelId === captured.panelId
      && record.target?.roleId === captured.roleId
    const sameCapturedBinding = () => samePanelOwner()
      && state.config?.raw?.sessionBindings?.[captured.roleId] === captured.sessionId
    const invoke = async (operation, body = {}) => {
      const api = app?.sceneRotation
      if (!['preview', 'confirm', 'status', 'resume', 'cancel', 'abandon'].includes(operation)
        || typeof api?.[operation] !== 'function') throw new Error('scene rotation unavailable')
      if (operation === 'preview' && !sameCapturedBinding()) throw new Error('scene rotation target changed')
      let request
      if (operation === 'preview') request = {
        sceneId: captured.sceneId, panelId: captured.panelId, archiveOld: body.archiveOld === true,
      }
      else if (operation === 'confirm' || operation === 'cancel') {
        if (typeof body.previewToken !== 'string') throw new Error('scene rotation preview unavailable')
        request = { previewToken: body.previewToken }
      } else {
        if (typeof body.operationId !== 'string') throw new Error('scene rotation operation unavailable')
        request = { operationId: body.operationId }
      }
      const result = await api[operation](request)
      if (operation === 'preview') return { ...result, staleTarget: !sameCapturedBinding() }
      if ((operation === 'confirm' || operation === 'resume') && result?.sessionId
        && ['bound', 'completed', 'archive_pending'].includes(result.status)) {
        const fresh = validateConfig(await app.sourceConfig())
        if (fresh.raw.sessionBindings?.[captured.roleId] !== result.sessionId) {
          throw new Error('scene rotation binding changed before renderer refresh')
        }
        state.config = fresh
        if (samePanelOwner() && typeof app.harnessSurface?.status === 'function') {
          const attached = await app.harnessSurface.status(captured.sceneId, captured.panelId)
          if (samePanelOwner() && attached?.status) onRoleStatus({ ...attached, sceneId: captured.sceneId, panelId: captured.panelId })
        }
      }
      return result
    }
    return Object.freeze({ target: captured, preview: body => invoke('preview', body), confirm: body => invoke('confirm', body),
      status: body => invoke('status', body), resume: body => invoke('resume', body), cancel: body => invoke('cancel', body),
      abandon: body => invoke('abandon', body) })
  }

  function panelMenuCapabilities(panel) {
    const role = state.roleRecord
    const roleReady = !!(role && role.panel === panel && role.created && role.target && isCurrentRole(role))
    const workflow = state.workflowRecord
    const workflowReady = !!(workflow && workflow.panel === panel && workflow.active && state.workflowMounted
      && workflow.host.isConnected && workflow.status === 'context-mounted' && !state.sceneTransitionPending
      && typeof app?.workflowCanvas?.popOut === 'function' && typeof app?.workflowCanvas?.returnToDock === 'function')
    return { independent: roleReady || workflowReady, nativeConversation: roleReady,
      placement: roleReady ? role.placement : workflowReady ? workflow.placement : undefined }
  }

  async function requestNativeUtility(panel, action) {
    const record = state.roleRecord, target = record?.target
    if (!['scene-memory','session-speech','session-skills'].includes(action) || !panelMenuCapabilities(panel).nativeConversation
      || !record || record.panel !== panel || !target || typeof app?.nativeUtility !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      const result = await app.nativeUtility({ sceneId: target.sceneId, panelId: target.panelId, action })
      if (!isCurrentRole(record) || record.panel !== panel || record.target !== target || result?.delivered !== true) return { ok: false, reason: 'unavailable' }
      return { ok: true }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function requestPanelPlacement(panel, intent = 'toggle') {
    if (panelMenuCapabilities(panel).nativeConversation) return requestRolePlacement(panel, intent)
    const record = state.workflowRecord
    if (!panelMenuCapabilities(panel).independent || !record || record.panel !== panel || intent !== 'toggle') return { ok: false, reason: 'unsupported' }
    if (record.placementPending) return { ok: false, reason: 'pending' }
    record.placementPending = true
    try {
      const api = app.workflowCanvas
      const before = await api.status()
      if (record !== state.workflowRecord || state.sceneTransitionPending || before?.componentKey !== 'workflow-canvas-native'
        || before.status !== 'context-mounted') return { ok: false, reason: 'unavailable' }
      const result = before.placement === 'popped-out' ? await api.returnToDock() : await api.popOut()
      if (record !== state.workflowRecord || state.sceneTransitionPending || !record.host.isConnected
        || result?.componentKey !== 'workflow-canvas-native' || result.status !== 'context-mounted'
        || !['docked', 'popped-out'].includes(result.placement)) return { ok: false, reason: 'unavailable' }
      record.placement = result.placement
      if (record.placement === 'docked') await syncWorkflow(record)
      return { ok: true, placement: record.placement }
    } catch { return { ok: false, reason: 'unavailable' } }
    finally { record.placementPending = false }
  }

  function insertRoleControl(panel, button) {
    const controls = panel?.querySelector(':scope > .panel-header > .panel-controls')
    if (!controls) return
    const fullscreen = controls.querySelector(':scope > .pi-fullscreen')
    controls.insertBefore(button, fullscreen)
  }

  function installRoleSkillsControl(record) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'icon-control business-native-skills'
    button.title = 'DSH Skills（当前会话）'
    button.setAttribute('aria-label', 'DSH Skills（当前会话）')
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.7')
    icon.setAttribute('aria-hidden', 'true')
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    shape.setAttribute('d', 'M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5')
    icon.append(shape)
    button.append(icon)
    record.updateSkillsControl = () => { button.disabled = !panelMenuCapabilities(record.panel).nativeConversation }
    record.updateSkillsControl()
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation()
      if (!isCurrentRole(record) || record.disposed) return
      await requestNativeUtility(record.panel, 'session-skills')
    })
    insertRoleControl(record.panel, button)
    record.skillsButton = button
    return button
  }

  function renderRolePanel(meta, content) {
    if (state.phase === 'idle') void start()
    const note = document.createElement('div')
    note.className = 'business-runtime-state'
    note.dataset.state = state.phase === 'unavailable' ? 'unavailable' : 'loading'
    note.textContent = state.phase === 'unavailable' ? state.error
      : state.phase === 'error' ? state.error : '正在读取角色绑定…'
    content.replaceChildren(note)
    const panel = content.closest('.panel')
    const record = {
      uiSceneId: meta?.sceneId || state.sceneId, panel, content, note,
      revision: state.sceneRevision, status: 'loading', created: false, visible: false,
      placement: 'docked', placementPending: false, disposed: false, syncRevision: 0, syncQueue: Promise.resolve(),
    }
    const placementButton = document.createElement('button')
    placementButton.className = 'icon-control business-native-placement'
    placementButton.type = 'button'
    placementButton.hidden = true
    placementButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void requestPlacement(record) })
    insertRoleControl(panel, placementButton)
    record.placementButton = placementButton
    const previous = state.roleRecord
    state.roleRecord = record
    installRoleSkillsControl(record)
    if (previous && previous !== record && previous.created && previous.target && previous.placement !== 'popped-out') {
      state.roleQueue = Promise.resolve(state.roleQueue).catch(() => {}).then(async () => {
        previous.disposed = true
        previous.syncRevision++
        try { await app.harnessSurface.setVisible(previous.target.sceneId, previous.target.panelId, false) } catch { /* Preserve existing view; the next owner reports its own state. */ }
        previous.visible = false
      })
    }
    const activate = async () => {
      if (!isCurrentRole(record)) return
      if (state.phase === 'loading') await state.configPromise
      if (!isCurrentRole(record)) return
      if (state.phase !== 'ready') {
        note.textContent = state.error || '业务配置不可用。'
        note.dataset.state = state.phase === 'unavailable' ? 'unavailable' : 'error'
        return
      }
      const roleId = meta.roleId ?? state.config?.scenes.get(record.uiSceneId)?.roleId ?? roleByUiScene[record.uiSceneId]
      const resolved = findRoleTarget(roleId, meta.hostPanelId)
      const target = resolved.target
      if (!target) {
        note.textContent = resolved.error === 'ambiguous'
          ? '当前业务场景存在多个可用主助手面板；未选择或创建会话。'
          : resolved.error === 'scene-unavailable'
            ? '当前界面没有匹配的业务场景配置；未创建新会话。'
            : '当前业务场景没有已绑定的主助手面板；未创建新会话。'
        note.dataset.state = 'error'
        return
      }
      record.target = target
      const result = await app.harnessSurface.create(target.sceneId, target.panelId)
      if (!isCurrentRole(record)) {
        const active = state.roleRecord
        const activeHasTarget = !state.tearingDown && active && !active.disposed
          && active.target?.sceneId === target.sceneId && active.target?.panelId === target.panelId
        if (!activeHasTarget && result?.status !== 'owned-elsewhere' && result?.placement !== 'popped-out') {
          await app.harnessSurface.setVisible(target.sceneId, target.panelId, false).catch(() => {})
        }
        return
      }
      record.created = result?.status !== 'owned-elsewhere' && typeof result?.status === 'string'
      record.status = result?.status || 'unavailable'
      record.updateSkillsControl?.()
      if (result?.placement) record.placement = result.placement
      onRoleStatus({ ...result, sceneId: target.sceneId, panelId: target.panelId })
      if (!record.created) return
      if (typeof app.harnessSurface.status === 'function') {
        const status = await app.harnessSurface.status(target.sceneId, target.panelId).catch(() => undefined)
        if (isCurrentRole(record) && status?.status) onRoleStatus({ ...status, sceneId: target.sceneId, panelId: target.panelId })
      }
      if (isCurrentRole(record) && record.status === 'context-mounted') await syncRole(record)
    }
    state.roleQueue = Promise.resolve(state.roleQueue).catch(() => {}).then(activate).catch(() => {
      if (isCurrentRole(record)) { record.status = 'error'; note.textContent = '原生助手暂时不可用。'; note.dataset.state = 'error' }
    })
    if (!state.roleObserver && typeof ResizeObserver === 'function') {
      state.roleObserver = new ResizeObserver(() => { const active = state.roleRecord; if (active && !active.geometryMotion) void syncRole(active) })
      const grid = document.getElementById('grid')
      if (grid) state.roleObserver.observe(grid)
    }
    if (state.roleObserver) state.roleObserver.observe(content)
    return () => {
      record.disposed = true
      record.syncRevision++
      state.roleObserver?.unobserve?.(content)
      record.placementButton?.remove()
      record.skillsButton?.remove()
      record.updateSkillsControl = undefined
      if (state.roleRecord === record) state.roleRecord = undefined
      if (record.created && record.target && record.placement !== 'popped-out') {
        state.roleQueue = Promise.resolve(state.roleQueue).catch(() => {}).then(async () => {
          try { await app.harnessSurface.setVisible(record.target.sceneId, record.target.panelId, false) } catch { /* no new owner is inferred */ }
          record.visible = false
        })
      }
      content.replaceChildren()
    }
  }

  function onWorkflowStatus(value) {
    const record = state.workflowRecord
    if (!record?.target || value?.componentKey !== 'workflow-canvas-native'
      || value.sceneId !== record.target.sceneId || value.panelId !== record.target.panelId) return
    const placement = typeof value.placement === 'string' ? value.placement : record.placement
    // Visibility setters echo the current status. Only a status or placement
    // transition can require another visibility synchronization.
    if (record.status === value.status && record.placement === placement) return
    record.status = value.status
    record.placement = placement
    if (record.note && value.status === 'context-mounted') {
      record.note.hidden = true
      void syncWorkflow(record)
    } else if (record.note && ['error', 'unavailable'].includes(value.status)) {
      record.note.hidden = false
      record.note.textContent = '原生工作流画布暂时不可用。'
      record.note.dataset.state = 'error'
      void syncWorkflow(record)
    }
  }

  async function syncWorkflow(record) {
    if (state.sceneTransitionPending || state.tearingDown || !record || record !== state.workflowRecord || !record.host.isConnected || record.placement === 'popped-out') return
    const bridge = app?.workflowCanvas
    if (!bridge || typeof bridge.setBounds !== 'function' || typeof bridge.setVisible !== 'function') return
    const rect = record.host.getBoundingClientRect()
    const visible = record.status === 'context-mounted'
      && state.sceneId === record.uiSceneId && record.active && nativePaneVisible(record.panel)
      && (record.uiSceneId === 'agent-center' || Boolean(workflowTemplateRoute(record.uiSceneId)))
      && rect.width > 0 && rect.height > 0
    const revision = ++record.revision
    record.queue = Promise.resolve(record.queue).catch(() => {}).then(async () => {
      if (record !== state.workflowRecord || revision !== record.revision) return
      if (!visible) {
        if (record.visible !== false) {
          try { await bridge.setVisible(false); record.visible = false } catch { record.visible = undefined }
        }
        return
      }
      try {
        record.visible = undefined
        await bridge.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        if (state.sceneTransitionPending || state.tearingDown || state.sceneId !== record.uiSceneId
          || record !== state.workflowRecord || revision !== record.revision) return
        await bridge.setVisible(true)
        record.visible = true
      } catch {
        if (record === state.workflowRecord && record.note) {
          record.note.hidden = false
          record.note.textContent = '原生工作流画布暂时不可用。'
          record.note.dataset.state = 'error'
        }
      }
    })
    return record.queue
  }

  function renderWorkflowPanel(meta, content) {
    if (state.phase === 'idle') void start()
    const tabs = document.createElement('div')
    tabs.className = 'file-tabs'
    tabs.setAttribute('role', 'group')
    tabs.setAttribute('aria-label', '工作流视图')
    const planButton = document.createElement('button')
    const canvasButton = document.createElement('button')
    for (const [button, label] of [[planButton, '业务计划'], [canvasButton, '工作流画布']]) {
      button.type = 'button'; button.className = 'chip chip-tab'; button.textContent = label; button.dataset.tabLabel = label
      tabs.append(button)
    }
    const plan = document.createElement('div')
    plan.className = 'business-plan-route'
    plan.style.cssText = 'display:flex;flex:1;min-height:0;min-width:0;'
    const host = document.createElement('div')
    host.className = 'business-workflow-host'
    host.dataset.workflowCanvasHost = 'true'
    host.style.display = 'none'
    const note = document.createElement('div')
    note.className = 'business-runtime-state'
    note.dataset.state = 'loading'
    note.textContent = '正在连接工作流画布…'
    host.append(note)
    const independent = meta.standaloneCanvas === true
    if (independent) content.replaceChildren(host)
    else content.replaceChildren(tabs, plan, host)

    let planCleanup = independent ? undefined : renderBusinessPanel(meta, plan, '/agent-center')
    const uiSceneId = meta.sceneId ?? state.sceneId
    const record = { uiSceneId, panel: content.closest('.panel'), host, note, hostObserver: undefined, active: false, visible: false, placement: 'docked', status: 'loading', revision: 0, queue: Promise.resolve() }
    state.workflowRecord = record
    let observer
    const choose = async label => {
      const canvas = label === '工作流画布'
      record.active = canvas
      plan.style.display = canvas ? 'none' : 'flex'
      host.style.display = canvas ? 'flex' : 'none'
      for (const button of [planButton, canvasButton]) {
        const selected = button.dataset.tabLabel === label
        button.classList.toggle('on', selected)
        button.setAttribute('aria-pressed', String(selected))
      }
      const title = content.closest('.panel')?.querySelector('.panel-title')
      if (title) title.textContent = canvas ? '工作流' : '工作流 · 业务计划'
      if (canvas) {
        if (state.phase === 'loading') await state.configPromise
        if (state.phase !== 'ready') {
          note.hidden = false; note.textContent = state.error || '业务配置不可用。'; note.dataset.state = state.phase === 'unavailable' ? 'unavailable' : 'error'
          return
        }
        if (record !== state.workflowRecord || state.sceneId !== uiSceneId) return
        const inherited = meta.id === 'workflow-main' && meta.type === 'canvas' && meta.hostPanelId === 'business-main'
          && meta.path === '/agent-center' && meta.componentId === undefined
        const route = uiSceneId === 'agent-center' ? routeForPath('/agent-center') : inherited && workflowTemplateRoute(uiSceneId)
        if (!route) {
          note.hidden = false; note.textContent = state.error || '工作流路由未配置。'; note.dataset.state = 'error'
          await syncWorkflow(record)
          return
        }
        record.target = route.route
        if (!state.workflowMounted) {
          state.workflowMounted = true
          const bridge = app?.workflowCanvas
          if (typeof bridge?.mount !== 'function') {
            state.workflowMounted = false
            note.hidden = false; note.textContent = '原生工作流画布入口不可用。'; note.dataset.state = 'error'
          } else {
            try {
              const result = await bridge.mount()
              if (result?.componentKey !== 'workflow-canvas-native'
                || result.sceneId !== route.route.sceneId || result.panelId !== route.route.panelId) throw new Error('workflow target mismatch')
              if (record.status === 'loading' || (record.status === 'document-loaded' && result.status === 'context-mounted')) record.status = result.status
              if (typeof result.placement === 'string') record.placement = result.placement
              if (record !== state.workflowRecord) return
              if (state.tearingDown && record.placement !== 'popped-out') {
                await bridge.setVisible(false).catch(() => {})
                record.visible = false
                return
              }
              if (record.status === 'context-mounted') note.hidden = true
              else if (['loading', 'document-loaded'].includes(record.status)) {
                note.hidden = false; note.textContent = '正在加载原生工作流画布…'
              }
            } catch {
              state.workflowMounted = false
              note.hidden = false; note.textContent = '原生工作流画布暂时不可用。'; note.dataset.state = 'error'
            }
          }
        } else if (record.status === 'loading') {
          try {
            const result = await app.workflowCanvas.status()
            if (record !== state.workflowRecord || !record.active) return
            if (result?.status === 'unavailable') {
              state.workflowMounted = false
              return choose(label)
            }
            if (record.status === 'loading') onWorkflowStatus(result)
          } catch {
            if (record !== state.workflowRecord || !record.active) return
            note.hidden = false; note.textContent = '原生工作流画布暂时不可用。'; note.dataset.state = 'error'
          }
        }
        if (!observer && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(() => { void syncWorkflow(record) })
          observer.observe(host)
          record.hostObserver = observer
        }
        void syncWorkflow(record)
      } else {
        if (observer) { observer.disconnect(); observer = undefined; record.hostObserver = undefined }
        void syncWorkflow(record)
      }
    }
    planButton.addEventListener('click', () => { void choose('业务计划') })
    canvasButton.addEventListener('click', () => { void choose('工作流画布') })
    const initial = !independent && meta.activeTab === '业务计划' ? '业务计划' : '工作流画布'
    void choose(initial)
    return () => {
      const title = content.closest('.panel')?.querySelector('.panel-title')
      if (title) title.textContent = meta.title
      if (observer) { observer.disconnect(); record.hostObserver = undefined }
      if (state.workflowRecord === record) state.workflowRecord = undefined
      record.active = false
      record.revision++
      if (record.placement !== 'popped-out' && record.visible !== false) void app?.workflowCanvas?.setVisible(false).then(() => { record.visible = false }).catch(() => { record.visible = undefined })
      planCleanup?.()
      planCleanup = undefined
      content.replaceChildren()
    }
  }

  function findCompanionPath(meta, view) {
    if (state.phase !== 'ready' || !['files', 'preview'].includes(view)) return undefined
    const companionPath = `/artifacts#${view}`
    if (!allowedRoutes.has('/artifacts') || !routeForPath(companionPath)) return undefined
    if (meta?.componentId) {
      const scene = state.config.scenes.get(meta.sceneId)
      const owner = scene?.panelMap.get(meta.hostPanelId)
      return owner?.componentId === meta.componentId && owner.type === 'business-iframe' && owner.path === companionPath
        ? { path: owner.path, panelId: owner.id, sceneId: scene.id } : undefined
    }
    const routePath = pathForScene(meta?.sceneId)
    if (!routePath || routePath === '/agent-center') {
      const inherited = meta?.id === view && meta.type === view && meta.hostPanelId === view && meta.path === companionPath
        && workflowTemplateRoute(meta.sceneId)
      if (inherited) return { path: companionPath, panelId: view, sceneId: meta.sceneId, workflowDirectory: true }
    }
    const target = routeForPath(routePath)
    if (!target) return undefined
    const panel = target.scene.panels.find(item => item.id === view && item.type === 'business-iframe'
      && item.path === companionPath)
    return panel ? { path: panel.path, panelId: panel.id, sceneId: target.scene.id } : undefined
  }

  function ensureFileBridge() {
    if (window.TradeLoomBusinessFileBridge?.create) return Promise.resolve(window.TradeLoomBusinessFileBridge)
    if (state.fileBridgePromise) return state.fileBridgePromise
    state.fileBridgePromise = new Promise(resolve => {
      const script = document.createElement('script')
      script.src = new URL('business-file-bridge.js', bridgeScriptUrl || location.href).href
      script.onload = () => resolve(window.TradeLoomBusinessFileBridge)
      script.onerror = () => resolve(undefined)
      document.head.append(script)
    })
    return state.fileBridgePromise
  }

  function releaseFileCompanion(uiSceneId, mounted, content) {
    mounted.refs = Math.max(0, mounted.refs - 1)
    if (mounted.refs === 0) {
      window.removeEventListener('message', mounted.handler)
      mounted.handler.dispose?.()
      fileBridgeMounts.delete(uiSceneId)
    }
    delete content.dataset.fileBridgeView
    delete content.dataset.fileBridgeReady
    delete content.__businessFileExport
    delete content.__businessFileFocus
    content.replaceChildren()
  }

  function mountWorkflowFiles(workflow, content, view, business, isCurrent = () => true) {
    const files = view === 'files'
    const area = document.createElement('section')
    area.className = 'tl-workflow-directory'
    area.dataset.directoryView = files ? 'files' : 'preview'
    const header = document.createElement('div')
    header.className = 'tl-workflow-directory-bar'
    const body = document.createElement('div')
    body.className = 'tl-workflow-directory-body'
    const status = document.createElement('p')
    status.className = 'tl-workflow-directory-status'
    status.setAttribute('role', 'status')
    area.append(header, status, body)
    content.prepend(area)
    content.classList.add('tl-workflow-directory-host')

    const button = (label, onClick, disabled = false) => {
      const node = document.createElement('button')
      node.type = 'button'
      node.textContent = label
      node.disabled = disabled
      node.addEventListener('click', onClick)
      return node
    }
    const download = ({ name, data }) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))]))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }
    const filePath = (directory, name) => {
      const separator = /\\/.test(directory.path) ? '\\' : '/'
      return directory.path.replace(/[\\/]+$/, '') + separator + name
    }
    const copySelectedPath = async () => {
      try {
        if (!window.navigator?.clipboard?.writeText || !workflow.directory || !workflow.selected) throw new Error('clipboard unavailable')
        await window.navigator.clipboard.writeText(filePath(workflow.directory, workflow.selected.name))
        workflow.error = '已复制文件路径。'
      } catch { workflow.error = '无法复制文件路径。' }
      refresh()
    }
    const refresh = () => { for (const render of workflow.panes) render() }
    async function request(operation, id) {
      if (!isCurrent()) return
      if (workflow.busy) {
        if (operation === 'current') workflow.dirty = true
        return
      }
      workflow.error = ''
      workflow.busy = true
      refresh()
      try {
        const value = await app.workflowFiles(id ? { operation, id } : { operation })
        if (!isCurrent() || !workflow.panes.size || (operation === 'pick' && value === null)) return
        if (operation === 'download') download(value)
        else if (operation === 'preview') workflow.selected = { ...value, id }
        else if (operation === 'open') workflow.error = '已请求系统打开所选文件。'
        else if (operation === 'reveal') workflow.error = '已在文件夹中定位所选文件。'
        else {
          workflow.directory = value
          if (!value?.entries.some(item => item.id === workflow.selected?.id)) workflow.selected = null
        }
      } catch {
        if (!isCurrent()) return
        if (operation === 'current') {
          if (!workflow.directory) return
          workflow.directory = null
          workflow.selected = null
        }
        workflow.error = '无法访问所选目录或文件。请重新打开目录。'
        if (operation !== 'pick' && operation !== 'current') {
          try {
            const directory = await app.workflowFiles({ operation: 'current' })
            if (isCurrent()) {
              workflow.directory = directory
              workflow.selected = null
            }
          } catch { /* Retain the visible directory while a retry is possible. */ }
        }
      } finally {
        workflow.busy = false
        if (isCurrent()) {
          refresh()
          if (workflow.dirty && workflow.panes.size) {
            workflow.dirty = false
            void request('current')
          }
        }
      }
    }
    const render = () => {
      const directory = workflow.directory
      const showLocal = Boolean(directory)
      const selected = workflow.selected
      business.hidden = showLocal
      area.hidden = !files && !showLocal
      body.hidden = !showLocal
      status.textContent = workflow.error || (workflow.busy ? '正在读取…' : '')
      status.hidden = !status.textContent
      header.replaceChildren()
      body.replaceChildren()

      const title = document.createElement('span')
      title.className = 'tl-workflow-directory-path'
      title.textContent = (showLocal && !files && selected?.name) || directory?.path || '尚未打开本地目录'
      title.title = title.textContent
      header.append(title)
      const actions = document.createElement('div')
      actions.className = 'tl-workflow-directory-actions'
      if (files) {
        actions.append(button('打开', () => void request('pick'), workflow.busy))
        actions.append(button('上一级', () => void request('up'), workflow.busy || !showLocal || !directory.canGoUp))
        if (directory) actions.append(button('重读', () => void request('current'), workflow.busy))
        if (directory) actions.append(button('关闭目录', () => void request('revoke'), workflow.busy))
      } else if (selected) {
        actions.append(button('重读', () => void request('preview', selected.id), workflow.busy))
        actions.append(button('复制路径', () => void copySelectedPath(), workflow.busy))
        actions.append(button('系统打开', () => void request('open', selected.id), workflow.busy))
        actions.append(button('在文件夹中显示', () => void request('reveal', selected.id), workflow.busy))
        actions.append(button('关闭预览', () => { workflow.selected = null; refresh() }, workflow.busy))
        actions.append(button('下载', () => void request('download', selected.id), workflow.busy))
      }
      if (actions.childElementCount) header.append(actions)
      if (!showLocal) return
      if (!files && selected) {
        if (selected.preview?.type === 'text/plain') {
          const text = document.createElement('pre')
          text.textContent = selected.preview.data
          body.append(text)
        } else if (['image/png', 'image/jpeg'].includes(selected.preview?.type)) {
          const img = document.createElement('img')
          img.alt = selected.name
          img.src = 'data:' + selected.preview.type + ';base64,' + selected.preview.data
          body.append(img)
        } else body.textContent = '此文件暂无可用预览。'
        return
      }
      if (!directory.entries.length) body.textContent = '此目录没有可浏览的条目。'
      else {
        const entries = files ? body : document.createElement('div')
        if (!files) {
          entries.className = 'tl-workflow-directory-cards'
          body.append(entries)
        }
        for (const item of directory.entries) {
          const folder = item.kind === 'folder'
          const entry = button(item.name, () => void request(folder ? 'enter' : 'preview', item.id), workflow.busy)
          entry.className = files ? 'tl-workflow-directory-row' : 'tl-workflow-directory-card'
          entry.setAttribute('aria-current', String(item.id === selected?.id))
          const icon = document.createElement('span')
          icon.setAttribute('aria-hidden', 'true')
          icon.textContent = folder ? '📁' : '📄'
          const name = document.createElement('span')
          name.className = 'tl-workflow-directory-name'
          name.textContent = item.name
          entry.title = item.name
          entry.replaceChildren(icon, name)
          if (!files) {
            const kind = document.createElement('span')
            kind.className = 'tl-workflow-directory-kind'
            kind.textContent = folder ? '文件夹' : '文件'
            entry.append(kind)
            if (!folder) {
              const size = document.createElement('span')
              size.className = 'tl-workflow-directory-size'
              size.textContent = Number.isFinite(item.size) ? `${item.size.toLocaleString()} B` : ''
              entry.append(size)
              const modified = document.createElement('time')
              modified.className = 'tl-workflow-directory-modified'
              if (Number.isFinite(item.modifiedAt)) {
                modified.dateTime = new Date(item.modifiedAt).toISOString()
                modified.textContent = new Date(item.modifiedAt).toLocaleString()
              }
              entry.append(modified)
            }
          }
          entries.append(entry)
        }
      }
      if (directory.truncated) {
        const note = document.createElement('p')
        note.textContent = '仅显示本目录的部分条目。'
        body.append(note)
      }
    }
    const firstPane = workflow.panes.size === 0
    workflow.panes.add(render)
    render()
    if (firstPane) {
      workflow.onFocus = () => { void request('current') }
      window.addEventListener('focus', workflow.onFocus)
      workflow.offChanged = app.onWorkflowFilesChanged?.(workflow.onFocus)
      void request('current')
    }
    return () => {
      workflow.panes.delete(render)
      if (!workflow.panes.size) {
        window.removeEventListener('focus', workflow.onFocus)
        workflow.offChanged?.()
      }
      content.classList.remove('tl-workflow-directory-host')
    }
  }

  function mountFileCompanion(meta, content, target, view) {
    const uiSceneId = meta.sceneId || state.sceneId
    let mounted = fileBridgeMounts.get(uiSceneId)
    if (!mounted) {
      const scene = [...state.config.scenes.values()].find(item => item.id === target.sceneId)
      if (!scene) {
        stateNode(content, '文件场景未包含在当前配置中。', 'error')
        return () => content.replaceChildren()
      }
      const handler = window.TradeLoomBusinessFileBridge.create({
        scene,
        origin: location.protocol === 'dsh-app:' && location.host === 'app' ? 'dsh-app://app' : location.origin,
        getFrames: () => [...document.querySelectorAll('#grid iframe[data-tradeloom-panel-id]')]
          .filter(frame => frame.dataset.tradeloomBusinessSceneId === target.sceneId),
        getBusinessPath: () => pathForScene(state.sceneId) || '',
        onSelection: selection => send('business-file-selection', { sceneId: uiSceneId, selection }),
      })
      mounted = { handler, refs: 0 }
      fileBridgeMounts.set(uiSceneId, mounted)
      window.addEventListener('message', handler)
    }
    mounted.refs++
    const panel = content.closest('.panel')
    if (panel) panel.dataset.businessRoute = (pathForScene(uiSceneId) || '/').slice(1)
    const directory = target.workflowDirectory === true || (uiSceneId === 'agent-center' && target.sceneId === 'agent-center')
    const local = directory && state.sceneId === uiSceneId && typeof app?.workflowFiles === 'function'
    const business = local ? document.createElement('div') : content
    if (local) {
      business.className = 'tl-workflow-directory-business'
      content.replaceChildren(business)
    }
    const cleanupFrame = renderBusinessPanel(meta, business, target.path, { sceneId: target.sceneId, panelId: target.panelId })
    const frame = business.querySelector('iframe')
    if (frame) {
      frame.dataset.tradeloomPanelId = target.panelId
      frame.dataset.tradeloomBusinessSceneId = target.sceneId
      frame.dataset.tradeloomBusinessPath = target.path
      frame.classList.add('business-route-frame')
    }
    content.dataset.fileBridgeView = view
    content.dataset.fileBridgeReady = 'true'
    content.__businessFileExport = mounted.handler.requestFileExport
    content.__businessFileFocus = mounted.handler.requestFileFocus
    if (local && !mounted.workflow) mounted.workflow = { panes: new Set() }
    const sceneRevision = state.sceneRevision
    const cleanupWorkflow = local ? mountWorkflowFiles(mounted.workflow, content, view, business,
      () => state.sceneId === uiSceneId && state.sceneRevision === sceneRevision
        && !state.sceneTransitionPending && !state.tearingDown
        && (!target.workflowDirectory || Boolean(workflowTemplateRoute(uiSceneId)))) : undefined
    return () => { cleanupWorkflow?.(); cleanupFrame?.(); releaseFileCompanion(uiSceneId, mounted, content) }
  }

  function renderCompanion(meta, content, view) {
    if (state.phase === 'idle') void start()
    if (state.phase === 'loading') {
      const onReady = () => { window.removeEventListener('business-config-ready', onReady); if (content.isConnected) renderCompanion(meta, content, view) }
      window.addEventListener('business-config-ready', onReady)
      stateNode(content, '正在读取文件路由…')
      return () => { window.removeEventListener('business-config-ready', onReady); content.replaceChildren() }
    }
    if (state.phase === 'unavailable') {
      stateNode(content, state.error || '浏览器预览未连接桌面宿主。', 'unavailable')
      return () => content.replaceChildren()
    }
    if (state.phase === 'error') {
      stateNode(content, state.error || '业务配置不可用。', 'error', () => {
        state.phase = 'loading'; state.error = ''; state.configPromise = undefined
        stateNode(content, '正在重试读取业务配置…')
        void start().then(() => { if (content.isConnected) renderCompanion(meta, content, view) })
      })
      return () => content.replaceChildren()
    }
    const target = findCompanionPath(meta, view)
    if (!target) {
      stateNode(content, view === 'files' ? '文件服务尚未映射到当前桌面配置。' : '预览服务尚未映射到当前桌面配置。', 'error')
      return () => content.replaceChildren()
    }
    if (window.TradeLoomBusinessFileBridge?.create) {
      return mountFileCompanion(meta, content, target, view)
    }
    const onReady = () => { window.removeEventListener('business-file-bridge-ready', onReady); if (content.isConnected) renderCompanion(meta, content, view) }
    window.addEventListener('business-file-bridge-ready', onReady)
    stateNode(content, view === 'files' ? '文件消息接线正在初始化…' : '预览消息接线正在初始化…')
    void ensureFileBridge().then(helper => {
      if (!helper?.create) {
        window.removeEventListener('business-file-bridge-ready', onReady)
        if (content.isConnected) stateNode(content, '文件消息接线不可用。', 'error')
        return
      }
      send('business-file-bridge-ready')
    })
    return () => { window.removeEventListener('business-file-bridge-ready', onReady); content.replaceChildren() }
  }

  function onSceneChanged(scene) {
    const next = typeof scene === 'string' ? scene : scene?.id
    if (!next) return
    // A scene can be reselected while a hide barrier is pending. That still
    // completes the barrier even though the scene generation stays unchanged.
    state.sceneTransitionPending = false
    if (next === state.sceneId) return
    state.sceneId = next
    state.sceneRevision++
    const record = state.roleRecord
    if (record && record.uiSceneId !== next) void syncRole(record)
    const workflow = state.workflowRecord
    if (workflow) void syncWorkflow(workflow)
  }

  async function prepareSceneTransition() {
    if (!isDesktop()) return { ok: true }
    if (state.tearingDown || state.sceneTransitionPending) return { ok: false }
    const transitionId = ++state.sceneTransitionSequence
    state.sceneTransitionPending = true
    const role = state.roleRecord
    const workflow = state.workflowRecord
    const candidates = []
    if (role?.created && role.target && role.placement !== 'popped-out' && role.visible !== false) {
      candidates.push({ kind: 'role', record: role })
    }
    if (state.workflowMounted && workflow?.active && workflow.placement !== 'popped-out' && workflow.visible !== false) {
      candidates.push({ kind: 'workflow', record: workflow })
    }

    const hide = candidate => {
      const { kind, record } = candidate
      if (kind === 'role') {
        const operation = Promise.resolve(record.syncQueue).catch(() => {}).then(async () => {
          if (transitionId !== state.sceneTransitionSequence || state.tearingDown || record !== state.roleRecord || record.disposed) throw new Error('scene-transition-stale')
          candidate.wasVisible = record.visible === true
          try {
            await app.harnessSurface.setVisible(record.target.sceneId, record.target.panelId, false)
            record.visible = false
          } catch (error) {
            record.visible = undefined
            throw error
          }
        })
        record.syncQueue = operation
        return operation
      }
      const operation = Promise.resolve(record.queue).catch(() => {}).then(async () => {
        if (transitionId !== state.sceneTransitionSequence || state.tearingDown || record !== state.workflowRecord) throw new Error('scene-transition-stale')
        candidate.wasVisible = record.visible === true
        try {
          await app.workflowCanvas.setVisible(false)
          record.visible = false
        } catch (error) {
          record.visible = undefined
          throw error
        }
      })
      record.queue = operation
      return operation
    }
    const results = await Promise.allSettled(candidates.map(hide))
    if (results.every(result => result.status === 'fulfilled')
      && transitionId === state.sceneTransitionSequence && !state.tearingDown) return { ok: true }

    // Keep the old renderer records mounted until every previous view has been
    // restored. A rejected hide can still have changed native visibility.
    const restore = candidate => {
      const { kind, record } = candidate
      if (kind === 'role') {
        const operation = Promise.resolve(record.syncQueue).catch(() => {}).then(async () => {
          if (state.tearingDown || record !== state.roleRecord || record.disposed || !record.target) return
          if (!candidate.wasVisible || record.placement === 'popped-out' || !nativePaneVisible(record.panel)
            || record.status !== 'context-mounted') return
          const rect = record.content.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          await app.harnessSurface.setBounds(record.target.sceneId, record.target.panelId, {
            x: rect.left, y: rect.top, width: rect.width, height: rect.height,
          })
          await app.harnessSurface.setVisible(record.target.sceneId, record.target.panelId, true)
          record.visible = true
        })
        record.syncQueue = operation
        return operation
      }
      const operation = Promise.resolve(record.queue).catch(() => {}).then(async () => {
        if (state.tearingDown || record !== state.workflowRecord || !record.host.isConnected) return
        if (!candidate.wasVisible || record.status !== 'context-mounted' || !record.active || record.placement === 'popped-out'
          || state.sceneId !== 'agent-center' || !nativePaneVisible(record.panel)) return
        const rect = record.host.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        await app.workflowCanvas.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        await app.workflowCanvas.setVisible(true)
        record.visible = true
      })
      record.queue = operation
      return operation
    }
    await Promise.allSettled(candidates.map(restore))
    if (transitionId === state.sceneTransitionSequence) {
      state.sceneTransitionPending = false
      if (!state.tearingDown && candidates.some(({ record }) => !nativePaneVisible(record.panel))) {
        syncNativeVisibility()
      }
    }
    return { ok: false }
  }

  function syncNativeVisibility() {
    const role = state.roleRecord
    if (role) void syncRole(role)
    const workflow = state.workflowRecord
    if (workflow) void syncWorkflow(workflow)
  }

  function applyThemeSnapshot(snapshot) {
    return acceptThemeSnapshot(snapshot)
  }

  function applyNativeScale(value) {
    const scale = Number(value)
    if (!nativeScaleValues.includes(scale)) {
      state.nativeScale = undefined
      send('business-ui-scale-state', { available: false, reason: 'unsupported-native-scale' })
      return
    }
    state.nativeScale = scale
    // Electron zoom scales the outer shell and all native WebContentsViews together.
    // Leave the approved CSS density tokens at 100% to avoid double scaling.
    send('business-ui-scale-state', { available: true, value: scale })
  }

  async function setNativeScale(value) {
    if (!isDesktop() || ![0.9, 1, 1.1].includes(Number(value)) || typeof app?.setUiScale !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      const result = await app.setUiScale(Number(value))
      if (result !== Number(value)) return { ok: false, reason: 'unsupported-native-scale' }
      applyNativeScale(result)
      return { ok: true, value: result }
    } catch { return { ok: false, reason: 'save-failed' } }
  }

  async function setThemePreference(value) {
    if (!isDesktop() || !['light', 'dark', 'system'].includes(value) || typeof app?.sourceTheme?.setPreference !== 'function') return false
    try { return await app.sourceTheme.setPreference(value) === true } catch { return false }
  }

  async function toggleSidebar() {
    if (!isDesktop() || state.accountStatus !== 'context-mounted' || typeof app?.accountSurface?.setSidebarOpen !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      state.accountSidebarOpen = await app.accountSurface.setSidebarOpen(!state.accountSidebarOpen) === true
      document.body.classList.toggle('native-sidebar-open', state.accountSidebarOpen)
      syncNativeVisibility()
      return { ok: true, open: state.accountSidebarOpen }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function globalAction(name) {
    if (!isDesktop()) return { ok: false, reason: 'unavailable' }
    try {
      if (name === 'plugins') return { ok: true, value: await app.pluginInventory() }
      if (name === 'open-plugin-manager') {
        if (typeof app.openPluginManager !== 'function') return { ok: false, reason: 'unavailable' }
        const value = await app.openPluginManager()
        return value?.opened === true ? { ok: true, value } : { ok: false, reason: 'unavailable' }
      }
      if (name === 'models') return { ok: true, value: await app.modelCatalog() }
      if (name === 'settings') return { ok: true, value: await app.settingsOpen() }
      if (name === 'mobile') return { ok: true, value: await app.mobileLink() }
      if (name === 'erpnext-status') return await openErpNextStatus()
      if (name === 'native-conversation') return await openNativeConversation()
      if (name === 'agent-data') return await readAgentData()
      if (name === 'tools') {
        const response = await window.fetch('/tradeloom/tool-schemas', {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
        })
        if (!response?.ok) return { ok: false, reason: response?.status === 401 || response?.status === 403 ? 'forbidden' : 'unavailable' }
        const value = await response.json()
        if (!value || value.scope !== 'global' || !Array.isArray(value.tools)
          || value.tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string'
            || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)
            || (tool.deferLoading !== undefined && typeof tool.deferLoading !== 'boolean'))) return { ok: false, reason: 'invalid-response' }
        return { ok: true, value }
      }
      return { ok: false, reason: 'unsupported' }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function openErpNextStatus() {
    const component = app?.erpNextStatus
    if (!isDesktop() || typeof component?.mount !== 'function' || typeof component?.status !== 'function'
      || typeof component?.popOut !== 'function') return { ok: false, reason: 'unavailable' }
    try {
      const mounted = await component.mount()
      if (mounted?.componentKey !== 'erpnext-status-native' || typeof mounted.sceneId !== 'string' || typeof mounted.panelId !== 'string') {
        return { ok: false, reason: 'unavailable' }
      }
      const before = await component.status()
      if (before?.componentKey !== 'erpnext-status-native') return { ok: false, reason: 'unavailable' }
      const popped = await component.popOut()
      if (popped?.componentKey !== 'erpnext-status-native') return { ok: false, reason: 'unavailable' }
      const status = await component.status().catch(() => before)
      return { ok: true, value: { status: status?.status, placement: status?.placement || popped.placement } }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function openNativeConversation() {
    const account = app?.accountSurface
    if (!isDesktop() || state.accountStatus !== 'context-mounted' || typeof account?.popOut !== 'function') {
      return { ok: false, reason: state.accountStatus === 'context-mounted' ? 'unavailable' : 'not-mounted' }
    }
    try {
      const status = await account.status()
      if (status?.status !== 'context-mounted') return { ok: false, reason: 'not-mounted' }
      const result = await account.popOut()
      if (result?.status !== 'context-mounted' || result?.placement !== 'popout') return { ok: false, reason: 'unavailable' }
      return { ok: true, value: result }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function openNativeMenu(name, rect) {
    if (!isDesktop() || !['application', 'edit'].includes(name) || typeof app?.openWindowsMenu !== 'function'
      || !rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom) || rect.left < 0 || rect.bottom < 0) {
      return { ok: false, reason: 'unavailable' }
    }
    try {
      const sourceEditor = state.sourceEditor
      if (name === 'edit' && !sourceEditor) {
        if (state.sceneTransitionPending || state.tearingDown) return { ok: false, reason: 'unavailable' }
        const role = state.roleRecord
        if (role && role.created && role.placement !== 'popped-out' && !state.globalPanelOpen && nativePaneVisible(role.panel)) {
          if (!isCurrentRole(role) || role.status !== 'context-mounted') return { ok: false, reason: 'unavailable' }
          await syncRole(role)
          await role.syncQueue
          if (!isCurrentRole(role) || state.sceneTransitionPending || role.status !== 'context-mounted'
            || role.visible !== true || state.sourceEditor !== sourceEditor) return { ok: false, reason: 'unavailable' }
        }
      }
      if (name === 'edit' && !sourceEditor && !state.globalPanelOpen) {
        const workflow = state.workflowRecord
        if (workflow?.active && workflow.placement !== 'popped-out' && nativePaneVisible(workflow.panel)) {
          if (workflow.status !== 'context-mounted' || !workflow.host.isConnected) return { ok: false, reason: 'unavailable' }
          await syncWorkflow(workflow)
          await workflow.queue
          if (workflow !== state.workflowRecord || state.sceneTransitionPending || state.tearingDown
            || state.sceneId !== workflow.uiSceneId || !workflow.active || !workflow.host.isConnected
            || workflow.status !== 'context-mounted' || workflow.visible !== true || state.sourceEditor !== sourceEditor) return { ok: false, reason: 'unavailable' }
        }
      }
      await app.openWindowsMenu(name, rect.left, rect.bottom, sourceEditor)
      return { ok: true }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function readAgentData() {
    if (!isDesktop() || !state.config || typeof window.fetch !== 'function') return { ok: false, reason: 'unavailable' }
    const role = roleByUiScene[state.sceneId]
    if (!role || !state.config.roles.has(role)) return { ok: false, reason: 'unconfigured' }
    return readAgentDataForRole(role)
  }

  async function readAssistantCapabilities() {
    const context = await app.assistantCapabilitiesContext()
    if (context?.componentKey !== 'assistant-capabilities-native' || typeof context.role !== 'string') return { ok: false, reason: 'unavailable' }
    return readAgentDataForRole(context.role)
  }

  async function readAgentDataForRole(role) {
    try {
      const [capResponse, configResponse] = await Promise.all([
        window.fetch(`/tradeloom/agent-capabilities?role=${encodeURIComponent(role)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }),
        window.fetch(`/tradeloom/agent-configuration?role=${encodeURIComponent(role)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }),
      ])
      if (!capResponse?.ok || !configResponse?.ok) {
        const status = capResponse?.status || configResponse?.status
        return { ok: false, reason: status === 401 || status === 403 ? 'forbidden' : 'unavailable' }
      }
      const [capabilities, configuration] = await Promise.all([capResponse.json(), configResponse.json()])
      if (!capabilities || capabilities.role !== role || !['ready', 'not_bound'].includes(capabilities.status)
        || !configuration || configuration.role !== role || typeof configuration.revision !== 'string'
        || !Array.isArray(configuration.mcpServers) || !Array.isArray(configuration.deniedTools)
        || !configuration.skill || typeof configuration.skill !== 'object') return { ok: false, reason: 'invalid-response' }
      return { ok: true, value: { role, capabilities, configuration } }
    } catch { return { ok: false, reason: 'unavailable' } }
  }

  async function openScene(uiSceneId) {
    if (!isDesktop() || !routeByUiScene[uiSceneId] || !state.config || typeof app?.win?.openScene !== 'function') return { ok: false, reason: 'unavailable' }
    const route = routeForPath(routeByUiScene[uiSceneId])
    if (!route) return { ok: false, reason: 'unconfigured' }
    try { await app.win.openScene(route.route.sceneId); return { ok: true } }
    catch { return { ok: false, reason: 'unavailable' } }
  }

  async function windowAction(action) {
    if (!isDesktop()) return undefined
    try {
      if (action === 'minimize') return await app.minimize()
      if (action === 'toggleMaximize') return await app.toggleMaximize()
      if (action === 'isMaximized') return await app.isMaximized()
      if (action === 'close') return await app.close()
    } catch { return undefined }
    return undefined
  }

  async function openWebAi(provider) {
    if (!['deepseek', 'doubao'].includes(provider)) return false
    if (isDesktop() && typeof app?.openAiWebWindow === 'function') {
      try { await app.openAiWebWindow({ provider }); return true } catch { return false }
    }
    return false
  }

  window.businessBridge = Object.freeze({
    start,
    isDesktop,
    prepareSceneTransition,
    sceneSelected: onSceneChanged,
    renderBusinessPanel,
    renderRolePanel,
    renderWorkflowPanel,
    renderCompanion,
    requestRolePlacement,
    openSceneRotation,
    panelMenuCapabilities,
    requestPanelPlacement,
    requestNativeUtility,
    setThemePreference,
    setNativeScale,
    globalAction,
    readAssistantCapabilities,
    openNativeMenu,
    toggleSidebar,
    openWebAi,
    openScene,
    windowAction,
    getConfigState: () => ({ phase: state.phase, error: state.error }),
    getNativeScale: () => state.nativeScale,
    getThemePreference: () => state.themePreference,
    whenInitialThemeReady,
  })
})()
