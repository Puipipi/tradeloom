(() => {
  'use strict'

  const ACTIONS = [
    ['独立窗口', '独立窗口操作暂不可用。'],
    ['打开原生会话', '该面板不支持原生会话。'],
    ['轮换此角色会话', '此面板当前没有可轮换的角色会话。'],
    ['应用', '原生应用菜单暂不可用。'],
    ['编辑', '原生编辑菜单暂不可用。'],
  ]
  const states = new Map()
  const TRACK_STORAGE_KEY = 'uiGridTrackWeights:v1'
  const SPLIT_TREE_STORAGE_KEY = 'uiPanelSplitTree:v2'
  const RESIZE_HIT_CSS_PX = 8
  const RESIZE_START_THRESHOLD_CSS_PX = 4
  const resizeHoverLifecycle = new WeakSet()
  let resizeLayer
  let resizeObserver
  let resizeClassObserver
  let resizeSignature = ''
  let activeGridResize
  let activeTreeResize
  let resizeTrees = new Map()
  let observer
  let menu
  let toastTimer

  const eligibleHeader = event => {
    const header = event.target.closest?.('.panel-header')
    if (!header) return null
    if (event.target.closest('button, input, textarea, select, a, [contenteditable="true"], .panel-controls, .panel-expand, .icon-control, .grip')) return null
    return header
  }

  function announce(message) {
    let toast = document.querySelector('.pi-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.className = 'pi-toast'
      toast.setAttribute('role', 'status')
      toast.setAttribute('aria-live', 'polite')
      document.body.append(toast)
    }
    toast.textContent = message
    toast.classList.add('pi-toast-visible')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('pi-toast-visible'), 2200)
  }

  function openSceneRotationDialog(flow) {
    const dialog = document.createElement('dialog')
    dialog.className = 'pi-scene-rotation-dialog'
    dialog.setAttribute('aria-labelledby', 'pi-scene-rotation-title')
    Object.assign(dialog.style, {
      display: 'grid', gap: '12px', background: 'var(--dsw-specific-sidebar-fill, var(--background-primary, #fff))',
      color: 'var(--dsw-alias-label-primary, var(--text-primary, #171717))',
      border: '1px solid var(--dsw-alias-border-primary, var(--border, #d1d5db))', borderRadius: '12px',
      boxSizing: 'border-box', maxWidth: '560px', width: 'min(560px, calc(100vw - 32px))', padding: '20px',
    })
    const title = document.createElement('h2')
    title.id = 'pi-scene-rotation-title'
    title.textContent = '轮换此角色会话'
    const target = document.createElement('p')
    target.textContent = `${flow.target.sceneId} / ${flow.target.panelId} / ${flow.target.roleId} / ${flow.target.sessionId}`
    const message = document.createElement('p')
    message.setAttribute('role', 'status')
    const detail = document.createElement('div')
    const actions = document.createElement('div')
    actions.className = 'pi-scene-rotation-actions'
    const archiveLabel = document.createElement('label')
    const archive = document.createElement('input')
    archive.type = 'checkbox'
    archive.checked = false
    archiveLabel.append(archive, document.createTextNode(' 归档旧会话（默认保留；不会停止旧会话活动）'))
    const addButton = (label, action) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pi-menu-item'
      button.textContent = label
      button.addEventListener('click', action)
      actions.append(button)
      return button
    }
    let preview
    let operationId
    let consumed = false
    let busy = false
    let closeButton
    const setBusy = value => { busy = value; for (const button of actions.querySelectorAll('button')) button.disabled = busy }
    const showOperationControls = () => {
      detail.replaceChildren()
      actions.replaceChildren()
      if (operationId) {
        addButton('读取操作状态', async () => run('status', { operationId }))
        addButton('恢复原操作', async () => run('resume', { operationId }))
        addButton('放弃本地操作', async () => run('abandon', { operationId }))
      }
      if (closeButton) actions.append(closeButton)
    }
    const run = async (operation, body) => {
      if (busy) return
      setBusy(true)
      message.textContent = '正在处理…'
      try {
        const result = await flow[operation](body)
        if (result?.pendingOperation) {
          preview = undefined
          consumed = true
          operationId = result.pendingOperation.operationId
          target.textContent = `${result.pendingOperation.sceneId} / ${result.pendingOperation.panelId} / ${result.pendingOperation.roleId} / ${result.pendingOperation.sessionId}`
          message.textContent = `发现原操作 ${operationId}（${result.pendingOperation.status}）。仅可恢复或放弃该操作。`
          showOperationControls()
          return
        }
        if (operation === 'preview') {
          preview = result
          operationId = result.operationId
          consumed = false
          archive.disabled = true
          actions.replaceChildren()
          if (result?.staleTarget) {
            message.textContent = '目标面板在预览返回时已变化。此预览不能确认，请取消或关闭。'
            addButton('取消预览', async () => {
              const token = preview?.previewToken
              if (token) await run('cancel', { previewToken: token })
            })
            if (closeButton) actions.append(closeButton)
            return
          }
          message.textContent = `${result?.impactMessage || '请核对固定角色和受影响面板后再确认。'} 旧会话：${result?.archiveOld === true ? '确认归档' : '保留'}`
          const list = document.createElement('ul')
          for (const item of result?.impactPanels ?? []) {
            const row = document.createElement('li')
            row.textContent = `${item.sceneId} / ${item.panelId}`
            list.append(row)
          }
          detail.replaceChildren(list)
          addButton('确认轮换', async () => {
            const token = preview?.previewToken
            if (!token) return
            consumed = true
            preview = undefined
            await run('confirm', { previewToken: token })
          })
          addButton('取消预览', async () => {
            const token = preview?.previewToken
            if (!token) return
            preview = undefined
            await run('cancel', { previewToken: token })
          })
          return
        }
        if (operation === 'cancel') {
          preview = undefined
          consumed = true
          operationId = result?.operationId ?? operationId
          if (result?.cancelled === true) {
            operationId = undefined
            detail.replaceChildren()
            archive.disabled = false
            actions.replaceChildren()
            if (closeButton) actions.append(closeButton)
            message.textContent = '预览已取消；没有创建或更改会话。'
          } else {
            message.textContent = `预览已被消费；保留原操作 ${operationId ?? ''}（${result?.status ?? '状态未知'}）。`
            showOperationControls()
          }
          return
        }
        if (result?.operationId) operationId = result.operationId
        if (operation === 'status' || operation === 'resume') {
          const status = result?.status ?? '状态未知'
          message.textContent = `原操作 ${operationId}：${status}${result?.sessionId ? `；会话 ${result.sessionId}` : ''}`
          if (['completed', 'bound', 'archive_pending'].includes(status)) {
            preview = undefined
            consumed = true
          }
        } else if (operation === 'abandon') {
          preview = undefined
          consumed = true
          message.textContent = result?.alreadyBound
            ? `绑定已生效，保留新会话 ${result.sessionId}；放弃不会回滚或停止会话。`
            : `原操作已放弃；外部会话不会被删除或停止。${result?.externalEffectStatus ? ` 外部结果：${result.externalEffectStatus}` : ''}`
        } else if (operation === 'confirm') {
          const status = result?.status ?? '状态未知'
          message.textContent = `轮换状态：${status}${result?.sessionId ? `；会话 ${result.sessionId}` : ''}`
          if (['completed', 'bound', 'archive_pending'].includes(status)) consumed = true
        }
        if (operationId && result?.status !== 'completed' && operation !== 'abandon') showOperationControls()
        else {
          detail.replaceChildren()
          actions.replaceChildren()
          if (closeButton) actions.append(closeButton)
        }
      } catch (error) {
        message.textContent = `${error?.message || '请求失败。'}${operationId ? ` 可读取或恢复原操作 ${operationId}。` : ''}`
        preview = undefined
        if (operationId) showOperationControls()
      } finally { setBusy(false) }
    }
    addButton('查看影响预览', async () => run('preview', { archiveOld: archive.checked }))
    closeButton = addButton('关闭', () => {
      if (preview && !consumed) void flow.cancel({ previewToken: preview.previewToken }).catch(() => {})
      dialog.close()
    })
    closeButton.classList.add('pi-scene-rotation-close')
    dialog.addEventListener('cancel', event => {
      event.preventDefault()
      if (preview && !consumed) void flow.cancel({ previewToken: preview.previewToken }).catch(() => {})
      dialog.close()
    })
    dialog.append(title, target, archiveLabel, message, detail, actions)
    document.body.append(dialog)
    dialog.addEventListener('close', () => dialog.remove(), { once: true })
    dialog.showModal()
  }

  function closeMenu() {
    if (!menu) return
    menu.button.setAttribute('aria-expanded', 'false')
    menu.element.remove()
    menu = null
    document.removeEventListener('pointerdown', onOutsideMenu, true)
    document.removeEventListener('keydown', onMenuKey, true)
  }

  function onOutsideMenu(event) {
    if (menu && !menu.element.contains(event.target) && event.target !== menu.button) closeMenu()
  }

  function onMenuKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      const button = menu?.button
      closeMenu()
      button?.focus()
    }
  }

  function openMenu(button, panel) {
    closeMenu()
    const element = document.createElement('div')
    element.className = 'pi-menu'
    element.setAttribute('role', 'menu')
    element.setAttribute('aria-label', '面板更多操作')
    const capabilities = window.businessBridge?.panelMenuCapabilities?.(panel)
    const entries = ACTIONS.filter(([label]) => label === '独立窗口' ? capabilities?.independent === true
      : label === '打开原生会话' || label === '轮换此角色会话' ? capabilities?.nativeConversation === true : true)
      .map(([label, explanation]) => ({ label, explanation }))
    const refreshButton = panel.querySelector('.panel-controls .icon-control[aria-label="刷新面板"]')
    const fullscreenButton = panel.querySelector('.panel-controls .pi-fullscreen')
    if (refreshButton && getComputedStyle(refreshButton).display === 'none') {
      entries.unshift({ label: '刷新面板', explanation: '重新渲染当前面板。', forwardButton: refreshButton })
    }
    if (fullscreenButton && getComputedStyle(fullscreenButton).display === 'none') {
      entries.unshift({ label: '放大到主体区域', explanation: '将当前面板放大到主体区域。', forwardButton: fullscreenButton })
    }
    for (const { label, explanation, forwardButton } of entries) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'pi-menu-item'
      item.setAttribute('role', 'menuitem')
      item.textContent = label === '独立窗口' && capabilities?.placement === 'popped-out' ? '收回工作台' : label
      item.addEventListener('click', () => {
        const itemRect = item.getBoundingClientRect()
        closeMenu()
        if (forwardButton) {
          forwardButton.click()
          return
        }
        if (label === '独立窗口') {
          const requestPlacement = window.businessBridge?.requestPanelPlacement
          if (typeof requestPlacement !== 'function') {
            announce('此面板不支持独立窗口。')
            return
          }
          Promise.resolve(requestPlacement(panel)).then(result => {
            if (result?.ok) return
            announce(result?.reason === 'unsupported' ? '此面板不支持独立窗口。'
              : result?.reason === 'pending' ? '独立窗口操作正在进行。'
                : '独立窗口操作暂不可用。')
          }).catch(() => announce('独立窗口操作暂不可用。'))
          return
        }
        if (label === '打开原生会话') {
          const requestPlacement = window.businessBridge?.requestRolePlacement
          if (typeof requestPlacement !== 'function') {
            announce(explanation)
            return
          }
          Promise.resolve(requestPlacement(panel, 'open')).then(result => {
            if (result?.ok) return
            announce(result?.reason === 'unsupported' ? explanation
              : result?.reason === 'pending' ? '原生会话窗口操作正在进行。'
                : '原生会话暂不可用。')
          }).catch(() => announce('原生会话暂不可用。'))
          return
        }
        if (label === '轮换此角色会话') {
          const openRotation = window.businessBridge?.openSceneRotation
          const flow = typeof openRotation === 'function' ? openRotation(panel) : undefined
          if (!flow) { announce(explanation); return }
          openSceneRotationDialog(flow)
          return
        }
        if (label === '应用' || label === '编辑') {
          const openNativeMenu = window.businessBridge?.openNativeMenu
          if (typeof openNativeMenu !== 'function') {
            announce(label === '应用' ? ACTIONS[2][1] : ACTIONS[3][1])
            return
          }
          const action = label === '应用' ? 'application' : 'edit'
          Promise.resolve(openNativeMenu(action, itemRect)).then(result => {
            if (!result?.ok) announce(label === '应用' ? ACTIONS[2][1] : ACTIONS[3][1])
          }).catch(() => announce(label === '应用' ? ACTIONS[2][1] : ACTIONS[3][1]))
          return
        }
        announce(`${label}：${explanation}`)
      })
      element.append(item)
    }
    document.body.append(element)
    const rect = button.getBoundingClientRect()
    element.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - element.offsetHeight - 8)}px`
    element.style.left = `${Math.max(8, Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8))}px`
    button.setAttribute('aria-expanded', 'true')
    menu = { element, button, panel }
    document.addEventListener('pointerdown', onOutsideMenu, true)
    document.addEventListener('keydown', onMenuKey, true)
    element.querySelector('button')?.focus()
  }

  function setFullscreenButton(button, active) {
    button.textContent = active ? '❐' : '⛶'
    button.title = active ? '还原面板大小' : '放大到主体区域'
    button.setAttribute('aria-label', button.title)
    button.setAttribute('aria-pressed', String(active))
  }

  function gridRect(panel) {
    const grid = panel.closest('#grid')
    return grid ? { grid, rect: grid.getBoundingClientRect() } : null
  }

  function setRect(panel, rect) {
    panel.style.left = `${Math.round(rect.left)}px`
    panel.style.top = `${Math.round(rect.top)}px`
    panel.style.width = `${Math.round(rect.width)}px`
    panel.style.height = `${Math.round(rect.height)}px`
  }

  function equalTracks(values, count) {
    return Array.from({ length: count }, () => 1)
  }

  function normalizedTracks(values, count) {
    if (!Array.isArray(values) || values.length !== count
      || values.some(value => !Number.isFinite(value) || value <= 0 || value > 100)) return equalTracks(values, count)
    const total = values.reduce((sum, value) => sum + value, 0)
    if (!Number.isFinite(total) || total <= 0) return equalTracks(values, count)
    return values.map(value => value * count / total)
  }

  function readTrackPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(TRACK_STORAGE_KEY) || 'null')
      return value?.version === 1 && value.scenes && typeof value.scenes === 'object' && !Array.isArray(value.scenes)
        ? value : { version: 1, scenes: {} }
    } catch { return { version: 1, scenes: {} } }
  }

  function getSceneTracks(sceneId, columns, rows) {
    const preferences = readTrackPreferences()
    const saved = preferences.scenes[sceneId]
    return {
      columns: normalizedTracks(saved?.columns, columns),
      rows: normalizedTracks(saved?.rows, rows),
    }
  }

  function saveSceneTracks(sceneId, tracks) {
    const previous = readTrackPreferences()
    const next = {
      ...previous,
      version: 1,
      scenes: {
        ...previous.scenes,
        [sceneId]: { columns: [...tracks.columns], rows: [...tracks.rows] },
      },
    }
    try { localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(next)); return true }
    catch { return false }
  }

  function readSplitTrees() {
    try {
      const value = JSON.parse(localStorage.getItem(SPLIT_TREE_STORAGE_KEY) || 'null')
      return value?.version === 2 && value.scenes && typeof value.scenes === 'object' && !Array.isArray(value.scenes)
        ? value : { version: 2, scenes: {} }
    } catch { return { version: 2, scenes: {} } }
  }

  function validSplitTree(tree, panelIds) {
    if (!tree || typeof tree !== 'object') return false
    const leaves = []
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 12) return false
      if (node.kind === 'leaf') {
        if (typeof node.id !== 'string') return false
        leaves.push(node.id); return true
      }
      if (node.kind !== 'split' || !['x', 'y'].includes(node.axis) || !Number.isFinite(node.ratio) || node.ratio < 0 || node.ratio > 1
        || !Number.isSafeInteger(node.boundary) || typeof node.path !== 'string') return false
      return visit(node.first, depth + 1) && visit(node.second, depth + 1)
    }
    if (!visit(tree)) return false
    return leaves.length === panelIds.length && new Set(leaves).size === leaves.length
      && JSON.stringify([...leaves].sort()) === JSON.stringify([...panelIds].sort())
  }

  function saveSplitTree(sceneId, tree) {
    const previous = readSplitTrees()
    const serializable = { tree: tree.tree, topology: tree.topology, geometry: tree.geometry }
    const next = { ...previous, version: 2, scenes: { ...previous.scenes, [sceneId]: serializable } }
    try { localStorage.setItem(SPLIT_TREE_STORAGE_KEY, JSON.stringify(next)); return true }
    catch { return false }
  }

  function gridMetrics(grid, columns, rows) {
    const rect = grid.getBoundingClientRect()
    const css = getComputedStyle(grid)
    const number = (value, fallback = 0) => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const borderLeft = number(css.borderLeftWidth), borderTop = number(css.borderTopWidth)
    const padLeft = number(css.paddingLeft, 5), padRight = number(css.paddingRight, 5)
    const padTop = number(css.paddingTop, 5), padBottom = number(css.paddingBottom, 5)
    const gapX = number(css.columnGap, number(css.gap, 5)), gapY = number(css.rowGap, number(css.gap, 5))
    const contentWidth = (grid.clientWidth || rect.width - borderLeft - number(css.borderRightWidth)) - padLeft - padRight
    const contentHeight = (grid.clientHeight || rect.height - borderTop - number(css.borderBottomWidth)) - padTop - padBottom
    const availableX = Math.max(1, contentWidth - gapX * (columns - 1))
    const availableY = Math.max(1, contentHeight - gapY * (rows - 1))
    return { rect, borderLeft, borderTop, padLeft, padTop, gapX, gapY, availableX, availableY }
  }

  function applyGridTracks(grid, tracks) {
    const equal = values => values.every(value => Math.abs(value - 1) < 0.0001)
    grid.style.gridTemplateColumns = equal(tracks.columns) ? '' : tracks.columns.map(value => `minmax(0, ${value}fr)`).join(' ')
    grid.style.gridTemplateRows = equal(tracks.rows) ? '' : tracks.rows.map(value => `minmax(0, ${value}fr)`).join(' ')
  }

  const panelRect = panel => {
    const rect = panel.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
  }

  function splitCandidates(panels, axis) {
    const startKey = axis === 'x' ? 'col' : 'row'
    const spanKey = axis === 'x' ? 'w' : 'h'
    const end = Math.max(...panels.map(panel => Number(panel.dataset[startKey]) + Number(panel.dataset[spanKey]) - 1))
    const start = Math.min(...panels.map(panel => Number(panel.dataset[startKey])))
    const candidates = []
    for (let boundary = start; boundary < end; boundary++) {
      const first = [], second = []
      let valid = true
      for (const panel of panels) {
        const panelStart = Number(panel.dataset[startKey])
        const panelEnd = panelStart + Number(panel.dataset[spanKey]) - 1
        if (panelEnd <= boundary) first.push(panel)
        else if (panelStart > boundary) second.push(panel)
        else { valid = false; break }
      }
      if (valid && first.length && second.length) {
        const firstArea = first.reduce((sum, panel) => sum + panelRect(panel).width * panelRect(panel).height, 0)
        const secondArea = second.reduce((sum, panel) => sum + panelRect(panel).width * panelRect(panel).height, 0)
        const ratio = firstArea / (firstArea + secondArea)
        candidates.push({ axis, boundary, first, second, score: Math.abs(.5 - ratio) })
      }
    }
    return candidates
  }

  function envelope(panels) {
    const rects = panels.map(panelRect)
    const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top))
    const right = Math.max(...rects.map(rect => rect.right)), bottom = Math.max(...rects.map(rect => rect.bottom))
    return { left, top, width: right - left, height: bottom - top, right, bottom }
  }

  function treeTopology(node) {
    return node.kind === 'leaf' ? `p:${node.id}` : `${node.axis}${node.boundary}[${treeTopology(node.first)}|${treeTopology(node.second)}]`
  }

  function buildMeasuredTree(panels, path = 'r') {
    if (panels.length === 1) return { kind: 'leaf', id: panels[0].dataset.panelId }
    const candidates = [...splitCandidates(panels, 'y'), ...splitCandidates(panels, 'x')]
      .sort((a, b) => a.score - b.score || (a.axis === 'y' ? -1 : 1))
    const split = candidates[0]
    if (!split) return null
    const firstRect = envelope(split.first), secondRect = envelope(split.second), parentRect = envelope(panels)
    const firstSize = split.axis === 'x' ? firstRect.width : firstRect.height
    const secondSize = split.axis === 'x' ? secondRect.width : secondRect.height
    const total = firstSize + secondSize
    if (!(total > 0)) return null
    const firstTree = buildMeasuredTree(split.first, `${path}0`)
    const secondTree = buildMeasuredTree(split.second, `${path}1`)
    if (!firstTree || !secondTree) return null
    return {
      kind: 'split', axis: split.axis, boundary: split.boundary, path,
      ratio: firstSize / total,
      first: firstTree,
      second: secondTree,
      sourceExtent: split.axis === 'x' ? parentRect.width : parentRect.height,
    }
  }

  function sceneGridGap(grid, axis) {
    const css = getComputedStyle(grid)
    const value = Number.parseFloat(axis === 'x' ? css.columnGap : css.rowGap)
    const scale = gridScale(grid)[axis === 'x' ? 'x' : 'y']
    return (Number.isFinite(value) ? value : 5) * scale
  }

  function gridScale(grid) {
    const rect = grid.getBoundingClientRect()
    return {
      x: rect.width / Math.max(1, grid.offsetWidth),
      y: rect.height / Math.max(1, grid.offsetHeight),
    }
  }

  function savedTree(info) {
    const stored = readSplitTrees().scenes[info.sceneId]
    const panelIds = info.geometry.map(item => item.id)
    if (!stored?.topology || !validSplitTree(stored.tree, panelIds) || stored.topology !== treeTopology(stored.tree)) return null
    if (!Array.isArray(stored.geometry) || stored.geometry.length !== panelIds.length
      || stored.geometry.some(item => !panelIds.includes(item.id) || !['col', 'row', 'w', 'h'].every(key => Number.isSafeInteger(item[key]) && item[key] > 0))) return null
    return stored
  }

  function treeFor(info) {
    let state = resizeTrees.get(info.sceneId)
    if (state && state.panelRefs && state.panelRefs.some((panel, index) => panel !== info.panels[index])) {
      const saved = savedTree(info)
      if (saved?.geometry?.length === info.panels.length) {
        const geometry = new Map(saved.geometry.map(item => [item.id, item]))
        for (const panel of info.panels) {
          const item = geometry.get(panel.dataset.panelId)
          if (!item) continue
          for (const key of ['col', 'row', 'w', 'h']) panel.dataset[key] = String(item[key])
          if (panel.__meta) for (const key of ['col', 'row', 'w', 'h']) panel.__meta[key] = Number(item[key])
        }
        state = { ...saved, geometrySignature: sceneGridInfo(document.getElementById('grid')).signature, panelRefs: [...info.panels] }
        resizeTrees.set(info.sceneId, state)
        return state
      }
    }
    if (state && validSplitTree(state.tree, info.geometry.map(item => item.id))
      && state.topology === treeTopology(state.tree) && state.geometrySignature === info.signature) return state
    if (state && state.geometrySignature !== info.signature) {
      const hasPersistedTree = Boolean(savedTree(info))
      const priorRatios = hasPersistedTree
        ? new Map(treeNodes(state.tree).map(node => [`${node.axis}:${node.boundary}`, node.ratio]))
        : null
      const rebuilt = buildMeasuredTree(info.panels)
      if (rebuilt) {
        if (priorRatios) {
          for (const node of treeNodes(rebuilt)) {
            const ratio = priorRatios.get(`${node.axis}:${node.boundary}`)
            if (Number.isFinite(ratio)) node.ratio = ratio
          }
        }
        state = { tree: rebuilt, topology: treeTopology(rebuilt), geometrySignature: info.signature, geometry: info.geometry.map(item => ({ ...item })), panelRefs: [...info.panels] }
        resizeTrees.set(info.sceneId, state)
        return state
      }
    }
    const saved = savedTree(info)
    if (saved) {
      const ids = info.geometry.map(item => item.id).sort()
      const savedIds = (saved.geometry || []).map(item => item.id).sort()
      if (JSON.stringify(ids) === JSON.stringify(savedIds)) {
        const geometry = new Map(saved.geometry.map(item => [item.id, item]))
        for (const panel of info.panels) {
          const item = geometry.get(panel.dataset.panelId)
          if (!item) continue
          for (const key of ['col', 'row', 'w', 'h']) panel.dataset[key] = String(item[key])
          if (panel.__meta) for (const key of ['col', 'row', 'w', 'h']) panel.__meta[key] = Number(item[key])
        }
        state = { ...saved, geometrySignature: info.signature, panelRefs: [...info.panels] }
        resizeTrees.set(info.sceneId, state)
        return state
      }
    }
    const tree = buildMeasuredTree(info.panels)
    if (!tree || !validSplitTree(tree, info.geometry.map(item => item.id))) return null
    state = { tree, topology: treeTopology(tree), geometrySignature: info.signature, geometry: info.geometry.map(item => ({ ...item })), panelRefs: [...info.panels] }
    resizeTrees.set(info.sceneId, state)
    return state
  }

  function treeNodes(node, result = []) {
    if (node?.kind !== 'split') return result
    result.push(node); treeNodes(node.first, result); treeNodes(node.second, result)
    return result
  }

  function treeRects(node, rect, gaps, output = new Map()) {
    if (node.kind === 'leaf') { output.set(node.id, rect); return output }
    const gap = node.axis === 'x' ? gaps.x : gaps.y
    const extent = node.axis === 'x' ? rect.width : rect.height
    const available = Math.max(0, extent - gap)
    const firstExtent = available * node.ratio
    const secondExtent = available - firstExtent
    if (node.axis === 'x') {
      treeRects(node.first, { ...rect, width: firstExtent, right: rect.left + firstExtent }, gaps, output)
      const secondLeft = rect.left + firstExtent + gap
      treeRects(node.second, { ...rect, left: secondLeft, width: secondExtent, right: rect.right }, gaps, output)
    } else {
      treeRects(node.first, { ...rect, height: firstExtent, bottom: rect.top + firstExtent }, gaps, output)
      const secondTop = rect.top + firstExtent + gap
      treeRects(node.second, { ...rect, top: secondTop, height: secondExtent, bottom: rect.bottom }, gaps, output)
    }
    return output
  }

  function gridContentBounds(grid) {
    const rect = grid.getBoundingClientRect(), css = getComputedStyle(grid)
    const number = key => Number.parseFloat(css.getPropertyValue(key)) || 0
    const scale = gridScale(grid)
    const left = rect.left + (number('border-left-width') + number('padding-left')) * scale.x
    const top = rect.top + (number('border-top-width') + number('padding-top')) * scale.y
    const width = Math.max(0, grid.clientWidth - number('padding-left') - number('padding-right')) * scale.x
    const height = Math.max(0, grid.clientHeight - number('padding-top') - number('padding-bottom')) * scale.y
    return { left, top, width, height, right: left + width, bottom: top + height }
  }

  function positionTreePanels(grid, tree, { persistGeometry = false } = {}) {
    const panels = [...grid.querySelectorAll(':scope > .panel')]
    if (!panels.length) return null
    const region = gridContentBounds(grid)
    const rects = treeRects(tree, region, { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') })
    const scale = gridScale(grid)
    for (const panel of panels) {
      const rect = rects.get(panel.dataset.panelId)
      if (!rect) return null
      panel.dataset.splitTreeManaged = 'true'
      panel.style.position = 'absolute'
      // Absolute grid items use their definite grid area as containing block.
      // Span the unchanged grid canvas so the stored rectangles are viewport-relative.
      panel.style.gridColumn = '1 / -1'
      panel.style.gridRow = '1 / -1'
      panel.style.left = `${(rect.left - region.left) / scale.x}px`
      panel.style.top = `${(rect.top - region.top) / scale.y}px`
      panel.style.width = `${rect.width / scale.x}px`
      panel.style.height = `${rect.height / scale.y}px`
      panel.style.zIndex = ''
    }
    if (persistGeometry) {
      const info = sceneGridInfo(grid)
      const state = info && resizeTrees.get(info.sceneId)
      if (state) state.geometry = info.geometry.map(item => ({ ...item }))
    }
    return { region, rects }
  }

  function collectTreeRegions(node, rect, gaps, result = new Map()) {
    if (node.kind === 'leaf') return result
    result.set(node.path, rect)
    const gap = node.axis === 'x' ? gaps.x : gaps.y
    const available = Math.max(0, (node.axis === 'x' ? rect.width : rect.height) - gap)
    const firstSize = available * node.ratio
    const secondSize = available - firstSize
    if (node.axis === 'x') {
      collectTreeRegions(node.first, { ...rect, width: firstSize, right: rect.left + firstSize }, gaps, result)
      const left = rect.left + firstSize + gap
      collectTreeRegions(node.second, { ...rect, left, width: secondSize, right: rect.right }, gaps, result)
    } else {
      collectTreeRegions(node.first, { ...rect, height: firstSize, bottom: rect.top + firstSize }, gaps, result)
      const top = rect.top + firstSize + gap
      collectTreeRegions(node.second, { ...rect, top, height: secondSize, bottom: rect.bottom }, gaps, result)
    }
    return result
  }

  function adjustTreeNode(info, node, delta) {
    const grid = document.getElementById('grid')
    if (!grid || !node || !Number.isFinite(delta)) return
    const state = treeFor(info)
    const regions = collectTreeRegions(state.tree, gridContentBounds(grid), { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') })
    const region = regions.get(node.path)
    if (!region) return
    const available = (node.axis === 'x' ? region.width - sceneGridGap(grid, 'x') : region.height - sceneGridGap(grid, 'y'))
    if (available <= 0) return
    const panels = new Map(info.panels.map(panel => [panel.dataset.panelId, panel]))
    node.ratio = clampSplitRatio(node, node.ratio + delta / available, region, panels, { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') })
  }

  function applyTreeState(info, state) {
    const grid = document.getElementById('grid')
    if (!grid || !state) return
    positionTreePanels(grid, state.tree)
    positionTreeHandles(info, state)
  }

  function panelConstraint(panel, axis, property) {
    const css = getComputedStyle(panel)
    const cssValue = css.getPropertyValue(property)
    const value = Number.parseFloat(cssValue)
    if (property.startsWith('max') && (!Number.isFinite(value) || cssValue === 'none')) return Infinity
    const scale = panel.getBoundingClientRect()[axis === 'width' ? 'width' : 'height']
      / Math.max(1, panel[axis === 'width' ? 'offsetWidth' : 'offsetHeight'])
    return Number.isFinite(value) ? Math.max(0, value * scale) : 0
  }

  function subtreeConstraint(node, panels, axis, property, gapX, gapY) {
    if (node.kind === 'leaf') {
      const panel = panels.get(node.id)
      return panel ? panelConstraint(panel, axis, property) : 0
    }
    const splitAxis = axis === 'width' ? 'x' : 'y'
    const first = subtreeConstraint(node.first, panels, axis, property, gapX, gapY)
    const second = subtreeConstraint(node.second, panels, axis, property, gapX, gapY)
    const sameAxis = node.axis === splitAxis
    const gap = sameAxis ? (splitAxis === 'x' ? gapX : gapY) : 0
    if (property.startsWith('min')) return sameAxis ? first + second + gap : Math.max(first, second)
    return sameAxis ? first + second + gap : Math.min(first, second)
  }

  function clampSplitRatio(node, ratio, region, panels, gaps) {
    const widthAxis = node.axis === 'x'
    const extent = widthAxis ? region.width : region.height
    const gap = widthAxis ? gaps.x : gaps.y
    const available = Math.max(0, extent - gap)
    const property = widthAxis ? 'width' : 'height'
    const minimum = subtreeConstraint(node.first, panels, property, `min-${property}`, gaps.x, gaps.y)
    const maximum = subtreeConstraint(node.first, panels, property, `max-${property}`, gaps.x, gaps.y)
    const otherMinimum = subtreeConstraint(node.second, panels, property, `min-${property}`, gaps.x, gaps.y)
    const otherMaximum = subtreeConstraint(node.second, panels, property, `max-${property}`, gaps.x, gaps.y)
    const lower = Math.max(0, minimum / Math.max(1, available), 1 - otherMaximum / Math.max(1, available))
    const upper = Math.min(1, maximum / Math.max(1, available), 1 - otherMinimum / Math.max(1, available))
    return Math.min(upper, Math.max(lower, ratio))
  }

  function createTreeHandle(layer, node, axis = node.axis) {
    const key = axis === 'xy' ? `txy:${node.xNode.path}:${node.yNode.path}` : `t${axis}:${node.path}`
    let button = [...layer.children].find(child => child.dataset.resizeKey === key)
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'; button.className = 'pi-resize-handle'
      button.dataset.resizeKey = key; button.dataset.axis = axis
      button.addEventListener('pointerdown', beginGridResize)
      button.addEventListener('keydown', onTreeHandleKey)
      layer.append(button)
    }
    bindResizeHoverLifecycle(button)
    button.dataset.treeHandle = 'true'
    button.dataset.axis = axis
    button.setAttribute('role', axis === 'xy' ? 'button' : 'separator')
    if (axis === 'xy') button.removeAttribute('aria-orientation')
    else button.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal')
    button.setAttribute('aria-label', axis === 'xy' ? '同时调整相邻面板宽度和高度' : axis === 'x' ? '调整相邻面板宽度' : '调整相邻面板高度')
    button.removeAttribute('title')
    button.setAttribute('aria-valuemin', '0')
    button.setAttribute('aria-valuemax', '100')
    button.setAttribute('aria-valuenow', '50')
    button.setAttribute('aria-valuetext', '相邻面板尺寸比例')
    return button
  }

  function updateTreeHandles(info, state) {
    const nodes = treeNodes(state.tree)
    const wanted = new Set()
    for (const node of nodes) { wanted.add(`t${node.axis}:${node.path}`); createTreeHandle(resizeLayer, node, node.axis) }
    const ys = nodes.filter(node => node.axis === 'y')
    const xs = nodes.filter(node => node.axis === 'x')
    for (const yNode of ys) for (const xNode of xs) {
      const contains = (root, target) => root === target || (root.kind === 'split' && (contains(root.first, target) || contains(root.second, target)))
      if (!contains(yNode.first, xNode) && !contains(yNode.second, xNode)) continue
      const combined = { axis: 'xy', xNode, yNode, path: `${xNode.path}-${yNode.path}` }
      const key = `txy:${xNode.path}:${yNode.path}`
      wanted.add(key); createTreeHandle(resizeLayer, combined, 'xy')
    }
    for (const child of [...resizeLayer.children]) if (!child.dataset.treeHandle || !wanted.has(child.dataset.resizeKey)) child.remove()
    positionTreeHandles(info, state)
  }

  function positionTreeHandles(info, state) {
    const grid = document.getElementById('grid')
    const panelMap = new Map(info.panels.map(panel => [panel.dataset.panelId, panel]))
    const bounds = gridContentBounds(grid)
    const gaps = { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') }
    const rects = treeRects(state.tree, bounds, gaps)
    const scale = gridScale(grid), gridRect = grid.getBoundingClientRect()
    const set = (button, rect, node) => {
      button.style.left = `${(rect.left - gridRect.left) / scale.x}px`
      button.style.top = `${(rect.top - gridRect.top) / scale.y}px`
      button.style.width = `${rect.width / scale.x}px`; button.style.height = `${rect.height / scale.y}px`
      if (node?.kind === 'split') {
        const now = Math.round(node.ratio * 100)
        button.setAttribute('aria-valuenow', String(now))
        button.setAttribute('aria-valuetext', `${now}%；可用方向：${node.axis === 'x' ? '左右' : '上下'}`)
      } else if (node?.axis === 'xy') {
        button.setAttribute('aria-valuetext', `宽度${Math.round(node.xNode.ratio * 100)}%，高度${Math.round(node.yNode.ratio * 100)}%`)
      }
    }
    for (const button of resizeLayer.children) {
      const match = button.dataset.resizeKey.match(/^t(x|y):(.+)$/)
      const xy = button.dataset.resizeKey.match(/^txy:(.+):(.+)$/)
      if (match) {
        const node = treeNodes(state.tree).find(item => item.path === match[2])
        if (!node) continue
        const nodeRect = envelope([...treeLeafIds(node).map(id => panelMap.get(id)).filter(Boolean)])
        if (node.axis === 'x') {
          const first = envelope(treeLeafIds(node.first).map(id => panelMap.get(id)).filter(Boolean))
          const second = envelope(treeLeafIds(node.second).map(id => panelMap.get(id)).filter(Boolean))
          const left = (first.right + second.left) / 2
          set(button, { left: left - RESIZE_HIT_CSS_PX / 2 * scale.x, top: nodeRect.top, width: RESIZE_HIT_CSS_PX * scale.x, height: nodeRect.height }, node)
        } else {
          const first = envelope(treeLeafIds(node.first).map(id => panelMap.get(id)).filter(Boolean))
          const second = envelope(treeLeafIds(node.second).map(id => panelMap.get(id)).filter(Boolean))
          const top = (first.bottom + second.top) / 2
          set(button, { left: nodeRect.left, top: top - RESIZE_HIT_CSS_PX / 2 * scale.y, width: nodeRect.width, height: RESIZE_HIT_CSS_PX * scale.y }, node)
        }
      } else if (xy) {
        const xNode = treeNodes(state.tree).find(item => item.path === xy[1])
        const yNode = treeNodes(state.tree).find(item => item.path === xy[2])
        if (!xNode || !yNode) continue
        const a = envelope(treeLeafIds(xNode.first).map(id => panelMap.get(id)).filter(Boolean))
        const b = envelope(treeLeafIds(xNode.second).map(id => panelMap.get(id)).filter(Boolean))
        const c = envelope(treeLeafIds(yNode.first).map(id => panelMap.get(id)).filter(Boolean))
        const d = envelope(treeLeafIds(yNode.second).map(id => panelMap.get(id)).filter(Boolean))
        const x = (a.right + b.left) / 2, y = (c.bottom + d.top) / 2
        set(button, { left: x - RESIZE_HIT_CSS_PX / 2 * scale.x, top: y - RESIZE_HIT_CSS_PX / 2 * scale.y, width: RESIZE_HIT_CSS_PX * scale.x, height: RESIZE_HIT_CSS_PX * scale.y }, { axis: 'xy', xNode, yNode })
      }
    }
  }

  function treeLeafIds(node, result = []) {
    if (node.kind === 'leaf') result.push(node.id)
    else { treeLeafIds(node.first, result); treeLeafIds(node.second, result) }
    return result
  }

  function onTreeHandleKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const amount = event.shiftKey ? 64 : 24
    let dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    let dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
    const nodePath = event.currentTarget.dataset.resizeKey.match(/^t[xy]:(.+)$/)?.[1]
    const xy = event.currentTarget.dataset.resizeKey.match(/^txy:(.+):(.+)$/)
    const grid = event.currentTarget.closest('#grid'), info = grid && sceneGridInfo(grid)
    const state = info && treeFor(info)
    if (!state) return
    const scale = gridScale(grid)
    dx *= scale.x; dy *= scale.y
    const hasX = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const hasY = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (xy) {
      const xNode = treeNodes(state.tree).find(node => node.path === xy[1])
      const yNode = treeNodes(state.tree).find(node => node.path === xy[2])
      if (xNode && hasX) adjustTreeNode(info, xNode, dx)
      if (yNode && hasY) adjustTreeNode(info, yNode, dy)
      if ((!xNode || !hasX) && (!yNode || !hasY)) return
    } else {
      const node = treeNodes(state.tree).find(item => item.path === nodePath)
      if (!node || (node.axis === 'x' ? !hasX : !hasY)) return
      adjustTreeNode(info, node, node.axis === 'x' ? dx : dy)
    }
    positionTreePanels(grid, state.tree, { persistGeometry: true })
    saveSplitTree(info.sceneId, { ...state, topology: treeTopology(state.tree), geometry: info.geometry.map(item => ({ ...item })) })
    updateResizeHandles()
    event.preventDefault()
  }

  function onLegacyHandleKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const [, axis, aText, bText] = event.currentTarget.dataset.resizeKey.match(/^(x|y|xy):(\d+):(\d+)$/) || []
    const grid = event.currentTarget.closest('#grid')
    const info = grid && sceneGridInfo(grid)
    const state = info && treeFor(info)
    if (!state || !axis) return
    const nodes = treeNodes(state.tree), a = Number(aText), b = Number(bText)
    const xNode = axis !== 'y' ? nodes.find(node => node.axis === 'x' && node.boundary === a) : null
    const yNode = axis === 'xy' ? nodes.find(node => node.axis === 'y' && node.boundary === b) : axis === 'y' ? nodes.find(node => node.axis === 'y' && node.boundary === a) : null
    const amount = event.shiftKey ? 64 : 24
    const scale = gridScale(grid)
    const delta = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : event.key === 'ArrowUp' ? -amount : amount
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (xNode && horizontal) adjustTreeNode(info, xNode, delta * scale.x)
    if (yNode && vertical) adjustTreeNode(info, yNode, delta * scale.y)
    if (!(xNode && horizontal) && !(yNode && vertical)) return
    state.topology = treeTopology(state.tree)
    state.geometry = info.geometry.map(item => ({ ...item }))
    state.geometrySignature = info.signature
    positionTreePanels(grid, state.tree)
    saveSplitTree(info.sceneId, state)
    updateResizeHandles()
    const focusKey = axis === 'xy' && xNode && yNode ? `txy:${xNode.path}:${yNode.path}`
      : xNode && horizontal ? `tx:${xNode.path}` : yNode && vertical ? `ty:${yNode.path}` : null
    if (focusKey) [...resizeLayer.children].find(button => button.dataset.resizeKey === focusKey)?.focus()
    event.preventDefault()
  }

  function sceneGridInfo(grid) {
    const panels = [...grid.querySelectorAll(':scope > .panel')]
    const first = panels[0]
    const sceneId = first?.__meta?.sceneId || first?.dataset.sceneId
    const columns = Math.max(1, Number.parseInt(grid.style.getPropertyValue('--cols') || '4', 10) || 4)
    const rows = Math.max(1, Number.parseInt(grid.style.getPropertyValue('--rows') || '4', 10) || 4)
    if (!sceneId || panels.length === 0) return null
    const geometry = panels.map(panel => ({
      id: panel.dataset.panelId,
      col: Number(panel.dataset.col), row: Number(panel.dataset.row),
      w: Number(panel.dataset.w), h: Number(panel.dataset.h),
    }))
    return { sceneId, columns, rows, panels, geometry, signature: JSON.stringify([sceneId, columns, rows, geometry, grid.clientWidth, grid.clientHeight]) }
  }

  function exposedVerticalRows(panels, boundary, rows) {
    const exposed = []
    for (let row = 1; row <= rows; row++) {
      const left = panels.some(panel => panel.col + panel.w - 1 === boundary && panel.row <= row && row < panel.row + panel.h)
      const right = panels.some(panel => panel.col === boundary + 1 && panel.row <= row && row < panel.row + panel.h)
      if (left && right) exposed.push(row)
    }
    return exposed
  }

  function exposedHorizontalColumns(panels, boundary, columns) {
    const exposed = []
    for (let col = 1; col <= columns; col++) {
      const top = panels.some(panel => panel.row + panel.h - 1 === boundary && panel.col <= col && col < panel.col + panel.w)
      const bottom = panels.some(panel => panel.row === boundary + 1 && panel.col <= col && col < panel.col + panel.w)
      if (top && bottom) exposed.push(col)
    }
    return exposed
  }

  function makeResizeHandle(layer, key, axis, label) {
    let button = [...layer.children].find(node => node.dataset.resizeKey === key)
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'pi-resize-handle'
      button.dataset.resizeKey = key
      button.dataset.axis = axis
      button.setAttribute('aria-label', label)
      button.removeAttribute('title')
      button.addEventListener('pointerdown', beginGridResize)
      button.addEventListener('keydown', onLegacyHandleKey)
      layer.append(button)
    } else if (button.dataset.axis !== axis || button.getAttribute('aria-label') !== label) {
      button.dataset.axis = axis
      button.setAttribute('aria-label', label)
      button.removeAttribute('title')
    }
    bindResizeHoverLifecycle(button)
    button.setAttribute('role', axis === 'xy' ? 'button' : 'separator')
    if (axis === 'xy') button.removeAttribute('aria-orientation')
    else button.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal')
    button.setAttribute('aria-valuemin', '0'); button.setAttribute('aria-valuemax', '100')
    button.setAttribute('aria-valuenow', '50'); button.setAttribute('aria-valuetext', '相邻面板尺寸比例')
    return button
  }

  function bindResizeHoverLifecycle(button) {
    if (resizeHoverLifecycle.has(button)) return
    resizeHoverLifecycle.add(button)
    button.addEventListener('pointerdown', () => {
      if (resizeLayer) resizeLayer.dataset.inputModality = 'pointer'
      delete button.dataset.pointerSuppressed
      button.dataset.pointerActive = 'true'
    }, true)
    const suppressPointerFeedback = () => {
      delete button.dataset.pointerActive
      button.dataset.pointerSuppressed = 'true'
    }
    button.addEventListener('pointerup', suppressPointerFeedback)
    button.addEventListener('pointercancel', suppressPointerFeedback)
    button.addEventListener('pointerleave', () => {
      if (button.dataset.pointerActive !== 'true') delete button.dataset.pointerSuppressed
    })
    button.addEventListener('blur', () => {
      delete button.dataset.pointerActive
      delete button.dataset.pointerSuppressed
    })
  }

  function legacyHandleRatio(info, tracks, axis, boundary, segment) {
    const weight = (start, span, values) => values.slice(start - 1, start - 1 + span).reduce((sum, value) => sum + value, 0)
    const spans = axis === 'x'
      ? [
          info.geometry.filter(item => item.col + item.w - 1 === boundary && item.row <= segment && segment < item.row + item.h),
          info.geometry.filter(item => item.col === boundary + 1 && item.row <= segment && segment < item.row + item.h),
        ]
      : [
          info.geometry.filter(item => item.row + item.h - 1 === boundary && item.col <= segment && segment < item.col + item.w),
          info.geometry.filter(item => item.row === boundary + 1 && item.col <= segment && segment < item.col + item.w),
        ]
    const values = axis === 'x' ? tracks.columns : tracks.rows
    const size = side => Math.max(0, ...side.map(item => weight(axis === 'x' ? item.col : item.row, axis === 'x' ? item.w : item.h, values)))
    const first = size(spans[0]), second = size(spans[1])
    return first + second > 0 ? first / (first + second) : .5
  }

  function updateResizeHandles() {
    const doc = globalThis.document
    if (!doc) return
    const grid = doc.getElementById('grid')
    if (!grid) return
    if (!grid.classList.contains('pi-split-resize-enabled')) grid.classList.add('pi-split-resize-enabled')
    const info = sceneGridInfo(grid)
    if (!info) {
      resizeLayer?.replaceChildren()
      return
    }
    if (activeTreeResize?.info.sceneId === info.sceneId) {
      if (activeTreeResize.previewTree) positionTreePanels(grid, activeTreeResize.previewTree)
      return
    }
    if (!resizeLayer || resizeLayer.parentElement !== grid) {
      resizeLayer?.remove()
      resizeLayer = doc.createElement('div')
      resizeLayer.className = 'pi-resize-layer'
      resizeLayer.setAttribute('aria-label', '面板尺寸调节')
      grid.append(resizeLayer)
      resizeSignature = ''
      resizeObserver?.disconnect()
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => {
          const current = sceneGridInfo(grid)
          if (activeTreeResize?.info.sceneId === current?.sceneId) {
            if (activeTreeResize.previewTree) positionTreePanels(grid, activeTreeResize.previewTree)
            return
          }
          if (current?.panels.some(panel => panel.classList.contains('panel-expanded') || panel.classList.contains('pi-maximized'))) return
          const tree = current && treeFor(current)
          if (current && tree) {
            if (savedTree(current)) applyTreeState(current, tree)
            updateTreeHandles(current, tree)
          } else if (current) positionResizeHandles(current)
        })
        resizeObserver.observe(grid)
      }
    }
    const persistedTree = savedTree(info)
    const tracks = activeGridResize?.info.sceneId === info.sceneId
      ? activeGridResize.current : getSceneTracks(info.sceneId, info.columns, info.rows)
    if (!persistedTree && activeGridResize?.info.sceneId !== info.sceneId) applyGridTracks(grid, tracks)
    const state = treeFor(info)
    if (state) {
      if (info.panels.some(panel => panel.classList.contains('panel-expanded') || panel.classList.contains('pi-maximized'))) {
        resizeLayer.hidden = true
        return
      }
      resizeLayer.hidden = false
      if (persistedTree) applyTreeState(info, state)
      updateTreeHandles(info, state)
      if (persistedTree) {
        if (state.topology !== persistedTree.topology || JSON.stringify(state.geometry) !== JSON.stringify(persistedTree.geometry)) saveSplitTree(info.sceneId, state)
      }
      return
    }
    if (activeGridResize?.info.sceneId !== info.sceneId) applyGridTracks(grid, tracks)
    if (resizeSignature !== info.signature) {
      const wanted = new Set()
      const vertical = new Map()
      const horizontal = new Map()
      for (let boundary = 1; boundary < info.columns; boundary++) {
        const rows = exposedVerticalRows(info.geometry, boundary, info.rows)
        vertical.set(boundary, rows)
        for (const row of rows) {
          const key = `x:${boundary}:${row}`
          wanted.add(key)
          makeResizeHandle(resizeLayer, key, 'x', `调整第${boundary}列与第${boundary + 1}列宽度`)
        }
      }
      for (let boundary = 1; boundary < info.rows; boundary++) {
        const columns = exposedHorizontalColumns(info.geometry, boundary, info.columns)
        horizontal.set(boundary, columns)
        for (const col of columns) {
          const key = `y:${boundary}:${col}`
          wanted.add(key)
          makeResizeHandle(resizeLayer, key, 'y', `调整第${boundary}行与第${boundary + 1}行高度`)
        }
      }
      for (const [xBoundary, xRows] of vertical) {
        for (const [yBoundary, yColumns] of horizontal) {
          const touchesX = xRows.some(row => row === yBoundary || row === yBoundary + 1)
          const touchesY = yColumns.some(col => col === xBoundary || col === xBoundary + 1)
          if (!touchesX || !touchesY) continue
          const key = `xy:${xBoundary}:${yBoundary}`
          wanted.add(key)
          makeResizeHandle(resizeLayer, key, 'xy', `同时调整第${xBoundary}列边界与第${yBoundary}行边界`)
        }
      }
      for (const child of [...resizeLayer.children]) if (!wanted.has(child.dataset.resizeKey)) child.remove()
      resizeSignature = info.signature
    }
    positionResizeHandles(info, tracks)
  }

  function positionResizeHandles(info, providedTracks) {
    const doc = globalThis.document
    if (!doc) return
    const grid = doc.getElementById('grid')
    if (!grid || !resizeLayer || info.panels.some(panel => panel.classList.contains('panel-expanded') || panel.classList.contains('pi-maximized'))) {
      if (resizeLayer) resizeLayer.hidden = true
      return
    }
    resizeLayer.hidden = false
    const tracks = providedTracks || getSceneTracks(info.sceneId, info.columns, info.rows)
    const metrics = gridMetrics(grid, info.columns, info.rows)
    const sizesX = tracks.columns.map(value => metrics.availableX * value / info.columns)
    const sizesY = tracks.rows.map(value => metrics.availableY * value / info.rows)
    const prefix = (sizes, index, gap) => sizes.slice(0, index).reduce((sum, value) => sum + value, 0) + gap * index
    const leftAt = boundary => metrics.borderLeft + metrics.padLeft + prefix(sizesX, boundary, metrics.gapX) - metrics.gapX
    const topAt = boundary => metrics.borderTop + metrics.padTop + prefix(sizesY, boundary, metrics.gapY) - metrics.gapY
    const colStart = col => metrics.borderLeft + metrics.padLeft + prefix(sizesX, col - 1, metrics.gapX)
    const rowStart = row => metrics.borderTop + metrics.padTop + prefix(sizesY, row - 1, metrics.gapY)
    const set = (button, left, top, width, height) => {
      button.style.left = `${left}px`; button.style.top = `${top}px`
      button.style.width = `${Math.max(0, width)}px`; button.style.height = `${Math.max(0, height)}px`
    }
    for (const button of resizeLayer.children) {
      const [, axis, aText, bText] = button.dataset.resizeKey.match(/^(x|y|xy):(\d+):(\d+)$/) || []
      if (!axis) continue
      const a = Number(aText), b = Number(bText)
      if (axis === 'x') {
        set(button, leftAt(a) + metrics.gapX / 2 - RESIZE_HIT_CSS_PX / 2, rowStart(b), RESIZE_HIT_CSS_PX, sizesY[b - 1])
        const now = Math.round(100 * legacyHandleRatio(info, tracks, axis, a, b))
        button.setAttribute('aria-valuenow', String(now))
        button.setAttribute('aria-valuetext', `${now}%；当前相邻列比例`)
      } else if (axis === 'y') {
        set(button, colStart(b), topAt(a) + metrics.gapY / 2 - RESIZE_HIT_CSS_PX / 2, sizesX[b - 1], RESIZE_HIT_CSS_PX)
        const now = Math.round(100 * legacyHandleRatio(info, tracks, axis, a, b))
        button.setAttribute('aria-valuenow', String(now))
        button.setAttribute('aria-valuetext', `${now}%；当前相邻行比例`)
      } else {
        set(button, leftAt(a) + metrics.gapX / 2 - RESIZE_HIT_CSS_PX / 2, topAt(b) + metrics.gapY / 2 - RESIZE_HIT_CSS_PX / 2, RESIZE_HIT_CSS_PX, RESIZE_HIT_CSS_PX)
        const xRatio = Math.round(100 * legacyHandleRatio(info, tracks, 'x', a, b))
        const yRatio = Math.round(100 * legacyHandleRatio(info, tracks, 'y', b, a))
        button.setAttribute('aria-valuenow', String(xRatio))
        button.setAttribute('aria-valuetext', `宽度${xRatio}%，高度${yRatio}%；当前相邻行列比例`)
      }
    }
  }

  function beginGridResize(event) {
    if (event.button !== 0 || activeGridResize) return
    const grid = event.currentTarget.closest('#grid')
    const info = grid && sceneGridInfo(grid)
    if (!info || info.panels.some(panel => panel.classList.contains('panel-expanded') || panel.classList.contains('pi-maximized'))) return
    const key = event.currentTarget.dataset.resizeKey
    if (key.startsWith('t')) return beginTreeResize(event, info, key)
    const [, axis, aText, bText] = key.match(/^(x|y|xy):(\d+):(\d+)$/) || []
    if (!axis) return
    const state = treeFor(info)
    if (state) {
      const nodes = treeNodes(state.tree)
      const a = Number(aText), b = Number(bText)
      const nodeFor = targetAxis => nodes.find(node => node.axis === targetAxis && node.boundary === a)
      const xNode = axis !== 'y' ? nodeFor('x') : null
      const yNode = axis === 'xy' ? nodes.find(node => node.axis === 'y' && node.boundary === b) : axis === 'y' ? nodes.find(node => node.axis === 'y' && node.boundary === a) : null
      if ((axis === 'x' && xNode) || (axis === 'y' && yNode) || (axis === 'xy' && xNode && yNode)) {
        const oldKey = event.currentTarget.dataset.resizeKey
        event.currentTarget.dataset.resizeKey = axis === 'xy' ? `txy:${xNode.path}:${yNode.path}` : `t${axis}:${(axis === 'x' ? xNode : yNode).path}`
        beginTreeResize(event, info, event.currentTarget.dataset.resizeKey)
        event.currentTarget.dataset.resizeKey = oldKey
        return
      }
    }
    const tracks = getSceneTracks(info.sceneId, info.columns, info.rows)
    const metrics = gridMetrics(grid, info.columns, info.rows)
    activeGridResize = {
      pointerId: event.pointerId, handle: event.currentTarget, grid, info, axis,
      boundaryX: axis === 'y' ? undefined : Number(aText),
      boundaryY: axis === 'x' ? undefined : (axis === 'y' ? Number(aText) : Number(bText)),
      startX: event.clientX, startY: event.clientY,
      availableX: metrics.availableX, availableY: metrics.availableY,
      base: { columns: [...tracks.columns], rows: [...tracks.rows] },
      current: tracks,
    }
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* Window listeners remain the fallback. */ }
    event.currentTarget.dataset.active = 'true'
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    document.body.classList.add('pi-grid-resizing')
    window.addEventListener('pointermove', moveGridResize, true)
    window.addEventListener('pointerup', endGridResize, true)
    window.addEventListener('pointercancel', cancelGridResize, true)
    window.addEventListener('blur', cancelGridResize, { once: true })
  }

  function findTreeNodesForLegacy(state, axis, a, b) {
    const nodes = treeNodes(state.tree)
    if (axis === 'xy') {
      const x = nodes.find(node => node.axis === 'x' && node.boundary === a)
      const y = nodes.find(node => node.axis === 'y' && node.boundary === b)
      return { xNode: x, yNode: y }
    }
    const targetAxis = axis
    const boundary = a
    const coordinate = b
    return { node: nodes.find(node => node.axis === targetAxis && node.boundary === boundary) }
  }

  function beginTreeResize(event, info, key) {
    if (event.button !== 0 || activeTreeResize) return
    const state = treeFor(info)
    if (!state) return
    const xy = key.match(/^txy:(.+):(.+)$/)
    const single = key.match(/^t([xy]):(.+)$/)
    const nodes = treeNodes(state.tree)
    const xNode = xy ? nodes.find(node => node.path === xy[1]) : null
    const yNode = xy ? nodes.find(node => node.path === xy[2]) : null
    const node = single ? nodes.find(item => item.path === single[2]) : null
    if ((xy && (!xNode || !yNode)) || (single && !node)) return
    const grid = event.currentTarget.closest('#grid')
    activeTreeResize = {
      pointerId: event.pointerId, handle: event.currentTarget, grid, info,
      state, original: JSON.parse(JSON.stringify(state.tree)),
      startX: event.clientX, startY: event.clientY,
      startScale: gridScale(grid),
      xNode, yNode, node, moved: false,
      originalStyles: new Map(info.panels.map(panel => [panel, { style: panel.getAttribute('style'), managed: panel.dataset.splitTreeManaged }]))
    }
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* Window listeners below remain active. */ }
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    window.addEventListener('pointermove', moveTreeResize, true)
    window.addEventListener('pointerup', endTreeResize, true)
    window.addEventListener('pointercancel', cancelTreeResize, true)
    window.addEventListener('blur', cancelTreeResize, { once: true })
    event.currentTarget.addEventListener('lostpointercapture', onTreeLostCapture)
  }

  function onTreeLostCapture(event) {
    if (activeTreeResize && activeTreeResize.pointerId === event.pointerId) finishTreeResize(true)
  }

  function moveTreeResize(event) {
    const active = activeTreeResize
    if (!active || (event.pointerId !== undefined && active.pointerId !== undefined && event.pointerId !== active.pointerId)) return
    if (!active.moved && Math.hypot((event.clientX - active.startX) / active.startScale.x, (event.clientY - active.startY) / active.startScale.y) < RESIZE_START_THRESHOLD_CSS_PX) return
    if (!active.moved) {
      active.handle.dataset.active = 'true'
      document.body.classList.add('pi-grid-resizing')
    }
    const currentTree = JSON.parse(JSON.stringify(active.original))
    const nodes = treeNodes(currentTree)
    const applyDelta = (path, delta) => {
      const node = nodes.find(item => item.path === path)
      if (!node || !delta) return false
      const liveState = active.state
      const sourceNode = treeNodes(liveState.tree).find(item => item.path === path)
      if (!sourceNode) return false
      const grid = active.grid
      const region = collectTreeRegions(liveState.tree, gridContentBounds(grid), { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') }).get(path)
      if (!region) return false
      const available = (node.axis === 'x' ? region.width - sceneGridGap(grid, 'x') : region.height - sceneGridGap(grid, 'y'))
      const panels = new Map(active.info.panels.map(panel => [panel.dataset.panelId, panel]))
      node.ratio = clampSplitRatio(node, node.ratio + delta / Math.max(1, available), region, panels, { x: sceneGridGap(grid, 'x'), y: sceneGridGap(grid, 'y') })
      return true
    }
    let changed = false
    if (active.xNode) changed = applyDelta(active.xNode.path, event.clientX - active.startX) || changed
    if (active.yNode) changed = applyDelta(active.yNode.path, event.clientY - active.startY) || changed
    if (active.node) changed = applyDelta(active.node.path, active.node.axis === 'x' ? event.clientX - active.startX : event.clientY - active.startY) || changed
    if (!changed) return
    active.previewTree = currentTree
    active.moved = true
    positionTreePanels(active.grid, currentTree)
    positionTreeHandles(active.info, { tree: currentTree })
    event.preventDefault(); event.stopPropagation()
  }

  function finishTreeResize(cancelled = false) {
    const active = activeTreeResize
    if (!active) return
    activeTreeResize = undefined
    window.removeEventListener('pointermove', moveTreeResize, true)
    window.removeEventListener('pointerup', endTreeResize, true)
    window.removeEventListener('pointercancel', cancelTreeResize, true)
    window.removeEventListener('blur', cancelTreeResize)
    active.handle.removeEventListener('lostpointercapture', onTreeLostCapture)
    document.body.classList.remove('pi-grid-resizing')
    delete active.handle.dataset.active
    delete active.handle.dataset.pointerActive
    active.handle.dataset.pointerSuppressed = 'true'
    try { if (active.handle.hasPointerCapture?.(active.pointerId)) active.handle.releasePointerCapture(active.pointerId) } catch { /* Capture may already be released by the browser. */ }
    if (cancelled || !active.moved) {
      if (savedTree(active.info)) {
        active.state.tree = active.original
        active.state.topology = treeTopology(active.original)
      }
      for (const [panel, original] of active.originalStyles) {
        if (original.style == null) panel.removeAttribute('style')
        else panel.setAttribute('style', original.style)
        if (original.managed === undefined) delete panel.dataset.splitTreeManaged
        else panel.dataset.splitTreeManaged = original.managed
      }
      if (!savedTree(active.info)) resizeTrees.delete(active.info.sceneId)
      const current = sceneGridInfo(document.getElementById('grid'))
      if (current?.sceneId === active.info.sceneId) updateResizeHandles()
      return
    }
    const tree = active.previewTree || active.original
    active.state.tree = tree
    active.state.topology = treeTopology(tree)
    active.state.geometrySignature = sceneGridInfo(active.grid).signature
    active.state.geometry = active.info.geometry.map(item => ({ ...item }))
    resizeTrees.set(active.info.sceneId, active.state)
    saveSplitTree(active.info.sceneId, active.state)
    updateResizeHandles()
  }

  function endTreeResize(event) {
    if (activeTreeResize && (event.pointerId === undefined || activeTreeResize.pointerId === undefined || event.pointerId === activeTreeResize.pointerId)) finishTreeResize(false)
  }

  function cancelTreeResize(event) {
    if (event?.type === 'pointercancel' && activeTreeResize?.pointerId !== undefined
      && event.pointerId !== undefined && event.pointerId !== activeTreeResize.pointerId) return
    finishTreeResize(true)
  }

  function adjustPair(values, boundary, delta, available) {
    if (!boundary || boundary < 1 || boundary >= values.length || available <= 0) return values
    const leftIndex = boundary - 1, rightIndex = boundary
    const total = values[leftIndex] + values[rightIndex]
    const minPixels = Math.min(140, available / (values.length * 1.35))
    const minWeight = minPixels / available * values.length
    const change = delta / available * values.length
    const nextLeft = Math.max(minWeight, Math.min(total - minWeight, values[leftIndex] + change))
    const next = [...values]
    next[leftIndex] = nextLeft
    next[rightIndex] = total - nextLeft
    return next
  }

  function moveGridResize(event) {
    const active = activeGridResize
    if (!active || (active.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== active.pointerId)) return
    const tracks = { columns: [...active.base.columns], rows: [...active.base.rows] }
    if (active.boundaryX) tracks.columns = adjustPair(tracks.columns, active.boundaryX, event.clientX - active.startX, active.availableX)
    if (active.boundaryY) tracks.rows = adjustPair(tracks.rows, active.boundaryY, event.clientY - active.startY, active.availableY)
    active.current = tracks
    applyGridTracks(active.grid, tracks)
    positionResizeHandles(active.info, tracks)
    event.preventDefault(); event.stopPropagation()
  }

  function finishGridResize(cancelled = false) {
    const active = activeGridResize
    if (!active) return
    activeGridResize = undefined
    window.removeEventListener('pointermove', moveGridResize, true)
    window.removeEventListener('pointerup', endGridResize, true)
    window.removeEventListener('pointercancel', cancelGridResize, true)
    window.removeEventListener('blur', cancelGridResize)
    document.body.classList.remove('pi-grid-resizing')
    const tracks = cancelled ? active.base : active.current
    delete active.handle.dataset.active
    delete active.handle.dataset.pointerActive
    active.handle.dataset.pointerSuppressed = 'true'
    applyGridTracks(active.grid, tracks)
    if (!cancelled) saveSceneTracks(active.info.sceneId, tracks)
    positionResizeHandles(active.info, tracks)
  }
  function endGridResize(event) {
    if (activeGridResize && (activeGridResize.pointerId === undefined || event.pointerId === undefined || event.pointerId === activeGridResize.pointerId)) finishGridResize(false)
  }
  function cancelGridResize(event) {
    if (event?.type === 'pointercancel' && activeGridResize?.pointerId !== undefined
      && event.pointerId !== undefined && event.pointerId !== activeGridResize.pointerId) return
    finishGridResize(true)
  }

  function transitionDone(panel, callback) {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      panel.removeEventListener('transitionend', onEnd)
      clearTimeout(fallback)
      callback()
    }
    const onEnd = event => {
      if (event.target === panel && ['width', 'height', 'left', 'top'].includes(event.propertyName)) finish()
    }
    const fallback = setTimeout(finish, 360)
    panel.addEventListener('transitionend', onEnd)
  }

  function restore(panel) {
    const state = states.get(panel)
    if (!state || state.pending) return
    state.pending = true
    panel.classList.add('pi-animating')
    // Commit the current fixed geometry before scheduling the restored grid geometry.
    panel.getBoundingClientRect()
    const target = state.slot?.getBoundingClientRect()
    if (!target) {
      finishRestore(panel, state)
      return
    }
    requestAnimationFrame(() => {
      setRect(panel, target)
      transitionDone(panel, () => finishRestore(panel, state))
    })
  }

  function finishRestore(panel, state) {
    if (state.originalStyle == null) panel.removeAttribute('style')
    else panel.setAttribute('style', state.originalStyle)
    panel.classList.remove('pi-maximized', 'pi-animating')
    state.slot?.remove()
    states.delete(panel)
    setFullscreenButton(state.fullButton, false)
    updateResizeHandles()
  }

  async function maximize(panel, button) {
    const current = states.get(panel)
    if (current) {
      restore(panel)
      return
    }

    // ▲ has its own fixed-position/placeholder stack. Let it restore completely before using ours.
    if (panel.classList.contains('panel-expanded')) {
      if (typeof window.collapsePanel !== 'function' || typeof window.expandedStateOf !== 'function') {
        announce('请先收起当前面板，再使用放大按钮。')
        return
      }
      window.collapsePanel(panel)
      button.setAttribute('aria-busy', 'true')
      setTimeout(() => {
        button.removeAttribute('aria-busy')
        if (panel.isConnected && !panel.classList.contains('panel-expanded')) maximize(panel, button)
      }, 360)
      return
    }

    const geometry = gridRect(panel)
    if (!geometry) return
    const { grid, rect: target } = geometry
    const from = panel.getBoundingClientRect()
    const slot = document.createElement('div')
    slot.className = 'pi-slot'
    slot.style.gridColumn = `${panel.dataset.col} / span ${panel.dataset.w}`
    slot.style.gridRow = `${panel.dataset.row} / span ${panel.dataset.h}`
    if (panel.dataset.splitTreeManaged === 'true') {
      const gridRect = grid.getBoundingClientRect(), panelRect = panel.getBoundingClientRect()
      const css = getComputedStyle(grid), scale = gridScale(grid)
      const originX = gridRect.left + ((Number.parseFloat(css.borderLeftWidth) || 0) + (Number.parseFloat(css.paddingLeft) || 0)) * scale.x
      const originY = gridRect.top + ((Number.parseFloat(css.borderTopWidth) || 0) + (Number.parseFloat(css.paddingTop) || 0)) * scale.y
      slot.style.position = 'absolute'
      slot.style.gridColumn = '1 / -1'; slot.style.gridRow = '1 / -1'
      slot.style.left = `${(panelRect.left - originX) / scale.x}px`
      slot.style.top = `${(panelRect.top - originY) / scale.y}px`
      slot.style.width = `${panelRect.width / scale.x}px`
      slot.style.height = `${panelRect.height / scale.y}px`
    }
    grid.insertBefore(slot, panel)

    const state = {
      originalStyle: panel.getAttribute('style'),
      slot,
      fullButton: button,
      pending: false,
    }
    states.set(panel, state)
    panel.style.position = 'fixed'
    panel.style.zIndex = '10000'
    setRect(panel, from)
    panel.classList.add('pi-maximized')
    // Commit viewport start geometry before enabling left/top transitions.
    panel.getBoundingClientRect()
    setFullscreenButton(button, true)
    requestAnimationFrame(() => {
      if (!panel.isConnected) return cleanupDetached(panel)
      panel.classList.add('pi-animating')
      const latest = grid.getBoundingClientRect()
      setRect(panel, latest)
      transitionDone(panel, () => { panel.classList.remove('pi-animating'); updateResizeHandles() })
    })
    requestAnimationFrame(updateResizeHandles)
  }

  function cleanupDetached(panel) {
    const state = states.get(panel)
    if (!state) return
    state.slot?.remove()
    states.delete(panel)
  }

  function installPanel(panel) {
    const header = panel.querySelector(':scope > .panel-header')
    const controls = header?.querySelector(':scope > .panel-controls')
    if (!header || !controls || controls.dataset.piInstalled === '1') return
    controls.dataset.piInstalled = '1'

    const fullButton = document.createElement('button')
    fullButton.type = 'button'
    fullButton.className = 'icon-control pi-action pi-fullscreen'
    setFullscreenButton(fullButton, false)
    fullButton.addEventListener('click', () => maximize(panel, fullButton))

    const moreButton = document.createElement('button')
    moreButton.type = 'button'
    moreButton.className = 'icon-control pi-action pi-more'
    moreButton.textContent = '⋯'
    moreButton.title = '更多面板操作'
    moreButton.setAttribute('aria-label', moreButton.title)
    moreButton.setAttribute('aria-haspopup', 'menu')
    moreButton.setAttribute('aria-expanded', 'false')
    moreButton.addEventListener('click', event => {
      event.stopPropagation()
      if (menu?.button === moreButton) closeMenu()
      else openMenu(moreButton, panel)
    })

    controls.append(fullButton, moreButton)
  }

  function scan(root) {
    if (activeTreeResize) {
      const current = sceneGridInfo(document.getElementById('grid'))
      if (!current || current.sceneId !== activeTreeResize.info.sceneId) finishTreeResize(true)
    }
    if (root.matches?.('.panel')) installPanel(root)
    root.querySelectorAll?.('.panel').forEach(installPanel)
    for (const panel of [...states.keys()]) {
      if (!panel.isConnected) cleanupDetached(panel)
    }
    if (menu && !menu.panel.isConnected) closeMenu()
    updateResizeHandles()
  }

  function onPointerDown(event) {
    const header = eligibleHeader(event)
    if (!header) return
    const panel = header.closest('.panel')
    if (event.detail >= 2 || (panel && states.has(panel))) event.stopImmediatePropagation()
  }

  function onDoubleClick(event) {
    const header = eligibleHeader(event)
    if (!header) return
    const panel = header.closest('.panel')
    if (!panel) return
    event.preventDefault()
    event.stopPropagation()
    const button = panel.querySelector('.pi-fullscreen')
    if (button) { maximize(panel, button); requestAnimationFrame(updateResizeHandles) }
  }

  function onExistingExpandClick(event) {
    const button = event.target.closest?.('.panel-expand')
    const panel = button?.closest('.panel')
    if (!button || !panel || !states.has(panel)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    restore(panel)
    setTimeout(() => {
      if (panel.isConnected && !states.has(panel)) button.click()
    }, 360)
  }

  function onResize() {
    for (const [panel, state] of states) {
      if (state.pending || !panel.isConnected) continue
      const geometry = gridRect(panel)
      if (geometry) setRect(panel, geometry.rect)
    }
  }

  function start() {
    scan(document)
    observer = new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(node => { if (node.nodeType === Node.ELEMENT_NODE) scan(node) })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const grid = document.getElementById('grid')
    if (grid && typeof MutationObserver === 'function') {
      resizeClassObserver = new MutationObserver(updateResizeHandles)
      resizeClassObserver.observe(grid, { attributes: true, attributeFilter: ['class', 'data-col', 'data-row', 'data-w', 'data-h'], subtree: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onResizePointerInput, true)
    document.addEventListener('pointerdown', onResizePointerInput, true)
    document.addEventListener('keydown', onResizeKeyboardInput, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    document.addEventListener('click', onExistingExpandClick, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('resize', updateResizeHandles)
  }

  function onResizePointerInput() {
    if (resizeLayer) resizeLayer.dataset.inputModality = 'pointer'
  }

  function onResizeKeyboardInput(event) {
    if (resizeLayer && ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      resizeLayer.dataset.inputModality = 'keyboard'
      if (document.activeElement?.classList.contains('pi-resize-handle')) delete document.activeElement.dataset.pointerSuppressed
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
