(() => {
  'use strict'

  const app = window.app
  const sceneSource = window.__SCENES__
  let scenes = Array.isArray(sceneSource) ? sceneSource : Array.isArray(sceneSource?.scenes) ? sceneSource.scenes : []
  let productConfig
  let productSceneOrder = []
  const params = new URLSearchParams(location.search)
  const account = app?.accountSurface
  const businessEntries = Object.freeze([
    Object.freeze({ id: 'home', label: '业务总览', route: '/home', path: '/business/home' }),
    Object.freeze({ id: 'products', label: '产品资料', route: '/products', path: '/business/products' }),
    Object.freeze({ id: 'agent-center', label: '工作流中心', route: '/agent-center', path: '/business/agent-center' }),
    Object.freeze({ id: 'artifacts', label: '交付资料', route: '/artifacts', path: '/business/artifacts' }),
    Object.freeze({ id: 'runs', label: '运行记录', route: '/runs', path: '/business/runs' }),
    Object.freeze({ id: 'tasks', label: '任务列表', path: '/business/' }),
  ])
  const knownFolderEntries = Object.freeze([
    Object.freeze({ key: 'desktop', label: '桌面', badge: '桌' }),
    Object.freeze({ key: 'documents', label: '文档', badge: '文' }),
    Object.freeze({ key: 'downloads', label: '下载', badge: '下' }),
  ])
  const uiScaleChoices = Object.freeze([0.85, 0.95, 1, 1.1, 1.25])
  const state = {
    target: null,
    creating: null,
    created: false,
    visible: false,
    placement: 'docked',
    accountSidebarOpen: false,
    accountSurfaceVisible: false,
    globalPanel: undefined,
    pendingAccountWindowAction: undefined,
    disposed: false,
    status: undefined,
    statusRevision: 0,
    modelRequestGeneration: 0,
    toolRequestGeneration: 0,
    folderPickerGeneration: 0,
    nativeActionGeneration: 0,
    pendingNativeActions: new Set(),
    nativeActionMessage: '',
    nativeFocusSubscribed: false,
    sourceEditor: true,
    pendingKnownFolders: new Set(),
    uiScaleValue: undefined,
    uiScaleKnown: false,
    uiScaleRevision: 0,
    uiScaleReadGeneration: 0,
    uiScaleLoading: false,
    uiScalePending: false,
    uiScaleSubscribed: false,
    uiScaleMessage: '',
    themeSnapshot: undefined,
    workflowCanvasMounted: false,
    workflowCanvasPlacement: 'docked',
    workflowCanvasPlacementControl: undefined,
    workflowCanvasVisible: false,
    workflowCanvasStatus: undefined,
    workflowCanvasObserver: undefined,
    roleSurfaces: new Map(),
    offRoleSurfaceStatus: undefined,
    roleSurfaceObserver: undefined,
    roleGeometryFrame: undefined,
    roleDragPanel: undefined,
    roleDragPointerId: undefined,
    accountChatMode: false,
    accountChatSceneId: undefined,
    accountChatPanel: undefined,
    accountChatOriginalTitle: undefined,
    offAccountChatRequest: undefined,
    offWorkflowCanvas: undefined,
    erpNextStatusMounted: false,
    erpNextStatusPlacement: 'docked',
    erpNextStatusPlacementControl: undefined,
    erpNextStatusVisible: false,
    erpNextStatusStatus: undefined,
    erpNextStatusObserver: undefined,
    offErpNextStatus: undefined,
    sceneLoader: undefined,
    offThemeChanged: undefined,
    offUiScale: undefined,
    offNativeFocus: undefined,
    createGeneration: 0,
    lastBoundsKey: '',
    syncRevision: 0,
    syncQueue: Promise.resolve(),
    offStatus: undefined,
    offSidebarStatus: undefined,
    gridObserver: undefined,
    gripListeners: new Map(),
    modalObserver: undefined,
    themeMenuObserver: undefined,
    panelObserver: undefined,
    observedPanel: undefined,
    resizeObserver: undefined,
    resizeTarget: undefined,
    geometryFrame: undefined,
    geometryPanel: undefined,
    dragPanel: undefined,
    dragPointerId: undefined,
    suppressedMotionPanel: undefined,
  }

  const statusText = document.getElementById('status-text')
  const modal = document.getElementById('modal-mask')
  const statusLabels = {
    loading: '原生账号工作区加载中…',
    'document-loaded': '等待原生账号工作区挂载…',
    'context-mounted': '原生账号工作区已挂载',
    error: '原生账号工作区不可用',
    unbound: '原生账号工作区尚未挂载',
  }
  const setStatus = value => {
    if (state.disposed || !statusText) return
    const valueStatus = typeof value?.status === 'string' ? value.status : undefined
    state.status = valueStatus
    statusText.textContent = statusLabels[valueStatus] || '原生账号工作区状态未知'
  }

  function showModelMessage(body, message) {
    body.replaceChildren()
    const note = document.createElement('div')
    note.className = 'stat-sub'
    note.textContent = message
    body.appendChild(note)
  }

  function modelRequestIsCurrent(generation, body) {
    return !state.disposed && state.modelRequestGeneration === generation
      && modal?.style.display !== 'none' && body?.isConnected
      && document.getElementById('modal-body') === body
      && document.getElementById('modal-title')?.textContent === '模型与提供方'
  }

  function validateModelCatalog(result) {
    if (!result || !Array.isArray(result.groups)) throw Error('invalid model catalog')
    const groups = result.groups.map(group => {
      if (!group || typeof group.id !== 'string' || !Array.isArray(group.models)) throw Error('invalid model group')
      if (group.name !== undefined && typeof group.name !== 'string') throw Error('invalid provider name')
      const models = group.models.map(model => {
        if (!model || typeof model.id !== 'string' || (model.name !== undefined && typeof model.name !== 'string')) throw Error('invalid model')
        return model
      })
      return { id: group.id, name: group.name || group.id, models }
    })
    let defaultModel
    if (result.defaultModel !== undefined) {
      if (!result.defaultModel || typeof result.defaultModel.provider !== 'string' || typeof result.defaultModel.model !== 'string') throw Error('invalid catalog default')
      defaultModel = result.defaultModel
    }
    const failures = result.failures === undefined ? [] : result.failures
    if (!Array.isArray(failures)) throw Error('invalid provider failures')
    return { groups, defaultModel, failures }
  }

  async function populateModelCatalog(body, generation) {
    const current = () => modelRequestIsCurrent(generation, body)
    if (!current()) return
    try {
      if (!isTrustedAppOrigin()) {
        showModelMessage(body, '原生模型目录仅在桌面工作区可读。')
        return
      }
      const status = await account?.status?.()
      if (!current()) return
      if (status?.status !== 'context-mounted') {
        showModelMessage(body, '原生账号工作区尚未挂载，模型目录不可读。')
        return
      }
      if (typeof app?.modelCatalog !== 'function') throw Error('model catalog unavailable')
      const result = validateModelCatalog(await app.modelCatalog())
      if (!current()) return
      const rows = []
      for (const group of result.groups) {
        if (group.models.length === 0) {
          rows.push([group.name.slice(0, 1) || '·', group.name, '该提供方目录当前没有模型条目。', []])
          continue
        }
        for (const model of group.models) {
          const isDefault = result.defaultModel?.provider === group.id && result.defaultModel.model === model.id
          rows.push([
            group.name.slice(0, 1) || '·',
            model.name || model.id,
            `${group.name} · ${model.id}`,
            isDefault ? [['目录默认（未指定会话）', 'info']] : [],
          ])
        }
      }
      const note = result.defaultModel
        ? `目录默认（未指定会话）：${result.defaultModel.model} @ ${result.defaultModel.provider}`
        : '目录默认模型：未提供。'
      const parts = [note]
      if (result.failures.length) parts.push(`部分提供方目录读取失败：${result.failures.length} 个；目录结果可能不完整。`)
      if (typeof window.modalRows !== 'function') throw Error('original modal row renderer unavailable')
      body.replaceChildren()
      window.modalRows(body, rows, parts.join(' '))
      if (!rows.length) {
        const empty = document.createElement('div')
        empty.className = 'stat-sub'
        empty.textContent = result.failures.length ? '未返回可确认的模型条目。' : '当前模型目录为空。'
        body.appendChild(empty)
      }
    } catch {
      if (current()) showModelMessage(body, '模型目录暂不可读。')
    }
  }

  function onDocumentClick(event) {
    const button = event.target?.closest?.('#btn-models')
    if (button) {
      const generation = ++state.modelRequestGeneration
      const body = document.getElementById('modal-body')
      if (!modelRequestIsCurrent(generation, body)) return
      showModelMessage(body, '正在读取模型目录…')
      void populateModelCatalog(body, generation)
      return
    }
    if (!event.target?.closest?.('#btn-tools')) return
    const title = document.getElementById('modal-title')
    const body = document.getElementById('modal-body')
    const generation = ++state.toolRequestGeneration
    if (!title || !body) return
    title.textContent = '已注册工具'
    showModelMessage(body, '正在读取已注册工具…')
    void populateToolCatalog(body, generation)
  }

  function toolRequestIsCurrent(generation, body) {
    return !state.disposed && state.toolRequestGeneration === generation
      && modal?.style.display !== 'none' && body?.isConnected
      && document.getElementById('modal-body') === body
      && document.getElementById('modal-title')?.textContent === '已注册工具'
  }

  function validateToolCatalog(result) {
    if (!result || result.scope !== 'global' || !Array.isArray(result.tools)) throw Error('invalid tool catalog')
    return result.tools.map(tool => {
      if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string'
        || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw Error('invalid tool')
      if (tool.deferLoading !== undefined && typeof tool.deferLoading !== 'boolean') throw Error('invalid deferLoading')
      return tool
    })
  }

  function toolParameterSummary(parameters) {
    const properties = parameters.properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return '参数结构未提供'
    const required = new Set(Array.isArray(parameters.required) ? parameters.required.filter(value => typeof value === 'string') : [])
    const names = Object.keys(properties)
    if (!names.length) return '无参数字段'
    return names.map(name => `${name}${required.has(name) ? '（必填）' : ''}`).join(' · ')
  }

  async function populateToolCatalog(body, generation) {
    const current = () => toolRequestIsCurrent(generation, body)
    if (!current()) return
    if (!isTrustedAppOrigin() || typeof window.fetch !== 'function') {
      showModelMessage(body, '工具目录暂不可用。')
      return
    }
    let response
    try {
      response = await window.fetch('/tradeloom/tool-schemas', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      })
    } catch {
      if (current()) showModelMessage(body, '工具目录暂不可用。')
      return
    }
    if (!current()) return
    if (!response?.ok) {
      const message = response?.status === 401 || response?.status === 403
        ? '当前无权读取工具目录。'
        : response?.status === 404 ? '当前版本不支持读取工具目录。'
          : response?.status === 503 ? '工具目录服务暂不可用。' : '工具目录暂不可用。'
      showModelMessage(body, message)
      return
    }
    let result
    let tools
    try {
      result = await response.json()
      tools = validateToolCatalog(result)
    } catch {
      if (current()) showModelMessage(body, '工具目录格式无效。')
      return
    }
    if (!current()) return
    if (typeof window.modalRows !== 'function') {
      showModelMessage(body, '工具目录暂不可用。')
      return
    }
    const rows = tools.map(tool => [
      tool.name.slice(0, 1) || '·',
      tool.name,
      `${tool.description} · 参数：${toolParameterSummary(tool.parameters)}`,
      tool.deferLoading ? [['延迟加载', 'info']] : [],
    ])
    body.replaceChildren()
    window.modalRows(body, rows, '')
    if (!rows.length) showModelMessage(body, '当前没有已注册工具。')
  }

  function receiveStatus(value) {
    if (state.disposed) return
    state.statusRevision++
    if (typeof value?.visible === 'boolean') state.accountSurfaceVisible = value.visible
    if (value?.placement === 'docked' || value?.placement === 'popout') {
      if (state.placement !== value.placement) {
        state.placement = value.placement
        state.syncRevision++
        state.lastBoundsKey = ''
        if (value.placement === 'popout') { state.visible = undefined; stopGeometryFrames() }
      }
    }
    if (value?.status === 'error') {
      state.createGeneration++
      state.creating = null
      state.created = false
      state.visible = false
      state.lastBoundsKey = ''
      state.offStatus?.()
      state.offStatus = undefined
    }
    setStatus(value)
    const body = document.getElementById('modal-body')
    const generation = state.folderPickerGeneration
    if (accountWindowPickerIsCurrent(generation, body)) renderAccountWindowEntries(body, generation)
    if (knownFolderPickerIsCurrent(generation, body)) renderNativeMenuEntries(body, generation)
  }

  function currentSceneId() {
    const active = document.querySelector('#scenario-tabs .tab.active')?.dataset.scId
    return active || params.get('scene') || scenes[0]?.id || null
  }

  function normalizeProductConfig(value) {
    if (!value || !Array.isArray(value.scenes) || !value.scenes.length || !value.grid
      || !Number.isInteger(value.grid.cols) || !Number.isInteger(value.grid.rows)
      || !value.businessRoutes || typeof value.businessRoutes !== 'object' || Array.isArray(value.businessRoutes)
      || !Array.isArray(value.roles) || !value.sessionBindings || typeof value.sessionBindings !== 'object' || Array.isArray(value.sessionBindings)) throw Error('source config unavailable')
    const roleIds = new Set()
    for (const role of value.roles) {
      if (!role || typeof role.id !== 'string' || !role.id || roleIds.has(role.id)
        || typeof role.label !== 'string') throw Error('invalid source roles')
      roleIds.add(role.id)
    }
    for (const [roleId, sessionId] of Object.entries(value.sessionBindings)) {
      if (!roleIds.has(roleId) || typeof sessionId !== 'string' || !sessionId) throw Error('invalid source session bindings')
    }
    const ids = new Set()
    const normalized = value.scenes.map(scene => {
      if (!scene || typeof scene.id !== 'string' || !scene.id || ids.has(scene.id) || typeof scene.label !== 'string'
        || !Array.isArray(scene.panels) || !scene.panels.length) throw Error('invalid source scenes')
      ids.add(scene.id)
      const panelIds = new Set()
      const panels = scene.panels.map(panel => {
        if (!panel || typeof panel.id !== 'string' || !panel.id || panelIds.has(panel.id)
          || !['business-iframe','native-chat','native-workspace','erpnext-status','placeholder'].includes(panel.type)
          || ![panel.col,panel.row,panel.w,panel.h].every(Number.isInteger) || panel.col < 1 || panel.row < 1 || panel.w < 1 || panel.h < 1) throw Error('invalid source panel')
        panelIds.add(panel.id)
        return { ...panel }
      })
      return { ...scene, name: scene.label, cols: value.grid.cols, rows: value.grid.rows, panels }
    })
    for (const [path, route] of Object.entries(value.businessRoutes)) {
      if (typeof path !== 'string' || !/^\/[a-z0-9-]+$/.test(path) || !route || !ids.has(route.sceneId) || typeof route.panelId !== 'string') throw Error('invalid source business routes')
      const target = normalized.find(scene => scene.id === route.sceneId)?.panels.find(panel => panel.id === route.panelId)
      if (!target || target.type !== 'business-iframe') throw Error('invalid source business route target')
    }
    return normalized
  }

  async function loadSceneData() {
    if (isTrustedAppOrigin()) {
      if (typeof app?.sourceConfig !== 'function') return { scenes: [], sourceError: true }
      try {
        const config = await app.sourceConfig()
        const normalized = normalizeProductConfig(config)
        productConfig = config
        let order = { saved: false, ids: [] }
        if (typeof app.getSceneOrder === 'function') {
          const candidate = await app.getSceneOrder()
          if (candidate && candidate.saved === true && Array.isArray(candidate.ids)) order = candidate
        }
        const known = new Set(normalized.map(scene => scene.id))
        productSceneOrder = order.ids.filter(id => known.has(id))
        scenes = [...productSceneOrder.map(id => normalized.find(scene => scene.id === id)), ...normalized.filter(scene => !productSceneOrder.includes(scene.id))]
        return { scenes, sceneOrder: productSceneOrder, sourceConfig: true }
      } catch {
        if (productConfig && scenes.length > 0) return { scenes, sceneOrder: productSceneOrder, sourceConfig: true, refreshError: true }
        productConfig = undefined
        scenes = []
        productSceneOrder = []
        return { scenes: [], sourceError: true }
      }
    }
    return { scenes }
  }

  function findTarget(target = state.target) {
    if (!target || target.sceneId !== currentSceneId()) return null
    const panel = [...document.querySelectorAll('#grid .panel-chat')]
      .find(element => element.dataset.panelId === target.panelId)
    const anchor = panel?.querySelector('.panel-content')
    return anchor?.isConnected ? anchor : null
  }

  function modalVisible() {
    if (!modal || modal.hidden) return false
    return window.getComputedStyle(modal).display !== 'none'
  }

  function menuVisible() {
    return !!document.querySelector('body > .theme-menu')
  }

  function syncHostedNativeVisibility() {
    for (const record of state.roleSurfaces.values()) void syncRoleSurface(record)
    const workflowHost = document.querySelector('[data-workflow-canvas-host]')
    if (workflowHost) syncWorkflowCanvas(workflowHost)
    const erpHost = document.querySelector('[data-erpnext-status-host]')
    if (erpHost) syncErpNextStatus(erpHost)
  }

  function isTrustedAppOrigin() {
    return location.protocol === 'dsh-app:' && location.hostname === 'app'
      && !location.port && !location.username && !location.password
  }

  function currentBounds(anchor) {
    const rect = anchor.getBoundingClientRect()
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  function movingPanel() {
    const panel = findTarget()?.closest('.panel-chat')
    if (!panel) return null
    const hasGhost = !!document.querySelector('#grid .drop-ghost')
    const dragging = state.dragPanel === panel && panel.classList.contains('dragging') && hasGhost
    if (state.dragPanel === panel && !hasGhost) {
      state.dragPanel = undefined
      state.dragPointerId = undefined
    }
    const animating = panel.classList.contains('panel-anim') && state.suppressedMotionPanel !== panel
    return dragging || animating ? { panel, dragging, animating } : null
  }

  function clearDragTracking(event) {
    if (!state.dragPanel) return
    if (event?.pointerId != null && state.dragPointerId != null && event.pointerId !== state.dragPointerId) return
    state.dragPanel = undefined
    state.dragPointerId = undefined
    sync()
  }

  function roleDragIsActive(record) {
    return state.roleDragPanel === record.panel && record.panel?.classList.contains('dragging')
      && !!document.querySelector('#grid .drop-ghost')
  }

  function roleMotionIsActive(record) {
    return record.created && record.placement === 'docked' && record.panel?.isConnected
      && (record.panel.classList.contains('panel-anim') || roleDragIsActive(record))
  }

  function stopRoleGeometryFrames() {
    if (state.roleGeometryFrame !== undefined) window.cancelAnimationFrame(state.roleGeometryFrame)
    state.roleGeometryFrame = undefined
  }

  function sampleRoleGeometry() {
    state.roleGeometryFrame = undefined
    if (state.disposed) return
    const active = [...state.roleSurfaces.values()].filter(roleMotionIsActive)
    if (!active.length) {
      for (const record of state.roleSurfaces.values()) {
        if (record.motionActive && record.created && record.placement === 'docked') void syncRoleSurface(record)
        record.motionActive = false
      }
      return
    }
    for (const record of active) { record.motionActive = true; void syncRoleSurface(record) }
    state.roleGeometryFrame = window.requestAnimationFrame(sampleRoleGeometry)
  }

  function startRoleGeometryFrames() {
    const active = [...state.roleSurfaces.values()].some(roleMotionIsActive)
    if (!active) {
      stopRoleGeometryFrames()
      for (const record of state.roleSurfaces.values()) {
        if (record.motionActive && record.created && record.placement === 'docked') void syncRoleSurface(record)
        record.motionActive = false
      }
      return
    }
    if (state.disposed || state.roleGeometryFrame !== undefined) return
    state.roleGeometryFrame = window.requestAnimationFrame(sampleRoleGeometry)
  }

  function trackRoleDragStart(event) {
    if (event.button !== 0 || event.target?.closest?.('.icon-control, .panel-expand')) return
    const panel = event.target?.closest?.('#grid .panel-chat[data-panel-id]')
    if (!panel || !panel.classList.contains('dragging')) return
    const record = [...state.roleSurfaces.values()].find(item => item.panel === panel && item.created && item.placement === 'docked')
    if (!record) return
    state.roleDragPanel = panel
    state.roleDragPointerId = event.pointerId
    startRoleGeometryFrames()
  }

  function clearRoleDragTracking(event) {
    if (!state.roleDragPanel) return
    if (event?.pointerId != null && state.roleDragPointerId != null && event.pointerId !== state.roleDragPointerId) return
    const panel = state.roleDragPanel
    state.roleDragPanel = undefined
    state.roleDragPointerId = undefined
    for (const record of state.roleSurfaces.values()) if (record.panel === panel) record.motionActive = true
    startRoleGeometryFrames()
  }

  function trackDragStart(event) {
    if (event.button !== 0 || event.target?.closest?.('.icon-control, .panel-expand')) return
    const panel = event.target?.closest?.('#grid .panel-chat[data-panel-id]')
    if (!panel || panel !== findTarget()?.closest('.panel-chat') || panel.classList.contains('panel-expanded')) return
    state.dragPanel = panel
    state.dragPointerId = event.pointerId
  }

  function onGripPointerDown(event) {
    trackDragStart(event)
    trackRoleDragStart(event)
    event.stopPropagation()
  }

  function syncGripListeners() {
    if (!grid) return
    const grips = new Set([...grid.querySelectorAll('.panel-header .grip')].filter(grip => !grip.closest('.drop-ghost')))
    for (const [grip, listener] of state.gripListeners) {
      if (grips.has(grip)) continue
      grip.removeEventListener('pointerdown', listener)
      state.gripListeners.delete(grip)
    }
    for (const grip of grips) {
      if (state.gripListeners.has(grip)) continue
      grip.addEventListener('pointerdown', onGripPointerDown)
      state.gripListeners.set(grip, onGripPointerDown)
    }
    if (state.dragPanel && (!state.dragPanel.isConnected || !grid.contains(state.dragPanel))) {
      state.dragPanel = undefined
      state.dragPointerId = undefined
    }
  }
  function liveBounds(anchor) {
    const ordinary = currentBounds(anchor)
    if (!ordinary) return null
    const moving = movingPanel()
    if (!moving?.dragging) return ordinary
    const ghost = document.querySelector('#grid .drop-ghost')
    if (!ghost) return ordinary
    if (!ghost.querySelector('.panel-header')) {
      const header = moving.panel.querySelector('.panel-header')?.cloneNode(true)
      if (header) {
        header.setAttribute('aria-hidden', 'true')
        header.style.pointerEvents = 'none'
        ghost.append(header)
      }
    }
    const panelRect = moving.panel.getBoundingClientRect()
    const ghostRect = ghost.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const values = [panelRect.x, panelRect.y, ghostRect.x, ghostRect.y, anchorRect.width, anchorRect.height]
    if (!values.every(Number.isFinite) || anchorRect.width <= 0 || anchorRect.height <= 0) return ordinary
    return {
      x: ghostRect.x + anchorRect.x - panelRect.x,
      y: ghostRect.y + anchorRect.y - panelRect.y,
      width: anchorRect.width,
      height: anchorRect.height,
    }
  }

  function liveRoleBounds(record) {
    const anchor = record.content
    const ordinaryRect = anchor.getBoundingClientRect()
    const ordinary = { x: ordinaryRect.left, y: ordinaryRect.top, width: ordinaryRect.width, height: ordinaryRect.height }
    if (!roleDragIsActive(record)) return ordinary
    const ghost = document.querySelector('#grid .drop-ghost')
    const panel = record.panel
    if (!ghost || !panel) return ordinary
    if (!ghost.querySelector('.panel-header')) {
      const header = panel.querySelector('.panel-header')?.cloneNode(true)
      if (header) {
        header.setAttribute('aria-hidden', 'true')
        header.style.pointerEvents = 'none'
        ghost.append(header)
      }
    }
    const panelRect = panel.getBoundingClientRect()
    const ghostRect = ghost.getBoundingClientRect()
    const values = [panelRect.left, panelRect.top, ghostRect.left, ghostRect.top, ordinaryRect.width, ordinaryRect.height]
    if (!values.every(Number.isFinite) || ordinaryRect.width <= 0 || ordinaryRect.height <= 0) return ordinary
    return {
      x: ghostRect.left + ordinaryRect.left - panelRect.left,
      y: ghostRect.top + ordinaryRect.top - panelRect.top,
      width: ordinaryRect.width,
      height: ordinaryRect.height,
    }
  }

  function stopGeometryFrames() {
    if (state.geometryFrame !== undefined) window.cancelAnimationFrame(state.geometryFrame)
    state.geometryFrame = undefined
    state.geometryPanel = undefined
  }

  function sampleMovingGeometry() {
    if (state.disposed || state.placement === 'popout') { stopGeometryFrames(); return }
    const moving = movingPanel()
    if (!moving) { stopGeometryFrames(); sync(); return }
    if (state.geometryPanel !== moving.panel) state.geometryPanel = moving.panel
    sync()
    state.geometryFrame = window.requestAnimationFrame(sampleMovingGeometry)
  }

  function startGeometryFrames() {
    if (state.disposed || state.placement === 'popout' || state.geometryFrame !== undefined || !movingPanel()) return
    state.geometryFrame = window.requestAnimationFrame(sampleMovingGeometry)
  }

  function desiredPlacement() {
    if (state.disposed || state.placement === 'popout' || !state.created || state.status === 'error' || (!state.globalPanel?.open && !state.target) || params.get('solo') === '1' || modalVisible() || menuVisible()) return null
    const anchor = state.globalPanel?.open ? document.getElementById('grid') : findTarget()
    const bounds = anchor && liveBounds(anchor)
    return anchor && bounds ? { anchor, bounds } : null
  }

  function observeAnchor(anchor) {
    const panel = anchor?.closest('.panel')
    if (state.observedPanel !== panel) {
      state.observedPanel?.removeEventListener('transitionend', onPanelTransitionEnd)
      state.observedPanel?.removeEventListener('transitioncancel', onPanelTransitionEnd)
      state.observedPanel?.removeEventListener('transitionrun', onPanelTransitionRun)
      state.panelObserver?.disconnect()
      state.observedPanel = panel || undefined
      if (panel && typeof window.MutationObserver === 'function') {
        state.panelObserver = new window.MutationObserver(() => {
          if (!panel.classList.contains('panel-anim') && state.suppressedMotionPanel === panel) state.suppressedMotionPanel = undefined
          sync()
          startGeometryFrames()
        })
        state.panelObserver.observe(panel, { attributes: true, attributeFilter: ['style', 'class', 'data-col', 'data-row', 'data-w', 'data-h'] })
        panel.addEventListener('transitionend', onPanelTransitionEnd)
        panel.addEventListener('transitioncancel', onPanelTransitionEnd)
        panel.addEventListener('transitionrun', onPanelTransitionRun)
      }
    }
    if (state.resizeTarget === anchor) return
    state.resizeObserver?.disconnect()
    state.resizeTarget = anchor || undefined
    if (anchor && typeof window.ResizeObserver === 'function') {
      state.resizeObserver = new window.ResizeObserver(sync)
      state.resizeObserver.observe(anchor)
    }
  }

  function onPanelTransitionEnd(event) {
    if (!event || event.target === state.observedPanel) {
      if (event?.type === 'transitioncancel') state.suppressedMotionPanel = state.observedPanel
      if (event?.type === 'transitionend' && state.observedPanel?.classList.contains('panel-anim')) { sync(); return }
      stopGeometryFrames()
      sync()
    }
  }

  function onPanelTransitionRun(event) {
    if (!event || event.target === state.observedPanel) {
      state.suppressedMotionPanel = undefined
      startGeometryFrames()
    }
  }

  function sync() {
    if (state.disposed) return
    if (state.placement === 'popout') { state.syncRevision++; return }
    const anchor = state.globalPanel?.open ? document.getElementById('grid') : findTarget()
    observeAnchor(anchor)
    const revision = ++state.syncRevision
    state.syncQueue = state.syncQueue.then(async () => {
      if (state.disposed || state.placement === 'popout' || !state.created || revision !== state.syncRevision) return
      const placement = desiredPlacement()
      if (!placement) {
        if (state.visible !== false) {
          try { await account.setVisible(false); state.visible = false }
          catch { state.visible = undefined; receiveStatus({ status: 'error' }) }
        }
        return
      }
      const key = `${state.globalPanel?.open ? `global/${state.globalPanel.mode}/${state.globalPanel.panelId ?? ''}` : `${state.target.sceneId}/${state.target.panelId}`}:${JSON.stringify(placement.bounds)}`
      try {
        if (key !== state.lastBoundsKey) {
          await account.setBounds(placement.bounds)
          state.lastBoundsKey = key
        }
        if (state.placement === 'popout') return
        const current = desiredPlacement()
        if (state.disposed || revision !== state.syncRevision || !current || !current.anchor.isConnected) {
          if (state.placement === 'popout') return
          if (state.visible !== false) { await account.setVisible(false); state.visible = false }
          return
        }
        if (state.visible !== true) { await account.setVisible(true); state.visible = true }
      } catch { if (state.placement !== 'popout') { state.visible = undefined; receiveStatus({ status: 'error' }) } }
    }).catch(() => { if (state.placement !== 'popout') receiveStatus({ status: 'error' }) })
  }

  async function mountTarget(sceneId, panelId) {
    state.target = { sceneId, panelId }
    closePicker()
    if (params.get('solo') === '1') {
      showSplitFailure('账号工作区仅可由主窗口挂载；此独立场景窗保留原面板。')
      return
    }
    if (!account || typeof account.create !== 'function') {
      showSplitFailure('原生账号工作区桥不可用；原面板仍保留。')
      return
    }
    if (!state.creating && !state.created) {
      const generation = ++state.createGeneration
      if (!state.offStatus && typeof account.onStatus === 'function') {
        state.offStatus = account.onStatus(value => { receiveStatus(value); sync() })
      }
      state.creating = Promise.resolve().then(async () => {
        const beforeCreateRevision = state.statusRevision
        const value = await account.create()
        if (state.disposed || generation !== state.createGeneration) return
        state.created = true
        if (beforeCreateRevision === state.statusRevision) receiveStatus(value)
        const beforeSnapshotRevision = state.statusRevision
        try {
          const snapshot = await account.status()
          if (!state.disposed && generation === state.createGeneration && beforeSnapshotRevision === state.statusRevision && snapshot?.status) receiveStatus(snapshot)
        } catch {
          if (!state.disposed && generation === state.createGeneration && beforeSnapshotRevision === state.statusRevision) receiveStatus({ status: 'error' })
        }
        sync()
      }).catch(() => {
        if (!state.disposed && generation === state.createGeneration) receiveStatus({ status: 'error' })
      }).finally(() => {
        if (generation === state.createGeneration) state.creating = null
      })
    }
    if (state.creating) await state.creating
    if (state.created) sync()
  }

  function closePicker() {
    if (!modal) return
    state.folderPickerGeneration++
    modal.style.display = 'none'
  }

  function knownFolderPickerIsCurrent(generation, body) {
    return !state.disposed && state.folderPickerGeneration === generation
      && modal?.style.display !== 'none' && body?.isConnected
      && document.getElementById('modal-body') === body
      && document.getElementById('modal-title')?.textContent === '原生工作区'
  }

  function nativeActionAvailable(action) {
    if (!isTrustedAppOrigin()) return false
    if (action === 'settings') return typeof app?.settingsOpen === 'function' && state.status === 'context-mounted'
    if (action === 'edit') return typeof app?.openWindowsMenu === 'function' && state.nativeFocusSubscribed
    return (action === 'application') && typeof app?.openWindowsMenu === 'function'
  }

  const nativeMenuActions = Object.freeze([
    Object.freeze({ id: 'application', label: '应用', menu: 'application', badge: '应' }),
    Object.freeze({ id: 'edit', label: '编辑', menu: 'edit', badge: '编' }),
    Object.freeze({ id: 'settings', label: '原生设置', badge: '设' }),
  ])

  function renderNativeMenuEntries(body, generation) {
    if (!knownFolderPickerIsCurrent(generation, body)) return
    for (const button of body.querySelectorAll('[data-native-action]')) {
      const action = button.dataset.nativeAction
      const pending = state.pendingNativeActions.has(action)
      button.disabled = !nativeActionAvailable(action) || pending
      const description = button.querySelector('.mdl-desc')
      if (!description) continue
      if (pending) description.textContent = action === 'settings' ? '正在打开原生设置…' : `正在打开${action === 'application' ? '应用' : '编辑'}菜单…`
      else if (!isTrustedAppOrigin() || (action !== 'settings' && typeof app?.openWindowsMenu !== 'function')) description.textContent = '原生菜单入口不可用。'
      else if (action === 'edit' && !state.nativeFocusSubscribed) description.textContent = '原生焦点归属入口不可用。'
      else if (action === 'settings' && typeof app?.settingsOpen !== 'function') description.textContent = '原生设置入口不可用。'
      else if (action === 'settings' && state.status !== 'context-mounted') description.textContent = '账号工作区尚未挂载，原生设置不可用。'
      else description.textContent = action === 'settings' ? '打开已挂载账号工作区的设置' : `打开系统${action === 'application' ? '应用' : '编辑'}菜单`
    }
  }

  function appendNativeMenuEntries(body, generation) {
    const heading = document.createElement('p')
    heading.textContent = '原生菜单'
    body.append(heading)
    for (const entry of nativeMenuActions) {
      const button = document.createElement('button')
      button.className = 'mdl-row'
      button.type = 'button'
      button.style.width = '100%'
      button.style.textAlign = 'left'
      button.style.background = 'transparent'
      button.style.border = '0'
      button.style.color = 'inherit'
      button.dataset.nativeAction = entry.id
      button.dataset.nativeGeneration = String(generation)
      const badge = document.createElement('div')
      badge.className = 'mdl-badge'
      badge.textContent = entry.badge
      const identity = document.createElement('div')
      const title = document.createElement('div')
      title.className = 'mdl-name'
      title.textContent = entry.label
      const description = document.createElement('div')
      description.className = 'mdl-desc'
      identity.append(title, description)
      button.append(badge, identity)
      button.addEventListener('mouseenter', () => { button.style.background = 'var(--bg-panel-hover)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.addEventListener('click', () => { void openNativeAction(entry, generation, body, button) })
      body.append(button)
    }
    renderNativeMenuEntries(body, generation)
    if (state.nativeActionMessage) {
      const note = document.createElement('div')
      note.className = 'modal-note'
      note.textContent = state.nativeActionMessage
      body.append(note)
      state.nativeActionMessage = ''
    }
  }

  async function openNativeAction(entry, generation, body, button) {
    if (state.disposed || !nativeMenuActions.includes(entry) || !knownFolderPickerIsCurrent(generation, body)
      || !nativeActionAvailable(entry.id) || state.pendingNativeActions.has(entry.id)) return
    const rect = entry.menu ? button.getBoundingClientRect() : undefined
    if (entry.menu && (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom) || rect.left < 0 || rect.bottom < 0)) return
    const sourceEditor = state.sourceEditor
    const actionGeneration = ++state.nativeActionGeneration
    state.pendingNativeActions.add(entry.id)
    renderNativeMenuEntries(body, generation)
    closePicker()
    const closedPickerGeneration = state.folderPickerGeneration
    let failure = ''
    try {
      if (entry.menu) {
        sync()
        await state.syncQueue
        if (state.disposed || actionGeneration !== state.nativeActionGeneration || state.folderPickerGeneration !== closedPickerGeneration || modalVisible()) return
        await app.openWindowsMenu(entry.menu, rect.left, rect.bottom, sourceEditor)
      } else {
        if (!state.created) throw Error('settings unavailable')
        const status = await account?.status?.()
        if (state.disposed || actionGeneration !== state.nativeActionGeneration || state.folderPickerGeneration !== closedPickerGeneration || modalVisible()) return
        if (status?.status !== 'context-mounted') throw Error('settings unavailable')
        await app.settingsOpen()
      }
    } catch {
      failure = entry.id === 'settings' ? '原生设置暂不可用。' : '原生菜单暂不可用。'
    } finally {
      state.pendingNativeActions.delete(entry.id)
      const activeBody = document.getElementById('modal-body')
      const activeGeneration = state.folderPickerGeneration
      if (knownFolderPickerIsCurrent(activeGeneration, activeBody)) renderNativeMenuEntries(activeBody, activeGeneration)
      if (failure && !state.disposed && actionGeneration === state.nativeActionGeneration
        && state.folderPickerGeneration === closedPickerGeneration && !modalVisible()
        && document.getElementById('modal-title')?.textContent === '原生工作区') {
        state.nativeActionMessage = failure
        openPicker()
      }
    }
  }

  function appendKnownFolderEntries(body, generation) {
    const heading = document.createElement('p')
    heading.textContent = '本机文件夹'
    body.append(heading)
    const available = isTrustedAppOrigin() && typeof app?.openKnownFolder === 'function'
    for (const entry of knownFolderEntries) {
      const button = document.createElement('button')
      button.className = 'mdl-row'
      button.type = 'button'
      button.style.width = '100%'
      button.style.textAlign = 'left'
      button.style.background = 'transparent'
      button.style.border = '0'
      button.style.color = 'inherit'
      button.addEventListener('mouseenter', () => { button.style.background = 'var(--bg-panel-hover)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.dataset.knownFolder = entry.key
      button.dataset.folderGeneration = String(generation)
      const pending = state.pendingKnownFolders.has(entry.key)
      button.disabled = !available || pending
      const badge = document.createElement('div')
      badge.className = 'mdl-badge'
      badge.textContent = entry.badge
      const title = document.createElement('div')
      title.className = 'mdl-name'
      title.textContent = entry.label
      const description = document.createElement('div')
      description.className = 'mdl-desc'
      description.textContent = !available ? '本机文件夹入口不可用。'
        : pending ? `正在打开${entry.label}…` : `打开系统${entry.label}文件夹`
      const identity = document.createElement('div')
      identity.append(title, description)
      button.append(badge, identity)
      button.addEventListener('click', () => { void openKnownFolder(entry, generation, body) })
      body.append(button)
    }
    if (!available) {
      const note = document.createElement('div')
      note.className = 'stat-sub'
      note.textContent = '本机文件夹入口不可用。'
      body.append(note)
    }
  }

  function hasUiScaleBridge() {
    return isTrustedAppOrigin() && state.uiScaleSubscribed
      && typeof app?.getUiScale === 'function' && typeof app?.setUiScale === 'function'
      && typeof app?.onUiScaleChanged === 'function'
  }

  function formatUiScale(value) {
    return `${Math.round(value * 100)}%`
  }

  function renderUiScaleMenu(body, generation, message = state.uiScaleMessage) {
    if (!knownFolderPickerIsCurrent(generation, body)) return
    const available = hasUiScaleBridge()
    for (const row of body.querySelectorAll('[data-ui-scale]')) {
      const value = Number(row.dataset.uiScale)
      row.disabled = !available || !state.uiScaleKnown || state.uiScaleLoading || state.uiScalePending
      const right = row.querySelector('.mdl-right')
      right?.replaceChildren()
      if (state.uiScaleKnown && state.uiScaleValue === value) {
        const selected = document.createElement('span')
        selected.className = 'tag ok'
        selected.textContent = '当前'
        right?.append(selected)
      }
    }
    const status = body.querySelector('[data-ui-scale-status]')
    if (!status) return
    status.textContent = !available ? '界面缩放入口不可用。'
      : message || (state.uiScaleKnown ? `当前界面缩放：${formatUiScale(state.uiScaleValue)}` : '读取当前界面缩放…')
  }

  async function readUiScale(body, generation) {
    if (!hasUiScaleBridge()) {
      state.uiScaleLoading = false
      state.uiScaleMessage = '界面缩放入口不可用。'
      renderUiScaleMenu(body, generation)
      return
    }
    const readGeneration = ++state.uiScaleReadGeneration
    const revision = state.uiScaleRevision
    state.uiScaleLoading = true
    state.uiScaleMessage = '正在读取当前界面缩放…'
    renderUiScaleMenu(body, generation)
    try {
      const value = await app.getUiScale()
      if (state.disposed || readGeneration !== state.uiScaleReadGeneration
        || revision !== state.uiScaleRevision || !knownFolderPickerIsCurrent(generation, body)) return
      state.uiScaleLoading = false
      if (!uiScaleChoices.includes(value)) {
        state.uiScaleKnown = false
        state.uiScaleValue = undefined
        state.uiScaleMessage = '当前界面缩放值无法识别。'
      } else {
        state.uiScaleKnown = true
        state.uiScaleValue = value
        state.uiScaleRevision++
        state.uiScaleMessage = `当前界面缩放：${formatUiScale(value)}`
      }
      renderUiScaleMenu(body, generation)
    } catch {
      if (state.disposed || readGeneration !== state.uiScaleReadGeneration
        || revision !== state.uiScaleRevision || !knownFolderPickerIsCurrent(generation, body)) return
      state.uiScaleLoading = false
      state.uiScaleMessage = state.uiScaleKnown
        ? `读取失败，保留上次确认值：${formatUiScale(state.uiScaleValue)}`
        : '读取界面缩放失败。'
      renderUiScaleMenu(body, generation)
    }
  }

  async function requestUiScale(value, body, generation) {
    if (!uiScaleChoices.includes(value) || !hasUiScaleBridge() || !state.uiScaleKnown
      || state.uiScaleLoading || state.uiScalePending || !knownFolderPickerIsCurrent(generation, body)) return
    const revision = state.uiScaleRevision
    state.uiScalePending = true
    state.uiScaleMessage = '正在保存界面缩放…'
    renderUiScaleMenu(body, generation)
    let result
    let errorMessage = ''
    try {
      result = await app.setUiScale(value)
      if (!uiScaleChoices.includes(result)) throw Error('invalid scale result')
      if (revision === state.uiScaleRevision) {
        state.uiScaleValue = result
        state.uiScaleKnown = true
        state.uiScaleRevision++
      }
    } catch {
      errorMessage = '保存界面缩放失败。'
    } finally {
      state.uiScalePending = false
      if (errorMessage && state.folderPickerGeneration === generation) state.uiScaleMessage = errorMessage
      else if (!errorMessage && revision === state.uiScaleRevision - 1) state.uiScaleMessage = `已保存界面缩放：${formatUiScale(state.uiScaleValue)}`
      else state.uiScaleMessage = state.uiScaleKnown ? `当前界面缩放：${formatUiScale(state.uiScaleValue)}` : ''
      const activeBody = document.getElementById('modal-body')
      const activeGeneration = state.folderPickerGeneration
      if (knownFolderPickerIsCurrent(activeGeneration, activeBody)) renderUiScaleMenu(activeBody, activeGeneration)
    }
  }

  function receiveUiScale(value) {
    if (state.disposed) return
    if (!uiScaleChoices.includes(value)) return
    state.uiScaleRevision++
    state.uiScaleReadGeneration++
    state.uiScaleValue = value
    state.uiScaleKnown = true
    state.uiScaleLoading = false
    state.uiScaleMessage = `当前界面缩放：${formatUiScale(value)}`
    const body = document.getElementById('modal-body')
    const generation = state.folderPickerGeneration
    if (knownFolderPickerIsCurrent(generation, body)) renderUiScaleMenu(body, generation)
  }

  function appendUiScaleEntries(body, generation) {
    const heading = document.createElement('p')
    heading.textContent = '界面缩放'
    body.append(heading)
    for (const value of uiScaleChoices) {
      const button = document.createElement('button')
      button.className = 'mdl-row'
      button.type = 'button'
      button.style.width = '100%'
      button.style.textAlign = 'left'
      button.style.background = 'transparent'
      button.style.border = '0'
      button.style.color = 'inherit'
      button.addEventListener('mouseenter', () => { button.style.background = 'var(--bg-panel-hover)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.dataset.uiScale = String(value)
      button.dataset.scaleGeneration = String(generation)
      const badge = document.createElement('div')
      badge.className = 'mdl-badge'
      badge.textContent = 'A'
      const identity = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'mdl-name'
      name.textContent = formatUiScale(value)
      const description = document.createElement('div')
      description.className = 'mdl-desc'
      description.textContent = '整体界面大小'
      identity.append(name, description)
      const right = document.createElement('div')
      right.className = 'mdl-right'
      button.append(badge, identity, right)
      button.addEventListener('click', () => { void requestUiScale(value, body, generation) })
      body.append(button)
    }
    const status = document.createElement('div')
    status.className = 'modal-note'
    status.dataset.uiScaleStatus = ''
    body.append(status)
    state.uiScaleMessage = hasUiScaleBridge() ? '正在读取当前界面缩放…' : '界面缩放入口不可用。'
    state.uiScaleLoading = hasUiScaleBridge()
    renderUiScaleMenu(body, generation)
    if (state.uiScaleLoading) void readUiScale(body, generation)
  }

  async function openKnownFolder(entry, generation, body) {
    if (!knownFolderEntries.includes(entry) || !knownFolderPickerIsCurrent(generation, body)
      || !isTrustedAppOrigin() || typeof app?.openKnownFolder !== 'function'
      || state.pendingKnownFolders.has(entry.key)) return
    state.pendingKnownFolders.add(entry.key)
    const currentButton = [...body.querySelectorAll('[data-known-folder]')]
      .find(button => button.dataset.knownFolder === entry.key && button.dataset.folderGeneration === String(generation))
    const currentDescription = currentButton?.querySelector('.mdl-desc')
    if (currentButton) currentButton.disabled = true
    if (currentDescription) currentDescription.textContent = `正在打开${entry.label}…`
    let opened = false
    try {
      const result = await app.openKnownFolder(entry.key)
      if (result?.accepted !== true) throw Error('folder open rejected')
      opened = true
    } catch { /* Show only a fixed product message. */ }
    finally {
      state.pendingKnownFolders.delete(entry.key)
      for (const button of document.querySelectorAll('[data-known-folder]')) {
        if (button.dataset.knownFolder !== entry.key) continue
        button.disabled = !isTrustedAppOrigin() || typeof app?.openKnownFolder !== 'function'
          || state.pendingKnownFolders.has(entry.key)
        const description = button.querySelector('.mdl-desc')
        if (description && button.dataset.folderGeneration !== String(generation)) {
          description.textContent = `打开系统${entry.label}文件夹`
        }
      }
      if (knownFolderPickerIsCurrent(generation, body) && currentButton?.isConnected) {
        if (currentDescription) currentDescription.textContent = opened ? `已请求打开${entry.label}` : `未能打开${entry.label}。`
        currentButton.disabled = false
      }
    }
  }

  function openPicker() {
    if (!modal) return
    const generation = ++state.folderPickerGeneration
    const title = document.getElementById('modal-title')
    const body = document.getElementById('modal-body')
    title.textContent = '原生工作区'
    body.replaceChildren()
    const note = document.createElement('p')
    note.textContent = '选择当前场景中的聊天面板，打开原生工作区。'
    body.append(note)
    appendAccountWindowEntries(body, generation)
    appendNativeMenuEntries(body, generation)
    appendKnownFolderEntries(body, generation)
    appendUiScaleEntries(body, generation)
    const sceneId = currentSceneId()
    const scene = scenes.find(item => item.id === sceneId)
    const choices = (scene?.panels || []).filter(panel => panel.type === 'chat' || panel.type === 'native-chat')
    if (params.get('solo') === '1') {
      const unavailable = document.createElement('p')
      unavailable.textContent = '请在主窗口打开原生工作区。'
      body.append(unavailable)
    } else if (!choices.length) {
      const empty = document.createElement('p')
      empty.textContent = '当前场景没有聊天面板。原场景保持不变。'
      body.append(empty)
    } else {
      for (const panel of choices) {
        const button = document.createElement('button')
        button.className = 'mdl-row'
        button.type = 'button'
        button.style.width = '100%'
        button.style.textAlign = 'left'
        button.style.background = 'transparent'
        button.style.border = '0'
        button.style.color = 'inherit'
        button.dataset.targetScene = sceneId
        button.dataset.targetPanel = panel.id
        const badge = document.createElement('div')
        badge.className = 'mdl-badge'
        badge.textContent = 'AI'
        const title = document.createElement('div')
        title.className = 'mdl-name'
        title.textContent = `${scene.name} · ${panel.title}`
        button.append(badge, title)
        button.addEventListener('click', () => { void mountTarget(sceneId, panel.id) })
        body.append(button)
      }
    }
    const businessHeading = document.createElement('p')
    businessHeading.textContent = '织贸业务'
    body.append(businessHeading)
    for (const entry of businessEntries) {
      const button = document.createElement('button')
      button.className = 'mdl-row'
      button.type = 'button'
      button.style.width = '100%'
      button.style.textAlign = 'left'
      button.style.background = 'transparent'
      button.style.border = '0'
      button.style.color = 'inherit'
      button.dataset.businessEntry = entry.id
      button.disabled = !isTrustedAppOrigin()
      const badge = document.createElement('div')
      badge.className = 'mdl-badge'
      badge.textContent = '织'
      const title = document.createElement('div')
      title.className = 'mdl-name'
      title.textContent = entry.label
      button.append(badge, title)
      button.addEventListener('click', () => openBusinessEntry(entry))
      body.append(button)
    }
    modal.style.display = 'flex'
    renderAccountWindowEntries(body, generation)
    renderNativeMenuEntries(body, generation)
    renderUiScaleMenu(body, generation)
    sync()
  }

  function accountWindowPickerIsCurrent(generation, body) {
    return !state.disposed && state.folderPickerGeneration === generation
      && modal?.style.display !== 'none' && body?.isConnected
      && document.getElementById('modal-body') === body
      && document.getElementById('modal-title')?.textContent === '原生工作区'
  }

  function accountWindowActionAvailable(action) {
    if (!isTrustedAppOrigin() || !state.created || state.status === 'error' || state.pendingAccountWindowAction) return false
    if (action === 'popout') return state.placement === 'docked' && typeof account?.popOut === 'function'
    return action === 'return' && state.placement === 'popout' && typeof account?.returnToDock === 'function'
  }

  function appendAccountWindowEntries(body, generation) {
    const heading = document.createElement('p')
    heading.textContent = '账号窗口'
    body.append(heading)
    for (const [action, label, badge] of [['popout','弹出独立窗口','弹'],['return','收回到主窗口','回']]) {
      const button = document.createElement('button')
      button.className = 'mdl-row'
      button.type = 'button'
      button.style.width = '100%'
      button.style.textAlign = 'left'
      button.style.background = 'transparent'
      button.style.border = '0'
      button.style.color = 'inherit'
      button.dataset.accountWindowAction = action
      button.dataset.accountWindowGeneration = String(generation)
      const badgeNode = document.createElement('div')
      badgeNode.className = 'mdl-badge'
      badgeNode.textContent = badge
      const identity = document.createElement('div')
      const title = document.createElement('div')
      title.className = 'mdl-name'
      title.textContent = label
      const description = document.createElement('div')
      description.className = 'mdl-desc'
      identity.append(title, description)
      button.append(badgeNode, identity)
      button.addEventListener('mouseenter', () => { button.style.background = 'var(--bg-panel-hover)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.addEventListener('click', () => { void requestAccountWindowAction(action, generation, body) })
      body.append(button)
    }
    renderAccountWindowEntries(body, generation)
  }

  function renderAccountWindowEntries(body, generation) {
    if (!accountWindowPickerIsCurrent(generation, body)) return
    for (const button of body.querySelectorAll('[data-account-window-action]')) {
      const action = button.dataset.accountWindowAction
      const pending = state.pendingAccountWindowAction === action
      button.disabled = pending || !accountWindowActionAvailable(action)
      const description = button.querySelector('.mdl-desc')
      if (description) description.textContent = pending ? '正在切换账号窗口…'
        : action === 'popout' ? (state.placement === 'popout' ? '账号工作区已在独立窗口中' : '在独立窗口中显示当前账号工作区')
          : (state.placement === 'popout' ? '将当前账号工作区收回主窗口' : '账号工作区当前位于主窗口')
    }
  }

  async function requestAccountWindowAction(action, generation, body) {
    if (!['popout','return'].includes(action) || !accountWindowPickerIsCurrent(generation, body)
      || !accountWindowActionAvailable(action)) return
    state.pendingAccountWindowAction = action
    renderAccountWindowEntries(body, generation)
    closePicker()
    const closedGeneration = state.folderPickerGeneration
    const actionGeneration = (state.accountWindowActionGeneration || 0) + 1
    state.accountWindowActionGeneration = actionGeneration
    let failure = ''
    try {
      if (action === 'popout') {
        sync()
        await state.syncQueue
      }
      if (state.disposed || actionGeneration !== state.accountWindowActionGeneration || state.folderPickerGeneration !== closedGeneration) return
      const beforeStatusRevision = state.statusRevision
      const result = await account[action === 'popout' ? 'popOut' : 'returnToDock']()
      if (!state.disposed && beforeStatusRevision === state.statusRevision && result) receiveStatus(result)
    } catch {
      failure = action === 'popout' ? '独立窗口暂不可用。' : '无法收回账号窗口。'
    } finally {
      if (state.pendingAccountWindowAction === action) state.pendingAccountWindowAction = undefined
      const activeBody = document.getElementById('modal-body')
      const activeGeneration = state.folderPickerGeneration
      if (accountWindowPickerIsCurrent(activeGeneration, activeBody)) renderAccountWindowEntries(activeBody, activeGeneration)
      if (failure && !state.disposed && actionGeneration === state.accountWindowActionGeneration
        && state.folderPickerGeneration === closedGeneration && !modalVisible()) showSplitFailure(failure)
    }
  }

  function openBusinessEntry(entry) {
    if (!isTrustedAppOrigin() || !businessEntries.includes(entry)) return
    const title = document.getElementById('modal-title')
    const body = document.getElementById('modal-body')
    title.textContent = entry.label
    body.replaceChildren()
    const frame = document.createElement('iframe')
    frame.title = entry.label
    frame.src = entry.path
    frame.style.width = '100%'
    frame.style.height = '60vh'
    frame.style.minHeight = '360px'
    frame.style.border = '0'
    frame.addEventListener('error', () => {
      if (!frame.isConnected || body.querySelector('#modal-body iframe') !== frame) return
      if (body.querySelector('.business-frame-error')) return
      const note = document.createElement('p')
      note.className = 'business-frame-error'
      note.textContent = '页面加载失败，请关闭此面板后重试。'
      body.append(note)
    })
    body.append(frame)
  }

  const themePaletteKeys = ['canvas','panel','header','border','text','muted','accent','accentStrong','accentSoft','teal','buttonInk','danger','dangerBackground','dangerBorder','warning','warningBackground','warningBorder','success','successBackground']
  const themeUiKeys = ['fontFamily','fontBody','fontCompact','lineHeight','topRowHeight','navHeight','modelControl','sceneTabHeight','dockTabHeight','controlHeight','toolbarHeight','iconSize','cornerRadius']
  const hasExactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  function acceptThemeSnapshot(snapshot) {
    if (!snapshot || !['light','dark','system'].includes(snapshot.preference) || !['light','dark'].includes(snapshot.colorScheme)
      || !hasExactKeys(snapshot.palette, themePaletteKeys) || !hasExactKeys(snapshot.ui, themeUiKeys)) return false
    if (themePaletteKeys.some(key => typeof snapshot.palette[key] !== 'string')
      || themeUiKeys.some(key => key === 'fontFamily' ? typeof snapshot.ui[key] !== 'string' : !Number.isFinite(snapshot.ui[key]))) return false
    state.themeSnapshot = snapshot
    return true
  }
  function isActiveBusinessFrame(frame) {
    if (!isTrustedAppOrigin() || !frame?.isConnected || !frame.matches('iframe[data-business-preview]')) return false
    const entry = businessEntries.find(item => item.id === frame.dataset.businessPreview)
    if (!entry || frame.closest('.panel-chat') || frame.closest('.panel')?.dataset.businessRoute !== entry.id) return false
    try {
      const url = new URL(frame.getAttribute('src'), location.href)
      return url.origin === location.origin && url.pathname === entry.path
    } catch { return false }
  }
  function sendBusinessTheme(frame) {
    if (!isActiveBusinessFrame(frame) || !state.themeSnapshot) return
    try {
      frame.contentWindow?.postMessage({
        type: 'tradeloom:theme',
        colorScheme: state.themeSnapshot.colorScheme,
        palette: state.themeSnapshot.palette,
        ui: state.themeSnapshot.ui,
      }, location.origin)
    } catch { /* The frame may be navigating. Its next load receives the current tokens. */ }
  }
  function sendThemeToActiveBusinessFrames() {
    for (const frame of document.querySelectorAll('#grid iframe[data-business-preview]')) sendBusinessTheme(frame)
  }
  function onBusinessThemeRequest(event) {
    if (event.origin !== location.origin || event.data?.type !== 'tradeloom:theme:request'
      || Object.keys(event.data ?? {}).sort().join(',') !== 'type') return
    const frame = [...document.querySelectorAll('#grid iframe[data-business-preview]')]
      .find(candidate => candidate.contentWindow === event.source)
    if (frame) sendBusinessTheme(frame)
  }
  if (isTrustedAppOrigin() && params.get('solo') !== '1' && app?.sourceTheme) {
    if (typeof app.sourceTheme.onChanged === 'function') {
      state.offThemeChanged = app.sourceTheme.onChanged(snapshot => {
        if (acceptThemeSnapshot(snapshot)) sendThemeToActiveBusinessFrames()
      })
    }
    if (typeof app.sourceTheme.getSnapshot === 'function') {
      void app.sourceTheme.getSnapshot().then(snapshot => {
        if (acceptThemeSnapshot(snapshot)) sendThemeToActiveBusinessFrames()
      }).catch(() => {})
    }
    window.addEventListener('message', onBusinessThemeRequest)
  }

  async function mountDefaultAccount() {
    if (!isTrustedAppOrigin() || params.get('solo') === '1') return { status: 'unavailable' }
    if (Array.isArray(productConfig?.roles) && productConfig?.sessionBindings && typeof productConfig.sessionBindings === 'object') {
      if (!account || typeof account.create !== 'function') return { status: 'unavailable' }
      if (state.created) return { status: 'mounted' }
      if (!state.offStatus && typeof account.onStatus === 'function') {
        state.offStatus = account.onStatus(value => receiveStatus(value))
      }
      try {
        const value = await account.create()
        if (state.disposed) return { status: 'unavailable' }
        state.created = true
        receiveStatus(value)
        try {
          const snapshot = await account.status()
          if (!state.disposed && snapshot?.status) receiveStatus(snapshot)
        } catch { /* Keep the create result; account status remains explicitly unknown. */ }
        return { status: 'mounted' }
      } catch {
        receiveStatus({ status: 'error' })
        return { status: 'unavailable' }
      }
    }
    const sceneId = currentSceneId()
    const scene = scenes.find(item => item.id === sceneId)
    const target = scene?.panels?.find(panel => panel.type === 'chat' || panel.type === 'native-chat')
    if (!target) return { status: 'no-chat-panel' }
    await mountTarget(sceneId, target.id)
    return { status: state.created ? 'mounted' : 'unavailable' }
  }

  function roleSurfaceKey(sceneId, panelId) { return `${sceneId}\u0000${panelId}` }

  function roleSurfaceVisible(record) {
    const rect = record.content?.getBoundingClientRect?.()
    return !state.disposed && record.content?.isConnected === true && record.sceneId === currentSceneId()
      && rect && rect.width > 0 && rect.height > 0 && record.panel?.isConnected === true
      && !(state.accountChatMode && state.target?.sceneId === record.sceneId && state.target?.panelId === record.panelId)
      && getComputedStyle(record.panel).display !== 'none' && !record.panel.hidden
      && !modalVisible() && !menuVisible()
  }

  function syncRoleSurface(record) {
    const bridge = app?.harnessSurface
    if (!bridge || !record.created || record.pendingPlacement || record.placement === 'popped-out' || !record.content?.isConnected) return
    const revision = (record.syncRevision || 0) + 1
    record.syncRevision = revision
    const task = Promise.resolve(record.syncQueue).catch(() => {}).then(async () => {
      if (state.disposed || record.syncRevision !== revision || record.pendingPlacement || record.placement !== 'docked'
        || state.roleSurfaces.get(roleSurfaceKey(record.sceneId, record.panelId)) !== record) return
      const visible = roleSurfaceVisible(record)
      if (!visible) {
        if (record.visible !== false) {
          try {
            await bridge.setVisible(record.sceneId, record.panelId, false)
            if (record.syncRevision === revision && !record.pendingPlacement && record.placement === 'docked') record.visible = false
          } catch {
            if (record.syncRevision === revision && !record.pendingPlacement && record.placement === 'docked') record.status = 'error'
          }
        }
        return
      }
      const bounds = liveRoleBounds(record)
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return
      try {
        await bridge.setBounds(record.sceneId, record.panelId, bounds)
        if (record.syncRevision !== revision || record.pendingPlacement || record.placement !== 'docked') return
        if (record.status !== 'unbound' && record.status !== 'owned-elsewhere') {
          await bridge.setVisible(record.sceneId, record.panelId, true)
          if (record.syncRevision === revision && !record.pendingPlacement && record.placement === 'docked') record.visible = true
        }
      } catch {
        if (record.syncRevision === revision && !record.pendingPlacement && record.placement === 'docked') {
          record.status = 'error'
          record.note.textContent = '原生助手面板暂不可用。'
        }
      }
    })
    record.syncQueue = task
    return task
  }

  function onRoleSurfaceStatus(value) {
    if (!value || typeof value.sceneId !== 'string' || typeof value.panelId !== 'string') return
    const record = state.roleSurfaces.get(roleSurfaceKey(value.sceneId, value.panelId))
    if (!record || typeof value.status !== 'string') return
    record.hostStatusRevision = (record.hostStatusRevision || 0) + 1
    record.status = value.status
    updateRolePlacementControl(record)
    if (value.placement === 'docked' || value.placement === 'popped-out') {
      if (record.placement !== value.placement) {
        record.placement = value.placement
        record.syncRevision = (record.syncRevision || 0) + 1
        updateRolePlacementControl(record)
        if (value.placement === 'docked') void syncRoleSurface(record)
        startRoleGeometryFrames()
      }
    }
    if (value.status === 'unbound') record.note.textContent = '此原生助手尚未绑定会话。'
    else if (value.status === 'owned-elsewhere') record.note.textContent = value.focused === true ? '已切换到此会话的独立窗口。' : '此助手会话已在其他面板打开。'
    else if (value.status === 'error') record.note.textContent = '原生助手面板暂不可用。'
    else if (value.status === 'context-mounted') record.note.textContent = record.placement === 'popped-out' ? '已在独立窗口打开。' : ''
  }

  function updateRolePlacementControl(record) {
    const button = record.placementButton
    if (!button) return
    button.hidden = record.status === 'owned-elsewhere'
    if (button.hidden) return
    const poppedOut = record.placement === 'popped-out'
    button.textContent = poppedOut ? '↙' : '↗'
    button.title = poppedOut ? '收回工作台' : '独立窗口'
    button.setAttribute('aria-label', button.title)
  }

  async function requestRolePlacement(record) {
    const bridge = app?.harnessSurface
    if (!bridge || record.pendingPlacement || !record.created) return
    const action = record.placement === 'popped-out' ? 'returnToDock' : 'popOut'
    if (typeof bridge[action] !== 'function') return
    record.pendingPlacement = true
    record.placementButton.disabled = true
    record.note.textContent = action === 'popOut' ? '正在打开独立窗口…' : '正在收回工作台…'
    if (action === 'popOut') record.syncRevision = (record.syncRevision || 0) + 1
    const hostStatusRevision = record.hostStatusRevision || 0
    try {
      await bridge[action](record.sceneId, record.panelId)
      if (state.roleSurfaces.get(roleSurfaceKey(record.sceneId, record.panelId)) !== record) return
      const value = typeof bridge.status === 'function' ? await bridge.status(record.sceneId, record.panelId) : undefined
      if (value && typeof value.status === 'string' && (record.hostStatusRevision || 0) === hostStatusRevision) {
        onRoleSurfaceStatus({ sceneId: record.sceneId, panelId: record.panelId, ...value })
      } else if ((record.hostStatusRevision || 0) === hostStatusRevision) {
        record.note.textContent = action === 'returnToDock' ? '收回状态尚未确认；原生助手保持原位。' : '独立窗口状态尚未确认；原生助手保持原位。'
      }
    } catch {
      if (state.roleSurfaces.get(roleSurfaceKey(record.sceneId, record.panelId)) === record
        && (record.hostStatusRevision || 0) === hostStatusRevision) {
        record.note.textContent = action === 'popOut' ? '无法打开独立窗口；原生助手保持原位。' : '无法收回工作台；原生助手保持独立窗口。'
      }
    } finally {
      record.pendingPlacement = false
      if (state.roleSurfaces.get(roleSurfaceKey(record.sceneId, record.panelId)) === record) {
        record.placementButton.disabled = false
        if (record.placement === 'docked') void syncRoleSurface(record)
      }
    }
  }

  function renderRolePanel(meta, content) {
    const sceneId = currentSceneId()
    const panelId = typeof meta?.id === 'string' ? meta.id : ''
    const bridge = app?.harnessSurface
    const note = document.createElement('div')
    note.className = 'runtime-empty'
    note.textContent = '正在连接原生助手…'
    content.replaceChildren(note)
    if (!isTrustedAppOrigin() || !sceneId || !panelId || typeof bridge?.create !== 'function') {
      note.textContent = '原生助手面板未连接。'
      return () => content.replaceChildren()
    }
    const record = { sceneId, panelId, meta, content, panel: content.closest('.panel'), note, status: 'loading', created: false, visible: false, placement: 'docked', hostStatusRevision: 0, motionActive: false }
    const controls = record.panel?.querySelector('.panel-controls')
    if (controls) {
      const placementButton = document.createElement('button')
      placementButton.type = 'button'
      placementButton.className = 'icon-control'
      placementButton.dataset.rolePlacement = 'true'
      placementButton.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void requestRolePlacement(record) })
      record.placementButton = placementButton
      controls.append(placementButton)
      updateRolePlacementControl(record)
    }
    const key = roleSurfaceKey(sceneId, panelId)
    state.roleSurfaces.set(key, record)
    if (!state.offRoleSurfaceStatus && typeof bridge.onStatus === 'function') {
      try { state.offRoleSurfaceStatus = bridge.onStatus(onRoleSurfaceStatus) } catch { /* The create response remains authoritative. */ }
    }
    if (!state.roleSurfaceObserver && typeof ResizeObserver === 'function') {
      state.roleSurfaceObserver = new ResizeObserver(() => { for (const item of state.roleSurfaces.values()) void syncRoleSurface(item); startRoleGeometryFrames() })
      state.roleSurfaceObserver.observe(document.getElementById('grid'))
    }
    void bridge.create(sceneId, panelId).then(async value => {
      if (state.disposed || state.roleSurfaces.get(key) !== record) return
      record.created = record.status !== 'owned-elsewhere'
      record.status = typeof value?.status === 'string' ? value.status : 'error'
      record.created = record.status !== 'owned-elsewhere'
      onRoleSurfaceStatus({ sceneId, panelId, status: record.status, placement: value?.placement, focused: value?.focused })
      if (record.status !== 'owned-elsewhere' && typeof bridge.status === 'function') {
        const hostStatusRevision = record.hostStatusRevision
        try {
          const status = await bridge.status(sceneId, panelId)
          if (record.hostStatusRevision === hostStatusRevision) onRoleSurfaceStatus({ sceneId, panelId, ...status })
        } catch { /* Create remains authoritative. */ }
      }
      if (record.status !== 'owned-elsewhere') await syncRoleSurface(record)
    }).catch(() => {
      if (state.roleSurfaces.get(key) !== record) return
      record.status = 'error'
      note.textContent = '原生助手面板暂不可用。'
    })
    return () => {
      if (state.roleSurfaces.get(key) !== record) return
      state.roleSurfaces.delete(key)
      record.placementButton?.remove()
      if (record.created && record.placement !== 'popped-out') void bridge.setVisible(sceneId, panelId, false).catch(() => {})
      content.replaceChildren()
    }
  }

  function showAccountChat(request) {
    if (!isTrustedAppOrigin() || !request || typeof request !== 'object') return false
    if (request.action === 'openBoundSession') {
      if (Object.keys(request).sort().join(',') !== 'action,panelId,sceneId,sessionId'
        || typeof request.sceneId !== 'string' || typeof request.panelId !== 'string'
        || typeof request.sessionId !== 'string' || request.sessionId.length < 1 || request.sessionId.length > 256) return false
      const targetScene = scenes.find(scene => scene.id === request.sceneId)
      const targetPanel = targetScene?.panels?.find(panel => panel.id === request.panelId && panel.type === 'native-chat')
      if (!targetPanel) return false
      const sceneChangeRequired = request.sceneId !== currentSceneId()
      if (sceneChangeRequired && typeof state.sceneLoader !== 'function') {
        showSplitFailure('无法切换到此会话原有的场景；原生会话保持不变。')
        return false
      }
      if (state.accountChatMode) closeAccountChat()
      if (sceneChangeRequired) {
        try { state.sceneLoader(request.sceneId) } catch { return false }
      }
      const panelElement = [...document.querySelectorAll('#grid .panel-chat')].find(item => item.dataset.panelId === request.panelId)
      if (!panelElement?.isConnected || panelElement.hidden || getComputedStyle(panelElement).display === 'none') return false
      const rect = panelElement.querySelector('.panel-content')?.getBoundingClientRect?.()
      if (!rect || rect.width <= 0 || rect.height <= 0) return false
      try { panelElement.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) } catch { /* Already visible in the selected scene. */ }
      panelElement.querySelector('.panel-expand')?.focus?.()
      return true
    }
    const action = request.action
    if (!['openSession', 'startSession'].includes(action)) return false
    const sceneId = currentSceneId()
    const scene = scenes.find(item => item.id === sceneId)
    const panel = scene?.panels?.find(item => item.type === 'native-chat')
    if (!panel) {
      showSplitFailure('当前场景没有可承载会话的聊天面板；原生会话已保留。')
      return false
    }
    const wasAccountChatMode = state.accountChatMode
    state.accountChatMode = true
    state.accountChatSceneId = sceneId
    state.target = { sceneId, panelId: panel.id }
    state.statusRevision++
    const panelElement = [...document.querySelectorAll('#grid .panel-chat')].find(item => item.dataset.panelId === panel.id)
    const title = panelElement?.querySelector('.panel-title')
    state.accountChatPanel = panelElement
    if (!wasAccountChatMode) state.accountChatOriginalTitle = panelElement?.__meta?.title ?? title?.textContent ?? ''
    if (title) title.textContent = '会话'
    if (panelElement?.__meta) panelElement.__meta.title = '会话'
    const controls = panelElement?.querySelector('.panel-controls')
    if (controls && !controls.querySelector('[data-account-chat-return]')) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.accountChatReturn = 'true'
      button.className = 'panel-control-button'
      button.title = '返回此面板的固定场景助手'
      button.textContent = '返回场景助手'
      button.addEventListener('click', () => closeAccountChat())
      controls.prepend(button)
    }
    for (const record of state.roleSurfaces.values()) void syncRoleSurface(record)
    if (!state.created) void mountDefaultAccount().then(() => sync())
    sync()
    return true
  }

  function closeAccountChat() {
    if (!state.accountChatMode) return false
    const sceneId = state.accountChatSceneId
    const panelId = state.target?.panelId
    state.accountChatMode = false
    state.accountChatSceneId = undefined
    state.target = null
    state.syncRevision++
    const panel = state.accountChatPanel?.isConnected ? state.accountChatPanel
      : [...document.querySelectorAll('#grid .panel-chat')].find(item => item.dataset.panelId === panelId)
    panel?.querySelector('[data-account-chat-return]')?.remove()
    const title = panel?.querySelector('.panel-title')
    if (title && state.accountChatOriginalTitle) title.textContent = state.accountChatOriginalTitle
    if (panel?.__meta && state.accountChatOriginalTitle) panel.__meta.title = state.accountChatOriginalTitle
    state.accountChatPanel = undefined
    state.accountChatOriginalTitle = undefined
    if (state.created) void account?.setVisible(false).then(() => { state.visible = false }).catch(() => { state.visible = undefined })
    for (const record of state.roleSurfaces.values()) void syncRoleSurface(record)
    if (sceneId && sceneId === currentSceneId()) return true
    return true
  }

  function updateSceneComponentPlacementControl(button,placement) {
    if(!button)return
    if(placement==='docked' || placement==='popped-out')button.dataset.placement=placement
    const poppedOut=button.dataset.placement==='popped-out'
    button.textContent=poppedOut?'↙':'↗'
    button.title=poppedOut?'收回工作台':'独立窗口'
    button.setAttribute('aria-label',button.title)
  }

  async function requestSceneComponentPlacement(button,bridge) {
    if(!button || button.disabled)return
    const action=button.dataset.placement==='popped-out'?'returnToDock':'popOut'
    if(typeof bridge?.[action]!=='function')return
    const previous=button.dataset.placement
    button.disabled=true
    try{
      const result=await bridge[action]()
      const value=result?.placement?result:await bridge.status?.()
      updateSceneComponentPlacementControl(button,value?.placement)
    }catch{
      updateSceneComponentPlacementControl(button,previous)
    }finally{button.disabled=false}
  }

  function addSceneComponentPlacementControl(panel,componentKey,bridge,visible,placement) {
    if(typeof bridge?.popOut!=='function' || typeof bridge?.returnToDock!=='function')return undefined
    const controls=panel?.querySelector('.panel-controls')
    if(!controls)return undefined
    let button=controls.querySelector(`[data-component-placement="${componentKey}"]`)
    if(!button){
      button=document.createElement('button')
      button.type='button';button.className='icon-control';button.dataset.componentPlacement=componentKey
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void requestSceneComponentPlacement(button,bridge)})
      controls.append(button)
    }
    button.hidden=visible!==true
    updateSceneComponentPlacementControl(button,placement)
    return button
  }
  function setWorkflowCanvasVisible(visible) {
    const bridge = app?.workflowCanvas
    if (!bridge || typeof bridge.setVisible !== 'function' || state.workflowCanvasPlacement === 'popped-out') return
    const next = visible === true && !modalVisible() && !menuVisible()
    if (state.workflowCanvasVisible === next) return
    state.workflowCanvasVisible = next
    void bridge.setVisible(next).catch(() => {
      state.workflowCanvasVisible = false
      state.workflowCanvasStatus = 'error'
    })
  }

  function syncWorkflowCanvas(host) {
    const bridge = app?.workflowCanvas
    if (state.workflowCanvasPlacement === 'popped-out') return
    if (!host?.isConnected || typeof bridge?.setBounds !== 'function') return
    const rect = host.getBoundingClientRect()
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      setWorkflowCanvasVisible(false)
      return
    }
    void bridge.setBounds(bounds).then(() => setWorkflowCanvasVisible(true)).catch(() => {
      state.workflowCanvasVisible = false
      state.workflowCanvasStatus = 'error'
    })
  }

  function ensureWorkflowCanvas(host) {
    const bridge = app?.workflowCanvas
    if (!isTrustedAppOrigin() || typeof bridge?.mount !== 'function') {
      state.workflowCanvasStatus = 'unavailable'
      return false
    }
    if (!state.offWorkflowCanvas && typeof bridge.onStatus === 'function') {
      state.offWorkflowCanvas = bridge.onStatus(value => {
        if (!value || value.componentKey && value.componentKey !== 'workflow-canvas-native') return
        state.workflowCanvasStatus = value.status
        if(value.placement){state.workflowCanvasPlacement=value.placement;updateSceneComponentPlacementControl(state.workflowCanvasPlacementControl,value.placement)}
        if (value.status === 'error' || value.status === 'unavailable') setWorkflowCanvasVisible(false)
      })
    }
    if (!state.workflowCanvasMounted) {
      state.workflowCanvasMounted = true
      void bridge.mount().then(value => {
        if (!value || value.componentKey !== 'workflow-canvas-native') throw new Error('invalid native workflow canvas')
        state.workflowCanvasStatus = value.status
        if(value.placement){state.workflowCanvasPlacement=value.placement;updateSceneComponentPlacementControl(state.workflowCanvasPlacementControl,value.placement)}
        if (host.isConnected && host.dataset.active === 'true') syncWorkflowCanvas(host)
      }).catch(() => {
        state.workflowCanvasMounted = false
        state.workflowCanvasStatus = 'error'
        host.replaceChildren(Object.assign(document.createElement('div'), { className: 'business-frame-error', textContent: '原生工作流画布暂不可用。' }))
      })
    }
    if (state.workflowCanvasObserver) state.workflowCanvasObserver.disconnect()
    if (typeof ResizeObserver === 'function') {
      state.workflowCanvasObserver = new ResizeObserver(() => syncWorkflowCanvas(host))
      state.workflowCanvasObserver.observe(host)
    }
    if (state.workflowCanvasMounted && state.workflowCanvasStatus && state.workflowCanvasStatus !== 'error' && state.workflowCanvasStatus !== 'unavailable') syncWorkflowCanvas(host)
    return true
  }

  function hideWorkflowCanvas() {
    state.workflowCanvasObserver?.disconnect()
    state.workflowCanvasObserver = undefined
    setWorkflowCanvasVisible(false)
  }

  function erpNextStatusTarget(meta) {
    if (!productConfig || !meta || meta.type !== 'erpnext-status') return false
    const scene = productConfig.scenes?.find(value => value.id === currentSceneId())
    return scene?.id === 'erpnext' && scene.panels?.some(panel => panel.id === meta.id && panel.type === 'erpnext-status') === true
  }

  function setErpNextStatusVisible(visible) {
    const bridge = app?.erpNextStatus
    if (state.erpNextStatusPlacement === 'popped-out') return
    const next = visible === true && !modalVisible() && !menuVisible()
    if (!bridge || typeof bridge.setVisible !== 'function' || state.erpNextStatusVisible === next) return
    state.erpNextStatusVisible = next
    void bridge.setVisible(next).catch(() => { state.erpNextStatusVisible = false; state.erpNextStatusStatus = 'error' })
  }

  function syncErpNextStatus(host) {
    const bridge = app?.erpNextStatus
    if (state.erpNextStatusPlacement === 'popped-out') return
    if (!host?.isConnected || typeof bridge?.setBounds !== 'function') return
    const rect = host.parentElement?.getBoundingClientRect?.() ?? host.getBoundingClientRect()
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      setErpNextStatusVisible(false)
      return
    }
    void bridge.setBounds(bounds).then(() => setErpNextStatusVisible(true)).catch(() => {
      state.erpNextStatusVisible = false
      state.erpNextStatusStatus = 'error'
      host.textContent = 'ERPNext 状态面板暂不可用。'
    })
  }

  function ensureErpNextStatus(host, meta) {
    const bridge = app?.erpNextStatus
    const sceneId = currentSceneId()
    if (!isTrustedAppOrigin() || !erpNextStatusTarget(meta) || typeof bridge?.mount !== 'function') {
      host.textContent = '此原生状态面板未在当前场景配置中启用。'
      return false
    }
    if (!state.offErpNextStatus && typeof bridge.onStatus === 'function') {
      state.offErpNextStatus = bridge.onStatus(value => {
        if (value?.componentKey !== 'erpnext-status-native' || value.sceneId !== 'erpnext' || value.panelId !== meta.id) return
        state.erpNextStatusStatus = value.status
        if(value.placement){state.erpNextStatusPlacement=value.placement;updateSceneComponentPlacementControl(state.erpNextStatusPlacementControl,value.placement)}
        if (value.status === 'error' || value.status === 'unavailable') setErpNextStatusVisible(false)
      })
    }
    if (!state.erpNextStatusMounted) {
      state.erpNextStatusMounted = true
      void bridge.mount().then(value => {
        if (!value || value.componentKey !== 'erpnext-status-native' || value.sceneId !== 'erpnext' || value.panelId !== meta.id) throw new Error('invalid ERPNext status surface')
        state.erpNextStatusStatus = value.status
        if(value.placement){state.erpNextStatusPlacement=value.placement;updateSceneComponentPlacementControl(state.erpNextStatusPlacementControl,value.placement)}
        if (host.isConnected && sceneId === currentSceneId()) syncErpNextStatus(host)
      }).catch(() => {
        state.erpNextStatusMounted = false
        state.erpNextStatusStatus = 'error'
        host.textContent = 'ERPNext 状态面板暂不可用。'
      })
    }
    if (state.erpNextStatusMounted) syncErpNextStatus(host)
    if (state.erpNextStatusObserver) state.erpNextStatusObserver.disconnect()
    if (typeof ResizeObserver === 'function') {
      state.erpNextStatusObserver = new ResizeObserver(() => syncErpNextStatus(host))
      state.erpNextStatusObserver.observe(host)
    }
    return true
  }

  function hideErpNextStatus() {
    state.erpNextStatusObserver?.disconnect()
    state.erpNextStatusObserver = undefined
    setErpNextStatusVisible(false)
  }

  function renderErpNextStatusPanel(meta, content) {
    state.erpNextStatusPlacementControl=addSceneComponentPlacementControl(content.closest('.panel'),'erpnext-status-native',app?.erpNextStatus,true,state.erpNextStatusPlacement)
    const host = document.createElement('div')
    host.className = 'erpnext-status-native-host'
    host.dataset.erpnextStatusHost = 'true'
    host.style.cssText = 'width:100%;height:100%;min-height:0;'
    host.textContent = '正在连接 ERPNext 状态…'
    content.replaceChildren(host)
    ensureErpNextStatus(host, meta)
    return () => { hideErpNextStatus(); content.replaceChildren() }
  }

  function renderAgentCenter(panel, content, entry) {
    state.workflowCanvasPlacementControl=addSceneComponentPlacementControl(panel,'workflow-canvas-native',app?.workflowCanvas,false,state.workflowCanvasPlacement)
    const tabs = document.createElement('nav')
    tabs.className = 'business-route-tabs'
    tabs.setAttribute('aria-label', '工作流页面')
    const body = document.createElement('div')
    body.className = 'business-route-body'
    const business = document.createElement('button')
    business.type = 'button'; business.textContent = '业务'; business.dataset.workflowView = 'business'; business.setAttribute('aria-current', 'page')
    const canvas = document.createElement('button')
    canvas.type = 'button'; canvas.textContent = '工作流画布'; canvas.dataset.workflowView = 'canvas'; canvas.setAttribute('aria-current', 'false')
    tabs.append(business, canvas)
    const frame = document.createElement('iframe')
    frame.title = entry.label; frame.dataset.businessPreview = entry.id; frame.referrerPolicy = 'no-referrer'; frame.src = entry.path
    frame.dataset.tradeloomBusinessFrame = 'true'
    frame.style.cssText = 'width:100%;height:100%;min-height:0;flex:1;border:0;background:var(--bg)'
    frame.addEventListener('load', () => sendBusinessTheme(frame))
    const host = document.createElement('div')
    host.className = 'workflow-canvas-host'; host.dataset.workflowCanvasHost = 'true'; host.dataset.active = 'false'
    host.style.cssText = 'position:absolute;inset:0;display:none;min-width:0;min-height:0'
    body.style.cssText = 'position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden'
    body.append(frame, host)
    const activate = kind => {
      const isCanvas = kind === 'canvas'
      business.setAttribute('aria-current', isCanvas ? 'false' : 'page')
      canvas.setAttribute('aria-current', isCanvas ? 'page' : 'false')
      frame.hidden = isCanvas
      host.style.display = isCanvas ? 'block' : 'none'
      host.dataset.active = String(isCanvas)
      if(state.workflowCanvasPlacementControl)state.workflowCanvasPlacementControl.hidden=!isCanvas
      if (isCanvas) ensureWorkflowCanvas(host)
      else hideWorkflowCanvas()
    }
    business.addEventListener('click', () => activate('business'))
    canvas.addEventListener('click', () => activate('canvas'))
    content.replaceChildren(tabs, body)
    return panel.dataset.panelId
  }

  function renderBusinessPanel(meta, content) {
    const path = typeof meta?.path === 'string' && meta.path.length <= 512 ? meta.path : ''
    const pathname = path.split(/[?#]/, 1)[0]
    if (!isTrustedAppOrigin() || !productConfig || !Object.hasOwn(productConfig.businessRoutes, pathname)) {
      content.appendChild(Object.assign(document.createElement('div'), { className: 'runtime-empty', textContent: '此业务页面尚未配置到桌面路由。' }))
      return () => content.replaceChildren()
    }
    const route = businessEntries.find(entry => entry.route === pathname)
    const frame = document.createElement('iframe')
    frame.title = typeof meta.title === 'string' ? meta.title : (route?.label ?? '织贸业务')
    frame.dataset.businessPreview = route?.id ?? pathname.slice(1)
    frame.referrerPolicy = 'no-referrer'
    frame.src = `/business${path}`
    frame.dataset.tradeloomBusinessFrame = 'true'
    frame.style.cssText = 'width:100%;height:100%;min-height:0;flex:1;border:0;background:var(--bg)'
    frame.addEventListener('load', () => sendBusinessTheme(frame))
    content.appendChild(frame)
    return () => content.replaceChildren()
  }

  function sceneSelected(scene) {
    if (!scene) return
    if (state.accountChatMode && scene.id !== state.accountChatSceneId) closeAccountChat()
    const selected = businessEntries.find(entry => entry.route === scene.defaultBusinessRoute)?.id
    for (const button of document.querySelectorAll('#business-navigation [data-business-route]')) {
      button.setAttribute('aria-current', button.dataset.businessRoute === selected ? 'page' : 'false')
    }
  }

  function persistSceneOrder(ids) {
    if (!isTrustedAppOrigin() || typeof app?.setSceneOrder !== 'function') return false
    const known = new Set(scenes.map(scene => scene.id))
    const safe = Array.isArray(ids) ? ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index) : []
    productSceneOrder = safe
    void app.setSceneOrder(safe).catch(() => {})
    return true
  }

  function showBusinessRoute(id) {
    if (!isTrustedAppOrigin()) return { status: 'unavailable' }
    const entry = businessEntries.find(item => item.id === id)
    if (!entry) return { status: 'unknown-route' }
    const configuredRoute = productConfig?.businessRoutes?.[entry.route]
    if (configuredRoute) {
      if (configuredRoute.sceneId !== currentSceneId()) state.sceneLoader?.(configuredRoute.sceneId)
      const panel = [...document.querySelectorAll('#grid .panel')].find(item => item.dataset.panelId === configuredRoute.panelId)
      const content = panel?.querySelector('.panel-content')
      if (!panel || !content || panel.classList.contains('panel-chat')) return { status: 'no-preview-pane' }
      hideWorkflowCanvas()
      for (const button of document.querySelectorAll('#business-navigation [data-business-route]')) button.setAttribute('aria-current', button.dataset.businessRoute === id ? 'page' : 'false')
      panel.dataset.businessRoute = entry.id
      const title = panel.querySelector('.panel-title')
      if (title) title.textContent = entry.label
      if (panel.__meta) panel.__meta.title = entry.label
      if (entry.id === 'agent-center') return { status: 'opened', route: entry.id, panelId: renderAgentCenter(panel, content, entry) }
      const meta = { id: configuredRoute.panelId, type: 'business-iframe', title: entry.label, path: entry.route }
      renderBusinessPanel(meta, content)
      return { status: 'opened', route: entry.id, panelId: configuredRoute.panelId }
    }
    if (productConfig) return { status: 'unconfigured', route: entry.id }
    const candidates = [...document.querySelectorAll('#grid .panel:not(.panel-chat)')]
    const panel = candidates.find(item => item.__meta?.type === 'preview')
      || candidates.find(item => item.__meta?.type === 'doc')
      || candidates[0]
    const content = panel?.querySelector('.panel-content')
    if (!panel || !content) return { status: 'no-preview-pane' }
    hideWorkflowCanvas()
    for (const button of document.querySelectorAll('#business-navigation [data-business-route]')) {
      button.setAttribute('aria-current', button.dataset.businessRoute === id ? 'page' : 'false')
    }
    const title = panel.querySelector('.panel-title')
    if (title) title.textContent = entry.label
    if (panel.__meta) panel.__meta.title = entry.label
    panel.dataset.businessRoute = entry.id
    if (entry.id === 'agent-center') return { status: 'opened', route: entry.id, panelId: renderAgentCenter(panel, content, entry) }
    const frame = document.createElement('iframe')
    frame.title = entry.label
    frame.dataset.businessPreview = entry.id
    frame.referrerPolicy = 'no-referrer'
    frame.src = entry.path
    frame.dataset.tradeloomBusinessFrame = 'true'
    frame.style.cssText = 'width:100%;height:100%;min-height:0;flex:1;border:0;background:var(--bg)'
    frame.addEventListener('error', () => {
      if (!frame.isConnected || content.querySelector('[data-business-preview]') !== frame) return
      const note = document.createElement('div')
      note.className = 'business-frame-error'
      note.textContent = '业务页面暂不可用。'
      content.replaceChildren(note)
    })
    frame.addEventListener('load', () => sendBusinessTheme(frame))
    content.replaceChildren(frame)
    return { status: 'opened', route: entry.id, panelId: panel.dataset.panelId }
  }

  function showSplitFailure(message) {
    if (state.disposed || !statusText) return
    statusText.textContent = message
  }

  async function openSceneWindow(sceneId) {
    if (typeof sceneId !== 'string' || !sceneId || typeof app?.listScenarios !== 'function' || typeof app?.win?.openScene !== 'function') {
      showSplitFailure('原生分窗桥不可用；场景和原入口仍保留。')
      return { status: 'unavailable' }
    }
    try {
      const registered = await app.listScenarios()
      if (!Array.isArray(registered) || !registered.some(scene => scene?.id === sceneId)) {
        showSplitFailure('此复刻场景尚未注册到原生分窗；原场景和入口仍保留。')
        return { status: 'unregistered' }
      }
      return await app.win.openScene(sceneId)
    } catch {
      showSplitFailure('原生分窗未能打开；原场景和入口仍保留。')
      return { status: 'error' }
    }
  }

  const controls = document.querySelector('#titlebar .titlebar-controls')
  const sidebarToggle = document.getElementById('btn-sidebar-overlay')
  const globalPanelButton = controls ? document.createElement('button') : undefined
  const setGlobalPanel = value => {
    const valid = value && value.open === true && (value.mode === 'settings' || value.mode === 'panel')
      && (value.mode === 'settings' ? value.panelId === null : typeof value.panelId === 'string' && value.panelId.length > 0)
    state.globalPanel = valid ? { mode:value.mode, panelId:value.panelId, open:true } : undefined
    if (globalPanelButton) {
      globalPanelButton.hidden = !valid
      globalPanelButton.textContent = valid ? (value.mode === 'settings' ? '返回工作台' : '返回工作台') : ''
      globalPanelButton.title = valid ? '关闭全局面板并返回工作台' : ''
      globalPanelButton.setAttribute('aria-label', globalPanelButton.title)
    }
    state.lastBoundsKey = ''
    state.syncRevision++
    if (state.created) sync()
  }
  if (globalPanelButton) {
    globalPanelButton.className = 'tb-btn'
    globalPanelButton.id = 'btn-global-panel-return'
    globalPanelButton.type = 'button'
    globalPanelButton.hidden = true
    globalPanelButton.style.width = 'auto'
    globalPanelButton.style.minWidth = '0'
    globalPanelButton.style.paddingInline = '8px'
    controls.insertBefore(globalPanelButton, document.getElementById('btn-theme'))
  }
  if (typeof account?.onGlobalPanelChanged === 'function') {
    try { state.offGlobalPanel = account.onGlobalPanelChanged(setGlobalPanel) } catch {}
  }
  if (typeof account?.closeGlobalPanel === 'function') {
    globalPanelButton?.addEventListener('click', () => { void account.closeGlobalPanel().catch(() => {}) })
  }
  const sidebarUnavailableReason = () => {
    if (state.placement === 'popout') return '账号工作区已分窗；侧栏跟随分窗窗口'
    if (state.status !== 'context-mounted') return '原生账号工作区尚未挂载'
    return undefined
  }
  const setSidebarToggle = open => {
    if (!sidebarToggle) return
    const unavailable = sidebarUnavailableReason()
    state.accountSidebarOpen = unavailable === undefined && open === true
    sidebarToggle.disabled = unavailable !== undefined || state.sidebarTogglePending === true
    const label = unavailable ?? (state.accountSidebarOpen ? '关闭会话侧栏' : '打开会话侧栏')
    sidebarToggle.setAttribute('aria-pressed', String(state.accountSidebarOpen))
    sidebarToggle.setAttribute('aria-label', label)
    sidebarToggle.title = label
  }
  if (sidebarToggle && typeof account?.toggleSidebar === 'function') {
    if (typeof account.onStatus === 'function') {
      try { state.offSidebarStatus = account.onStatus(value => { receiveStatus(value); setSidebarToggle(state.accountSidebarOpen) }) } catch {}
    }
    if (typeof account.status === 'function') void account.status().then(value => {
      if (state.disposed) return
      receiveStatus(value)
      setSidebarToggle(state.accountSidebarOpen)
    }).catch(() => setSidebarToggle(false))
    if (typeof account.sidebarOpen === 'function') void account.sidebarOpen().then(setSidebarToggle).catch(() => {})
    sidebarToggle.addEventListener('click', async () => {
      if (sidebarUnavailableReason() !== undefined || state.sidebarTogglePending === true) return
      state.sidebarTogglePending = true
      sidebarToggle.disabled = true
      try { setSidebarToggle(await account.setSidebarOpen(!state.accountSidebarOpen) === true) }
      catch { setSidebarToggle(false) }
      finally { state.sidebarTogglePending = false; setSidebarToggle(state.accountSidebarOpen) }
    })
    if (typeof account.onSidebarChanged === 'function') {
      try { state.offSidebar = account.onSidebarChanged(setSidebarToggle) } catch {}
    }
  }
  if (controls) {
    const button = document.createElement('button')
    button.className = 'tb-btn'
    button.id = 'btn-native-workspace'
    button.type = 'button'
    button.title = '选择目标面板并挂载完整原生账号工作区'
    button.textContent = '工作区'
    button.style.width = 'auto'
    button.style.minWidth = '0'
    button.style.paddingInline = '8px'
    button.addEventListener('click', openPicker)
    controls.insertBefore(button, document.getElementById('btn-theme'))
  }

  const grid = document.getElementById('grid')
  const onSourcePointerDown = event => {
    if (event.target?.closest?.('#btn-native-workspace, #btn-sidebar-overlay, #btn-global-panel-return, [data-native-action]')) return
    state.sourceEditor = true
  }
  const onSourceFocusIn = event => {
    if (event.target?.matches?.('input,textarea,[contenteditable="true"],iframe')) state.sourceEditor = true
  }
  const onSourceWindowBlur = () => setTimeout(() => {
    if (document.hasFocus() && document.activeElement?.tagName === 'IFRAME') state.sourceEditor = true
  }, 0)
  document.addEventListener('pointerdown', onSourcePointerDown, true)
    document.addEventListener('pointerdown', trackDragStart)
    document.addEventListener('pointerdown', trackRoleDragStart)
  document.addEventListener('pointerup', clearDragTracking)
    document.addEventListener('pointerup', clearRoleDragTracking)
  document.addEventListener('pointercancel', clearDragTracking)
    document.addEventListener('pointercancel', clearRoleDragTracking)
  document.addEventListener('lostpointercapture', clearDragTracking)
    document.addEventListener('lostpointercapture', clearRoleDragTracking)
  document.addEventListener('focusin', onSourceFocusIn, true)
  window.addEventListener('blur', onSourceWindowBlur)
  if (isTrustedAppOrigin() && typeof app?.onNativeFocus === 'function') {
    try {
      const unsubscribe = app.onNativeFocus(() => { state.sourceEditor = false })
      if (typeof unsubscribe === 'function') {
        state.offNativeFocus = unsubscribe
        state.nativeFocusSubscribed = true
      }
    } catch { /* Edit menu remains unavailable without native focus tracking. */ }
  }
  if (isTrustedAppOrigin() && typeof app?.onAccountChatRequested === 'function') {
    try { state.offAccountChatRequest = app.onAccountChatRequested(value => showAccountChat(value)) } catch { /* Sidebar commands still remain in the account guest. */ }
  }
  if (grid && typeof window.MutationObserver === 'function') {
    state.gridObserver = new window.MutationObserver(() => { syncGripListeners(); sync(); startGeometryFrames(); startRoleGeometryFrames() })
    state.gridObserver.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    syncGripListeners()
  }
  if (modal && typeof window.MutationObserver === 'function') {
    state.modalObserver = new window.MutationObserver(() => { sync(); syncHostedNativeVisibility() })
    state.modalObserver.observe(modal, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
  }
  if (document.body && typeof window.MutationObserver === 'function') {
    state.themeMenuObserver = new window.MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && node.classList.contains('theme-menu')))) {
        sync()
        syncHostedNativeVisibility()
      }
    })
    state.themeMenuObserver.observe(document.body, { childList: true })
  }
  window.addEventListener('resize', sync)
  window.addEventListener('scroll', sync, true)
  document.addEventListener('click', onDocumentClick)
  if (isTrustedAppOrigin() && typeof app?.onUiScaleChanged === 'function') {
    try {
      const unsubscribe = app.onUiScaleChanged(receiveUiScale)
      if (typeof unsubscribe === 'function') {
        state.offUiScale = unsubscribe
        state.uiScaleSubscribed = true
      }
    } catch { /* The picker remains unavailable without the native subscription. */ }
  }
  window.addEventListener('pagehide', () => {
    if (state.disposed) return
    state.disposed = true
    stopGeometryFrames()
    stopRoleGeometryFrames()
    state.syncRevision++
    state.modelRequestGeneration++
    state.toolRequestGeneration++
    state.folderPickerGeneration++
    state.nativeActionGeneration++
    state.pendingKnownFolders.clear()
    state.pendingNativeActions.clear()
    state.uiScaleReadGeneration++
    state.uiScalePending = false
    state.gridObserver?.disconnect()
    state.roleSurfaceObserver?.disconnect()
    state.workflowCanvasObserver?.disconnect()
    state.erpNextStatusObserver?.disconnect()
    state.offWorkflowCanvas?.()
    state.offErpNextStatus?.()
    for (const [grip, listener] of state.gripListeners) grip.removeEventListener('pointerdown', listener)
    state.gripListeners.clear()
    state.modalObserver?.disconnect()
    state.themeMenuObserver?.disconnect()
    state.panelObserver?.disconnect()
    state.observedPanel?.removeEventListener('transitionend', onPanelTransitionEnd)
    state.observedPanel?.removeEventListener('transitioncancel', onPanelTransitionEnd)
    state.observedPanel?.removeEventListener('transitionrun', onPanelTransitionRun)
    state.resizeObserver?.disconnect()
    state.offStatus?.()
    state.offGlobalPanel?.()
    state.offSidebarStatus?.()
    state.offSidebar?.()
    state.offUiScale?.()
    state.offNativeFocus?.()
    state.offThemeChanged?.()
    state.offAccountChatRequest?.()
    window.removeEventListener('resize', sync)
    window.removeEventListener('scroll', sync, true)
    document.removeEventListener('click', onDocumentClick)
    document.removeEventListener('pointerdown', onSourcePointerDown, true)
    document.removeEventListener('pointerdown', trackDragStart)
    document.removeEventListener('pointerdown', trackRoleDragStart)
    document.removeEventListener('pointerup', clearDragTracking)
    document.removeEventListener('pointerup', clearRoleDragTracking)
    document.removeEventListener('pointercancel', clearDragTracking)
    document.removeEventListener('pointercancel', clearRoleDragTracking)
    document.removeEventListener('lostpointercapture', clearDragTracking)
    document.removeEventListener('lostpointercapture', clearRoleDragTracking)
    document.removeEventListener('focusin', onSourceFocusIn, true)
    window.removeEventListener('blur', onSourceWindowBlur)
    window.removeEventListener('message', onBusinessThemeRequest)
    if (state.visible !== false && state.placement !== 'popout') void account?.setVisible(false).catch(() => {})
  }, { once: true })

  window.reference = Object.freeze({
    data: loadSceneData,
    renderBusinessPanel,
    renderRolePanel,
    renderErpNextStatusPanel,
    sceneSelected,
    persistSceneOrder,
    setSceneLoader: loader => { state.sceneLoader = typeof loader === 'function' ? loader : undefined },
    openSceneWindow,
    mountDefaultAccount,
    showBusinessRoute,
    win: Object.freeze({
      minimize: () => app.minimize(),
      toggleMaximize: () => app.toggleMaximize(),
      isMaximized: () => app.isMaximized(),
      close: () => app.close(),
    }),
  })
})()
