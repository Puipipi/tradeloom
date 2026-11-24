window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.scenes.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROLE_WIDGET_RETAIN_SOURCE = 'tradeloomRoleWidget'
    let MarkdownText
    try { MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText } catch { /* The source view and download remain available without the optional reader module. */ }
    const listeners = new Set()
    const retainedByRole = new Map()
    const pendingFloatingRestoreByScene = new Map()
    const floatingOriginsByScene = new Map()
    const pendingPopoutRestoreByScene = new Map()
    const dockviewApis = new Map()
    const pendingScenePanelFocus = new Map()
    const pendingClosedPanelPositions = new Map()
    const dockviewRenderers = new Map()
    const narrowListeners = new Map()
    const asyncRequire = typeof require.async === 'function' ? require.async.bind(require) : null
    let dockviewChunkRequest
    let workflowRequest
    let businessViewIntentRevision = 0
    let dockSaveQueue = Promise.resolve()
    let dockMotionSequence = 0
    let dockRevision = 0
    let dockPersistedRevision = 0
    let snapshot = {
      config: null, configError: '', activeSceneId: 'center', roleByScene: {}, businessPath: '/home',
      layouts: {}, dockLayouts: null, dockDefaults: {}, visitedScenes: ['center'], dockSaveErrors: {},
      businessPathsByScene: {}, proposalHrefsByScene: {}, businessViewIntentsByScene: {}, sessionBindings: {}, sessionBindingMetadata: {}, sessionErrors: {}, panelRefreshKeys: {},
      fileSelectionGenerations: {},
    }
    let layoutApi
    let uiWorkspaceApi
    let sessionsApi
    let modelDirectoriesApi
    let themeApi
    let activeColorScheme = 'light'
    let activeUiTokens = {}
    let activePalette = {}
    let businessOriginCallback
    let roleDefinitionsCallback
    let configRequest
    let configGeneration = 0
    const sceneTabPreferenceKey = 'tradeloom.workbench.scene-tabs'
    let sceneTabPreferences
    let sceneTabStorageReadable = true
    let sceneStateRequest
    const sessionRequests = new Map()
    const fileSelectionByScene = new Map()

    function trustedDesktopPopoutWindow(popoutWindow) {
      if (!popoutWindow || popoutWindow.opener !== window) return false
      try {
        const location = popoutWindow.location
        return location.protocol === 'dsh-app:' && location.hostname === 'app' && location.port === ''
          && location.pathname === '/desktop-pane-popout.html' && location.hash === ''
          && [...new URL(location.href).searchParams.entries()].length === 1
          && /^[A-Za-z0-9_-]{43}$/.test(new URL(location.href).searchParams.get('ticket') ?? '')
          && new URL(location.href).searchParams.has('ticket')
      } catch { return false }
    }

    function validDesktopPopoutUrl(value) {
      try {
        const url = new URL(value)
        const params = [...url.searchParams.entries()]
        return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
          && url.username === '' && url.password === '' && url.pathname === '/desktop-pane-popout.html'
          && url.hash === '' && params.length === 1 && params[0][0] === 'ticket' && /^[A-Za-z0-9_-]{43}$/.test(params[0][1])
          ? url.href : ''
      } catch { return '' }
    }

    function serializeDockGridWithoutPanel(dockview, panelId) {
      if (!dockview?.grid?.root || !dockview.panels) return null
      const stripPanel = (node, root = false) => {
        if (node.type === 'leaf') {
          if (!node.data.views.includes(panelId)) return node
          const views = node.data.views.filter(id => id !== panelId)
          if (!views.length) return null
          return { ...node, data: {
            ...node.data, views,
            activeView: views.includes(node.data.activeView) ? node.data.activeView : views[0],
          } }
        }
        const data = node.data.map(child => stripPanel(child)).filter(Boolean)
        if (!data.length) return null
        if (data.length === 1) return { ...data[0], size: root ? 100 : node.size }
        const total = data.reduce((sum, child) => sum + child.size, 0)
        const normalized = total > 0
          ? data.map(child => ({ ...child, size: Number((child.size / total * 100).toFixed(3)) }))
          : data
        return { ...node, size: root ? 100 : node.size, data: normalized }
      }
      const grid = { ...dockview.grid, root: stripPanel(dockview.grid.root, true) }
      return JSON.stringify({ grid, panels: Object.keys(dockview.panels).filter(id => id !== panelId).sort() })
    }

    function findSerializedGridLeaf(root, matchesGroup) {
      if (!root) return null
      if (root.type === 'leaf') return matchesGroup(root.data) ? root : null
      for (const child of root.data ?? []) {
        const found = findSerializedGridLeaf(child, matchesGroup)
        if (found) return found
      }
      return null
    }

    function findSerializedLeafForPanel(root, panelId) {
      return findSerializedGridLeaf(root, group => group?.views?.includes(panelId))
    }

    function findSerializedLeafByGroupId(root, groupId) {
      return findSerializedGridLeaf(root, group => group?.id === groupId)
    }

    // Build a storage-only grid from the current tree; the live Dockview stays untouched.
    function projectFloatingGroupsIntoSavedGrid(layout, origins) {
      const copy = JSON.parse(JSON.stringify(layout))
      const floating = copy.floatingGroups ?? []
      if (floating.length !== origins.size || copy.grid?.root?.type !== 'branch') return null
      const entries = []
      for (const [panelId, origin] of origins) {
        const external = floating.find(item => item.data?.views?.length === 1 && item.data.views[0] === panelId)
        if (!external || !copy.panels?.[panelId]) return null
        const target = findSerializedLeafByGroupId(copy.grid.root, origin.groupId)
        if (target) {
          const current = target.data.views
          const at = origin.views.indexOf(panelId)
          const next = origin.views.slice(at + 1).find(id => current.includes(id))
          const previous = origin.views.slice(0, at).reverse().find(id => current.includes(id))
          const index = previous && next && current.indexOf(previous) > current.indexOf(next) ? current.indexOf(previous) + 1
            : next ? current.indexOf(next) : previous ? current.indexOf(previous) + 1 : current.length ? -1 : 0
          if (at < 0 || index < 0) return null
          current.splice(index, 0, panelId)
          if (copy.activeGroup === external.data.id) target.data.activeView = panelId
        } else {
          if (!origin.anchor?.flat) return null
          entries.push({ origin, external })
        }
        if (copy.activeGroup === external.data.id) copy.activeGroup = target?.data.id ?? external.data.id
      }
      if (entries.length) {
        const nodes = copy.grid.root.data
        if (nodes.some(node => node.type !== 'leaf')) return null
        const base = entries[0].origin.anchor
        if (entries.some(({origin}) => origin.anchor.dimension !== base.dimension)) return null
        const indexed = nodes.map(node => {
          const sibling = base.siblings.find(item => item.id === node.data.id)
          return sibling ? { node, index: sibling.index } : null
        })
        if (indexed.some(item => !item)) return null
        const total = indexed.reduce((sum, item) => sum + item.node.size, 0)
        const externalWeight = entries.reduce((sum, item) => sum + item.origin.anchor.slotWeight, 0)
        if (!(total > 0 && externalWeight > 0 && externalWeight < 1)) return null
        const extent = base.dimension === 'width' ? copy.grid.width : copy.grid.height
        const original = entries[0].origin.layout.grid
        const originalNodes = original.root.data
        const originalExtent = base.dimension === 'width' ? original.width : original.height
        const margin = originalNodes.length > 1
          ? (originalExtent - originalNodes.reduce((sum, node) => sum + node.size, 0)) / (originalNodes.length - 1)
          : 0
        const available = extent - Math.max(0, margin) * (nodes.length + entries.length - 1)
        for (const item of indexed) item.node.size = available * (1 - externalWeight) * item.node.size / total
        for (const {origin, external} of entries) indexed.push({ index:origin.anchor.index,
          node:{ type:'leaf', size:available * origin.anchor.slotWeight, data:external.data } })
        indexed.sort((a,b) => a.index-b.index)
        copy.grid.root.data = indexed.map(item => item.node)
      }
      delete copy.floatingGroups
      return copy
    }

    function captureFloatingPanelReturnAnchor(grid, panelId) {
      let found = null
      const firstLeaf = node => node?.type === 'leaf' ? node : (node?.data ?? []).map(firstLeaf).find(Boolean)
      const visit = (node, orientation) => {
        if (node?.type !== 'branch') return
        const children = node.data ?? []
        for (let i = 0; i < children.length; i++) {
          const child = children[i]
          if (child?.type === 'leaf' && child.data?.views?.includes(panelId)) {
            const siblingIndex = i ? i - 1 : i + 1
            const anchor = firstLeaf(children[siblingIndex])
            if (anchor?.data?.id) {
              const total = children.reduce((sum, child) => sum + child.size, 0)
              found = { anchorId: anchor.data.id,
                direction: orientation === 'HORIZONTAL' ? (siblingIndex < i ? 'right' : 'left') : (siblingIndex < i ? 'below' : 'above'),
                dimension: orientation === 'HORIZONTAL' ? 'width' : 'height', flat:children.every(child => child.type === 'leaf'),
                slotWeight: total > 0 ? children[i].size / total : 0,
                siblings: children.map((child, index) => ({index, id:firstLeaf(child)?.data?.id, weight:total > 0 ? child.size / total : 0})).filter(item => item.index !== i && item.id), index:i }
            }
          } else visit(child, orientation === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL')
        }
      }
      visit(grid?.root, grid?.orientation)
      return found
    }

    // A popout can leave an empty return group in its opener; rebuild that group in the return snapshot.
    function reconstructPopoutReturnLayout(layout, restore) {
      const targetId = restore?.returnGroupId
      const panelIds = restore?.returnPanelIds
      if (!layout?.grid?.root || !layout.panels || !targetId || !Array.isArray(panelIds)
        || !Array.isArray(layout.popoutGroups) || layout.popoutGroups.length !== 1) return null

      const livePanelIds = panelIds.filter(id => Object.prototype.hasOwnProperty.call(layout.panels, id))
      if (!livePanelIds.includes(restore.panelId)) return null
      let targetFound = false
      let returnedCount = 0
      const addReturnedPanels = node => {
        if (node.type === 'leaf') {
          if (node.data?.id !== targetId) return node
          const existingViews = Array.isArray(node.data.views) ? node.data.views : []
          if (existingViews.length) return node
          const missingViews = livePanelIds.filter(id => !findSerializedLeafForPanel(layout.grid.root, id))
          if (!existingViews.length && !missingViews.length) return node
          targetFound = true
          returnedCount = missingViews.length
          const views = [...existingViews, ...missingViews]
          return { ...node, visible: true, data: {
            ...node.data,
            views,
            activeView: views.includes(node.data.activeView) ? node.data.activeView
              : views.includes(restore.returnActiveView) ? restore.returnActiveView : views[0],
          } }
        }
        return { ...node, data: (node.data ?? []).map(addReturnedPanels) }
      }
      const root = addReturnedPanels(layout.grid.root)
      if (!targetFound || !returnedCount) return null
      const merged = { ...layout, grid: { ...layout.grid, root } }
      delete merged.popoutGroups
      return merged
    }

    function registeredPopoutBusinessFrames(requestedSceneId) {
      const frames = []
      for (const [sceneId, api] of dockviewApis) {
        if (requestedSceneId && sceneId !== requestedSceneId) continue
        const scene = snapshot.config?.scenes.find(item => item.id === sceneId)
        if (!scene) continue
        for (const popout of api?.getPopouts?.() ?? []) {
          const popoutWindow = popout?.window
          if (!trustedDesktopPopoutWindow(popoutWindow)) continue
          const groupPanelIds = new Set((popout.group?.panels ?? []).map(panel => panel?.id).filter(Boolean))
          try {
            for (const frame of popoutWindow.document.querySelectorAll('iframe[data-tradeloom-business-frame]')) {
              const panelId = frame.dataset?.tradeloomPanelId
              if (!groupPanelIds.has(panelId) || !scene.panels.some(panel => panel.id === panelId && panel.type === 'business-iframe')) continue
              frames.push(frame)
            }
          } catch { /* A closed or navigating popout contributes no trusted frames. */ }
        }
      }
      return frames
    }

    function notifyBusinessPopoutFramesChanged() {
      try { window.dispatchEvent(new Event('tradeloom:business-popout-frames-change')) } catch { /* Optional theme bridge refresh. */ }
    }

    const OWNER_DOCUMENT_ROOT_SELECTOR = '[data-dsh-owner-document-root]'
    const OWNER_DOCUMENT_CHANGE_EVENT = 'dsh:composer-owner-document-change'

    function notifyOwnerDocumentRoots(document) {
      try {
        const EventConstructor = document?.defaultView?.Event
        if (typeof EventConstructor !== 'function') return 0
        const roots = [...(document.documentElement?.matches?.(OWNER_DOCUMENT_ROOT_SELECTOR) ? [document.documentElement] : []),
          ...(document.documentElement?.querySelectorAll?.(OWNER_DOCUMENT_ROOT_SELECTOR) ?? [])]
        for (const root of roots) {
          if (root.ownerDocument !== document) continue
          root.dispatchEvent(new EventConstructor(OWNER_DOCUMENT_CHANGE_EVENT))
        }
        return roots.length
      } catch { return 0 }
    }

    function scheduleOwnerDocumentRefresh(targetWindow) {
      if (!targetWindow) return
      const targetDocument = targetWindow.document
      let frames = 0
      const refresh = () => {
        notifyOwnerDocumentRoots(targetDocument)
        // Dockview moves the existing React portal after its lifecycle event;
        // one additional frame lets the adopted roots settle without a global observer.
        if (frames++ < 1 && !targetWindow.closed && typeof targetWindow.requestAnimationFrame === 'function') {
          targetWindow.requestAnimationFrame(refresh)
        }
      }
      try {
        if (typeof targetWindow.requestAnimationFrame === 'function') targetWindow.requestAnimationFrame(refresh)
        else Promise.resolve().then(refresh)
      } catch { /* A closing secondary window no longer needs rebinding. */ }
    }

    function filePanelRole(panel) {
      if (panel?.type !== 'business-iframe') return ''
      if (panel.path === '/artifacts#files') return 'files'
      if (panel.path === '/artifacts#preview') return 'preview'
      if (panel.path === '/artifacts#deliverables' && panel.id === 'business-main') return 'deliverables'
      return ''
    }

    const FILE_DROP_MIME = 'application/x-tradeloom-file'
    const FILE_EXPORT_TIMEOUT_MS = 15000
    const FILE_FOCUS_TIMEOUT_MS = 5000

    function parseFileDropPayload(dataTransfer) {
      if (!dataTransfer?.types || !Array.from(dataTransfer.types).includes(FILE_DROP_MIME)) return null
      try {
        const value = JSON.parse(dataTransfer.getData(FILE_DROP_MIME))
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'id,kind'
          || !['source', 'artifact'].includes(value.kind)
          || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128
          || /[\u0000-\u001f\u007f]/.test(value.id)) return null
        return { kind: value.kind, id: value.id }
      } catch { return null }
    }

    function createFileSelectionMessageHandler(scene, getFrames, origin, getBusinessPath = () => '') {
      const send = (frame, message) => frame?.contentWindow?.postMessage?.(message, origin)
      const pendingExports = new Map()
      const pendingFocus = new Map()
      let fileSelectionSource
      let exportSequence = 0
      function frameRole(frame, panel) {
        if (!frame?.src || panel?.type !== 'business-iframe') return ''
        let frameUrl
        try { frameUrl = new URL(frame.src, origin) } catch { return '' }
        const frameOrigin = frameUrl.protocol === 'dsh-app:' && frameUrl.host === 'app' ? 'dsh-app://app' : frameUrl.origin
        if (frameOrigin !== origin) return ''
        if (panel.id === 'business-main' && scene?.id === 'agent-center') {
          const businessPath = getBusinessPath?.() || panel.path
          if (businessPath && frameUrl.pathname === `/business${businessPath.split('#')[0]}` && frameUrl.hash === '') {
            return /^\/workflow-tasks\/[A-Za-z0-9_-]{1,128}$/.test(businessPath) ? 'workflow-tasks' : ''
          }
        }
        if (frameUrl.pathname !== `/business${panel.path?.split('#')[0]}`
          || frameUrl.hash !== (panel.path?.includes('#') ? `#${panel.path.split('#')[1]}` : '')) return ''
        return filePanelRole(panel)
      }
      function requestFileExport(kind, id, onResult) {
        const validId = typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id)
        if (!['source', 'artifact'].includes(kind) || !validId || typeof onResult !== 'function') return false
        const frames = getFrames?.() ?? []
        const candidates = frames.filter(frame => {
          const panel = scene.panels.find(item => item.id === frame?.dataset?.tradeloomPanelId)
          const role = frameRole(frame, panel)
          return kind === 'source' ? role === 'files' : ['files', 'deliverables'].includes(role)
        })
        const selectedSource = fileSelectionSource?.kind === kind && fileSelectionSource.id === id
          ? fileSelectionSource : null
        const target = selectedSource && candidates.find(frame => frame === selectedSource.frame
          && frame.contentWindow === selectedSource.contentWindow) || null
        if (!target) return false
        const nonce = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID() : `tradeloom-${Date.now()}-${++exportSequence}`
        const timeout = setTimeout(() => {
          const pending = pendingExports.get(nonce)
          if (!pending) return
          pendingExports.delete(nonce)
          pending.onResult({ ok: false, error: '文件导出超时，请重试。' })
        }, FILE_EXPORT_TIMEOUT_MS)
        pendingExports.set(nonce, { kind, id, source: target.contentWindow, onResult, timeout })
        send(target, { type: 'tradeloom:file-export-request', kind, id, nonce })
        return true
      }
      function requestFileFocus(kind, id, onResult) {
        const validId = typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id)
        const selection = fileSelectionByScene.get(scene?.id)
        if (!['source', 'artifact'].includes(kind) || !validId || typeof onResult !== 'function'
          || selection?.kind !== kind || selection.id !== id) return false
        const frame = (getFrames?.() ?? []).find(item => {
          const panel = scene.panels.find(candidate => candidate.id === item?.dataset?.tradeloomPanelId)
          return frameRole(item, panel) === 'files'
        })
        const nonce = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID() : `tradeloom-focus-${Date.now()}-${++exportSequence}`
        const generation = snapshot.fileSelectionGenerations?.[scene.id] ?? 0
        const timeout = setTimeout(() => {
          const pending = pendingFocus.get(nonce)
          if (!pending) return
          pendingFocus.delete(nonce)
          pending.onResult({ ok: false, found: false, error: '文件栏未能定位到此版本，请重试。' })
        }, FILE_FOCUS_TIMEOUT_MS)
        const pending = { kind, id, source: null, targetFrame: frame ?? null, generation, onResult, timeout }
        pendingFocus.set(nonce, pending)
        if (frame?.contentWindow) {
          pending.source = frame.contentWindow
          send(frame, { type: 'tradeloom:file-focus', kind, id, nonce })
        }
        return true
      }
      const handler = event => {
        if (!scene || event?.origin !== origin || !Array.isArray(scene.panels)) return false
        const frames = getFrames?.() ?? []
        const frame = frames.find(item => item?.contentWindow === event.source)
        const panel = scene.panels.find(item => item.id === frame?.dataset?.tradeloomPanelId)
        const role = frameRole(frame, panel)
        if (!role || !frame?.src) return false
        const data = event.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false
        const exact = keys => Object.keys(data).sort().join(',') === [...keys].sort().join(',')
        const sendSelection = target => {
          const selection = fileSelectionByScene.get(scene.id)
          if (selection) send(target, { type: 'tradeloom:file-selection', ...selection })
        }
        if (data.type === 'tradeloom:file-export-response') {
          const exactSuccess = exact(['type', 'kind', 'id', 'nonce', 'name', 'mimeType', 'lastModified', 'blob'])
          const exactFailure = exact(['type', 'kind', 'id', 'nonce', 'error'])
          const pending = typeof data.nonce === 'string' ? pendingExports.get(data.nonce) : null
          if ((!exactSuccess && !exactFailure) || typeof data.nonce !== 'string' || data.nonce.length > 128
            || !['source', 'artifact'].includes(data.kind) || typeof data.id !== 'string' || data.id.length > 128) return false
          if (!pending || pending.source !== event.source || pending.kind !== data.kind || pending.id !== data.id
            || !(role === 'files' || role === 'deliverables' || role === 'workflow-tasks')) return false
          if (pending.kind === 'source' && role !== 'files') return false
          if (pending.kind === 'artifact' && !['files', 'deliverables', 'workflow-tasks'].includes(role)) return false
          pendingExports.delete(data.nonce)
          clearTimeout(pending.timeout)
          if (exactFailure && typeof data.error === 'string' && data.error.trim()) {
            pending.onResult({ ok: false, error: data.error.slice(0, 240) })
            return true
          }
          const blob = data.blob
          if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size) || blob.size < 0
            || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 255
            || typeof data.mimeType !== 'string' || data.mimeType.length > 128
            || !Number.isSafeInteger(data.lastModified) || data.lastModified < 0) {
            pending.onResult({ ok: false, error: '文件数据无效，未添加到会话。' })
            return false
          }
          let file
          try { file = new File([blob], data.name, { type: data.mimeType, lastModified: data.lastModified }) }
          catch { pending.onResult({ ok: false, error: '无法创建附件文件，未添加到会话。' }); return false }
          pending.onResult({ ok: true, file, blobMimeType: typeof blob.type === 'string' ? blob.type : '' })
          return true
        }
        if (data.type === 'tradeloom:file-focus-result') {
          if (!exact(['type', 'kind', 'id', 'nonce', 'found']) || role !== 'files'
            || !['source', 'artifact'].includes(data.kind) || typeof data.id !== 'string' || data.id.length > 128
            || typeof data.nonce !== 'string' || data.nonce.length > 128 || typeof data.found !== 'boolean') return false
          const pending = pendingFocus.get(data.nonce)
          if (!pending || pending.source !== event.source || pending.kind !== data.kind || pending.id !== data.id) return false
          pendingFocus.delete(data.nonce)
          clearTimeout(pending.timeout)
          const current = fileSelectionByScene.get(scene.id)
          const generation = snapshot.fileSelectionGenerations?.[scene.id] ?? 0
          if (pending.generation !== generation || current?.kind !== pending.kind || current.id !== pending.id) {
            pending.onResult({ ok: false, found: false, error: '所选版本已变化，请重新定位。' })
            return false
          }
          if (data.found) {
            // A successful focus proves this exact registered files frame has
            // the selected row. Remember it as the export source after a
            // close/reopen cycle; never broaden export lookup to other frames.
            fileSelectionSource = { ...current, frame, contentWindow: event.source }
          }
          pending.onResult({ ok: true, found: data.found })
          return true
        }
        if (role === 'files' && data.type === 'tradeloom:files-ready' && exact(['type'])) {
          sendSelection(frame)
          const generation = snapshot.fileSelectionGenerations?.[scene.id] ?? 0
          for (const [nonce, pending] of pendingFocus) {
            const current = fileSelectionByScene.get(scene.id)
            if ((pending.targetFrame && pending.targetFrame !== frame)
              || pending.generation !== generation || current?.kind !== pending.kind || current.id !== pending.id) continue
            pending.targetFrame = frame
            pending.source = event.source
            send(frame, { type: 'tradeloom:file-focus', kind: pending.kind, id: pending.id, nonce })
          }
          return true
        }
        if (role === 'preview' && data.type === 'tradeloom:preview-ready' && exact(['type'])) {
          sendSelection(frame)
          return true
        }
        const selectionKeys = Object.keys(data).sort().join(',')
        const validSelectionShape = selectionKeys === 'id,kind,type' || selectionKeys === 'id,kind,previewMime,type'
        if (['files', 'deliverables', 'workflow-tasks'].includes(role) && data.type === 'tradeloom:file-selection' && validSelectionShape
          && (role === 'files' || data.kind === 'artifact')
          && ['source', 'artifact'].includes(data.kind) && typeof data.id === 'string' && data.id.length > 0
          && data.id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(data.id)
          && (selectionKeys === 'id,kind,type' || data.kind === 'artifact' && data.previewMime === 'text/markdown')) {
          const selection = { kind: data.kind, id: data.id,
            ...(data.previewMime === 'text/markdown' ? { previewMime: 'text/markdown' } : {}) }
          fileSelectionSource = { ...selection, frame, contentWindow: event.source }
          fileSelectionByScene.set(scene.id, selection)
          const generation = (snapshot.fileSelectionGenerations?.[scene.id] ?? 0) + 1
          publish({ fileSelectionGenerations: { ...(snapshot.fileSelectionGenerations ?? {}), [scene.id]: generation } })
          for (const candidate of frames) {
            const candidatePanel = scene.panels.find(item => item.id === candidate?.dataset?.tradeloomPanelId)
            const candidateRole = filePanelRole(candidatePanel)
            if (candidate === frame) continue
            if (candidateRole === 'preview' || candidateRole === 'files'
              || candidateRole === 'deliverables' && selection.kind === 'artifact') {
              send(candidate, { type: 'tradeloom:file-selection', ...selection })
            }
          }
          return true
        }
        if (role === 'preview' && data.type === 'tradeloom:file-request-selection' && exact(['type'])) {
          sendSelection(frame)
          if (!fileSelectionByScene.has(scene.id)) {
            for (const candidate of frames) {
              const candidatePanel = scene.panels.find(item => item.id === candidate?.dataset?.tradeloomPanelId)
              if (['files', 'deliverables'].includes(filePanelRole(candidatePanel))) send(candidate, { type: 'tradeloom:file-request-selection' })
            }
          }
          return true
        }
        return false
      }
      handler.requestFileExport = requestFileExport
      handler.requestFileFocus = requestFileFocus
      handler.dispose = () => {
        for (const pending of pendingExports.values()) {
          clearTimeout(pending.timeout)
          pending.onResult({ ok: false, error: '场景已切换，文件导入已取消。' })
        }
        pendingExports.clear()
        for (const pending of pendingFocus.values()) {
          clearTimeout(pending.timeout)
          pending.onResult({ ok: false, found: false, error: '场景已切换，文件定位已取消。' })
        }
        pendingFocus.clear()
      }
      return handler
    }

    function publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function validRoleMetadata(roles) {
      if (!Array.isArray(roles) || roles.length === 0 || roles.length > 32) return false
      const seen = new Set()
      return roles.every(role => {
        if (!role || typeof role !== 'object' || Array.isArray(role)
          || Object.keys(role).sort().join(',') !== 'assistantLabel,id,label'
          || typeof role.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(role.id) || seen.has(role.id)
          || typeof role.label !== 'string' || !role.label.trim() || role.label.length > 100
          || typeof role.assistantLabel !== 'string' || !role.assistantLabel.trim() || role.assistantLabel.length > 100) return false
        seen.add(role.id)
        return true
      })
    }

    function validSessionBindings(bindings, roles) {
      if (bindings === undefined) return true
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return false
      const roleIds = new Set((Array.isArray(roles) ? roles : []).map(role => role?.id))
      return Object.entries(bindings).every(([roleId, sessionId]) => roleIds.has(roleId)
        && typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId))
    }

    function isRoleId(config, roleId) {
      return typeof roleId === 'string' && Array.isArray(config?.roles)
        && config.roles.some(role => role?.id === roleId)
    }

    function normalizePanelStyle(layout, expanded = false) {
      if (expanded) return { gridColumn: '1 / -1', gridRow: '1 / -1', zIndex: 2 }
      return { gridColumn: `${layout.col} / span ${layout.w}`, gridRow: `${layout.row} / span ${layout.h}` }
    }

    function rememberLayout(layouts, sceneId, layout) {
      return { ...layouts, [sceneId]: { ...(layouts[sceneId] ?? {}), ...layout } }
    }

    function isStandardWorkflowScene(config, scene) {
      const route = config?.businessRoutes?.['/agent-center']
      if (route?.sceneId !== 'agent-center' || route.panelId !== 'business-main'
        || (scene?.templateSceneId ?? scene?.id) !== route.sceneId) return false
      return ['business-main', 'business-plan'].every(id => scene.panels.some(panel =>
        panel.id === id && panel.type === 'business-iframe' && panel.path === '/agent-center'
        && panel.optional !== true && panel.frontendTabs === undefined))
    }

    function normalizeSceneBusinessPath(scene, path) {
      if (path === '/artifacts' && ['deliverables', 'user-profile'].includes(scene?.id)) {
        return scene.defaultBusinessPath ?? path
      }
      return path
    }

    function selectScene(current, sceneId) {
      const scene = current?.config?.scenes?.find(item => item.id === sceneId)
      if (!scene) return current
      const mainPath = scene.panels.find(panel => panel.id === 'business-main' && panel.type === 'business-iframe')?.path
      const businessPath = normalizeSceneBusinessPath(scene,
        current.businessPathsByScene?.[sceneId] ?? scene.defaultBusinessPath ?? scene.defaultBusinessRoute ?? mainPath ?? current.businessPath)
      return {
        ...current, activeSceneId: sceneId, businessPath,
        visitedScenes: [...new Set([...(current.visitedScenes ?? []), sceneId])],
      }
    }

    // The generated chunk provides the Dockview adapter and CSS through the Host module loader.
    function loadDockviewChunk() {
      if (!asyncRequire) return Promise.reject(new Error('dockview-loader-unavailable'))
      if (!dockviewChunkRequest) {
        dockviewChunkRequest = asyncRequire('./client.dockview.js').then(value => {
          const module = value?.default ?? value
          if (!module || typeof module.DockviewReact !== 'object' && typeof module.DockviewReact !== 'function'
            || typeof module.dockviewCss !== 'string') throw new Error('dockview-asset-unavailable')
          return module
        }).catch(error => { dockviewChunkRequest = undefined; throw error })
      }
      return dockviewChunkRequest
    }

    function captureClosedPanelPosition(grid, panelId) {
      const group = findSerializedLeafForPanel(grid?.root, panelId)?.data
      if (!group) return undefined
      const index = group.views.indexOf(panelId)
      const tabNeighbors = group.views.filter(id => id !== panelId)
      if (tabNeighbors.length) return { direction: 'within', neighbors: tabNeighbors, index }
      const anchor = captureFloatingPanelReturnAnchor(grid, panelId)
      const neighbors = findSerializedLeafByGroupId(grid.root, anchor?.anchorId)?.data.views
      if (neighbors?.length) return { direction: anchor.direction, neighbors }
      return undefined
    }

    function buildDockLayoutRecord(sceneId, dockview) {
      const scene = snapshot.config?.scenes.find(item => item.id === sceneId)
      if (!scene || !dockview || typeof dockview !== 'object') return undefined
      const previous = snapshot.dockLayouts?.scenes?.[sceneId]
      const hasFloatingPanel = Array.isArray(dockview.floatingGroups) && dockview.floatingGroups.length > 0
      const floatingRestore = hasFloatingPanel
        ? pendingFloatingRestoreByScene.get(sceneId) ?? previous?.floatingRestore
        : undefined
      if (!hasFloatingPanel) pendingFloatingRestoreByScene.delete(sceneId)
      const openPanels = dockview.panels && typeof dockview.panels === 'object' ? dockview.panels : {}
      const panels = { ...openPanels }
      for (const panel of scene.panels) {
        if (panel.type === 'native-chat' && panels[panel.id]) {
          panels[panel.id] = { ...panels[panel.id], title: panel.roleId ? assistantLabel(panel.roleId) : panel.title }
        }
      }
      const closedPanelIds = scene.panels.filter(panel => !Object.hasOwn(openPanels, panel.id)).map(panel => panel.id)
      const positions = pendingClosedPanelPositions.get(sceneId) ?? previous?.closedPanelPositions ?? {}
      const closedPanelPositions = Object.fromEntries(Object.entries(positions).filter(([id]) => closedPanelIds.includes(id)))
      return {
        version: 2,
        dockview: { ...dockview, panels },
        closedPanelIds,
        ...(Object.keys(closedPanelPositions).length ? { closedPanelPositions } : {}),
        ...(floatingRestore ? { floatingRestore } : {}),
        ...(previous?.preset ? { preset: previous.preset } : {}),
        legacyV1Snapshot: previous?.legacyV1Snapshot ?? null,
        migration: previous?.migration ?? { status: 'default', reason: 'client-layout-change' },
      }
    }

    function queueDockLayoutSave(sceneId, dockview, preset) {
      const record = buildDockLayoutRecord(sceneId, dockview)
      if (!record) return Promise.resolve(false)
      if (preset) record.preset = preset
      let failureMessage = '布局保存失败（网络错误），请重试。'
      const nextScenes = { ...(snapshot.dockLayouts?.scenes ?? {}), [sceneId]: record }
      pendingClosedPanelPositions.delete(sceneId)
      publish({ dockLayouts: { version: 2, scenes: nextScenes }, dockSaveErrors: { ...snapshot.dockSaveErrors, [sceneId]: '' } })
      dockRevision++
      const requested = dockRevision
      dockSaveQueue = dockSaveQueue.catch(() => {}).then(async () => {
        while (dockPersistedRevision < requested) {
          const revision = dockRevision
          const response = await fetch('/tradeloom/dock-layouts', {
            method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(snapshot.dockLayouts),
          })
          if (!response.ok) {
            const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
              ? response.status : null
            const allowedCodes = new Set(['invalid-json', 'invalid-dock-layout', 'request-too-large', 'dock-layout-unavailable'])
            let code = status === 401 || status === 403 ? 'unauthorized' : 'unknown'
            if (code === 'unknown' && typeof response.json === 'function') {
              try {
                const body = await response.json()
                if (allowedCodes.has(body?.error)) code = body.error
              } catch {}
            }
            const statusLabel = status === null ? '' : `HTTP ${status}`
            failureMessage = `布局保存失败${statusLabel || code ? `（${[statusLabel, code].filter(Boolean).join(' · ')}）` : ''}，请重试。`
            throw new Error('dock-layout-save-failed')
          }
          dockPersistedRevision = revision
          publish({ dockSaveErrors: Object.fromEntries(Object.keys(snapshot.dockSaveErrors).map(id => [id, ''])) })
        }
        return true
      }).catch(() => {
        publish({ dockSaveErrors: { ...snapshot.dockSaveErrors, [sceneId]: failureMessage } })
        return false
      })
      return dockSaveQueue
    }

    function focusScenePanel(sceneId, panelId) {
      const api = dockviewApis.get(sceneId)
      const panel = api?.getPanel(panelId)
      if (panel) panel.api.setActive()
      return Boolean(panel)
    }

    function refreshScenePanel(sceneId, panelId) {
      const sceneKeys = snapshot.panelRefreshKeys?.[sceneId] ?? {}
      const panelRefreshKeys = {
        ...snapshot.panelRefreshKeys,
        [sceneId]: { ...sceneKeys, [panelId]: (sceneKeys[panelId] ?? 0) + 1 },
      }
      publish({ panelRefreshKeys })
      return panelRefreshKeys[sceneId][panelId]
    }

    function reopenScenePanel(sceneId, panelId) {
      const api = dockviewApis.get(sceneId)
      const scene = snapshot.config?.scenes.find(item => item.id === sceneId)
      const panel = scene?.panels.find(item => item.id === panelId)
      if (!api || !panel) return false
      const panelRoleId = roleForPanel(snapshot.config, sceneId, panelId)
      if (panel.optional === true && !snapshot.sessionBindings[panelRoleId]) return false
      const existing = api.getPanel(panelId)
      if (existing) { existing.api.setActive(); return true }
      const positions = pendingClosedPanelPositions.get(sceneId) ?? snapshot.dockLayouts?.scenes?.[sceneId]?.closedPanelPositions
      const candidates = [positions?.[panelId]]
      if (!panel.optional) candidates.push(captureClosedPanelPosition(snapshot.dockDefaults?.[sceneId]?.dockview?.grid, panelId))
      let position
      for (const anchor of candidates) {
        const neighbor = anchor?.neighbors.map(id => api.getPanel(id)).find(item => item?.api.location?.type === 'grid')
        if (!neighbor) continue
        position = { referencePanel: neighbor.id, direction: anchor.direction }
        if (anchor.direction === 'within') position.index = Math.min(anchor.index, neighbor.api.group.panels.length)
        break
      }
      const gridPanels = api.panels.filter(item => item.api.location?.type === 'grid')
      const reference = (panel.optional && gridPanels.find(item => item.id === 'native-chat'))
        || gridPanels.find(item => item.id === 'business-main') || gridPanels[0]
      if (!position && reference) position = { referencePanel: reference.id,
        direction: scene.id === 'center' && panel.id === 'native-chat' ? 'right'
          : panel.id === 'business-plan' && (scene.templateSceneId ?? scene.id) === 'agent-center' ? 'left'
          : panel.optional ? 'right' : 'within' }
      api.addPanel({
        id: panel.id, component: panel.type,
        title: panel.type === 'native-chat' ? assistantLabel(panelRoleId) : panel.title,
        renderer: 'always',
        params: { panelId: panel.id },
        ...(position ? { position } : {}),
      })
      api.getPanel(panelId)?.api.setActive()
      return true
    }

    function requestScenePanelFocus(sceneId, panelId) {
      if (focusScenePanel(sceneId, panelId) || reopenScenePanel(sceneId, panelId)) {
        pendingScenePanelFocus.delete(sceneId)
        return true
      }
      pendingScenePanelFocus.set(sceneId, panelId)
      return false
    }

    function sceneNavigationItems(config) {
      return (Array.isArray(config?.scenes) ? config.scenes : []).map(scene => ({
        id: scene.id,
        label: scene.label,
        icon: typeof scene.icon === 'string' && scene.icon ? scene.icon : scene.label.slice(0, 1),
        ...(scene.templateSceneId ? { templateSceneId: scene.templateSceneId } : {}),
        route: scene.defaultBusinessRoute ?? null,
        navigationGroup: scene.navigationGroup ?? 'business',
      }))
    }

    function sceneTabsNeedCompact(fullWidth, availableWidth) {
      return Number.isFinite(fullWidth) && Number.isFinite(availableWidth) && fullWidth > availableWidth
    }

    function readSceneTabPreferences() {
      if (sceneTabPreferences) return sceneTabPreferences
      sceneTabPreferences = { version: 1, order: [], pinned: [] }
      try {
        const raw = window.localStorage?.getItem(sceneTabPreferenceKey)
        if (raw) {
          const value = JSON.parse(raw)
          const ids = list => Array.isArray(list) && list.every(id => typeof id === 'string' && /^[a-z0-9-]{1,48}$/.test(id)) && new Set(list).size === list.length
          if (value?.version !== 1 || !ids(value.order) || !ids(value.pinned)) throw new Error()
          sceneTabPreferences = { version: 1, order: value.order, pinned: value.pinned }
        }
      } catch {
        sceneTabStorageReadable = false
        snapshot.sceneTabPreferenceError = '标签偏好无法读取；原存储已保留，本次更改不会保存。'
      }
      return sceneTabPreferences
    }

    function orderedSceneTabs(config) {
      const items = sceneNavigationItems(config).filter(scene => scene.navigationGroup !== 'tools')
      const preferences = readSceneTabPreferences()
      const byId = new Map(items.map(item => [item.id, item]))
      const ids = [...preferences.order.filter(id => byId.has(id)), ...items.map(item => item.id).filter(id => !preferences.order.includes(id))]
      return [...ids.filter(id => preferences.pinned.includes(id)), ...ids.filter(id => !preferences.pinned.includes(id))].map(id => byId.get(id))
    }

    function saveSceneTabPreferences(order, pinned = readSceneTabPreferences().pinned) {
      const previous = readSceneTabPreferences()
      const visibleIds = new Set(sceneNavigationItems(snapshot.config).filter(scene => scene.navigationGroup !== 'tools').map(scene => scene.id))
      sceneTabPreferences = { version: 1,
        order: [...order, ...previous.order.filter(id => !visibleIds.has(id))],
        pinned: [...pinned.filter(id => visibleIds.has(id)), ...previous.pinned.filter(id => !visibleIds.has(id))],
      }
      let error = ''
      try {
        if (!sceneTabStorageReadable || !window.localStorage?.setItem) throw new Error()
        window.localStorage.setItem(sceneTabPreferenceKey, JSON.stringify(sceneTabPreferences))
      } catch { error = '标签偏好未保存；当前排序仅在本次窗口中保留。' }
      publish({ sceneTabPreferenceError: error, sceneTabPreferenceRevision: (snapshot.sceneTabPreferenceRevision ?? 0) + 1 })
    }

    const sceneIcons = Object.freeze({
      center: 'M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z',
      products: 'm10 2.5 7 4v7l-7 4-7-4v-7l7-4ZM3 6.5l7 4 7-4M10 10.5v7',
      'agent-center': 'M7 3.5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-12a1 1 0 0 0-1-1h-2M7 2.5h6v3H7zM7 8h6M7 11h6M7 14h4',
      deliverables: 'M3 4.5h14v3H3zM4 7.5v9h12v-9M8 11h4m-2-2v5m-2-2 2 2 2-2',
      runs: 'M17.5 10a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0ZM10 5.5v5l3.5 2',
      'user-profile': 'M13 6.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3.5 17c.7-3.1 3.1-4.8 6.5-4.8s5.8 1.7 6.5 4.8',
      erpnext: 'M3 4a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 4v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16ZM6 6h8M6 9h8M6 12h3M11.5 12H14M6 15h3M11.5 15H14',
    })
    function sceneIcon(sceneId) {
      const common = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }
      const shape = Object.hasOwn(sceneIcons, sceneId) ? sceneIcons[sceneId] : 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z'
      return h('svg', common, h('path', { d: shape }))
    }

    function updatePanelLayout(layout, panelId, action) {
      const panels = layout.panels ?? {}
      if (action === 'expand') return { ...layout, expandedPanel: layout.expandedPanel === panelId ? '' : panelId }
      if (action === 'hide' || action === 'restore') {
        const current = panels[panelId] ?? { visible: true }
        return { ...layout, panels: { ...panels, [panelId]: { ...current, visible: action === 'restore' } } }
      }
      if (action === 'refresh') return { ...layout, refreshCounts: { ...(layout.refreshCounts ?? {}), [panelId]: (layout.refreshCounts?.[panelId] ?? 0) + 1 } }
      return layout
    }

    function roleForScene(config, sceneId) {
      const roleId = snapshot.roleByScene[sceneId] ?? config?.scenes?.find(scene => scene.id === sceneId)?.roleId
      return isRoleId(config, roleId) ? roleId : undefined
    }

    function roleForPanel(config, sceneId, panelId) {
      const panel = config?.scenes?.find(scene => scene.id === sceneId)?.panels?.find(item => item.id === panelId)
      if (!['native-chat', 'native-workspace'].includes(panel?.type)) return undefined
      const roleId = panel.roleId ?? roleForScene(config, sceneId)
      return isRoleId(config, roleId) ? roleId : undefined
    }

    function bindSession(bindings, roleId, sessionId, config = snapshot.config) {
      if (!isRoleId(config, roleId) || typeof sessionId !== 'string' || sessionId.length === 0) return bindings
      return { ...bindings, [roleId]: sessionId }
    }

    function rememberBindingMetadata(metadata, roleId, sessionId, binding) {
      if (binding === undefined && metadata?.[roleId]?.sessionId === sessionId) return metadata
      const valid = binding?.scope === 'role' && binding.roleId === roleId && binding.sessionId === sessionId
      return { ...metadata, [roleId]: { sessionId, binding: {
        scope: 'role', roleId, sessionId,
        workspaceId: valid && typeof binding.workspaceId === 'string' ? binding.workspaceId : null,
        archiveState: valid && ['archived', 'unarchived', 'unknown'].includes(binding.archiveState) ? binding.archiveState : 'unknown',
      } } }
    }

    function roleBindingStatus(state, roleId) {
      const sessionId = state.sessionBindings?.[roleId]
      const metadata = state.sessionBindingMetadata?.[roleId]
      const binding = metadata && metadata.sessionId === sessionId ? metadata.binding : undefined
      const archiveState = sessionId && binding?.scope === 'role' && binding.roleId === roleId && binding.sessionId === sessionId
        && ['archived', 'unarchived'].includes(binding.archiveState) ? binding.archiveState : 'unknown'
      return {
        roleId, sessionId,
        workspaceId: binding?.scope === 'role' && binding.roleId === roleId && binding.sessionId === sessionId && typeof binding.workspaceId === 'string' && binding.workspaceId ? binding.workspaceId : null,
        archiveState,
        label: !sessionId ? '未绑定' : archiveState === 'archived' ? '▣ 已归档' : '✓ 已绑定',
        title: !sessionId ? '此角色尚未关联已有会话；此处不会自动创建会话。'
          : archiveState === 'archived' ? '此角色绑定已归档历史。请在原生会话侧栏选择“显示归档”查看和管理；不会自动恢复归档。'
            : `此角色已关联已有会话；${archiveState === 'unarchived' ? '会话未归档' : '归档状态未知'}；不代表会话已连接或模型调用成功。`,
      }
    }

    function RoleBindingDetails({ state, roleId }) {
      const status = roleBindingStatus(state, roleId)
      const root = React.useRef(null)
      const position = () => {
        const details = root.current
        if (!details?.open) return
        const content = details.querySelector('.tl-dock-binding-details-content')
        const rect = details.querySelector('summary').getBoundingClientRect()
        const viewport = details.ownerDocument.defaultView
        const bounds = content.getBoundingClientRect()
        content.style.left = `${Math.max(8, Math.min(viewport.innerWidth - bounds.width - 8, rect.right - bounds.width))}px`
        content.style.top = `${Math.max(8, Math.min(viewport.innerHeight - bounds.height - 8, rect.bottom + 4))}px`
      }
      React.useLayoutEffect(() => {
        position()
        const viewport = root.current?.ownerDocument.defaultView
        const content = root.current?.querySelector('.tl-dock-binding-details-content')
        const observer = content && typeof viewport.ResizeObserver === 'function' ? new viewport.ResizeObserver(position) : undefined
        if (content) observer?.observe(content)
        viewport?.addEventListener('resize', position)
        return () => { observer?.disconnect(); viewport?.removeEventListener('resize', position) }
      }, [state.sessionBindings, state.sessionBindingMetadata, state.roleByScene, state.config])
      React.useEffect(() => {
        const ownerDocument = root.current?.ownerDocument
        const dismiss = event => {
          if (!root.current?.open) return
          if (event.type === 'keydown' && event.key !== 'Escape') return
          if (event.type !== 'keydown' && root.current.contains(event.target)) return
          root.current.open = false
          if (event.type === 'keydown') root.current.querySelector('summary').focus()
        }
        ownerDocument?.addEventListener('keydown', dismiss)
        ownerDocument?.addEventListener('pointerdown', dismiss)
        return () => { ownerDocument?.removeEventListener('keydown', dismiss); ownerDocument?.removeEventListener('pointerdown', dismiss) }
      }, [])
      const roleLabel = id => state.config?.roles?.find(role => role.id === id)?.assistantLabel || id
      const sharedScenes = (state.config?.scenes ?? []).filter(scene => {
        const configuredRole = state.roleByScene?.[scene.id] ?? scene.roleId
        return configuredRole === roleId || scene.panels.some(panel => panel.type === 'native-chat' && (panel.roleId ?? configuredRole) === roleId)
      })
      const sameSessionRoles = status.sessionId ? Object.entries(state.sessionBindings ?? {}).filter(([id, session]) => id !== roleId && session === status.sessionId).map(([id]) => id) : []
      return h('details', { ref: root, className: 'tl-dock-binding-details', onToggle: position,
        onPointerDown: event => event.stopPropagation(), onMouseDown: event => event.stopPropagation(), onClick: event => event.stopPropagation() },
        h('summary', { 'aria-label': '查看角色会话绑定详情' }, h('span', {
          className: 'tl-dock-binding-status', 'data-binding-state': status.sessionId ? 'bound' : 'unbound', 'data-archive-state': status.archiveState,
          'aria-label': !status.sessionId ? '角色会话绑定：未绑定' : status.archiveState === 'archived' ? '角色会话绑定：已绑定归档历史' : '角色会话绑定：已绑定',
          title: status.title,
        }, status.label)),
        h('style', null, `
          .tl-dock-binding-details { min-width:0; flex:0 1 auto; }
          .tl-dock-binding-details > summary { list-style:none; cursor:pointer; font:inherit; color:inherit; }
          .tl-dock-binding-details > summary::-webkit-details-marker { display:none; }
          .tl-dock-binding-details > summary:focus-visible { outline:2px solid var(--tl-shell-accent,var(--tl-theme-accent)); outline-offset:-2px; }
          .tl-dock-binding-details-content { position:fixed; z-index:10000; box-sizing:border-box; width:min(calc(420px * var(--tl-ui-scale,1)),calc(100vw - 16px)); max-height:calc(100vh - 16px); overflow:auto; padding:var(--tl-space-3); border:1px solid var(--tl-shell-line,var(--tl-theme-border)); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface,var(--tl-theme-panel)); color:var(--tl-shell-ink,var(--tl-theme-text)); box-shadow:0 8px 24px rgb(0 0 0 / 20%); font:var(--tl-font-compact)/1.45 var(--tl-font-family); white-space:normal; overflow-wrap:anywhere; }
          .tl-dock-binding-details-content dl { margin:var(--tl-space-2) 0; }
          .tl-dock-binding-details-content dt { color:var(--tl-shell-muted,var(--tl-theme-muted)); }
          .tl-dock-binding-details-content dd { margin:0 0 var(--tl-space-2); }
          .tl-dock-binding-details-content p { margin:0; }
          .tl-dock-binding-details-content header { display:flex; align-items:center; justify-content:space-between; gap:var(--tl-space-2); }
          .tl-dock-binding-details-content button { display:inline-grid; place-items:center; flex:none; font:inherit; color:inherit; background:transparent; border:1px solid var(--tl-shell-line,var(--tl-theme-border)); border-radius:var(--tl-corner-radius); cursor:pointer; min-width:var(--tl-control-height); min-height:var(--tl-control-height); }
          .tl-dock-binding-details-content button svg { display:block; width:var(--tl-icon-size,15px); height:var(--tl-icon-size,15px); }
        `),
        h('div', { className: 'tl-dock-binding-details-content', role: 'group', 'aria-label': '角色会话绑定详情' },
          h('header', null, h('strong', null, '角色会话绑定'), h('button', { type: 'button', 'aria-label': '关闭绑定详情', onClick: () => { root.current.open = false; root.current.querySelector('summary').focus() } }, actionIcon(closeActionPath))),
          h('dl', null, h('dt', null, '角色'), h('dd', null, `${roleLabel(roleId)} · ${roleId}`),
            h('dt', null, '会话 ID'), h('dd', null, status.sessionId || '未绑定'), h('dt', null, '工作区 ID'), h('dd', null, status.workspaceId || '未知'),
            h('dt', null, '归档'), h('dd', null, { archived: '已归档', unarchived: '未归档', unknown: '未知' }[status.archiveState]),
            h('dt', null, '配置共享范围（含可选面板）'), h('dd', null, sharedScenes.map(scene => `${scene.label} (${scene.id})`).join('、') || '无'),
            h('dt', null, '同一会话的其他角色'), h('dd', null, sameSessionRoles.map(id => `${roleLabel(id)} (${id})`).join('、') || '无')),
          h('p', null, status.title)))
    }

    function modelDirectoryEntries(groups) {
      return (Array.isArray(groups) ? groups : []).map(group => ({
        provider: group.id,
        providerName: group.name,
        models: (Array.isArray(group.models) ? group.models : []).map(model => ({
          provider: group.id, providerName: group.name, id: model.id, name: model.name,
        })),
      }))
    }

    function providerBadgeLabel(providerName) {
      const name = typeof providerName === 'string' ? providerName.trim() : ''
      return name.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? Array.from(name)[0] ?? '模'
    }

    function currentModelLabel(current, groups) {
      if (!current) return '选择模型'
      const provider = (Array.isArray(groups) ? groups : []).find(group => (group.provider ?? group.id) === current.provider)
      const model = provider?.models?.find(item => item.id === current.model)
      return provider && model ? `${provider.providerName ?? provider.name} · ${model.name}` : '已选择模型'
    }

    function persistState(next = snapshot) {
      if (!next.config) return Promise.resolve(false)
      const value = {
        version: 1,
        activeSceneId: next.activeSceneId,
        roleByScene: next.roleByScene,
        businessPath: next.businessPath,
        layouts: Object.fromEntries(next.config.scenes.map(scene => [scene.id, {
          expandedPanel: next.layouts[scene.id]?.expandedPanel ?? '',
          panels: Object.fromEntries(scene.panels.map(panel => {
            const saved = next.layouts[scene.id]?.panels?.[panel.id] ?? {}
            return [panel.id, { col: saved.col ?? panel.col, row: saved.row ?? panel.row, w: saved.w ?? panel.w, h: saved.h ?? panel.h, visible: saved.visible !== false }]
          })),
        }])) ,
      }
      return fetch('/tradeloom/scene-layouts', {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      }).then(response => response.ok).catch(() => false)
    }

    function defaultDockRecord(scene) {
      const workflow = (scene.templateSceneId ?? scene.id) === 'agent-center'
      const visiblePanels = scene.panels.filter(panel => panel.optional !== true
        && !(scene.id === 'center' && panel.id === 'native-chat')
        && (!workflow || panel.id !== 'business-plan'))
      const byId = new Map(visiblePanels.map(panel => [panel.id, panel]))
      const hasPlan = byId.has('business-plan')
      const chat = visiblePanels.filter(panel => panel.type === 'native-chat')
      const business = visiblePanels.filter(panel => panel.type !== 'native-chat')
      const makeLeaf = (id, panels, size) => ({
        type: 'leaf', data: { views: panels.map(panel => panel.id), activeView: panels[0]?.id, id }, size,
      })
      let root
      let orientation = 'HORIZONTAL'
      let activeGroup = '1'
      if (chat.length > 0 && business.length > 0 && scene.layoutProfile?.kind === 'collaboration_grid'
        && byId.size === (hasPlan ? 5 : 4)
        && ['business-main', 'files', 'preview', 'native-chat'].every(id => byId.has(id))) {
        const leaf = (groupId, panelId, size) => makeLeaf(groupId, [byId.get(panelId)], size)
        const row = (size, ...data) => ({ type: 'branch', size, data })
        root = { type: 'branch', size: 100, data: [
          row(hasPlan ? 50 : scene.id === 'deliverables' ? 50 : 65,
            ...(hasPlan ? [leaf('top-plan', 'business-plan', 20)] : []),
            leaf('topa', 'business-main', hasPlan ? 60 : 75), leaf('topb', 'files', hasPlan ? 20 : 25)),
          row(hasPlan ? 50 : scene.id === 'deliverables' ? 50 : 35,
            leaf('bottoma', 'preview', hasPlan ? 20 : scene.id === 'deliverables' ? 60 : workflow ? 50 : 25),
            leaf('bottomb', 'native-chat', hasPlan ? 80 : scene.id === 'deliverables' ? 40 : workflow ? 50 : 75)),
        ] }
        orientation = 'VERTICAL'
        activeGroup = 'topa'
      } else if (chat.length > 0 && business.length > 0) {
        const split = scene.layoutProfile?.kind === 'assistant_lead' ? [32, 68] : [72, 28]
        root = { type: 'branch', data: [makeLeaf('1', business, split[0]), makeLeaf('2', chat, split[1])], size: 100 }
        if (scene.layoutProfile?.kind === 'assistant_lead') activeGroup = '2'
      } else root = { type: 'branch', data: [makeLeaf('1', visiblePanels, 100)], size: 100 }
      return {
        version: 2, closedPanelIds: scene.panels.filter(panel => !visiblePanels.includes(panel)).map(panel => panel.id), legacyV1Snapshot: null,
        migration: { status: 'default', reason: 'client-reset-default' },
        dockview: {
          grid: { root, width: 100, height: 100, orientation },
          panels: Object.fromEntries(visiblePanels.map(panel => [panel.id, {
            id: panel.id, contentComponent: panel.type, title: panel.title, renderer: 'always', params: { panelId: panel.id },
          }])),
          activeGroup,
        },
      }
    }

    async function loadConfig(force = false) {
      if (force) {
        configRequest = undefined
        sceneStateRequest = undefined
        configGeneration++
        publish({ configError: '' })
      }
      if (snapshot.config && !force) return snapshot.config
      if (!configRequest) {
        const generation = configGeneration
        configRequest = Promise.all([
          fetch('/tradeloom/scenes', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const config = await response.json()
            if (!response.ok || config?.version !== 1 || !Array.isArray(config.scenes) || config.scenes.length === 0
            || !validRoleMetadata(config.roles)
            || !validSessionBindings(config.sessionBindings, config.roles)
              || !config.scenes.every(scene => typeof scene.id === 'string' && typeof scene.label === 'string'
                && isRoleId(config, scene.roleId) && Array.isArray(scene.panels))) throw new Error()
            if (new Set(config.scenes.map(scene => scene.id)).size !== config.scenes.length) throw new Error('scene-config-invalid')
            for (const scene of config.scenes) {
              if (new Set(scene.panels.map(panel => panel.id)).size !== scene.panels.length) throw new Error('scene-config-invalid')
              for (const panel of scene.panels) {
                if (!['business-iframe', 'placeholder', 'native-chat', 'native-workspace', 'erpnext-status'].includes(panel.type)) throw new Error('scene-panel-type-unknown')
                if (typeof panel.id !== 'string' || !panel.id || typeof panel.title !== 'string') throw new Error('scene-config-invalid')
                if (Object.hasOwn(panel, 'componentId') && !config.componentCatalog?.some(component =>
                  component.id === panel.componentId
                  && (/^component-[a-z0-9-]{1,38}$/.test(panel.id)
                    ? component.allowStandalone === true && typeof scene.templateSceneId === 'string' && scene.templateSceneId !== scene.id
                    : component.templateSceneId === scene.templateSceneId && component.panelId === panel.id)
                  && component.type === panel.type && component.path === panel.path
                  && component.category === panel.category)) throw new Error('scene-component-invalid')
              }
            }
            return { ...config, sessionBindings: config.sessionBindings ?? {} }
          }),
          fetch('/tradeloom/scene-layouts', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const state = await response.json()
            if (!response.ok || state?.version !== 1 || typeof state.activeSceneId !== 'string'
              || !state.roleByScene || typeof state.roleByScene !== 'object' || !state.layouts || typeof state.layouts !== 'object') throw new Error()
            return state
          }),
          fetch('/tradeloom/dock-layouts', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const state = await response.json()
            if (!response.ok || state?.version !== 2 || !state.scenes || typeof state.scenes !== 'object') throw new Error()
            return state
          }),
        ]).then(([config, saved, savedDockLayouts]) => {
          if (generation !== configGeneration) return snapshot.config
          const current = snapshot.config ? snapshot : null
          if (current) {
            saved = { ...saved, activeSceneId: current.activeSceneId, roleByScene: { ...saved.roleByScene, ...current.roleByScene }, layouts: { ...saved.layouts, ...current.layouts },
              businessPath: current.businessPath, businessPathsByScene: { ...saved.businessPathsByScene, ...current.businessPathsByScene } }
            const previousScenes = new Map(current.config.scenes.map(scene => [scene.id, scene]))
            savedDockLayouts = { ...savedDockLayouts, scenes: Object.fromEntries(config.scenes.map(scene => {
              const incoming = savedDockLayouts.scenes[scene.id]
              const previous = current.dockLayouts.scenes[scene.id]
              if (!previous || JSON.stringify(previousScenes.get(scene.id)?.panels) !== JSON.stringify(scene.panels)) {
                return [scene.id, incoming]
              }
              const { preset, ...layout } = previous
              const retainedPreset = dockPersistedRevision < dockRevision ? preset : incoming?.preset
              return [scene.id, { ...layout, ...(retainedPreset ? { preset: retainedPreset } : {}) }]
            })) }
          }
          if (!config.scenes.some(scene => scene.id === saved.activeSceneId)) throw new Error()
          const sceneIds = new Set(config.scenes.map(scene => scene.id))
          if (Object.keys(saved.roleByScene).some(id => !sceneIds.has(id) || !isRoleId(config, saved.roleByScene[id]))) throw new Error()
          if (Object.keys(saved.layouts).some(id => !sceneIds.has(id))) throw new Error()
          if (Object.keys(savedDockLayouts.scenes).some(id => !sceneIds.has(id))) throw new Error()
          if (config.scenes.some(scene => {
            const record = savedDockLayouts.scenes[scene.id]
            return !record || record.version !== 2 || !record.dockview || !Array.isArray(record.closedPanelIds)
          })) throw new Error()
          const normalizedLayouts = Object.fromEntries(config.scenes.map(scene => {
            const savedLayout = saved.layouts[scene.id] ?? {}
            const savedPanels = savedLayout.panels ?? {}
            const panels = Object.fromEntries(scene.panels.map(panel => {
              const current = savedPanels[panel.id] ?? {}
              const insideGrid = [current.col ?? panel.col, current.row ?? panel.row, current.w ?? panel.w, current.h ?? panel.h]
                .every(value => Number.isInteger(value) && value >= 1 && value <= 4)
              const col = insideGrid ? (current.col ?? panel.col) : panel.col
              const row = insideGrid ? (current.row ?? panel.row) : panel.row
              const w = insideGrid ? (current.w ?? panel.w) : panel.w
              const height = insideGrid ? (current.h ?? panel.h) : panel.h
              return [panel.id, { col, row, w, h: height, visible: current.visible !== false }]
            }))
            return [scene.id, { expandedPanel: scene.panels.some(panel => panel.id === savedLayout.expandedPanel) ? savedLayout.expandedPanel : '', panels, refreshCounts: {} }]
          }))
          const businessPathsByScene = Object.fromEntries(config.scenes.map(scene => [
            scene.id, normalizeSceneBusinessPath(scene,
              saved.businessPathsByScene?.[scene.id]
                ?? (saved.activeSceneId === scene.id ? saved.businessPath : undefined)
                ?? scene.defaultBusinessPath ?? scene.defaultBusinessRoute
                ?? scene.panels.find(panel => panel.id === 'business-main')?.path ?? null),
          ]))
          const activeScene = config.scenes.find(scene => scene.id === saved.activeSceneId)
          const sessionBindings = { ...config.sessionBindings }
          for (const [roleId, sessionId] of Object.entries(snapshot.sessionBindings ?? {})) {
            if (isRoleId(config, roleId) && typeof sessionId === 'string'
              && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) sessionBindings[roleId] = sessionId
          }
          let sessionBindingMetadata = snapshot.sessionBindingMetadata ?? {}
          for (const [roleId, sessionId] of Object.entries(sessionBindings)) {
            const incoming = config.sessionBindingMetadata?.[roleId]
            sessionBindingMetadata = rememberBindingMetadata(sessionBindingMetadata, roleId, sessionId,
              incoming?.sessionId === sessionId ? incoming : undefined)
          }
          const next = {
            config, configError: '', activeSceneId: saved.activeSceneId,
            roleByScene: Object.fromEntries(config.scenes.map(scene => [scene.id, saved.roleByScene[scene.id] ?? scene.roleId])),
            businessPath: normalizeSceneBusinessPath(activeScene,
              saved.businessPath ?? activeScene?.defaultBusinessPath ?? activeScene?.defaultBusinessRoute ?? '/home'),
            layouts: normalizedLayouts, dockLayouts: savedDockLayouts,
            dockDefaults: Object.fromEntries(config.scenes.map(scene => [scene.id, defaultDockRecord(scene)])),
            visitedScenes: [...new Set([...(snapshot.visitedScenes ?? []), saved.activeSceneId])],
            businessPathsByScene, proposalHrefsByScene: current?.proposalHrefsByScene ?? {}, businessViewIntentsByScene: current?.businessViewIntentsByScene ?? {}, dockSaveErrors: current?.dockSaveErrors ?? {},
            sessionBindings, sessionBindingMetadata, sessionErrors: {},
          }
          publish(next)
          businessOriginCallback?.(config.businessOrigin)
          roleDefinitionsCallback?.({ status: 'ready', error: '', roles: config.roles.map(({ id, label, assistantLabel }) => ({ id, label, assistantLabel })) })
          return config
        }).catch(error => {
          if (generation !== configGeneration) return snapshot.config
          configRequest = undefined
          publish({ configError: error?.message === 'scene-panel-type-unknown' ? '场景配置包含未知面板类型；已保留当前工作区，请重试读取。' : '工作场景暂时无法读取，请重试。' })
          if (!snapshot.config) roleDefinitionsCallback?.({ status: 'error', error: '助手列表暂不可用，请重试。', roles: null })
          throw new Error('workbench-unavailable')
        })
        if (!snapshot.config) roleDefinitionsCallback?.({ status: 'loading', error: '', roles: null })
      }
      return await configRequest
    }

    async function ensureRoleSession(roleId) {
      if (!isRoleId(snapshot.config, roleId)) return undefined
      const bound = snapshot.sessionBindings[roleId]
      if (bound) return bound
      if (sessionRequests.has(roleId)) return await sessionRequests.get(roleId)
      const request = fetch('/tradeloom/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: roleId }),
      }).then(async response => {
        const result = await response.json()
        if (!response.ok || result.role !== roleId || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('会话暂时无法连接')
        publish({ sessionBindings: bindSession(snapshot.sessionBindings, roleId, result.sessionId),
          sessionBindingMetadata: rememberBindingMetadata(snapshot.sessionBindingMetadata, roleId, result.sessionId, result.binding),
          sessionErrors: { ...snapshot.sessionErrors, [roleId]: '' } })
        void persistState()
        return result.sessionId
      }).catch(error => {
        publish({ sessionErrors: { ...snapshot.sessionErrors, [roleId]: error instanceof Error ? error.message : '连接失败' } })
        return undefined
      }).finally(() => sessionRequests.delete(roleId))
      sessionRequests.set(roleId, request)
      return await request
    }

    function selectRole(roleId, knownSessionId, binding) {
      if (!isRoleId(snapshot.config, roleId)) return Promise.resolve(false)
      const bindings = typeof knownSessionId === 'string' && knownSessionId
        ? bindSession(snapshot.sessionBindings, roleId, knownSessionId)
        : snapshot.sessionBindings
      const next = {
        ...snapshot,
        roleByScene: { ...snapshot.roleByScene, [snapshot.activeSceneId]: roleId },
        sessionBindings: bindings,
        sessionBindingMetadata: knownSessionId
          ? rememberBindingMetadata(snapshot.sessionBindingMetadata, roleId, knownSessionId, binding)
          : snapshot.sessionBindingMetadata,
      }
      publish(next)
      layoutApi?.selectPanel('scene-workbench')
      const chatPanelId = snapshot.config?.scenes.find(item => item.id === snapshot.activeSceneId)?.panels.find(panel => panel.type === 'native-chat')?.id
      if (chatPanelId) { if (!focusScenePanel(snapshot.activeSceneId, chatPanelId)) reopenScenePanel(snapshot.activeSceneId, chatPanelId) }
      void persistState(next)
      return (knownSessionId ? Promise.resolve(knownSessionId) : ensureRoleSession(roleId)).then(sessionId => Boolean(sessionId))
    }

    function bindRoleSession(roleId, sessionId, binding) {
      const bindings = bindSession(snapshot.sessionBindings, roleId, sessionId)
      if (bindings === snapshot.sessionBindings) return false
      const next = { ...snapshot, sessionBindings: bindings,
        sessionBindingMetadata: rememberBindingMetadata(snapshot.sessionBindingMetadata, roleId, sessionId, binding) }
      publish(next)
      void persistState(next)
      return true
    }

    function navigateBusiness(path, proposalHref, options = {}) {
      const target = snapshot.config?.businessRoutes?.[path]
      if (!target) return false
      const scene = snapshot.config.scenes.find(item => item.id === target.sceneId)
      const businessPath = normalizeSceneBusinessPath(scene, path)
      const workflowEntry = path === '/agent-center'
      const next = {
        ...snapshot, activeSceneId: target.sceneId, businessPath,
        businessPathsByScene: { ...snapshot.businessPathsByScene, [target.sceneId]: businessPath },
        proposalHrefsByScene: { ...snapshot.proposalHrefsByScene, [target.sceneId]: proposalHref ?? snapshot.proposalHrefsByScene?.[target.sceneId] ?? '' },
        businessViewIntentsByScene: workflowEntry ? { ...snapshot.businessViewIntentsByScene, [target.sceneId]: {
          view: proposalHref ? 'business' : 'workflow-canvas', revision: ++businessViewIntentRevision,
        } } : snapshot.businessViewIntentsByScene,
        visitedScenes: [...new Set([...(snapshot.visitedScenes ?? []), target.sceneId])],
      }
      publish(next)
      if (options?.select !== false) {
        layoutApi?.selectPanel('scene-workbench')
        if (workflowEntry && isStandardWorkflowScene(snapshot.config, scene)) {
          const panelId = proposalHref ? 'business-plan' : target.panelId
          if (!dockRenderContexts.get(target.sceneId)?.selectPanel?.(panelId)) {
            requestScenePanelFocus(target.sceneId, panelId)
          }
        } else requestScenePanelFocus(target.sceneId, target.panelId)
      }
      void persistState(next)
      return true
    }

    function navigateScene(sceneId) {
      const scene = snapshot.config?.scenes?.find(item => item.id === sceneId)
      if (!scene) return false
      if (scene.defaultBusinessRoute) return navigateBusiness(scene.defaultBusinessRoute)
      const next = selectScene(snapshot, sceneId)
      publish(next)
      layoutApi?.selectPanel('scene-workbench')
      const panelId = scene.panels.find(panel => panel.type === 'erpnext-status')?.id ?? scene.panels[0]?.id
      if (panelId) requestScenePanelFocus(sceneId, panelId)
      void persistState(next)
      return true
    }

    function useSnapshot() {
      const [current, setCurrent] = React.useState(snapshot)
      React.useEffect(() => {
        const listener = () => setCurrent(snapshot)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return current
    }

    function SceneTabs({ onSceneSelect, workbenchActive } = {}) {
      const state = useSnapshot()
      const activeSceneId = state.activeSceneId
      const [, setActionRevision] = React.useState(0)
      const [layoutMenuOpen, setLayoutMenuOpen] = React.useState(false)
      const [tabMenu, setTabMenu] = React.useState(null)
      const [dragRevision, setDragRevision] = React.useState(0)
      const dragRef = React.useRef(null)
      const flipRef = React.useRef(null)
      const suppressClick = React.useRef(null)
      const tabRoot = React.useRef(null)
      const tabMenuRoot = React.useRef(null)
      let tabsElement = null
      const layoutContext = dockRenderContexts.get(activeSceneId) ?? {}
      const orderedTabs = orderedSceneTabs(state.config)
      const pinned = readSceneTabPreferences().pinned
      const drag = dragRef.current
      const displayTabs = drag?.started ? drag.order.map(id => orderedTabs.find(scene => scene.id === id)).filter(Boolean) : orderedTabs
      const finishDrag = (event, commit) => {
        const current = dragRef.current
        if (!current || event.pointerId !== current.pointerId) return
        dragRef.current = null
        current.removePointerListeners?.()
        try { current.element.releasePointerCapture?.(current.pointerId) } catch { /* The host may already have cancelled capture. */ }
        if (current.started) {
          suppressClick.current = current.sceneId
          if (commit) saveSceneTabPreferences(current.order)
          setDragRevision(value => value + 1)
        }
      }
      const startDrag = (event, sceneId) => {
        if (event.button !== 0 || dragRef.current) return
        suppressClick.current = null
        setTabMenu(null)
        const element = event.currentTarget
        dragRef.current = { sceneId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
          x: event.clientX, y: event.clientY, rect: element.getBoundingClientRect(), element, started: false,
          order: orderedTabs.map(scene => scene.id) }
        const onUp = event => finishDrag(event, true)
        const onCancel = event => finishDrag(event, false)
        const onBlur = () => finishDrag({ pointerId: event.pointerId }, false)
        window.addEventListener('pointermove', moveDrag)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
        window.addEventListener('blur', onBlur)
        dragRef.current.removePointerListeners = () => {
          window.removeEventListener('pointermove', moveDrag)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
          window.removeEventListener('blur', onBlur)
        }
        try { element.setPointerCapture?.(event.pointerId) } catch { /* Pointer capture is optional in non-browser tests. */ }
      }
      const moveDrag = event => {
        const current = dragRef.current
        if (!current || event.pointerId !== current.pointerId) return
        if (!current.started && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 8) return
        event.preventDefault()
        current.started = true
        current.x = event.clientX; current.y = event.clientY
        const root = tabRoot.current
        const others = current.order.filter(id => id !== current.sceneId)
        const rootRect = root.getBoundingClientRect()
        let target = others.findIndex(id => {
          const button = [...root.querySelectorAll('[data-scene-tab-id]')].find(node => node.dataset.sceneTabId === id)
          return button && event.clientX < rootRect.left + button.offsetLeft + button.offsetWidth / 2
        })
        if (target < 0) target = others.length
        const fixedCount = others.filter(id => pinned.includes(id)).length
        target = pinned.includes(current.sceneId) ? Math.min(target, fixedCount) : Math.max(target, fixedCount)
        const next = [...others.slice(0, target), current.sceneId, ...others.slice(target)]
        if (next.join('|') !== current.order.join('|')) {
          flipRef.current = new Map([...root.querySelectorAll('[data-scene-tab-id]')].filter(node => node !== current.element)
            .map(node => [node.dataset.sceneTabId, node.getBoundingClientRect().left]))
          current.order = next
        }
        setDragRevision(value => value + 1)
      }
      React.useLayoutEffect(() => {
        const current = dragRef.current
        if (current?.started) {
          try { current.element.setPointerCapture?.(current.pointerId) } catch { /* A cancelled pointer cannot be captured again. */ }
        }
        const before = flipRef.current
        flipRef.current = null
        if (!before || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
        for (const button of tabRoot.current?.querySelectorAll('[data-scene-tab-id]') ?? []) {
          const oldLeft = before.get(button.dataset.sceneTabId)
          if (oldLeft === undefined || button === dragRef.current?.element) continue
          const delta = oldLeft - button.getBoundingClientRect().left
          if (Math.abs(delta) > .5) button.animate?.([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' })
        }
      }, [dragRevision])
      React.useEffect(() => () => {
        const current = dragRef.current
        dragRef.current = null
        current?.removePointerListeners?.()
        try { current?.element.releasePointerCapture?.(current.pointerId) } catch { /* Removed controls have no capture. */ }
      }, [])
      React.useEffect(() => {
        if (!tabMenu) return undefined
        const close = event => {
          if (event.type === 'keydown' && event.key !== 'Escape') return
          if (event.type !== 'keydown' && tabMenuRoot.current?.contains(event.target)) return
          setTabMenu(null)
          if (event.type === 'keydown') tabMenu.trigger.focus?.()
        }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', close)
        return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
      }, [tabMenu])
      React.useLayoutEffect(() => {
        const menu = tabMenuRoot.current
        if (!menu || !tabMenu) return
        const rect = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, tabMenu.x))}px`
        menu.style.top = `${Math.max(8, Math.min(window.innerHeight - rect.height - 8, tabMenu.y))}px`
        menu.querySelector('button:not(:disabled)')?.focus()
      }, [tabMenu])
      const openTabMenu = (event, sceneId) => {
        event.preventDefault(); event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setTabMenu({ sceneId, trigger: event.currentTarget, x: event.type === 'contextmenu' ? event.clientX : rect.left,
          y: event.type === 'contextmenu' ? event.clientY : rect.bottom + 4 })
      }
      React.useEffect(() => { void loadConfig().catch(() => {}) }, [])
      React.useEffect(() => subscribeDockActions(activeSceneId, () => setActionRevision(value => value + 1)), [activeSceneId])
      React.useEffect(() => {
        const tabs = tabsElement
        if (!tabs) return undefined
        let frame = 0
        const measure = () => {
          if (typeof window === 'undefined') return
          const buttons = [...tabs.querySelectorAll('.tl-scene-tab')]
          let fullWidth = 0
          for (const button of buttons) {
            const label = button.querySelector('.tl-scene-tab-label')
            const icon = button.querySelector('.tl-scene-tab-icon')
            const style = window.getComputedStyle(button)
            const textWidth = label?.getBoundingClientRect().width ?? 0
            fullWidth += (icon?.getBoundingClientRect().width ?? 18) + textWidth
              + (Number.parseFloat(style.paddingInlineStart) || 0) + (Number.parseFloat(style.paddingInlineEnd) || 0)
              + (Number.parseFloat(style.borderInlineStartWidth) || 0) + (Number.parseFloat(style.borderInlineEndWidth) || 0)
              + (Number.parseFloat(style.columnGap) || 6)
          }
          const listStyle = window.getComputedStyle(tabs)
          fullWidth += Math.max(0, buttons.length - 1) * (Number.parseFloat(listStyle.columnGap) || 4)
          const compact = sceneTabsNeedCompact(fullWidth, tabs.clientWidth)
          tabs.classList.toggle('is-compact', compact)
          tabs.dataset.compact = compact ? 'true' : 'false'
        }
        const schedule = () => {
          if (frame) window.cancelAnimationFrame(frame)
          frame = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(measure) : window.setTimeout(measure, 0)
        }
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
        observer?.observe(tabs)
        window.addEventListener('resize', schedule)
        schedule()
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) {
            if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
            else window.clearTimeout(frame)
          }
        }
      }, [state.config])
      const layoutMenuId = 'tl-scene-layout-menu'
      function positionLayoutMenu(event) {
        if (typeof document === 'undefined' || typeof window === 'undefined') return
        const popover = document.getElementById(layoutMenuId)
        if (!popover) return
        const rect = event.currentTarget.getBoundingClientRect()
        const width = Math.min(240, window.innerWidth - 16)
        popover.style.position = 'fixed'
        popover.style.inset = 'auto'
        popover.style.margin = '0'
        popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`
        popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 180, rect.bottom + 4))}px`
      }
      function runLayoutAction(action) {
        return () => {
          if (typeof document === 'undefined') { action?.(); return }
          const popover = document.getElementById(layoutMenuId)
          if (popover?.matches?.(':popover-open')) popover.hidePopover?.()
          setLayoutMenuOpen(false)
          action?.()
        }
      }
      return h(React.Fragment, null,
        h('style', { 'data-tradeloom-scene-tab-style': true }, `
          .tl-scene-tab-list { position:relative; }
          .tl-scene-tab[data-scene-tab-id] { touch-action:none; user-select:none; cursor:grab; }
          .tl-scene-tab[data-dragging="true"] { cursor:grabbing; box-shadow:0 8px 22px rgb(0 0 0 / 35%); border-color:var(--tl-shell-accent); background:var(--tl-shell-accent-soft); }
          .tl-scene-tab[data-pinned="true"] { border-bottom-color:var(--tl-shell-accent); }
          .tl-scene-tab-placeholder { flex:none; box-sizing:border-box; border:1px dashed var(--tl-shell-accent); border-radius:var(--tl-corner-radius); background:var(--tl-shell-accent-soft); }
          .tl-scene-tab-menu { position:fixed; z-index:10002; box-sizing:border-box; display:grid; gap:var(--tl-space-1); max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto; padding:var(--tl-space-2); border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface); color:var(--tl-shell-ink); box-shadow:0 8px 24px rgb(0 0 0 / 20%); font:var(--tl-font-compact)/1.45 var(--tl-font-family); }
          .tl-scene-tab-menu button { min-height:var(--tl-control-height); font:inherit; text-align:start; color:inherit; background:var(--tl-shell-soft); border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); padding:var(--tl-space-1) var(--tl-space-2); cursor:pointer; }
          .tl-scene-tab-menu button:disabled { opacity:.6; cursor:default; }
          .tl-scene-tab-menu p { margin:0; overflow-wrap:anywhere; }
          .tl-scene-tab-save-error { color:var(--tl-theme-danger); overflow-wrap:anywhere; }
        `),
        h('div', { ref: element => { tabsElement = element; tabRoot.current = element }, className: 'tl-scene-tab-list', 'data-compact': 'false' },
        displayTabs.map(scene => h(React.Fragment, { key: scene.id },
          drag?.started && drag.sceneId === scene.id ? h('span', { className: 'tl-scene-tab-placeholder', 'aria-hidden': true,
            style: { width: drag.rect.width, height: drag.rect.height } }) : null,
          h('button', {
          key: scene.id, type: 'button', className: 'tl-scene-tab',
          'data-scene-tab-id': scene.id, 'data-pinned': pinned.includes(scene.id) ? 'true' : 'false',
          'data-dragging': drag?.started && drag.sceneId === scene.id ? 'true' : undefined,
          style: drag?.started && drag.sceneId === scene.id ? { position: 'fixed', zIndex: 10001, width: drag.rect.width, height: drag.rect.height,
            left: drag.rect.left + drag.x - drag.startX, top: drag.rect.top + drag.y - drag.startY, pointerEvents: 'none' } : undefined,
          'aria-label': scene.label, title: `${scene.label}${pinned.includes(scene.id) ? ' · 已固定' : ''} · 右键或 Shift+F10 管理标签`,
          'aria-haspopup': 'menu', 'aria-expanded': tabMenu?.sceneId === scene.id,
          'aria-current': workbenchActive && state.activeSceneId === scene.id ? 'page' : undefined,
          onPointerDown: event => startDrag(event, scene.id),
          onContextMenu: event => openTabMenu(event, scene.id),
          onKeyDown: event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) openTabMenu(event, scene.id) },
          onClick: event => {
            if (suppressClick.current === scene.id && event?.detail !== 0) { suppressClick.current = null; event?.preventDefault?.(); event?.stopPropagation?.(); return }
            suppressClick.current = null
            if (typeof onSceneSelect === 'function') onSceneSelect(scene.id)
            else navigateScene(scene.id)
          },
        }, h('span', { className: 'tl-scene-tab-icon' }, sceneIcon(scene.templateSceneId ?? scene.id)),
        h('span', { className: 'tl-scene-tab-label' }, scene.label))))),
        tabMenu ? h('div', { ref: tabMenuRoot, className: 'tl-scene-tab-menu', role: 'menu', 'aria-label': '场景标签操作' },
          h('button', { type: 'button', role: 'menuitem', onClick: () => {
            const next = pinned.includes(tabMenu.sceneId) ? pinned.filter(id => id !== tabMenu.sceneId) : [...pinned, tabMenu.sceneId]
            saveSceneTabPreferences(orderedTabs.map(scene => scene.id), next)
            setTabMenu(null); tabMenu.trigger.focus?.()
          } }, pinned.includes(tabMenu.sceneId) ? '取消固定' : '固定标签'),
          h('button', { type: 'button', role: 'menuitem', disabled: true, title: '待桌面提供完整场景窗口能力；当前仅支持单面板浮出。' }, '独立打开场景'),
          ...(dockRenderContexts.get(tabMenu.sceneId)?.closedPanels ?? []).map(panel => h('button', {
            key: panel.id, type: 'button', role: 'menuitem', onClick: () => {
              dockRenderContexts.get(tabMenu.sceneId)?.selectPanel(panel.id)
              setTabMenu(null)
              tabMenu.trigger.focus?.()
            },
          }, `恢复面板：${panel.title}`)),
          h('p', null, '独立场景窗口能力尚未提供。')) : null,
        sceneNavigationItems(state.config).some(scene => scene.navigationGroup === 'tools') ? h(React.Fragment, null,
          h('button', { type: 'button', className: 'tl-scene-layout-trigger', 'aria-label': '工具', 'aria-haspopup': 'true',
            popovertarget: 'tl-scene-tools-menu', onClick: event => {
              const menu = document.getElementById('tl-scene-tools-menu')
              const rect = event.currentTarget.getBoundingClientRect()
              Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: '0',
                left: `${Math.max(8, Math.min(window.innerWidth - 248, rect.left))}px`, top: `${rect.bottom + 4}px` })
            } }, '工具'),
          h('div', { id: 'tl-scene-tools-menu', className: 'tl-layout-menu-popover', popover: 'auto', role: 'group', 'aria-label': '工具' },
            h('span', { className: 'tl-layout-menu-title' }, '工具'),
            ...sceneNavigationItems(state.config).filter(scene => scene.navigationGroup === 'tools').map(scene => h('button', {
              key: scene.id, type: 'button', 'aria-label': scene.label, 'aria-current': workbenchActive && state.activeSceneId === scene.id ? 'page' : undefined,
              onClick: () => { document.getElementById('tl-scene-tools-menu')?.hidePopover?.()
                if (typeof onSceneSelect === 'function') onSceneSelect(scene.id)
                else navigateScene(scene.id) },
            }, scene.label)))) : null,
        workbenchActive ? h(React.Fragment, null,
          h('button', { type: 'button', className: 'tl-scene-layout-trigger', 'aria-label': '工作区布局', title: '工作区布局',
            disabled: typeof layoutContext.resetLayout !== 'function', 'aria-haspopup': 'true', 'aria-expanded': layoutMenuOpen,
            popovertarget: layoutMenuId, popovertargetaction: 'toggle',
            onClick: positionLayoutMenu }, '布局'),
          h('div', { id: layoutMenuId, className: 'tl-layout-menu-popover', popover: 'auto', role: 'group', 'aria-label': '工作区布局',
            onToggle: event => setLayoutMenuOpen(event.newState === 'open') },
            h('span', { className: 'tl-layout-menu-title' }, '工作区布局'),
            h('button', { type: 'button', onClick: runLayoutAction(layoutContext.saveLayoutPreset) }, '保存当前为预设'),
            h('button', { type: 'button', disabled: !state.dockLayouts?.scenes?.[state.activeSceneId]?.preset,
              onClick: runLayoutAction(layoutContext.applyLayoutPreset) }, '使用已保存预设'),
            h('button', { type: 'button', onClick: runLayoutAction(layoutContext.resetLayout) }, '恢复默认预设'),
            ...['business', 'resources', 'assistant'].flatMap(category => {
              const panels = (state.config?.scenes.find(scene => scene.id === state.activeSceneId)?.panels ?? [])
                .filter(panel => (panel.category ?? (panel.type === 'native-chat' ? 'assistant' : panel.type === 'native-workspace' || ['files', 'preview'].includes(panel.id) ? 'resources' : 'business')) === category && (panel.optional !== true || panel.type === 'native-workspace'))
              return panels.length ? [h('span', { key: `${category}-title`, className: 'tl-layout-menu-section' },
                { business: '业务', resources: '资料', assistant: '助手' }[category]),
                ...panels.map(panel => h('button', { key: panel.id, type: 'button',
                  onClick: runLayoutAction(() => requestScenePanelFocus(state.activeSceneId, panel.id)) }, panel.title))] : []
            }),
            layoutContext.assistantOptions?.length ? h('span', { className: 'tl-layout-menu-section' }, '并排协作助手') : null,
            ...(layoutContext.assistantOptions ?? []).map(panel => h('button', { key: panel.id, type: 'button',
              onClick: runLayoutAction(() => layoutContext.addAssistantPanel?.(panel.id)) }, assistantLabel(panel.roleId))),
            ...(layoutContext.closedPanels ?? []).map(closed => h('button', { key: `restore-${closed.id}`, type: 'button',
              onClick: runLayoutAction(() => layoutContext.selectPanel?.(closed.id)) }, `恢复${closed.title}`)),
            layoutContext.saveError ? h('button', { type: 'button', onClick: runLayoutAction(layoutContext.retrySave) }, '重试保存布局') : null,
            layoutContext.error ? h('button', { type: 'button', onClick: runLayoutAction(layoutContext.resetLayout) }, '重试推荐布局') : null)) : null,
        state.sceneTabPreferenceError ? h('span', { role: 'status', className: 'tl-scene-tab-save-error' }, state.sceneTabPreferenceError) : null,
        state.configError ? h('span', { role: 'status' }, state.configError, h('button', { type: 'button', onClick: () => { void loadConfig(true).catch(() => {}) } }, '重试读取场景')) : null)
    }

    function modelDirectoryDiagnostic(stage, error, missingService = '') {
      const phaseLabels = {
        setup: '准备目录服务',
        retain: '连接助手会话',
        ready: '等待会话就绪',
        directoryFor: '创建模型目录',
        subscribe: '订阅模型目录',
        load: '读取模型目录',
      }
      const serviceNames = new Set(['sessions', 'modelDirectories'])
      const injectableServiceNames = new Set(['sessions', 'modelDirectories', 'remote', 'remote.session'])
      let reason = 'unavailable'
      if (serviceNames.has(missingService)) reason = `missingInjected:${missingService}`
      else {
        const message = error && typeof error.message === 'string' ? error.message : ''
        if (/^ui-model-selection: session "[^"]+" resolved no scope$/.test(message)) reason = 'missingScope'
        else if (/^ui-model-selection: session "[^"]+" resolved no binding$/.test(message)) reason = 'missingBinding'
        else if (message === "Cannot read properties of undefined (reading 'directoryFor')"
          || message === 'directoryFor is not a function') reason = 'missingInjected:modelDirectories'
        else {
          const missingInjection = message.match(/^cannot get property ["']([^"']+)["'] without inject$/i)?.[1]
          if (injectableServiceNames.has(missingInjection)) reason = `missingInjected:${missingInjection}`
        }
      }
      const phase = Object.prototype.hasOwnProperty.call(phaseLabels, stage) ? stage : 'load'
      return {
        phase,
        reason,
        error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
      }
    }

    function ModelDirectoryFailure({ diagnostic }) {
      return h('span', {
        role: 'status',
        'data-model-directory-phase': diagnostic.phase,
        'data-model-directory-error': diagnostic.reason,
      }, diagnostic.error)
    }

    const workbenchNavigationStyles = `
          .tl-model-rail {
            --tl-shell-surface: var(--tl-theme-panel); --tl-shell-soft: var(--tl-theme-header); --tl-shell-ink: var(--tl-theme-text);
            --tl-shell-muted: var(--tl-theme-muted); --tl-shell-line: var(--tl-theme-border); --tl-shell-accent: var(--tl-theme-accent);
            --tl-shell-accent-soft: var(--tl-theme-accent-soft); --tl-shell-button: var(--tl-theme-accent); --tl-shell-button-hover: var(--tl-theme-accent-strong);
            --tl-shell-button-ink: var(--tl-theme-button-ink);
            display: flex; flex: 1 1 0; align-items: center; gap: var(--tl-space-1); min-width: 0; min-height: var(--tl-row-height);
            padding: 1px var(--tl-space-1); overflow: visible; position: relative; z-index: 30; container-type:inline-size;
            color: var(--tl-shell-ink); font-family: var(--tl-font-family); font-size: var(--tl-font-compact);
          }
          .tl-model-picker-trigger { display:none; flex:0 0 auto; width:var(--tl-model-size,28px); height:var(--tl-model-size,28px); padding:0; border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface); color:var(--tl-shell-ink); font:inherit; cursor:pointer; }
          .tl-model-picker-menu { width:min(360px,calc(100vw - 16px)); }
          .tl-model-picker-menu strong { padding:6px 9px; font-size:var(--tl-font-compact); color:var(--tl-shell-muted); }
          .tl-model-picker-menu button[aria-current="true"] { background:var(--tl-shell-accent-soft); }
          .tl-model-rail[data-models-compact="true"] .tl-model-groups { display:none; }
          .tl-model-rail[data-models-compact="true"] .tl-model-picker-trigger { display:grid; place-items:center; }
          @container (max-width:360px) { .tl-model-groups { display:none!important; } .tl-model-picker-trigger { display:grid; place-items:center; } }
          .tl-model-current { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
          .tl-model-groups { display: flex; flex: 0 0 auto; align-items: center; gap: var(--tl-space-1); min-width: 0; overflow: visible; }
          .tl-model-group { position: relative; flex: 0 0 auto; min-width:var(--tl-model-size,28px); max-width:var(--tl-model-size,28px); }
          .tl-model-group > summary {
            display:grid; place-items:center; box-sizing:border-box; width:var(--tl-model-size); min-width:var(--tl-model-size); height:var(--tl-model-size); padding:0;
            border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface);
            color:var(--tl-shell-ink); cursor:pointer; list-style:none; white-space:nowrap; text-align:center; line-height:1; font-size:var(--tl-font-body); font-weight:700;
          }
          .tl-model-group > summary::-webkit-details-marker { display: none; }
          .tl-model-group > summary:focus-visible, .tl-model-options button:focus-visible,
          .tl-theme-cycle:focus-visible, .tl-scene-tab:focus-visible, .tl-scene-layout-trigger:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-model-options {
            position: absolute; top: calc(100% + var(--tl-space-1)); left: 0; z-index: 50; display: grid; gap: var(--tl-space-1);
            min-width: 180px; max-height: min(60vh,360px); overflow: auto; padding: var(--tl-space-2);
            border: 1px solid var(--tl-shell-line); border-radius: 7px; background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); box-shadow: 0 8px 24px color-mix(in srgb, var(--tl-theme-text) 18%, transparent);
          }
          .tl-model-options > strong { display:block; padding:6px 9px; border-bottom:1px solid var(--tl-shell-line); font-size:var(--tl-font-compact); }
          .tl-model-options button { width: 100%; border: 0; border-radius: 5px; padding: 7px 9px; text-align: left; background: transparent; color: inherit; cursor: pointer; }
          .tl-model-options button:hover, .tl-model-options button[aria-current="true"] { background: var(--tl-shell-accent-soft); }
          .tl-theme-toggle { display: flex; align-items: center; gap: var(--tl-space-1); flex: 0 0 auto; margin-left: auto; }
          .tl-theme-cycle {
            position: relative; display: grid; place-items: center; width: var(--tl-control-height); height: var(--tl-control-height); padding: 3px;
            border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease;
          }
          .tl-theme-cycle:hover { background: var(--tl-shell-soft); border-color: var(--tl-shell-accent); }
          .tl-theme-cycle svg { display: block; width: var(--tl-icon-size); height: var(--tl-icon-size); }
          .tl-theme-auto-badge {
            position: absolute; right: -2px; bottom: -2px; display: grid; place-items: center;
            width: 10px; height: 10px; border: 1px solid var(--tl-shell-line); border-radius: 50%;
            background: var(--tl-shell-soft); color: var(--tl-shell-muted); font-size: calc(var(--tl-font-compact) * .55); font-weight: 700; line-height: 1;
          }
          .tl-theme-error { margin: 0 10px 3px; color: var(--tl-shell-danger); font-size: var(--tl-font-compact); }
          .tl-navigation .tl-scene-tab-list { display:flex; flex:1 1 auto; align-items:center; gap:var(--tl-space-1); min-width:0; overflow:visible; }
          .tl-navigation .tl-scene-tab { display: inline-flex; flex:0 0 auto; align-items: center; justify-content: flex-start; gap:0; min-width:var(--tl-model-size); height:var(--tl-scene-tab-height); padding:0 var(--tl-space-2); border:1px solid transparent; border-radius:var(--tl-corner-radius); white-space:nowrap; transition:background-color 160ms ease,border-color 160ms ease,box-shadow 160ms ease; }
          .tl-navigation .tl-scene-tab-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; font-size: var(--tl-font-body); }
          .tl-navigation .tl-scene-tab-icon svg { display: block; width: var(--tl-icon-size); height: var(--tl-icon-size); }
          .tl-navigation .tl-scene-tab-label { display:inline-block; max-width:0; overflow:hidden; opacity:0; white-space:nowrap; transition:max-width 180ms ease,opacity 180ms ease,margin-inline-start 180ms ease; }
          .tl-navigation .tl-scene-tab[aria-current="page"] .tl-scene-tab-label { max-width:10em; margin-inline-start:var(--tl-space-1); opacity:1; }
          .tl-navigation .tl-scene-tab:hover, .tl-navigation .tl-scene-tab:focus-visible, .tl-navigation .tl-scene-tab[aria-current="page"] { background: var(--tl-shell-accent-soft); border-color: var(--tl-shell-line); }
          .tl-navigation .tl-scene-tab { color:var(--tl-shell-muted); }
          .tl-navigation .tl-scene-tab[aria-current="page"] { color:var(--tl-shell-ink); border-color:color-mix(in srgb,var(--tl-shell-accent) 48%,var(--tl-shell-line)); background:linear-gradient(180deg,color-mix(in srgb,var(--tl-shell-accent) 20%,var(--tl-shell-surface)),color-mix(in srgb,var(--tl-shell-accent) 8%,var(--tl-shell-surface))); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tl-shell-accent) 12%,transparent),0 0 12px color-mix(in srgb,var(--tl-shell-accent) 20%,transparent); }
          .tl-navigation .tl-scene-layout-trigger { flex:0 0 auto; min-width:var(--tl-model-size); min-height:calc(var(--tl-control-height) - 2px); padding:2px 8px; border:1px solid var(--tl-shell-line); border-radius:6px; background:var(--tl-shell-surface); color:var(--tl-shell-ink); font:inherit; cursor:pointer; }
          .tl-navigation .tl-scene-layout-trigger:hover:not(:disabled) { background:var(--tl-shell-soft); }
          .tl-navigation .tl-scene-layout-trigger:disabled { opacity:.55; cursor:default; }
          .tl-layout-menu-popover { box-sizing:border-box; position:fixed; inset:auto; margin:0; z-index:10000; display:grid; gap:3px; min-width:190px; max-width:min(240px,calc(100vw - 16px)); max-height:min(60vh,360px); overflow:auto; padding:6px; border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface); color:var(--tl-shell-ink); box-shadow:0 8px 24px color-mix(in srgb, var(--tl-theme-text) 18%, transparent); }
          .tl-layout-menu-popover:not(:popover-open) { display:none; }
          .tl-layout-menu-section { padding:5px 9px 1px; color:var(--tl-shell-muted); font-size:var(--tl-font-compact); font-weight:600; }
          .tl-layout-menu-popover button { min-height:var(--tl-control-height); padding:6px 9px; border:0; border-radius:5px; background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer; }
          .tl-layout-menu-popover button:hover { background:var(--tl-shell-soft); }
          .tl-layout-menu-popover button:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:1px; }
          @media (prefers-reduced-motion: reduce) { .tl-navigation .tl-scene-tab, .tl-navigation .tl-scene-tab-label, .tl-theme-cycle { transition: none; } }
        `

    // Official site favicons, captured with source hashes in the visual-fix evidence.
    const aiWebProviders = [
      { id: 'deepseek', label: 'DeepSeek', icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAuMDAwMDAwIiBoZWlnaHQ9IjUwLjAwMDAwMCIgdmlld0JveD0iMCAwIDUwIDUwIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciCgl4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayI+Cgk8cGF0aCBpZD0icGF0aCIKCQlkPSJNNDguODM1NCAxMC4wNDc5QzQ4LjMyMzIgOS43OTE5OSA0OC4xMDI1IDEwLjI3OTggNDcuODAzMiAxMC41Mjc4QzQ3LjcwMDcgMTAuNjA3OSA0Ny42MTQzIDEwLjcxMTkgNDcuNTI3MyAxMC44MDc2QzQ2Ljc3OTMgMTEuNjI0IDQ1LjkwNDggMTIuMTU5NyA0NC43NjIyIDEyLjA5NTdDNDMuMDkyMyAxMiA0MS42NjYgMTIuNTM1NiA0MC40MDU4IDEzLjgzOThDNDAuMTM3NyAxMi4yMzE5IDM5LjI0NzYgMTEuMjcyIDM3Ljg5MjYgMTAuNjU1OEMzNy4xODM2IDEwLjMzNTkgMzYuNDY2OCAxMC4wMTU2IDM1Ljk3MDIgOS4zMTk4MkMzNS42MjM1IDguODIzNzMgMzUuNTI5MyA4LjI3MTk3IDM1LjM1NiA3LjcyNzU0QzM1LjI0NTYgNy4zOTk5IDM1LjEzNTMgNy4wNjM5NiAzNC43NjUxIDcuMDA3ODFDMzQuMzYzMyA2Ljk0Mzg1IDM0LjIwNTYgNy4yODc2IDM0LjA0NzkgNy41NzU2OEMzMy40MTggOC43NTE5NSAzMy4xNzMzIDEwLjA0NzkgMzMuMTk3MyAxMS4zNTk5QzMzLjI1MjQgMTQuMzEyIDM0LjQ3MzYgMTYuNjY0MSAzNi44OTk5IDE4LjMzNTlDMzcuMTc1OCAxOC41Mjc4IDM3LjI0NjYgMTguNzE5NyAzNy4xNTk3IDE5QzM2Ljk5NDYgMTkuNTc1NyAzNi43OTc0IDIwLjEzNTcgMzYuNjI0IDIwLjcxMTlDMzYuNTEzNyAyMS4wODAxIDM2LjM0ODYgMjEuMTU5NyAzNS45NjI0IDIxQzM0LjYzMDkgMjAuNDMyMSAzMy40ODEgMTkuNTkxOCAzMi40NjQ0IDE4LjU3NTdDMzAuNzM5MyAxNi44NzIxIDI5LjE3OTIgMTQuOTkxNyAyNy4yMzM0IDEzLjUyQzI2Ljc3NjQgMTMuMTc1OCAyNi4zMTkzIDEyLjg1NiAyNS44NDY3IDEyLjU1MThDMjMuODYxOCAxMC41ODQgMjYuMTA2OSA4Ljk2Nzc3IDI2LjYyNyA4Ljc3NTg4QzI3LjE3MDQgOC41NzU2OCAyNi44MTU5IDcuODg3NyAyNS4wNTkxIDcuODk2QzIzLjMwMjIgNy45MDM4MSAyMS42OTUzIDguNTAzOTEgMTkuNjQ3IDkuMzAzNzFDMTkuMzQ3NyA5LjQyMzgzIDE5LjAzMjIgOS41MTE3MiAxOC43MDk1IDkuNTgzOThDMTYuODUwMSA5LjIyMzYzIDE0LjkxOTkgOS4xNDM1NSAxMi45MDMzIDkuMzc1OThDOS4xMDU5NiA5LjgwNzYyIDYuMDcyNzUgMTEuNjM5NiAzLjg0MzI2IDE0Ljc2ODFDMS4xNjQ1NSAxOC41Mjc4IDAuNTM0MTggMjIuNzk5OCAxLjMwNjY0IDI3LjI1NTlDMi4xMTc2OCAzMS45NTIxIDQuNDY1ODIgMzUuODM5OCA4LjA3MzczIDM4Ljg3OTlDMTEuODE1OSA0Mi4wMzIyIDE2LjEyNTUgNDMuNTc2MiAyMS4wNDEgNDMuMjgwM0MyNC4wMjY5IDQzLjEwNCAyNy4zNTE2IDQyLjY5NjMgMzEuMTAxNiAzOS40NTYxQzMyLjA0NjkgMzkuOTM2IDMzLjAzOTYgNDAuMTI3OSAzNC42ODYgNDAuMjcyQzM1Ljk1NDYgNDAuMzkyMSAzNy4xNzU4IDQwLjIwOCAzOC4xMjExIDQwLjAwNzhDMzkuNjAyMSAzOS42ODggMzkuNDk5NSAzOC4yODgxIDM4Ljk2MzkgMzguMDMyMkMzNC42MjMgMzUuOTY3OCAzNS41NzYyIDM2LjgwODEgMzQuNzEgMzYuMTI3OUMzNi45MTU1IDMzLjQ2MzkgNDAuMjQwMiAzMC42OTU4IDQxLjU0IDIxLjcyOEM0MS42NDI2IDIxLjAxNjEgNDEuNTU1NyAyMC41Njc5IDQxLjU0IDE5Ljk5MTdDNDEuNTMyMiAxOS42Mzk2IDQxLjYxMDggMTkuNTAzOSA0Mi4wMDQ5IDE5LjQ2MzlDNDMuMDkyMyAxOS4zMzU5IDQ0LjE0NzkgMTkuMDMxNyA0NS4xMTY3IDE4LjQ4NzhDNDcuOTI5MiAxNi45MTk5IDQ5LjA2NCAxNC4zNDM4IDQ5LjMzMTUgMTEuMjU1OUM0OS4zNzExIDEwLjc4MzcgNDkuMzIzNyAxMC4yOTU5IDQ4LjgzNTQgMTAuMDQ3OVpNMjQuMzI2MiAzNy44Mzk4QzIwLjExOTYgMzQuNDYzOSAxOC4wNzkxIDMzLjM1MjEgMTcuMjM1OCAzMy4zOTk5QzE2LjQ0ODIgMzMuNDQ4MiAxNi41ODk4IDM0LjM2ODIgMTYuNzYzMiAzNC45Njc4QzE2Ljk0NDMgMzUuNTYwMSAxNy4xODEyIDM1Ljk2ODMgMTcuNTExNyAzNi40ODc4QzE3Ljc0MDIgMzYuODMyIDE3Ljg5NzkgMzcuMzQ0MiAxNy4yODMyIDM3LjcyOEMxNS45MjgyIDM4LjU4NCAxMy41NzI4IDM3LjQzOTkgMTMuNDYyNCAzNy4zODM4QzEwLjcyMDcgMzUuNzM1OCA4LjQyODIyIDMzLjU2MDEgNi44MTM0OCAzMC41ODRDNS4yNTM0MiAyNy43MTk3IDQuMzQ3NjYgMjQuNjQ3OSA0LjE5Nzc1IDIxLjM2NzdDNC4xNTgyIDIwLjU3NTcgNC4zODY3MiAyMC4yOTU5IDUuMTU4NjkgMjAuMTUxOUM2LjE3NTI5IDE5Ljk2IDcuMjIzMTQgMTkuOTE5OSA4LjIzOTI2IDIwLjA3MThDMTIuNTMyNyAyMC43MTE5IDE2LjE4ODUgMjIuNjcxOSAxOS4yNTI5IDI1Ljc3NTlDMjEuMDAyIDI3LjU0MzkgMjIuMzI1MiAyOS42NTU4IDIzLjY4ODUgMzEuNzIwMkMyNS4xMzc3IDMzLjkxMjEgMjYuNjk3OCAzNiAyOC42ODMxIDM3LjcxMTlDMjkuMzg0MyAzOC4zMTIgMjkuOTQzNCAzOC43NjgxIDMwLjQ3OSAzOS4xMDRDMjguODY0MyAzOS4yODgxIDI2LjE2OTkgMzkuMzI4MSAyNC4zMjYyIDM3LjgzOThaTTI2LjM0MzMgMjQuNjAwMUMyNi4zNDMzIDI0LjI0OCAyNi42MTkxIDIzLjk2NzggMjYuOTY1OCAyMy45Njc4QzI3LjA0NDQgMjMuOTY3OCAyNy4xMTUyIDIzLjk4MzkgMjcuMTc4MiAyNC4wMDc4QzI3LjI2NTEgMjQuMDQgMjcuMzQzOCAyNC4wODc5IDI3LjQwNjcgMjQuMTYwMkMyNy41MTcxIDI0LjI3MiAyNy41ODAxIDI0LjQzMjEgMjcuNTgwMSAyNC42MDAxQzI3LjU4MDEgMjQuOTUyMSAyNy4zMDQyIDI1LjIzMTkgMjYuOTU3NSAyNS4yMzE5QzI2LjYxMDggMjUuMjMxOSAyNi4zNDMzIDI0Ljk1MjEgMjYuMzQzMyAyNC42MDAxWk0zMi42MDY0IDI3Ljg3OTlDMzIuMjA0NiAyOC4wNDc5IDMxLjgwMjcgMjguMTkxOSAzMS40MTY1IDI4LjIwOEMzMC44MTc5IDI4LjIzOTcgMzAuMTY0MSAyNy45OTIyIDI5LjgwOTYgMjcuNjg4QzI5LjI1ODMgMjcuMjE1OCAyOC44NjQzIDI2Ljk1MjEgMjguNjk4NyAyNi4xMjc5QzI4LjYyNzkgMjUuNzc1OSAyOC42Njc1IDI1LjIzMTkgMjguNzMwNSAyNC45MTk5QzI4Ljg3MjEgMjQuMjQ4IDI4LjcxNDQgMjMuODE1OSAyOC4yNDk1IDIzLjQyMzhDMjcuODcxNiAyMy4xMDQgMjcuMzkxMSAyMy4wMTYxIDI2Ljg2MzMgMjMuMDE2MUMyNi42NjYgMjMuMDE2MSAyNi40ODQ5IDIyLjkyNzcgMjYuMzUxMSAyMi44NTZDMjYuMTMwNCAyMi43NDQxIDI1Ljk0OTIgMjIuNDYzOSAyNi4xMjI2IDIyLjEyMDFDMjYuMTc3NyAyMi4wMDc4IDI2LjQ0NTggMjEuNzM1OCAyNi41MDg4IDIxLjY4OEMyNy4yMjU2IDIxLjI3MiAyOC4wNTI3IDIxLjQwNzcgMjguODE2OSAyMS43MTk3QzI5LjUyNTkgMjIuMDE2MSAzMC4wNjE1IDIyLjU2MDEgMzAuODM0IDIzLjMyODFDMzEuNjIxNiAyNC4yNTU5IDMxLjc2MzIgMjQuNTExNyAzMi4yMTI0IDI1LjIwOEMzMi41NjY5IDI1Ljc1MiAzMi44OTAxIDI2LjMxMiAzMy4xMTA0IDI2Ljk1MjFDMzMuMjQ0NiAyNy4zNTIxIDMzLjA3MTMgMjcuNjgwMiAzMi42MDY0IDI3Ljg3OTlaIgoJCWZpbGw9IiM0RDZCRkUiIGZpbGwtb3BhY2l0eT0iMS4wMDAwMDAiIGZpbGwtcnVsZT0ibm9uemVybyIgLz4KPC9zdmc+' },
      { id: 'doubao', label: '豆包', icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAsTAAALEwEAmpwYAAABaWlDQ1BEaXNwbGF5IFAzAAB4nHWQvUvDUBTFT6tS0DqIDh0cMolD1NIKdnFoKxRFMFQFq1OafgltfCQpUnETVyn4H1jBWXCwiFRwcXAQRAcR3Zw6KbhoeN6XVNoi3sfl/Ticc7lcwBtQGSv2AijplpFMxKS11Lrke4OHnlOqZrKooiwK/v276/PR9d5PiFlNu3YQ2U9cl84ul3aeAlN//V3Vn8maGv3f1EGNGRbgkYmVbYsJ3iUeMWgp4qrgvMvHgtMunzuelWSc+JZY0gpqhrhJLKc79HwHl4plrbWD2N6f1VeXxRzqUcxhEyYYilBRgQQF4X/8044/ji1yV2BQLo8CLMpESRETssTz0KFhEjJxCEHqkLhz634PrfvJbW3vFZhtcM4v2tpCAzidoZPV29p4BBgaAG7qTDVUR+qh9uZywPsJMJgChu8os2HmwiF3e38M6Hvh/GMM8B0CdpXzryPO7RqFn4Er/QcXKWq8MSlPPgAAAA50RVh0U29mdHdhcmUARmlnbWGesZZjAAAXm0lEQVR4AbVbCXAU55X+untOSegExCHEyIjL4hA24NgOtnxs4qwd23GcxAmbGGdzVLLJmo2rdmtTW2W8m92tZLNlO4nXuznKJpXDydpZO4dzlGOETTAgwBBzmgQGSYBuRtLMaM7u/d7/d0vCgGhxPGimp6en53/vf//33vvej4ErLG+ecmL5IloMYLltIGY4iPFyJY/YO26N80g4Bl9t7LUc7LGC2LNiphHHFRQDV0DaOpwWPvkeB7gXZys6WdkjBw23cdUcoxWXWS6bAd485lQWQnjYcbAOl670+STO47GghdbL5RmXbIBxiq+Hdu1zC91heKAL7W/vR6LnFIYGelAo5BGKlKJm5mzMaliIGbEFMK0AfEjcMPBswMTGSzXEJRlgx0nnYa7XDZhA8dxICod2bEbbKy/iyN42FAsFGsMWe2hxHD0M08LsxkW49f51WLbmDhiGCR8S5/HY6jrjWVykXJQB3iCwWUU8w9OW891jc3YPbP89Xn72W+g9eRy24/2YwT+O0ttRr+pEnasTfnrjnR/CXX/9CLKZEWRSSVTWTEO4tHyiIcW5LG65GG+YtAH8zHpqcAD/9/RX8MetmziTBkwetihaLEKpSmvID8s1R73aPPRQxCBF28aC5SthmSa6O9oxb0kz7vnUelTOiGECSdj0hnfVGU9gEjIpA7R1Oo9zwOsnuqfr2H48/41/QX/3SQQCAc5gCoV8BuLQpmkog8CdeTGEeIYtr1S6wKMoFhEc4BIoLS1DMZdDIBjErNg83HzvWiy+7lZYwdB5f5+P37BqtvEYfIpvA+w44TwDjfDnlVNH9+PX3/06chz04OkBDPWfouIOPcCk8iYsUd41QFEpb2sjUHExQsEu0kls5Ao2zFAYJt8HLUvdL4ZyeF4/fwnu/cwjmLv4momG8ixx4SFcLgPs6HTe5EvzRPec7opj529+ir5T7Th6YB/SQwkEqKxlmZxMvQz07Ct9lPsrxR2tvM3lIR5QKBRpgCLyvKc0FESIXiRfU95B4xR4vaSiEvd8cj1Wv/f+icByD42wAheQC0KtmvkLKJ9NDeLo7lZk08M4vPdNrbyplbc4awFTe4AYQXkCr4WCAYSoYCAQVO9NRoExI/GVCls8teQ5PAJ8lhwWrZdKDOAnT/0bdvzuZxMNq5kT9wwuxQBtJ5xHL+T2drGAzn1bkB7sxx/feB3FTIoD1utdKQQN/6K4rOUwXTscCSMYCimMUO6t1n9ReYO8560KAGF4wAi1VNRnYhS+FkYyeP7pr+LoW9smGt46GuFxXIwBBO35wxtwAelv349MMoHdWzYjPTyoRmuoP9ALTC0Di4qHEAmL4kHl/iOZDIaTKaSpSCaTRT5fQKFoq7UumBFmXAsq91dBU2OA7f2qPLhIgB3GL575BvLZ9ERDXL+t01k/KQNInHdD3YSSSyWQ7I5zze/HQG+XjukiXnIDPZNhonaIMy/XUukRDA4NIZlMIi1xnoCZpxcJBjg0gHxXZjkUsFBTVY6p1ZUoi0aUQUzLUGtem9dUnnP8yEHsfe3lCcdJJR+Vouw8n50tTHI2YaK01pWBjoPIpFM4sn8v7HwOhjOa3yljiNsHqXyAhwDYMEPi0PAwRjjrWc64XIMcBL2AU0Qp1051NIyZFWWoKokyi8zQM3II03NKolEaIUAcMCRC0rCWer4Y4eDOLUy8chMNtTKvE7ez5KzEm2tmHXwUM/mRIYwM9iD+p7eRGhLXF1e1PedXritrXNZ9gbObSqfp8knkmQrLoFndIchvTC+LYvlVc9G8tAmxBQtQPXOmQvkRLosf/fg5bNqyDUUXQwQoAwE3e4RED22I1DDHMpxAadX0iYbcIkvhnYnSGQZQrl/Eo/AhQycOI8M8v+PPR1DM59W69sKcp7wAXZELN5VMI5nSyqsskIBXW1qKlqULce2qazFn4QJU1s5CsHQKDIn7fEyEz/n8334By5ctxcYfPofugQQcF1Pk+RIZVPikh4hBs8O9FzKAXgrHnGdXNBiJcxogYONBx8fs28zshgdOYaC7l1Vdv0JvN79Rg5cBBumu8j5FxYdTaQVyBu+L8pZlc+tw27uuRWPzckyvq0ekogpmOAIVPuRBCvEclQ3eePPNWEQDfec738Mfdr+lvMFxSymLyyHPmqPr+DEa4DR8SGUuoDLZDeOMokVm37lAyPNkZOCEquo6jh5hwZLWyO/NvhiSs2+aAYJchjM/gmwuD5NrfBbX9V3NV+O+992GJTe8myVwI6KVNTAjVD7gKu/BiFskyVEzdRoe+dJ6fPjO98JyxjJH+UzC7eBALw7u2eFn6PITD0sJf5YBCHwt8EVkOMrdhrnu+7u7RpF77AcY/4ngObpmmus+y+VhceZrI1Hc0BhD84plmDV/ISqnTkWwpBQGMUKhmuMqr4O+jvsS9+Tc0Ub92AMfwsfvvYvGlNtsvexMUxl9++ZX1XLwIZ4XnGkAiq+1b+eSjL8JnKTbpZPDBPHiuEJWZ3qiTHqEIS6bg0NPmUFkf1djPRYtno+ZjfNRMbUGoajMegAq5rmG1co7Y8rb7qHOtZHvfv+d+NT99xBHxgoqiwbvOdGOvq52PyqIFzx4hgEUh+eTxsonB2iADHo6O1jl5dzBuhaAo+K0rEtRXtZ9TTiIq2fWYl5DHabPrUcpET4oOYHpwo/jjCnoOMA7lHds/ZnDJaQAlKN/z3tux323rVGYogoqwSA+Kn5wD3xKzNVZG8AxxyxyISmkE+jv62a11884rtNXhc7uMpBZyWazCvENGmLGlDLMqKlE9bRpKCmvYFgMuIDpaAWLnpKuwo6bG9hj1x2VKMm6L6rPxcvuu/suLL0qphIoySfkWufRw37VgEvY6ijAmNzs+PqWrdy/9+RJgl92bPY1twMvr5eZz9EDgjxvP53A8OE83uzuQ3XVPsyeOR2NDQ24uqkJtbPrYKgRMLs33BEoly/qWC8KS5VIHBHQVQSKAkEHQQLnug9/AAe+9iQyqo5wGJl64VvIWvPf9QGF/sWJq71RKYww6RlCor+PVi/o2dL6u5HAVPm8JD5JAmA58/6qslLMqZ2OisoKApaFI0eOYeuuvaj63e/xkXvvxnVrbhqlyjRNpL1ClC/SkMODp7F9Rxs6TpxSn0+rnop5TJxmzKhFLZOmlpUr8JvtuzgZRYwQkyYhMUmPA8E8mm1f/KMAIFPZxCCSLHfFPYW6Gu85sj6lOpQ1u2JWLZbU1WJxYwPqFsxH1QxmeGVTyOYEOdAk9u07wNo/J+Qhn2GNlsGOo13fKRQVxrz0819h2569qpaIhkM48Paf8ctXWxFhVHmQYPgXN92AV3fsVgTLuGrJl0jDJsDEotkvLWTnRpBg4pMlwntxWCfA3vrXpEWI7iy5fDXXf5gRwGLNb7rEhazVipoa3HTrLSpXUOtdnmJqA8jM09/5N6/W/Epmgjdc24yyinJFmcu1HIuoY/FOvL71DSxasBCrmxZj26EjxNUgJiVc+sJVLHd8AQBXQCFDDzit+HwVgjx219a5gEdwlhPoqsoiZG8cvLb3EFJ7D2PqtFo0LWjAquXLUErDGEReM2gr19WTr6kvx2WHFMDSOHUNc5VXOR7WOCEVRZqWVWE+PWuYxdVp5iTbDr6NaFk5JiMcdSwAx38XJ0fgSzP/L6iCRgOVPVr6auZXMKCHYfIX+4fRl86gdm4MI0yF+1/bzoougnriwRcf+CBabljNr0QUXRZQuYP7HFtjiACfTW6wWNDn3b296O4bUElQbM5MlElEoSFKyy1cVV+vuMPZc32rooQ/PZe11YXLXk9kTebp/o472zpv0chsuEyvkKBLuP7f6j2NOddez7UbQusvX1SzPqWqCsOkfTfFu5nH78TNNILFDqgTcDBKF8rzxAPoZQVyBX19fXji+z9F24GDcIIRVFVPQ4ie+NAH7sRN161kLkW+IVpCA9CV330HJimVsjBjfu8u5rOu+9sq3GmKyquCNNFZwpmYz1B344rlaFq6FN2MzZ/49GepaECFxyA9p2b6DOwfGMEIyRHliIYmOLQn6VAqESB+vB3/8M3vYicjR4IVZU/XSfYIlqBh5Q34j43P4clnfsB0m7UGH7FgxfWoqWvEJCXmE/9dA6iZKYzOOFyW23ArQLkUpgEiTE2bYrNRUVKCNENm29Y/KM4gSaq8kgApdPeNt9+BIRZKEhWkBDYUe2yp31GRgL9xNMNrgRA+uHYtjZdXHrd/+1Z84IEHsHTRAqz/5F+hhL+R4HOba0sQ7dgF+MQzTyZlAAEo1dOR1E+oKUeDoOE+RmwQFDTnxTklYdSHTMxiuTvAqrGMwNhApqeEhOiNa27G3Jpy1MVisBjODKkJBMEDYgBtUYkyJazvi4l+ZIaTennxujBG5eQSPnzH7SibMkX9vtBrixvmoCrZjqqu3ZNRCb5asZ6YXjgzMA4H9KtHhylTEAiNXBZLAynMuu9OPM/Uv5vcAVEL71/7IJbPrkFF2OLsV40mU1LVedEoFIogUBVE8xTygswfXvnfHyNCD5ldVYnFS5fBSA5hzapmFS1k2S2cOwfTqqYomj2S7Uc61YNs6XTfBojDJw6Yqs43XbrbXbEKvBzN1LjXJBGSe4I02MIp5fjnz34KgZIyHiWweBgQ/jCiDUe3d7zyF7YCPyl9DX53RqCAL6z9CP7r6f/BtEQC02fV4X3vfR/q7CSjQVTxijIBFWUlKjUOEFAtelo02eXXAPGAIdtS4E8CwbCq9dXAPfLCm0EXB0ylhs172fwQdGb2F2SPLyiurnp6xlgFKId4lDRNpSgSvp+FlDRLJEaZTCqb5zXg6Q3/hDzBTrBCZZ85kqop3S0SL4hIk0WRr0HVZofjGwgSwibE/d5tCc/HwXnsj5cIiRt4f1SPT3p7HIjF9S5Ul8V4LcSHPji7jAiGywMoXBFej0rZI2kawCU1Rt0JCiAtpsEGjW/ymYIZuujKKTAW+i0gn9FANgubEZ/uz58+HuAkHPfbIrUYh4OkqDULM0aAkp3Q56bk8iRDSIFJf0+amST4tdLCEQYsl/R0Q54b80eI4sN9vdr9wyVkhctp7LDiCNV37ZB+tscZqEKR/UP+rIRVwwpJjq0StP5CCLmyGb704Qj28OnwzSLIEpB6XoDQcFvdboaq3/O0LEqai8mJUODZbEbzd4auGUw3WTKcgvZ+14CRqmoEuIYLBE7V+BA3dhkgFRmKIU0YFXQDpeDoBmqBFjDzKWRpzyzvT5bNxEj9Sjqkzxl1aICihVar6O9+cd0AkVxwwFvDugVmKGZLBp+iW5aWlyNXzLNqHFSMryFdXmlyuhhhuf1/t4kIoyhNT3nLJSIeQxeXGkGTIJpwsfn9Io2Xl2KIOcFAOodjfUOIXbOGVq+BU8qIEirBZITD2hO4fqYRZzMkDh+RQAauOrnezOsC3p1JU+/oIF9wbGBQER9JdoIi7BcG1frlLFq817RVcZNjnZ8nsqe7uhjIWcfTW8SwoaoKhGPzmfYS0UNRzTnykLa5sEyifJbp9HMv/w7Tr7kV9XOW4SJF7UHUGYyDl/x8w+AMhQSEVBLkurDjfcbZ5YwW6IpvHu/EwZO9yLCZLwRKkhVbjiCnSRQNnCE2QcJ0/VLOeFBCKK9lWGkOHH4bPbva2HUaUspK9inFUU54Ri6RDL3ihVc2Y9Nrm9FwtT8e53wGkH+UAajIi36+ocFvXOXmRRtDM8LiIQKHKYLgpj8ewI59h4kFbKKQFkvxyArKUxH1FXqSRbwoRCSek0O08zCke0y6vGxRE41TA1UXCNjxc6HYJOf/9ZY2PPfCC2yxR1Ezqx4XK7LxUl5VJig7MH0tA1OHGcN9wjj9x/YASK/OyWOIpfOre95ivp/Ge65fTbOZ6jtqqbgbIiRMVly9FKVXNZJsTSuQM9zlosJcVnOLYrgUQ+u3f/QTbN7yhso5pByWPYYXKXFv1+loKsxJ3cgHPzrh18jgSOnpuJsXHJfLNwy960u6NBKPBeDynLnBTA5vkKlp7+nDB29Zg4X8XrGgSY+yCkOVsOIJ0hOUJolwATaNkKerC+maTg2rbG/XwT/jez96Dr0srCT1la03wg6pTRQXJ495J6MGCBXwRD6IhzEBP2DQALGma3GivYMFyLDa5CADMoUYodsHCVySLpdKkeLy+WKZbhIjP3j1ddw2cBrvXtakQE2ULKvgLLLtLZFFbZyi8rI3MM0QmhwaxuH2U/j5ps3YSU5QOD+HhnXIiNhSUUoyZVm4CJE9ha1nGUA6pts7nCcn9AIOYNai63H/wtUY6u/GQFcnOv90APFDe3GCr4M9pxApq8AXv/Jt1aYS4JM9g2mGQ4cN1eoMmyo97azwWKyQHMlMrUWIM684Qy6JIkNnZiSDP3V24WcEur0HDhD48gp7ZHOE6jrREMWc9B1yOnEKTc4I4unjN1SekTFI05BecAyTYInGnmyrzRKn2Z6aOa/pnLcUjmyHs/V5tYGKEE93z1IphjsWSo4iTIpITJ+H/czzZZ+h6vunJIJkVZKUJykbjpQpT6lgh+njX/5P8oMRTELO2lF6VsrU1umsp+M+jisgxX2vwNwvlHZYrXfZBCmbnfJqKdFAJEatlX+JyMpJU1t+5aF37is+C0VW6R0UrbgC4pzuVmVrkEAanlKBSGU1otVy1CDC7FEapkYujSsk8XNtqj4nIcL0+CGmx7I5cvJL4TwiipmJU8wKxQClXLsCfOIFUQQZ6oRxNugJmaEeXAFJiOuf64NzxhFJj41xoeJySLHzAELII8yGifAEoTBfI1MImpWI0BuijAjKC7IEzNQgLqfIJurz7SSfsGza0eE8wTsexqVKsg/G6z/ElKiFEjJEwXBUb5KUzpAwzEx5c5LtMQRmyf8NRKdjx6BBo1RjZn0DKqtr2fSY4vf/EJwhRP3HrptjbDjf5xesG7d3Os/ypgdxETI40IeBQzvQMHREcYDSHg+REpNtc9Y4YkU1PySsSVudR3owgUOsJdpY7b3w8m9RykSphp2l2bF5PBZg8fLVaFyycmzv8XmEuLrxujpj3UT3+Cqc/WyW9kTS1rfaNuO13/4Mu7e9jq8/8jdomlau9vmFuP618gFNg2uGwG2HFXQLXCo+RodkaTVb6yms+/znNIcgBZOkz8wF5Dn1DY346Ge+hCWrW86nhq/N0n77ohN6gmR28cN7sXPLK2j99Qvo6+1hzM4p/6usrMQXP/Np3PsXtyDMRCfAbrApJbRhuMyQZnhkE0SRn+RIbOaIDQXi8xNPPYWfsvDxqg5vCRiKRrBIi5fj45/7e9xy99ozx+Nj5idtAGWEDmfDOzPFU8eP4MXvfwu7tm1m+jqk6neMa50pppCp6+prrsHaj34Mq1euQpRMhCJTXEJV88GGTnX5Okie4PGnvolf/ea3ox2oUZJw3IiFlxDy5ctf+x7mL13laf/k6jnGer86TcoAIm6iJEao3N/Wiu9/61/RcTzuDtQdg2ZK3X6BNoKqBJkBTq+ZhttbWnANDVLJbK6KKbEsgX7ygidPnsTO3buw5Y2tGDid0M8QwlVV3ob73m3Fu14hnrDy+pvwpa/8d8IKR6/sf5nxRHaV9B8/uunfH3kw1iNb5Vx62xg3Q17T1Bs6xv9raCZpvMHGNlobow0XraYmS5x3PNcjVuRRpWWlrQ984rMPbfjHv4tjknJRBvBk0aJF6whYj7IMjimWyNDuLunF+J3jnjLjxXF5ZWU8x6PYbLf15sDbe+wNcZSCd71A32cnbNt47MSJ9knN+ni5qHrSE7au99RWVLxkm9YgFY9BZY6eIdz//eGdu9eVGF4/0RjtrurWmunyixj1JnfnzJliGAl+/lXLMj/a0XG8FZcgl+QB4yVGsYJWC08fZfEaM8eRFbqbDG/WXJA0PJTwNhrA83XPV7x1ridezXycXrKRhnoiHo8ncBnkshlgvDQ2NrbQAOt4upwz2Dz+p7zWtxv9Ro1hwIsIo11H935F1b1EkH2RSrfiMssVMcB4IU7EbDvfTLRuJqIvp0Ix6lZpyytst7WmlI1Ln5LuHadJjjPG7QlawdZDhw7FcQXl/wGKqPo5VF6eRwAAAABJRU5ErkJggg==' },
    ]

    function AIWebRail() {
      const bridge = window.dshDesktop?.aiWeb
      const available = typeof bridge?.toggle === 'function' && typeof bridge?.status === 'function'
      const supportsEvents = typeof bridge?.subscribe === 'function'
      const [states, setStates] = React.useState(() => Object.fromEntries(aiWebProviders.map(({ id }) => [id,
        { provider: id, available: available && (id === 'deepseek' || supportsEvents), open: false, visible: false, phase: 'closed', error: null }])))
      const [busy, setBusy] = React.useState({})
      const [notices, setNotices] = React.useState({})
      const requests = React.useRef({ live: true, byProvider: Object.fromEntries(aiWebProviders.map(({ id }) => [id, { sequence: 0, revision: -1, busy: false }])) })
      function accept(next, provider) {
        const current = requests.current
        const pending = current.byProvider[provider]
        if (!current.live || !pending || next?.provider !== provider || typeof next.available !== 'boolean'
          || typeof next.open !== 'boolean' || typeof next.visible !== 'boolean') return
        if (Number.isInteger(next.revision)) {
          if (next.revision < pending.revision) return
          pending.revision = next.revision
        } else if (pending.revision >= 0) return
        setStates(previous => ({ ...previous, [provider]: next }))
        setNotices(previous => ({ ...previous, [provider]: '' }))
      }
      React.useEffect(() => {
        const current = requests.current
        current.live = true
        const unsubscribe = supportsEvents ? bridge.subscribe(next => accept(next, next?.provider)) : null
        async function refresh() {
          if (!available) return
          await Promise.all(aiWebProviders.map(async ({ id }) => {
            if (id === 'doubao' && !supportsEvents) return
            const pending = current.byProvider[id]
            if (pending.busy) return
            const sequence = ++pending.sequence
            try {
              const next = await bridge.status({ provider: id })
              if (current.live && sequence === pending.sequence) accept(next, id)
            } catch {
              if (current.live && sequence === pending.sequence) setNotices(previous => ({ ...previous, [id]: '网页窗口状态暂时无法读取，请重试。' }))
            }
          }))
        }
        void refresh()
        const timer = available ? window.setInterval(refresh, 2000) : null
        window.addEventListener('focus', refresh)
        return () => {
          current.live = false
          for (const pending of Object.values(current.byProvider)) pending.sequence++
          if (typeof unsubscribe === 'function') unsubscribe()
          if (timer !== null) window.clearInterval(timer)
          window.removeEventListener('focus', refresh)
        }
      }, [bridge, available, supportsEvents])
      async function toggle(provider) {
        const current = requests.current
        const pending = current.byProvider[provider]
        if (!available || !states[provider]?.available || pending.busy) return
        pending.busy = true
        const sequence = ++pending.sequence
        setBusy(previous => ({ ...previous, [provider]: true }))
        setNotices(previous => ({ ...previous, [provider]: '' }))
        try {
          const next = await bridge.toggle({ provider })
          if (current.live && sequence === pending.sequence) accept(next, provider)
        } catch {
          if (current.live && sequence === pending.sequence) setNotices(previous => ({ ...previous, [provider]: '网页窗口暂时无法操作，请重试。' }))
        } finally {
          pending.busy = false
          if (current.live) setBusy(previous => ({ ...previous, [provider]: false }))
        }
      }
      return h(React.Fragment, null,
        h('style', { 'data-tradeloom-navigation-style': 'true' }, workbenchNavigationStyles),
        h('style', { 'data-tradeloom-ai-web-style': 'true' }, `
          .tl-ai-web-rail { display:flex; flex:1 1 0; align-items:center; gap:var(--tl-space-1); min-width:0; color:var(--tl-shell-ink); font:inherit; }
          .tl-ai-web-launch { position:relative; display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; gap:0; height:var(--tl-model-size,28px); padding:0 var(--tl-space-1); border:1px solid transparent; border-radius:var(--tl-corner-radius); background:transparent; color:var(--tl-shell-muted); font:inherit; cursor:pointer; transition:background-color 180ms ease,border-color 180ms ease,box-shadow 180ms ease; }
          .tl-ai-web-launch:hover { background:var(--tl-shell-soft); color:var(--tl-shell-ink); }
          .tl-ai-web-launch[aria-pressed="true"] { color:var(--tl-shell-ink); border-color:var(--tl-theme-accent); background:var(--tl-theme-accent-soft); box-shadow:0 0 9px color-mix(in srgb,var(--tl-theme-accent) 26%,transparent); }
          .tl-ai-web-launch:focus-visible { outline:2px solid var(--tl-theme-accent); outline-offset:1px; }
          .tl-ai-web-launch:disabled { opacity:.5; cursor:default; }
          .tl-ai-web-mark { display:block; flex:none; width:var(--tl-icon-size); height:var(--tl-icon-size); object-fit:contain; }
          .tl-ai-web-name { display:inline-block; max-width:0; overflow:hidden; opacity:0; white-space:nowrap; transition:max-width 180ms ease,opacity 180ms ease,margin-inline-start 180ms ease; }
          .tl-ai-web-launch[aria-pressed="true"] .tl-ai-web-name { max-width:7em; margin-inline-start:var(--tl-space-1); opacity:1; }
          .tl-ai-web-state { position:absolute; right:2px; bottom:2px; width:6px; height:6px; border-radius:50%; box-shadow:0 0 0 1px var(--tl-shell-surface); pointer-events:none; }
          .tl-ai-web-launch[data-phase="loading"] .tl-ai-web-state { background:var(--tl-theme-accent); animation:tl-ai-web-pulse 1.2s ease-in-out infinite; }
          .tl-ai-web-launch[data-phase="error"] .tl-ai-web-state { background:var(--tl-theme-danger); }
          .tl-ai-web-live { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
          @keyframes tl-ai-web-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }
          html[data-windows-titlebar] .tl-top-model-row .tl-ai-web-launch { height:26px; font-size:min(var(--tl-font-compact),16px); }
          @media(prefers-reduced-motion:reduce) { .tl-ai-web-launch,.tl-ai-web-name { transition:none; } .tl-ai-web-launch[data-phase="loading"] .tl-ai-web-state { animation:none; opacity:.8; } }
        `),
        h('nav', { className: 'tl-ai-web-rail', 'aria-label': 'AI 网页应用' }, ...aiWebProviders.map(({ id, label, icon }) => {
          const state = states[id]
          const shown = !!(state.available && state.open && state.visible)
          const phaseLabel = !available || !state.available ? '独立网页窗口需要更新桌面版本。'
            : state.error || state.phase === 'error' ? '网页加载失败，请在网页窗口刷新。'
              : state.phase === 'loading' ? '网页正在加载…'
                : state.phase === 'ready' ? '网页已加载；登录和站点提示请在网页窗口处理。'
                  : `打开独立的 ${label} 网页窗口。`
          const attention = shown && (state.error || state.phase === 'error' || state.phase === 'loading')
          return h('button', { key: id, type: 'button', className: 'tl-ai-web-launch', 'data-provider': id,
            'data-phase': state.phase, 'data-error': state.error || '',
            disabled: !available || !state.available || !!busy[id], 'aria-label': `${shown ? '收起' : '打开'} ${label} 网页窗口`,
            'aria-pressed': shown, 'aria-busy': !!busy[id], title: `${label} 网页 · ${notices[id] || phaseLabel}`,
            onClick: () => { void toggle(id) } },
          h('img', { className: 'tl-ai-web-mark', src: icon, alt: '', 'aria-hidden': 'true', draggable: false }),
          h('span', { className: 'tl-ai-web-name', 'aria-hidden': 'true' }, label),
          attention ? h('span', { className: 'tl-ai-web-state', 'aria-hidden': 'true' }) : null)
        }), h('span', { className: 'tl-ai-web-live', role: 'status', 'aria-live': 'polite' },
          aiWebProviders.map(({ id, label }) => {
            const state = states[id]
            if (!(state.available && state.open && state.visible)) return ''
            if (state.error || state.phase === 'error') return `${label} 网页加载失败，请在网页窗口刷新。`
            if (state.phase === 'loading') return `${label} 网页正在加载。`
            return ''
          }).filter(Boolean).join(' '))))
    }

    function ModelDirectoryRail() {
      const state = useSnapshot()
      const scene = state.config?.scenes.find(item => item.id === state.activeSceneId)
      const roleId = scene ? roleForScene(state.config, scene.id) : undefined
      const sessionId = roleId ? state.sessionBindings[roleId] : undefined
      const directoryKey = roleId && sessionId ? JSON.stringify([roleId, sessionId]) : ''
      const [directoryInfo, setDirectoryInfo] = React.useState({ key: '', status: 'idle', snapshot: null, error: '' })
      const [themeError, setThemeError] = React.useState('')
      const activeDirectoryInfo = directoryInfo.key === directoryKey ? directoryInfo : null
      const directoryState = activeDirectoryInfo?.snapshot
      const directoryError = activeDirectoryInfo?.error ?? ''
      function updateSelectionState(directory, error = '') {
        setDirectoryInfo(current => {
          if (!directoryKey || current.key !== directoryKey) return current
          return {
            ...current,
            status: error ? 'error' : 'ready',
            snapshot: directory ? directory.store.getSnapshot() : current.snapshot,
            error,
          }
        })
      }
      React.useEffect(() => {
        let live = true
        let unsubscribe
        if (!roleId || !sessionId) {
          return () => { live = false }
        }
        const missingService = !sessionsApi ? 'sessions' : !modelDirectoriesApi ? 'modelDirectories' : ''
        if (missingService) {
          const diagnostic = modelDirectoryDiagnostic('setup', null, missingService)
          setDirectoryInfo({ key: directoryKey, status: 'error', snapshot: null, ...diagnostic })
          return () => { live = false }
        }
        setDirectoryInfo({ key: directoryKey, status: 'pending', snapshot: null, error: '' })
        const stopWaiting = retainListedRoleSession(sessionsApi, roleId, sessionId, {
          onReady() {
            if (!live) return
            void (async () => {
              let stage = 'directoryFor'
              try {
                const directory = modelDirectoriesApi.directoryFor(sessionId)
                const update = () => {
                  if (live) setDirectoryInfo({ key: directoryKey, status: 'ready', snapshot: directory.store.getSnapshot(), error: '', phase: '', reason: '' })
                }
                stage = 'subscribe'
                unsubscribe = directory.store.subscribe(update)
                update()
                stage = 'load'
                await directory.load()
                update()
              } catch (error) {
                if (live) setDirectoryInfo({
                  key: directoryKey, status: 'error', snapshot: null,
                  ...modelDirectoryDiagnostic(stage, error),
                })
              }
            })()
          },
          onUnavailable() {
            if (live) setDirectoryInfo({
              key: directoryKey, status: 'error', snapshot: null,
              ...modelDirectoryDiagnostic('ready', new Error('session-reference-unavailable')),
            })
          },
        })
        return () => { live = false; stopWaiting?.(); unsubscribe?.() }
      }, [roleId, sessionId])
      const entries = modelDirectoryEntries(directoryState?.groups)
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const rail = document.querySelector('.tl-model-rail')
        const groups = rail?.querySelector('.tl-model-groups')
        if (!rail || !groups) return undefined
        const measure = () => {
          const summaries = [...groups.querySelectorAll('summary')]
          const gap = parseFloat(window.getComputedStyle(groups).columnGap) || 0
          const needed = summaries.reduce((sum, node) => sum + (parseFloat(window.getComputedStyle(node).width) || 28), 0)
            + Math.max(0, summaries.length - 1) * gap + 12
          rail.dataset.modelsCompact = String(needed > rail.clientWidth)
        }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(rail)
        window.addEventListener?.('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener?.('resize', measure) }
      }, [entries.length, activeUiTokens.fontBody, directoryKey])
      async function selectThemePreference(preference) {
        setThemeError('')
        try {
          themeApi?.setTheme?.(preference)
        } catch {
          setThemeError('主题设置失败，请重试。')
        }
      }
      const themePreference = themeApi?.getTheme?.()?.preference
      const followsSystem = themePreference === 'system'
      const currentAppearance = followsSystem
        ? `跟随系统（${activeColorScheme === 'dark' ? '深色' : '浅色'}）`
        : activeColorScheme === 'dark' ? '深色' : '浅色'
      const nextAppearance = followsSystem
        ? activeColorScheme === 'dark' ? '浅色' : '深色'
        : '跟随系统'
      const appearanceLabel = `当前外观：${currentAppearance}，切换到${nextAppearance}`
      const currentModel = sessionId
        ? directoryState?.current ? currentModelLabel(directoryState.current, directoryState.groups)
          : activeDirectoryInfo?.status === 'pending' ? '正在连接模型目录…' : '选择模型'
        : '连接助手后选择模型'
      function cycleThemePreference() {
        const nextPreference = followsSystem
          ? activeColorScheme === 'dark' ? 'light' : 'dark'
          : 'system'
        void selectThemePreference(nextPreference)
      }
      return h(React.Fragment, null,
        h('style', { 'data-tradeloom-navigation-style': 'true' }, workbenchNavigationStyles),
        h('nav', { className: `tl-model-rail ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': '模型目录' },
          h('span', { className: 'tl-model-current', role: 'status', 'aria-live': 'polite', title: currentModel }, currentModel),
          h('button', { type: 'button', className: 'tl-model-picker-trigger', 'aria-label': '选择模型', title: `选择模型 · ${currentModel}`,
            popovertarget: 'tl-model-directory-menu', 'aria-haspopup': 'true', onClick: event => {
              const menu = document.getElementById('tl-model-directory-menu')
              const rect = event.currentTarget.getBoundingClientRect()
              const width = Math.min(360, window.innerWidth - 16)
              Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: '0',
                left: `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`,
                top: `${Math.max(8, Math.min(window.innerHeight - 180, rect.bottom + 4))}px` })
            } }, '◈'),
          h('div', { id: 'tl-model-directory-menu', className: 'tl-layout-menu-popover tl-model-picker-menu', popover: 'auto', role: 'group', 'aria-label': '选择模型' },
            h('span', { className: 'tl-layout-menu-title' }, currentModel),
            ...entries.flatMap(group => [h('strong', { key: `${group.provider}-title` }, group.providerName),
              ...group.models.map(model => h('button', { key: `${model.provider}/${model.id}`, type: 'button',
                'aria-label': `选择${model.providerName}的${model.name}`,
                'aria-current': directoryState?.current?.provider === model.provider && directoryState?.current?.model === model.id ? 'true' : undefined,
                onClick: async () => {
                  if (!sessionId) return
                  try {
                    const directory = modelDirectoriesApi.directoryFor(sessionId)
                    const result = await directory.select({ provider: model.provider, model: model.id })
                    updateSelectionState(directory, result.ok ? '' : '模型暂时无法切换')
                    if (result.ok) document.getElementById('tl-model-directory-menu')?.hidePopover?.()
                  } catch { updateSelectionState(undefined, '模型暂时无法切换') }
                },
              }, model.name))]),
            !entries.length ? h('span', { role: 'status', className: 'tl-layout-menu-section' }, directoryError || '模型目录加载中') : null),
          h('div', { className: 'tl-model-groups' }, entries.map(group => h('details', { key: group.provider, className: 'tl-model-group' },
            h('summary', { 'aria-label': `${group.providerName}模型列表`, title: group.providerName }, providerBadgeLabel(group.providerName)),
            h('div', { className: 'tl-model-options' }, h('strong', null, group.providerName), ...group.models.map(model => h('button', {
              key: `${model.provider}/${model.id}`, type: 'button',
              'aria-label': `选择${model.providerName}的${model.name}`, title: `${model.providerName} · ${model.name}`,
              'aria-current': directoryState?.current?.provider === model.provider && directoryState?.current?.model === model.id ? 'true' : undefined,
              onClick: async () => {
                if (!sessionId) return
                let directory
                try {
                  directory = modelDirectoriesApi.directoryFor(sessionId)
                  const result = await directory.select({ provider: model.provider, model: model.id })
                  updateSelectionState(directory, result.ok ? '' : '模型暂时无法切换')
                } catch { updateSelectionState(directory, '模型暂时无法切换') }
              },
            }, model.name)))))),
          h('div', { className: 'tl-theme-toggle' },
            h('button', { type: 'button', className: 'tl-theme-cycle', 'aria-label': appearanceLabel, title: appearanceLabel, onClick: cycleThemePreference },
              activeColorScheme === 'dark'
                ? h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                  h('path', { d: 'M20.3 15.4A8.5 8.5 0 0 1 8.6 3.7 8.6 8.6 0 1 0 20.3 15.4Z' }))
                : h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' },
                  h('circle', { cx: 12, cy: 12, r: 4 }),
                  h('path', { d: 'M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42' })),
              followsSystem ? h('span', { className: 'tl-theme-auto-badge', 'aria-hidden': 'true' }, 'A') : null),
          ),
          directoryError ? h(ModelDirectoryFailure, { diagnostic: activeDirectoryInfo }) : null),
        themeError ? h('p', { className: 'tl-theme-error', role: 'alert' }, themeError) : null)
    }

    function useRoleModelGroups(roleId = 'center') {
      const state = useSnapshot()
      const sessionId = state.sessionBindings[roleId]
      const key = sessionId ? JSON.stringify([roleId, sessionId]) : ''
      const [catalog, setCatalog] = React.useState({ key: '', groups: [] })
      React.useEffect(() => {
        let live = true
        let unsubscribe
        setCatalog({ key, groups: [] })
        if (!key || !sessionsApi || !modelDirectoriesApi) return () => { live = false }
        const stop = retainListedRoleSession(sessionsApi, roleId, sessionId, {
          onReady() {
            if (!live) return
            void (async () => {
              try {
                const directory = modelDirectoriesApi.directoryFor(sessionId)
                const update = () => {
                  if (live) setCatalog({ key, groups: modelDirectoryEntries(directory.store.getSnapshot()?.groups).map(group => ({
                    provider: group.provider, providerName: group.providerName,
                    models: group.models.map(({ provider, id, name }) => ({ provider, id, name })),
                  })) })
                }
                unsubscribe = directory.store.subscribe(update)
                update()
                await directory.load()
                update()
              } catch { if (live) setCatalog({ key, groups: [] }) }
            })()
          },
          onUnavailable() { if (live) setCatalog({ key, groups: [] }) },
        })
        return () => { live = false; stop?.(); unsubscribe?.() }
      }, [roleId, sessionId])
      return key && catalog.key === key ? catalog.groups : []
    }

    function loadWorkflowCanvas() {
      if (!workflowRequest) workflowRequest = Promise.resolve()
        .then(() => {
          if (!asyncRequire) throw new Error('workflow-module-loader-unavailable')
          return asyncRequire('./client.workflow.js')
        })
        .then(value => {
          const module = value?.default ?? value
          if (typeof module?.WorkflowCanvas !== 'function') throw new Error('workflow-component-unavailable')
          return module.WorkflowCanvas
        })
        .catch(error => { workflowRequest = undefined; throw error })
      return workflowRequest
    }

    function WorkflowCanvasPane({ refreshRequest, nativeToolbar = false } = {}) {
      const modelGroups = useRoleModelGroups('center')
      const [revision, setRevision] = React.useState(0)
      const [module, setModule] = React.useState({ status: 'loading', Component: null })
      React.useEffect(() => {
        let live = true
        setModule({ status: 'loading', Component: null })
        void loadWorkflowCanvas().then(Component => {
          if (live) setModule({ status: 'ready', Component })
        }, () => { if (live) setModule({ status: 'error', Component: null }) })
        return () => { live = false }
      }, [revision])
      if (module.status === 'error') return h(PaneState, {
        title: '工作流画布暂时无法加载', description: '业务计划仍可继续使用，请重试加载画布。',
        tone: 'error', action: { label: '重试画布', onClick: () => setRevision(value => value + 1) },
      })
      if (!module.Component) return h(PaneState, { title: '正在加载工作流画布', description: '正在读取前端画布组件。', busy: true })
      return h('div', { className: 'tl-workflow-canvas-pane', 'data-workflow-canvas': 'true' },
        modelGroups.length ? null : h('p', { className: 'tl-workflow-model-hint', role: 'status' },
          '中心助手尚无可用模型目录；请选择已连接的中心助手模型，不会自动创建会话。'),
        h(module.Component, { modelGroups, refreshRequest, nativeToolbar }))
    }

    function BusinessPaneTabs({ panel, path, proposalHref, refreshKey, sceneId, viewIntent, fitContainer = false }) {
      const tabs = panel.frontendTabs.filter(tab => ['business', 'workflow-canvas'].includes(tab.view))
      const initial = tabs.find(tab => tab.id === panel.defaultFrontendTab) ?? tabs[0]
      const [activeId, setActiveId] = React.useState(initial.id)
      const [canvasVisited, setCanvasVisited] = React.useState(initial.view === 'workflow-canvas')
      const selected = tabs.find(tab => tab.id === activeId) ?? initial
      const select = tab => { setActiveId(tab.id); if (tab.view === 'workflow-canvas') setCanvasVisited(true) }
      React.useLayoutEffect(() => {
        const requested = tabs.find(tab => tab.view === viewIntent?.view)
        if (requested) select(requested)
      }, [viewIntent?.revision])
      const idFor = tab => `tl-${sceneId}-${panel.id}-${tab.id}`
      return h('div', { className: 'tl-business-pane-tabs', 'data-business-view-tabs': sceneId,
        style: fitContainer ? { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0, width: '100%', height: '100%', overflow: 'hidden' } : undefined },
        h('div', { className: 'tl-business-view-tabs', role: 'tablist', 'aria-label': '工作流视图' }, tabs.map((tab, index) => h('button', {
          key: tab.id, id: `${idFor(tab)}-tab`, type: 'button', role: 'tab', 'aria-selected': selected.id === tab.id,
          'aria-controls': `${idFor(tab)}-panel`, tabIndex: selected.id === tab.id ? 0 : -1,
          onClick: () => select(tab), onKeyDown: event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
            if (next < 0) return
            event.preventDefault(); select(tabs[next])
            event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus()
          },
        }, tab.label))),
        ...tabs.map(tab => h('div', { key: tab.id, id: `${idFor(tab)}-panel`, role: 'tabpanel',
          className: 'tl-business-view-panel', 'aria-labelledby': `${idFor(tab)}-tab`, hidden: selected.id !== tab.id,
          style: fitContainer ? { display: selected.id === tab.id ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' } : undefined,
        }, tab.view === 'business' ? h(BusinessFrame, { panel, path, proposalHref, refreshKey, fitContainer })
          : canvasVisited ? h(WorkflowCanvasPane) : null)))
    }

    function PanelFrame({ panel, expanded, layout, onExpand, onRefresh, refreshLabel, onHide, children }) {
      return h('section', {
        className: 'tl-panel', 'aria-label': panel.title,
        style: { ...normalizePanelStyle(layout, expanded), minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--tl-theme-border)', borderRadius: 'var(--tl-corner-radius)', overflow: 'hidden', background: 'var(--tl-theme-panel)' },
      },
      h('header', { className: 'tl-panel-header' },
        h('strong', { style: { flex: 1 } }, panel.title),
        h('button', { type: 'button', onClick: onRefresh, 'aria-label': refreshLabel }, refreshLabel),
        h('button', { type: 'button', onClick: onExpand, 'aria-label': expanded ? `还原${panel.title}` : `展开${panel.title}` }, expanded ? '还原' : '展开'),
        h('button', { type: 'button', onClick: onHide, 'aria-label': `关闭${panel.title}` }, '关闭')),
      h('div', { className: 'tl-panel-body', style: {
        flex: 1, minWidth: 0, minHeight: 0, padding: panel.type === 'business-iframe' ? 0 : 10,
        ...(panel.type === 'native-chat' ? { display: 'flex', flexDirection: 'column' } : {}),
      } }, children))
    }

    function BusinessFrame({ panel, path, proposalHref, refreshKey, fitContainer = false }) {
      const src = path === '/agent-center' && proposalHref ? proposalHref : `/business${path}`
      return h('iframe', { key: refreshKey, 'data-tradeloom-business-frame': 'true', 'data-tradeloom-panel-id': panel.id, title: `织贸助手 · ${panel.title}`, src,
        style: { display: 'block', width: '100%', height: '100%', minHeight: fitContainer ? 0 : 180, border: 0,
          ...(fitContainer ? { flex: '1 1 0', minWidth: 0 } : {}) } })
    }

    const CATALOG_MARKDOWN_IMAGE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/
    const catalogMarkdownPathImages = Object.freeze({
      resolve(value) {
        if (typeof value !== 'string') return undefined
        const match = CATALOG_MARKDOWN_IMAGE.exec(value)
        if (!match || match[1].length % 4 !== 0) return undefined
        return value
      },
    })
    const markdownLabels = Object.freeze({ code: Object.freeze({ copyLabel: '复制代码', copiedLabel: '已复制' }), footnotes: '脚注' })

    function ArtifactMarkdownPreview({ sceneId, selection, generation = 0, activeScene = true, requestFileExport, requestFileFocus, openFilesPanel, closePanel }) {
      const identity = `${selection?.kind ?? ''}:${selection?.id ?? ''}`
      const isCurrentSelection = () => {
        const current = fileSelectionByScene.get(sceneId)
        return snapshot.activeSceneId === sceneId
          && (snapshot.fileSelectionGenerations?.[sceneId] ?? 0) === generation
          && (current ? current.kind === selection?.kind && current.id === selection?.id : generation === 0)
      }
      const [mode, setMode] = React.useState(MarkdownText ? 'reader' : 'source')
      const [reloadRevision, setReloadRevision] = React.useState(0)
      const [documentState, setDocumentState] = React.useState({ status: 'loading', file: null, text: '', error: '' })
      const [downloadHref, setDownloadHref] = React.useState('')
      const [actionStatus, setActionStatus] = React.useState('')
      const actionsTrigger = React.useRef(null)
      const actionsMenu = React.useRef(null)

      function positionActionsMenu() {
        const menu = actionsMenu.current
        const trigger = actionsTrigger.current
        if (!menu || !trigger || !menu.matches(':popover-open')) return
        const viewport = menu.ownerDocument.defaultView
        const margin = 8
        menu.style.maxHeight = `${Math.max(0, viewport.innerHeight - margin * 2)}px`
        const anchor = trigger.getBoundingClientRect()
        const bounds = menu.getBoundingClientRect()
        const below = viewport.innerHeight - margin - anchor.bottom - 4
        const above = anchor.top - margin - 4
        const proposedTop = below >= bounds.height || below >= above ? anchor.bottom + 4 : anchor.top - bounds.height - 4
        menu.style.left = `${Math.max(margin, Math.min(anchor.right - bounds.width, viewport.innerWidth - margin - bounds.width))}px`
        menu.style.top = `${Math.max(margin, Math.min(proposedTop, viewport.innerHeight - margin - bounds.height))}px`
      }

      React.useLayoutEffect(() => {
        const menu = actionsMenu.current
        if (!menu) return undefined
        if (!activeScene) {
          if (menu.matches(':popover-open')) menu.hidePopover()
          return undefined
        }
        const viewport = menu.ownerDocument.defaultView
        let observer = null
        function stopPositioning() {
          observer?.disconnect()
          observer = null
          viewport.removeEventListener('resize', positionActionsMenu)
          viewport.removeEventListener('scroll', positionActionsMenu, true)
        }
        function onToggle() {
          stopPositioning()
          if (!menu.matches(':popover-open')) return
          observer = typeof viewport.ResizeObserver === 'function' ? new viewport.ResizeObserver(positionActionsMenu) : null
          observer?.observe(menu)
          viewport.addEventListener('resize', positionActionsMenu)
          viewport.addEventListener('scroll', positionActionsMenu, true)
          positionActionsMenu()
        }
        menu.addEventListener('toggle', onToggle)
        return () => {
          stopPositioning()
          menu.removeEventListener('toggle', onToggle)
          if (menu.matches(':popover-open')) menu.hidePopover()
        }
      }, [activeScene])

      React.useEffect(() => {
        let live = true
        setDocumentState({ status: 'loading', file: null, text: '', error: '' })
        if (!activeScene) return () => { live = false }
        if (!requestFileExport || selection?.kind !== 'artifact' || !selection.id) {
          setDocumentState({ status: 'error', file: null, text: '', error: '无法确认当前交付版本，请从文件栏重新选择。' })
          return () => { live = false }
        }
        const started = requestFileExport('artifact', selection.id, async result => {
          if (!live || !isCurrentSelection()) return
          if (!result?.ok || !(result.file instanceof File)
            || result.file.name !== 'catalog.md' || result.file.type.trim().toLowerCase() !== 'text/markdown'
            || result.blobMimeType?.trim?.().toLowerCase() !== 'text/markdown') {
            setDocumentState({ status: 'error', file: null, text: '', error: result?.ok
              ? '当前版本不是受支持的 Markdown 文件。' : result?.error || '无法读取当前交付版本，请重试。' })
            return
          }
          try {
            const text = await result.file.text()
            if (live && isCurrentSelection()) setDocumentState({ status: 'ready', file: result.file, text, error: '' })
          } catch {
            if (live) setDocumentState({ status: 'error', file: null, text: '', error: '读取 Markdown 内容失败，请重试。' })
          }
        })
        if (!started && live) setDocumentState({ status: 'error', file: null, text: '', error: '当前文件来源已失效，请从文件栏重新选择。' })
        return () => { live = false }
      }, [sceneId, identity, generation, activeScene, selection?.kind, selection?.id, requestFileExport, reloadRevision])

      React.useEffect(() => {
        let href = ''
        if (documentState.file && typeof globalThis.URL?.createObjectURL === 'function') {
          try { href = globalThis.URL.createObjectURL(documentState.file) } catch { href = '' }
        }
        setDownloadHref(href)
        return () => { if (href && typeof globalThis.URL?.revokeObjectURL === 'function') globalThis.URL.revokeObjectURL(href) }
      }, [documentState.file])

      const file = documentState.file
      const generatedAt = file?.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '—'
      const sizeLabel = file ? `${file.size.toLocaleString('zh-CN')} 字节` : '—'
      async function copyVersionId() {
        if (!isCurrentSelection()) return
        try {
          if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') throw new Error()
          await globalThis.navigator.clipboard.writeText(selection.id)
          if (isCurrentSelection()) setActionStatus('版本ID已复制。')
        } catch {
          if (isCurrentSelection()) setActionStatus('无法访问剪贴板，可手动选择页脚中的版本ID。')
        }
      }
      function locateVersion() {
        if (!isCurrentSelection()) return
        setActionStatus('正在定位文件行…')
        const onResult = result => {
          if (!isCurrentSelection()) return
          setActionStatus(result?.ok && result.found ? '已定位到文件行。'
            : result?.error || '文件列表中未找到此版本。')
        }
        if (!openFilesPanel?.()) {
          setActionStatus('文件栏未打开，无法定位此版本。')
          return
        }
        if (!requestFileFocus?.('artifact', selection.id, onResult)) {
          setActionStatus('文件栏暂不可用，请重试定位。')
        }
      }
      const previewActionsId = `tl-preview-actions-${sceneId}`
      const downloadIcon = h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
        h('path', { d: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5' }))
      const controls = h('div', { className: 'tl-markdown-preview-controls' },
        h('div', { className: 'tl-markdown-preview-modes', role: 'group', 'aria-label': 'Markdown视图模式' },
          h('button', { type: 'button', 'aria-pressed': mode === 'source', onClick: () => setMode('source') }, '源码'),
          h('button', { type: 'button', 'aria-pressed': mode === 'reader', onClick: () => setMode('reader') }, '阅读')),
        downloadHref ? h('a', { href: downloadHref, download: file?.name ?? 'catalog.md', className: 'tl-preview-icon-action', 'aria-label': '下载原文件', title: '下载原文件' }, downloadIcon)
          : h('button', { type: 'button', disabled: true, className: 'tl-preview-icon-action', 'aria-label': '下载原文件', title: '原文件尚未载入' }, downloadIcon),
        h('button', { ref: actionsTrigger, type: 'button', 'aria-label': '更多预览操作', title: '更多预览操作', popovertarget: previewActionsId,
          onClick: event => {
            event.preventDefault()
            const menu = actionsMenu.current
            if (!menu) return
            if (menu.matches(':popover-open')) menu.hidePopover()
            else {
              menu.showPopover()
              positionActionsMenu()
            }
          } }, '⋯'),
        h('div', { ref: actionsMenu, id: previewActionsId, className: 'tl-preview-actions-menu', popover: 'auto', 'aria-label': '预览操作',
          onClick: event => { if (event.target.closest('button')) event.currentTarget.hidePopover() } },
          h('button', { type: 'button', onClick: () => setReloadRevision(value => value + 1) }, '重读'),
          h('button', { type: 'button', onClick: copyVersionId }, '复制版本ID'),
          h('button', { type: 'button', onClick: locateVersion }, '定位'),
          h('button', { type: 'button', onClick: closePanel, 'aria-label': '关闭预览' }, '关闭')))
      let content
      if (documentState.status === 'loading') content = h('div', { className: 'tl-markdown-preview-status', role: 'status' }, '正在读取已登记版本…')
      else if (documentState.status === 'error') content = h('div', { className: 'tl-markdown-preview-status is-error', role: 'alert' },
        documentState.error,
        mode === 'reader' && !MarkdownText ? h('p', null, '原生 Markdown 阅读器不可用；可切回源码或下载原文件。') : null)
      else if (mode === 'source') content = h('pre', { className: 'tl-markdown-preview-source', 'aria-label': 'Markdown源码', tabIndex: 0 }, h('code', null, documentState.text))
      else if (MarkdownText) content = h('div', { className: 'tl-markdown-preview-reader', 'aria-label': 'Markdown阅读视图' },
        h(MarkdownText, { text: documentState.text, labels: markdownLabels, pathImages: catalogMarkdownPathImages, variant: 'body' }))
      else content = h('div', { className: 'tl-markdown-preview-status is-error', role: 'alert' }, '原生 Markdown 阅读器不可用；可切回源码或下载原文件。')
      return h('section', { className: 'tl-markdown-preview', 'data-file-id': selection?.id ?? '', 'data-scene-id': sceneId },
        h('header', { className: 'tl-markdown-preview-header' },
          h('strong', { title: file?.name ?? 'catalog.md' }, file?.name ?? 'catalog.md'), controls),
        h('div', { className: `tl-markdown-preview-content is-${mode}` }, content),
        h('footer', { className: 'tl-markdown-preview-footer' },
          h('span', null, '只读 · 已登记版本'),
          h('details', { className: 'tl-preview-version-details' }, h('summary', null, '版本信息'),
            h('span', { className: 'tl-markdown-preview-version-id' }, '版本ID ', h('code', null, selection?.id ?? '—')),
            h('span', null, `文件大小 ${sizeLabel}`), h('span', null, `版本生成时间 ${generatedAt}`)),
          actionStatus ? h('span', { role: 'status', 'aria-live': 'polite' }, actionStatus) : null))
    }

    const ERP_DOCTYPES = Object.freeze(['Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order'])
    const ERP_DOCTYPE_LABELS = Object.freeze({
      Item: '商品', Customer: '客户', Supplier: '供应商', Warehouse: '仓库', Bin: '库存数量',
      'Sales Order': '销售订单', 'Purchase Order': '采购订单',
    })
    const ERP_LIST_FIELDS = Object.freeze({
      Item: ['item_code', 'item_name', 'item_group', 'stock_uom', 'disabled'],
      Customer: ['customer_name', 'customer_type', 'customer_group', 'territory', 'disabled'],
      Supplier: ['supplier_name', 'supplier_type', 'supplier_group', 'country', 'disabled'],
      Warehouse: ['warehouse_name', 'company', 'parent_warehouse', 'disabled'],
      Bin: ['item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'projected_qty', 'stock_uom'],
      'Sales Order': ['name', 'customer_name', 'company', 'transaction_date', 'status', 'grand_total', 'currency'],
      'Purchase Order': ['name', 'supplier_name', 'company', 'transaction_date', 'status', 'grand_total', 'currency'],
    })
    const ERP_FIELD_LABELS = Object.freeze({
      name: '编号', modified: '最后修改', item_code: '商品编码', item_name: '商品名称', item_group: '商品组',
      stock_uom: '库存单位', disabled: '已停用', description: '说明', brand: '品牌', image: '图片路径',
      is_stock_item: '库存商品', has_variants: '含变体', customer_name: '客户名称', alias: '别名',
      customer_type: '客户类型', customer_group: '客户组', territory: '区域', tax_id: '税号',
      default_currency: '默认币种', website: '网站', email_id: '电子邮箱', mobile_no: '手机',
      supplier_name: '供应商名称', supplier_type: '供应商类型', supplier_group: '供应商组', country: '国家/地区',
      warehouse_name: '仓库名称', is_group: '分组仓库', company: '公司', parent_warehouse: '上级仓库',
      warehouse_type: '仓库类型', phone_no: '电话', city: '城市', state: '省/州', warehouse: '仓库',
      actual_qty: '实际数量', reserved_qty: '已预留数量', ordered_qty: '已订购数量', indented_qty: '申请数量',
      planned_qty: '计划数量', projected_qty: '预计数量', customer: '客户编号', supplier: '供应商编号',
      transaction_date: '交易日期', delivery_date: '交货日期', schedule_date: '计划日期', status: '状态',
      delivery_status: '交付状态', billing_status: '开票状态', total_qty: '总数量', grand_total: '总金额',
      currency: '币种', docstatus: '单据状态', items: '商品明细', barcodes: '条码', qty: '数量', uom: '单位',
      rate: '单价', amount: '金额', barcode: '条码', barcode_type: '条码类型',
    })

    function safeErpNextSiteUrl(value) {
      if (typeof value !== 'string' || !value || value.length > 2048) return ''
      try {
        const parsed = new URL(value)
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
        const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
        if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !loopback)
          || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
        return parsed.href.replace(/\/$/, '')
      } catch { return '' }
    }

    function erpDisplayValue(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (value === true) return '是'
      if (value === false) return '否'
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      return '—'
    }

    function ERPNextRecords({ refreshKey = 0 }) {
      const [state, setState] = React.useState({
        doctype: 'Item', offset: 0, loading: true, listError: '', records: [], nextOffset: null,
        listRetry: 0, selectedName: '', detail: null, detailLoading: false, detailError: '', detailRetry: 0,
      })
      React.useEffect(() => {
        let live = true
        setState(current => ({ ...current, loading: true, listError: '', records: [], nextOffset: null, selectedName: '', detail: null, detailError: '' }))
        const query = new URLSearchParams({ doctype: state.doctype, limit: '20', offset: String(state.offset) })
        void fetch(`/business-api/erpnext/records?${query}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || value.doctype !== state.doctype || !Array.isArray(value.records)
              || value.records.length > 20 || !(value.next_offset === null || (Number.isInteger(value.next_offset) && value.next_offset >= 0))
              || value.records.some(record => !record || record.doctype !== state.doctype || !record.data
                || typeof record.data.name !== 'string' || !record.external_ref || record.external_ref.system !== 'erpnext'
                || record.external_ref.doctype !== state.doctype || record.external_ref.name !== record.data.name)) throw new Error()
            return value
          })
          .then(value => { if (live) setState(current => ({ ...current, loading: false, records: value.records, nextOffset: value.next_offset })) })
          .catch(() => { if (live) setState(current => ({ ...current, loading: false, listError: '暂时无法读取 ERPNext 列表，请重试。' })) })
        return () => { live = false }
      }, [state.doctype, state.offset, state.listRetry, refreshKey])
      React.useEffect(() => {
        let live = true
        if (!state.selectedName) return () => { live = false }
        setState(current => ({ ...current, detailLoading: true, detailError: '', detail: null }))
        const query = new URLSearchParams({ doctype: state.doctype, name: state.selectedName })
        void fetch(`/business-api/erpnext/record?${query}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || value.doctype !== state.doctype || !value.data
              || value.data.name !== state.selectedName || !value.external_ref || value.external_ref.system !== 'erpnext'
              || value.external_ref.doctype !== state.doctype || value.external_ref.name !== state.selectedName) throw new Error()
            return value
          })
          .then(value => { if (live) setState(current => ({ ...current, detailLoading: false, detail: value })) })
          .catch(() => { if (live) setState(current => ({ ...current, detailLoading: false, detailError: '暂时无法读取记录详情，请重试。' })) })
        return () => { live = false }
      }, [state.doctype, state.selectedName, state.detailRetry, refreshKey])

      const columns = ERP_LIST_FIELDS[state.doctype]
      const detailData = state.detail?.data
      const childFields = new Set(['items', 'barcodes'])
      return h('div', { className: 'tl-erpnext-browser' },
        h('div', { className: 'tl-erpnext-controls' },
          h('label', null, '数据类型', h('select', {
            value: state.doctype,
            onChange: event => setState(current => ({ ...current, doctype: event.target.value, offset: 0, selectedName: '', detail: null })),
            'aria-label': '选择 ERPNext 数据类型',
          }, ERP_DOCTYPES.map(doctype => h('option', { key: doctype, value: doctype }, ERP_DOCTYPE_LABELS[doctype])))),
          h('button', { type: 'button', onClick: () => setState(current => ({ ...current, listRetry: current.listRetry + 1 })) }, '刷新列表')),
        state.loading ? h('p', { role: 'status' }, `正在读取${ERP_DOCTYPE_LABELS[state.doctype]}…`)
          : state.listError ? h('p', { role: 'alert' }, state.listError,
            h('button', { type: 'button', onClick: () => setState(current => ({ ...current, listRetry: current.listRetry + 1 })) }, '重试'))
            : state.records.length === 0 ? h('p', { role: 'status' }, '当前没有可显示的记录。')
              : h('div', { className: 'tl-erpnext-table-wrap' }, h('table', null,
                h('thead', null, h('tr', null,
                  ...columns.map(field => h('th', { key: field, scope: 'col' }, ERP_FIELD_LABELS[field] ?? field)),
                  h('th', { scope: 'col' }, '操作'))),
                h('tbody', null, state.records.map(record => h('tr', { key: record.data.name },
                  ...columns.map(field => h('td', { key: field }, erpDisplayValue(record.data[field]))),
                  h('td', null, h('button', { type: 'button', onClick: () => setState(current => ({ ...current, selectedName: record.data.name, detail: null, detailError: '' })) }, '详情'))))))),
        !state.loading && !state.listError && state.records.length > 0 ? h('div', { className: 'tl-erpnext-pagination' },
          state.offset > 0 ? h('button', { type: 'button', onClick: () => setState(current => ({ ...current, offset: Math.max(0, current.offset - 20), selectedName: '', detail: null })) }, '上一页') : null,
          h('span', null, `从第 ${state.offset + 1} 项开始`),
          state.nextOffset !== null ? h('button', { type: 'button', onClick: () => setState(current => ({ ...current, offset: current.nextOffset, selectedName: '', detail: null })) }, '下一页') : null) : null,
        state.selectedName ? h('section', { className: 'tl-erpnext-detail', 'aria-live': 'polite' },
          h('div', { className: 'tl-erpnext-detail-heading' }, h('h4', null, '记录详情'),
            h('button', { type: 'button', onClick: () => setState(current => ({ ...current, selectedName: '', detail: null, detailError: '' })) }, '关闭详情')),
          state.detailLoading ? h('p', { role: 'status' }, '正在读取详情…')
            : state.detailError ? h('p', { role: 'alert' }, state.detailError,
              h('button', { type: 'button', onClick: () => setState(current => ({ ...current, detailRetry: current.detailRetry + 1 })) }, '重试'))
              : detailData ? h(React.Fragment, null,
                h('dl', null, ...Object.entries(detailData).filter(([key, value]) => !childFields.has(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
                  .map(([key, value]) => h(React.Fragment, { key }, h('dt', null, ERP_FIELD_LABELS[key] ?? key), h('dd', null, erpDisplayValue(value))))),
                ...[...childFields].filter(key => Array.isArray(detailData[key]) && detailData[key].length > 0)
                  .map(key => h('div', { key, className: 'tl-erpnext-child-table' },
                    h('h5', null, ERP_FIELD_LABELS[key]),
                    h('pre', null, JSON.stringify(detailData[key], null, 2)))),
                h('p', { className: 'tl-erpnext-source' }, `来源：ERPNext · ${state.detail.external_ref.instance_id} · ${state.detail.external_ref.doctype}/${state.detail.external_ref.name} · 修改时间 ${erpDisplayValue(state.detail.external_ref.modified)}`)) : null) : null)
    }

    function PaneState({ title, description = '', action, icon, tone = 'neutral', busy = false, role = tone === 'error' ? 'alert' : 'status' } = {}) {
      const defaultIcon = h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', focusable: 'false', 'aria-hidden': 'true' },
      h('rect', { x: 3.5, y: 4, width: 17, height: 13, rx: 2 }),
      h('path', { d: 'M8 20h8M12 17v3M8 10h8M8 13h4' }))
      return h('section', { className: `tl-pane-state${tone === 'error' ? ' is-error' : ''}`, role,
        'aria-live': role === 'alert' ? 'assertive' : 'polite', 'aria-busy': busy ? 'true' : undefined },
      h('div', { className: 'tl-pane-state-symbol', 'aria-hidden': 'true' },
        h('div', { className: 'tl-pane-state-icon' }, icon ?? defaultIcon),
        busy ? h('span', { className: 'tl-pane-state-spinner' }) : null),
      h('h3', { className: 'tl-pane-state-title' }, title),
      description ? h('p', { className: 'tl-pane-state-description' }, description) : null,
      action ? h('button', { className: 'tl-pane-state-action', type: 'button', onClick: action.onClick,
        disabled: Boolean(action.disabled || busy) }, action.label) : null)
    }

    function Placeholder({ panel }) { return h('div', { className: 'tl-placeholder' }, h('p', null, panel.text)) }
    function ERPNextStatus({ refreshKey = 0 } = {}) {
      const [state, setState] = React.useState({ loading: true, configured: false, connected: false, status: '', error: '', siteUrl: '', retry: 0 })
      React.useEffect(() => {
        let live = true
        setState(current => ({ ...current, loading: true }))
        void fetch('/business-api/erpnext/status', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || typeof value.configured !== 'boolean' || typeof value.connected !== 'boolean'
              || !['not_configured', 'invalid_configuration', 'connected', 'unavailable'].includes(value.status)) throw new Error()
            if (live) setState(current => ({ ...current, loading: false, configured: value.configured, connected: value.connected, status: value.status, error: '', siteUrl: safeErpNextSiteUrl(value.site_url) }))
          })
          .catch(() => { if (live) setState(current => ({ ...current, loading: false, configured: false, connected: false, status: '', error: '暂时无法读取连接状态，请稍后重试。', siteUrl: '' })) })
        return () => { live = false }
      }, [refreshKey, state.retry])
      const title = state.loading ? '正在检查 ERPNext 连接…'
        : state.error ? 'ERPNext 状态暂不可用'
          : state.status === 'not_configured' ? 'ERPNext 尚未配置'
            : state.connected ? 'ERPNext 已连接' : 'ERPNext 暂时无法连接'
      const detail = state.error || (state.status === 'not_configured'
        ? '请由管理员配置 ERPNext 连接后再使用只读数据。'
        : state.connected ? '连接检查已通过。以下为 ERPNext 只读记录。'
          : state.loading ? '正在读取本地连接状态。' : '请检查服务状态或连接配置。')
      const checkConnection = () => setState(current => ({ ...current, retry: current.retry + 1 }))
      const failedStatus = ['invalid_configuration', 'unavailable'].includes(state.status)
      const showPaneState = Boolean(state.error || failedStatus || state.status === 'not_configured')
      const paneStateTone = state.error || failedStatus ? 'error' : 'neutral'
      const statusContent = showPaneState
        ? [h(PaneState, { title, description: detail, icon: sceneIcon('erpnext'), tone: paneStateTone,
          role: state.error || failedStatus ? 'alert' : 'status', busy: state.loading,
          action: { label: state.error ? '重试' : '检查连接', onClick: checkConnection, disabled: state.loading } })]
        : [
          h('div', { className: 'tl-erpnext-status-heading' }, h('h3', null, title),
            h('button', { type: 'button', onClick: checkConnection, disabled: state.loading }, '检查连接')),
          h('p', null, detail),
          state.connected ? h(ERPNextRecords, { key: refreshKey, refreshKey }) : null,
        ].filter(Boolean)
      return h('section', { className: 'tl-erpnext-status', 'aria-live': 'polite' },
        h(React.Fragment, null, ...statusContent),
        state.siteUrl ? h('div', { className: 'tl-erpnext-entry-actions' },
          h('a', { href: `${state.siteUrl}/app`, target: '_blank', rel: 'noopener noreferrer' }, '打开 ERPNext 工作台')) : null,
        h(ERPNextQuotationDraft, { enabled: state.connected }))
    }

    const EMPTY_QUOTATION_ITEM = Object.freeze({ item_code: '', qty: '', rate: '', uom: '' })
    const QUOTATION_TEXT_LIMITS = Object.freeze({
      company: 140, party_name: 140, transaction_date: 10, valid_till: 10, currency: 3,
      item_code: 140, qty: 32, rate: 32, uom: 140,
    })
    const DRAFT_OPERATION_ID = /^[0-9a-f]{32}$/
    const DRAFT_MODIFIED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

    function safeQuotationReadback(value) {
      const ref = value?.external_ref
      const data = value?.data
      if (value?.doctype !== 'Quotation' || !data || typeof data !== 'object' || Array.isArray(data)
        || typeof data.name !== 'string' || !data.name || data.docstatus !== 0
        || typeof data.modified !== 'string' || !DRAFT_MODIFIED.test(data.modified)
        || !ref || ref.system !== 'erpnext' || ref.doctype !== 'Quotation' || ref.name !== data.name
        || typeof ref.instance_id !== 'string' || !ref.instance_id || ref.modified !== data.modified) return null
      return {
        doctype: 'Quotation', data: { name: data.name, modified: data.modified, docstatus: 0 },
        external_ref: { system: 'erpnext', instance_id: ref.instance_id, doctype: 'Quotation', name: ref.name, modified: ref.modified },
      }
    }

    function quotationOperation(value) {
      if (!value || typeof value !== 'object' || !DRAFT_OPERATION_ID.test(value.operation_id ?? '')
        || value.doctype !== 'Quotation' || !['create', 'update'].includes(value.action)
        || !['reserved', 'outcome_unknown', 'succeeded', 'conflict'].includes(value.status)) return null
      const receipt = value.receipt ? safeQuotationReadback(value.receipt) : null
      const remoteCurrent = value.remote_current ? safeQuotationReadback(value.remote_current) : null
      if ((value.receipt && !receipt) || (value.remote_current && !remoteCurrent)) return null
      const operation = {
        operation_id: value.operation_id,
        action: value.action,
        status: value.status,
        remote_name: typeof value.remote_name === 'string' ? value.remote_name : '',
        remote_modified: typeof value.remote_modified === 'string' ? value.remote_modified : '',
        receipt,
        remote_current: remoteCurrent,
      }
      if (operation.status === 'succeeded' && operation.receipt) return operation
      if (operation.status !== 'succeeded') return operation
      return null
    }

    function quotationPayload(fields) {
      const payload = {
        company: fields.company.trim(),
        party_name: fields.party_name.trim(),
        transaction_date: fields.transaction_date,
        currency: fields.currency.trim().toUpperCase(),
        items: fields.items.map(item => ({
          item_code: item.item_code.trim(), qty: item.qty.trim(), rate: item.rate.trim(), uom: item.uom.trim(),
        })),
      }
      if (fields.valid_till) payload.valid_till = fields.valid_till
      if (!payload.company || payload.company.length > QUOTATION_TEXT_LIMITS.company
        || !payload.party_name || payload.party_name.length > QUOTATION_TEXT_LIMITS.party_name
        || payload.transaction_date.length > QUOTATION_TEXT_LIMITS.transaction_date
        || !/^\d{4}-\d{2}-\d{2}$/.test(payload.transaction_date)
        || (fields.valid_till && !/^\d{4}-\d{2}-\d{2}$/.test(fields.valid_till))
        || (payload.valid_till && payload.valid_till.length > QUOTATION_TEXT_LIMITS.valid_till)
        || payload.currency.length > QUOTATION_TEXT_LIMITS.currency || !/^[A-Z]{3}$/.test(payload.currency)
        || payload.items.length < 1 || payload.items.length > 100
        || payload.items.some(item => !item.item_code || item.item_code.length > QUOTATION_TEXT_LIMITS.item_code
          || !item.uom || item.uom.length > QUOTATION_TEXT_LIMITS.uom
          || item.qty.length > QUOTATION_TEXT_LIMITS.qty || item.rate.length > QUOTATION_TEXT_LIMITS.rate
          || !/^\d+(?:\.\d+)?$/.test(item.qty)
          || !/^\d+(?:\.\d+)?$/.test(item.rate) || Number(item.qty) <= 0)) return null
      return payload
    }

    function ERPNextQuotationDraft({ enabled = false } = {}) {
      const [state, setState] = React.useState(() => ({
        fields: { company: '', party_name: '', transaction_date: '', valid_till: '', currency: '', items: [{ ...EMPTY_QUOTATION_ITEM }] },
        operation: null, baseOperation: null, pendingRequest: null, current: null, needsReadback: false, loading: false, error: '', notice: '',
      }))

      function updateFields(change) {
        setState(current => ({ ...current, fields: { ...current.fields, ...change }, error: '', notice: '' }))
      }

      async function csrfHeaders() {
        await fetch('/business-api/', { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/html' } })
        const cookie = typeof document === 'object' ? document.cookie : ''
        const match = /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookie)
        if (!match) throw new Error('csrf_unavailable')
        return { accept: 'application/json', 'content-type': 'application/json', 'X-CSRFToken': decodeURIComponent(match[1]) }
      }

      async function sendWrite(request) {
        setState(current => ({ ...current, loading: true, error: '', notice: '', pendingRequest: request }))
        try {
          const headers = await csrfHeaders()
          const response = await fetch(request.path, {
            method: request.method, credentials: 'same-origin', headers, body: request.body,
          })
          let value
          try { value = await response.json() } catch { throw new Error('invalid_response') }
          const operation = quotationOperation(value)
          if (!operation || (response.status === 409 && operation.status !== 'conflict')
            || (response.status !== 409 && !response.ok && response.status !== 202)
            || (response.status === 202 && operation.status !== 'outcome_unknown' && operation.status !== 'reserved')) {
            const uncertain = response.status >= 500 || !operation && (response.ok || response.status === 202)
            setState(current => ({ ...current, loading: false, pendingRequest: uncertain ? request : null,
              error: uncertain ? '暂未收到可核对的操作回执。请使用原请求键恢复，不要另建请求。' : '报价操作未完成，请检查输入后明确发起新操作。' }))
            return
          }
          const currentRecord = operation.status === 'succeeded' ? operation.remote_current ?? operation.receipt
            : operation.status === 'conflict' ? operation.remote_current : null
          setState(current => ({ ...current, loading: false, operation,
            baseOperation: operation.status === 'succeeded' ? operation : current.baseOperation,
            current: currentRecord ?? current.current,
            pendingRequest: null, needsReadback: operation.status === 'conflict',
            notice: operation.status === 'succeeded' ? '已确认保存草稿。'
              : operation.status === 'conflict' ? '版本冲突；请先读取当前版本，再决定是否创建新的修改操作。'
                : '结果待核对；请读取操作状态，不要重复创建或使用新请求键。',
            error: '' }))
        } catch {
          setState(current => ({ ...current, loading: false, pendingRequest: request,
            error: '暂未收到操作回执。请使用原请求键恢复，不要另建请求。' }))
        }
      }

      async function readOperation(operationId, isRecovery = false) {
        setState(current => ({ ...current, loading: true, error: '', notice: '' }))
        try {
          const response = await fetch(`/business-api/erpnext/quotation-drafts/${encodeURIComponent(operationId)}`,
            { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          const value = await response.json()
          const operation = quotationOperation(value)
          if (!response.ok || !operation) throw new Error('invalid_response')
          const latestRemote = operation.remote_current ?? (operation.status === 'succeeded' ? operation.receipt : null)
          setState(current => ({ ...current, loading: false, operation,
            baseOperation: operation.status === 'succeeded' ? operation : current.baseOperation,
            current: latestRemote ?? current.current,
            pendingRequest: null,
            needsReadback: operation.status === 'conflict' && !latestRemote,
            notice: operation.status === 'succeeded' ? '已确认保存草稿。'
              : operation.status === 'conflict' ? '已读取冲突时的当前版本；如需修改，请明确创建一条新操作。'
                : '结果待核对；此操作仅查询状态，没有重新写入。', error: '' }))
        } catch {
          setState(current => ({ ...current, loading: false, error: '暂时无法读取操作状态，请稍后重试。' }))
        }
      }

      function createDraft() {
        const payload = quotationPayload(state.fields)
        if (!enabled) { setState(current => ({ ...current, error: 'ERPNext 当前不可写入；已有操作仍可只读核对。' })); return }
        if (!payload) { setState(current => ({ ...current, error: '请填写有效的公司、客户、日期、币种和报价行。' })); return }
        const idempotencyKey = globalThis.crypto?.randomUUID?.()
        if (!idempotencyKey) { setState(current => ({ ...current, error: '当前环境无法生成安全请求键。' })); return }
        if (state.operation && ['outcome_unknown', 'reserved', 'conflict'].includes(state.operation.status)) {
          setState(current => ({ ...current, error: '请先读取当前操作状态，再开始新的操作。' })); return
        }
        const body = JSON.stringify({ idempotency_key: idempotencyKey, payload })
        return sendWrite({ method: 'POST', path: '/business-api/erpnext/quotation-drafts', body })
      }

      function updateDraft() {
        const payload = quotationPayload(state.fields)
        const target = state.baseOperation
        const ref = state.current?.external_ref
        const idempotencyKey = globalThis.crypto?.randomUUID?.()
        if (!enabled || !payload || !target || target.status !== 'succeeded'
          || state.pendingRequest
          || ['outcome_unknown', 'reserved'].includes(state.operation?.status)
          || (state.operation?.status === 'conflict' && state.needsReadback)
          || !ref || ref.system !== 'erpnext'
          || ref.doctype !== 'Quotation' || ref.name !== target.remote_name || !DRAFT_MODIFIED.test(ref.modified ?? '')
          || state.needsReadback || !idempotencyKey) {
          setState(current => ({ ...current, error: '请先读取一条已成功草稿的当前版本，并确认报价内容有效。' })); return
        }
        const body = JSON.stringify({ idempotency_key: idempotencyKey, expected_modified: ref.modified, payload })
        return sendWrite({ method: 'PUT', path: `/business-api/erpnext/quotation-drafts/${encodeURIComponent(target.operation_id)}`, body })
      }

      function addItem() {
        if (state.fields.items.length >= 100) return
        updateFields({ items: [...state.fields.items, { ...EMPTY_QUOTATION_ITEM }] })
      }

      const textField = (label, key, type = 'text', required = true) => h('label', { className: 'tl-erpnext-draft-field', key },
        h('span', null, label), h('input', { type, required, value: state.fields[key], 'aria-label': label,
          maxLength: QUOTATION_TEXT_LIMITS[key],
          onChange: event => updateFields({ [key]: event.target.value }) }))
      return h('section', { className: 'tl-erpnext-draft', 'aria-labelledby': 'tl-erpnext-draft-title' },
        h('div', { className: 'tl-erpnext-detail-heading' }, h('h4', { id: 'tl-erpnext-draft-title' }, '报价草稿'),
          h('span', { className: 'tl-erpnext-source' }, '仅保存 ERPNext Quotation 草稿；不会提交或开具单据。')),
        h('div', { className: 'tl-erpnext-draft-fields' },
          textField('公司', 'company'), textField('客户', 'party_name'), textField('交易日期', 'transaction_date', 'date'),
          textField('有效日期', 'valid_till', 'date', false), textField('币种', 'currency')),
        h('div', { className: 'tl-erpnext-draft-items' },
          h('div', { className: 'tl-erpnext-detail-heading' }, h('h5', null, '报价行'),
            h('button', { type: 'button', onClick: addItem, disabled: state.fields.items.length >= 100 }, '添加商品行')),
          ...state.fields.items.map((item, index) => h('div', { className: 'tl-erpnext-draft-item', key: index },
            ...[
              ['商品编码', 'item_code', 'text'], ['数量', 'qty', 'text'], ['单价', 'rate', 'text'], ['单位', 'uom', 'text'],
            ].map(([label, key, type]) => h('label', { className: 'tl-erpnext-draft-field', key },
              h('span', null, `${label} ${index + 1}`), h('input', { type, inputMode: key === 'qty' || key === 'rate' ? 'decimal' : undefined,
                value: item[key], maxLength: QUOTATION_TEXT_LIMITS[key], 'aria-label': `${label} ${index + 1}`,
                onChange: event => updateFields({ items: state.fields.items.map((row, rowIndex) => rowIndex === index
                  ? { ...row, [key]: event.target.value } : row) }) }))),
            state.fields.items.length > 1 ? h('button', { type: 'button', onClick: () => updateFields({ items: state.fields.items.filter((_, rowIndex) => rowIndex !== index) }) }, '移除商品行') : null))),
        h('div', { className: 'tl-erpnext-draft-actions' },
          h('button', { type: 'button', onClick: createDraft, disabled: !enabled || state.loading || Boolean(state.pendingRequest)
            || ['outcome_unknown', 'reserved'].includes(state.operation?.status)
            || (state.operation?.status === 'conflict' && state.needsReadback) }, '创建报价草稿'),
          state.baseOperation?.status === 'succeeded' ? h('button', { type: 'button', onClick: updateDraft, disabled: !enabled || state.loading || state.pendingRequest || state.needsReadback
            || ['outcome_unknown', 'reserved'].includes(state.operation?.status) }, '保存为新修改操作') : null,
          state.pendingRequest ? h('button', { type: 'button', onClick: () => sendWrite(state.pendingRequest), disabled: state.loading }, '用原请求键恢复回执') : null,
          state.operation && ['outcome_unknown', 'reserved', 'conflict'].includes(state.operation.status)
            ? h('button', { type: 'button', onClick: () => readOperation(state.operation.operation_id), disabled: state.loading }, '读取操作状态') : null,
          state.operation?.status === 'conflict' ? h('button', { type: 'button', onClick: () => readOperation(state.operation.operation_id), disabled: state.loading }, '刷新冲突版本') : null),
        state.loading ? h('p', { role: 'status' }, '正在处理…') : null,
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.notice ? h('p', { role: state.operation?.status === 'succeeded' ? 'status' : 'alert' }, state.notice) : null,
        state.current ? h('p', { className: 'tl-erpnext-source' }, `ERPNext 报价：${state.current.data?.name ?? state.operation?.remote_name ?? '—'} · 修改时间 ${state.current.external_ref?.modified ?? '—'}`) : null)
    }

    function installShortPaneTriggerOverlays(root) {
      if (!root) return () => {}
      let document = root.ownerDocument
      let viewport = document.defaultView
      let frame = 0
      let disposed = false
      let resizeObserver
      const entries = new Map()
      const properties = ['position', 'top', 'right', 'bottom', 'left', 'width', 'margin', 'max-height']
      function originalStyle(node) {
        return Object.fromEntries(properties.map(name => [name, [node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]]))
      }
      function release(node, entry) {
        try { if (node.matches(':popover-open')) node.hidePopover() } catch { /* A removed menu has no top-layer entry. */ }
        entry.styleObserver?.disconnect()
        resizeObserver?.unobserve(node)
        for (const [name, [value, priority]] of Object.entries(entry.original)) {
          if (value) node.style.setProperty(name, value, priority)
          else node.style.removeProperty(name)
        }
        node.removeAttribute('popover')
        entries.delete(node)
      }
      function fit() {
        if (disposed) return
        if (document !== root.ownerDocument) bindOwner()
        const rootRect = root.getBoundingClientRect()
        for (const node of root.querySelectorAll('[data-trigger-menu]')) {
          if (!entries.has(node) && !node.hasAttribute('popover') && typeof node.showPopover === 'function') {
            const entry = { original: originalStyle(node), appliedMax: null }
            entries.set(node, entry)
            entry.styleObserver = new viewport.MutationObserver(() => {
              // Native React may replace max-height after our RAF. Refit before paint;
              // ignore the adapter's own cap and position writes to prevent observer loops.
              if (!disposed && node.style.getPropertyValue('max-height') !== entry.appliedMax) fit()
            })
            entry.styleObserver.observe(node, { attributes: true, attributeFilter: ['style'] })
            node.setAttribute('popover', 'manual')
            resizeObserver?.observe(node)
          }
        }
        for (const [node, entry] of entries) {
          if (!node.isConnected || !root.contains(node)) { release(node, entry); continue }
          const card = node.closest('[data-composer-card]')
          const input = card?.querySelector('[data-composer-input]')
          const seat = node.closest('[data-composer-seat]')
          if (!card || !rootRect.width || !rootRect.height || root.checkVisibility && !root.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) {
            try { if (node.matches(':popover-open')) node.hidePopover() } catch { /* Hidden scene. */ }
            continue
          }
          resizeObserver?.observe(card)
          const cardRect = card.getBoundingClientRect()
          const inputRect = input?.getBoundingClientRect()
          const seatRect = seat?.getBoundingClientRect() || rootRect
          const clipTop = Math.max(8, rootRect.top, seatRect.top)
          const clipBottom = Math.min(viewport.innerHeight - 8, rootRect.bottom, seatRect.bottom)
          const anchor = inputRect ?? cardRect
          const anchorTop = Math.max(clipTop, anchor.top)
          const anchorBottom = Math.min(clipBottom, anchor.bottom)
          const anchorLeft = Math.max(8, rootRect.left, seatRect.left, anchor.left)
          const anchorRight = Math.min(viewport.innerWidth - 8, rootRect.right, seatRect.right, anchor.right)
          if (anchorBottom <= anchorTop || anchorRight <= anchorLeft) {
            try { if (node.matches(':popover-open')) node.hidePopover() } catch { /* Anchor is outside the pane. */ }
            continue
          }
          // The provider's cap is measured against the outer window frame.
          // In a docked guest that can reserve the same chrome twice and leave
          // only a title plus a sliver of the first row. The owned pane bounds
          // are the safe viewport here; keep the menu inside them directly.
          const paneTop = Math.max(8, rootRect.top)
          const paneBottom = Math.min(viewport.innerHeight - 8, rootRect.bottom)
          const above = Math.max(0, anchorTop - paneTop - 12)
          const below = Math.max(0, paneBottom - anchorBottom - 12)
          const placeAbove = above >= Math.min(160, Math.max(40, node.scrollHeight)) || above >= below
          const available = placeAbove ? above : below
          // Track React's latest cap so release restores its value, but use the
          // pane-local ceiling because the provider measured against outer chrome.
          const currentMax = node.style.getPropertyValue('max-height')
          if (currentMax !== entry.appliedMax) entry.original['max-height'] = [currentMax, node.style.getPropertyPriority('max-height')]
          const cap = Math.min(available, 400)
          const width = Math.min(cardRect.width, Math.max(0, viewport.innerWidth - 16))
          Object.assign(node.style, { position: 'fixed', top: 'auto', right: 'auto', bottom: 'auto', left: `${Math.max(8, Math.min(viewport.innerWidth - width - 8, cardRect.left))}px`, width: `${width}px`, margin: '0', maxHeight: `${cap}px` })
          entry.appliedMax = node.style.getPropertyValue('max-height')
          try { if (!node.matches(':popover-open')) node.showPopover() } catch { continue }
          const height = node.getBoundingClientRect().height
          node.style.top = `${Math.max(paneTop, Math.min(paneBottom - height, placeAbove ? anchorTop - height - 4 : anchorBottom + 4))}px`
        }
      }
      function schedule() {
        if (disposed || frame) return
        frame = viewport.requestAnimationFrame(() => { frame = 0; fit() })
      }
      function bindOwner() {
        if (frame) { viewport.cancelAnimationFrame(frame); frame = 0 }
        resizeObserver?.disconnect()
        viewport.removeEventListener('resize', schedule)
        viewport.removeEventListener('scroll', schedule, true)
        document = root.ownerDocument
        viewport = document.defaultView
        resizeObserver = typeof viewport.ResizeObserver === 'function' ? new viewport.ResizeObserver(schedule) : undefined
        resizeObserver?.observe(root)
        for (const node of entries.keys()) resizeObserver?.observe(node)
        viewport.addEventListener('resize', schedule)
        viewport.addEventListener('scroll', schedule, true)
      }
      const observer = new viewport.MutationObserver(schedule)
      observer.observe(root, { childList: true, subtree: true })
      const ownerChanged = () => { bindOwner(); schedule() }
      root.addEventListener('dsh:composer-owner-document-change', ownerChanged, true)
      root.addEventListener('scroll', schedule, true)
      bindOwner()
      schedule()
      function dispose() {
        disposed = true
        observer.disconnect()
        resizeObserver?.disconnect()
        if (frame) viewport.cancelAnimationFrame(frame)
        root.removeEventListener('dsh:composer-owner-document-change', ownerChanged, true)
        root.removeEventListener('scroll', schedule, true)
        viewport.removeEventListener('resize', schedule)
        viewport.removeEventListener('scroll', schedule, true)
        for (const [node, entry] of entries) release(node, entry)
      }
      dispose.refresh = schedule
      return dispose
    }

    function SceneChatPanel({ renderSlot, renderFactorySlot, requestFileExport, onAddFiles, nativeHeaderFactoryAvailable = false }) {
      const [draggingFile, setDraggingFile] = React.useState(false)
      const [fileDropStatus, setFileDropStatus] = React.useState(null)
      const rootRef = React.useRef(null)
      React.useLayoutEffect(() => installShortPaneTriggerOverlays(rootRef.current), [])
      function acceptsTradeLoomFile(event) {
        return Array.from(event.dataTransfer?.types ?? []).includes(FILE_DROP_MIME)
      }
      function onDragEnter(event) {
        if (!acceptsTradeLoomFile(event)) return
        event.preventDefault()
        setDraggingFile(true)
      }
      function onDragOver(event) {
        if (!acceptsTradeLoomFile(event)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
        setDraggingFile(true)
      }
      function onDragLeave(event) {
        if (!rootRef.current?.contains(event.relatedTarget)) setDraggingFile(false)
      }
      function onDrop(event) {
        if (!acceptsTradeLoomFile(event)) return
        event.preventDefault()
        setDraggingFile(false)
        const selection = parseFileDropPayload(event.dataTransfer)
        if (!selection) {
          setFileDropStatus({ ok: false, text: '文件引用无效，未添加附件。' })
          return
        }
        setFileDropStatus({ ok: true, pending: true, text: '正在读取文件…' })
        const requested = requestFileExport?.(selection.kind, selection.id, result => {
          if (!result?.ok || !(result.file instanceof File)) {
            setFileDropStatus({ ok: false, text: result?.error || '文件读取失败，未添加附件。' })
            return
          }
          try {
            const added = onAddFiles?.([result.file])
            setFileDropStatus(added
              ? { ok: true, text: `已将“${result.file.name}”加入附件草稿；尚未发送。` }
              : { ok: false, text: '当前会话不可用或输入正忙，文件未加入草稿。' })
          } catch (error) {
            setFileDropStatus({ ok: false, text: error instanceof Error ? error.message : '文件未能加入草稿。' })
          }
        })
        if (!requested) setFileDropStatus({ ok: false, text: '当前场景没有可读取此文件的文件面板。' })
      }
      return h('div', { ref: rootRef, className: 'tl-native-conversation', onDragEnter, onDragOver, onDragLeave, onDrop },
        nativeHeaderFactoryAvailable ? renderFactorySlot('conversation.header.frame', {})
          : null,
        renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }),
        draggingFile ? h('div', { className: 'tl-chat-file-drop-overlay', role: 'status', 'aria-live': 'polite' },
          h('span', null, '拖放文件以添加到会话草稿')) : null,
        fileDropStatus ? h('div', { className: `tl-chat-file-drop-status${fileDropStatus.ok ? ' is-success' : ' is-error'}`,
          role: fileDropStatus.ok ? 'status' : 'alert', 'aria-live': 'polite' },
        h('span', null, fileDropStatus.text), h('button', { type: 'button', 'aria-label': '关闭文件导入提示', onClick: () => setFileDropStatus(null) }, actionIcon(closeActionPath))) : null)
    }

    function retainRoleSession(sessions, roleId, sessionId) {
      if (typeof roleId !== 'string' || !roleId || typeof sessionId !== 'string' || !sessionId) return undefined
      const retained = retainedByRole.get(roleId)
      if (retained?.sessionId === sessionId) return retained.reference
      for (const reference of retained?.references ?? (retained?.reference ? [retained.reference] : [])) reference.release()
      const reference = sessions.retain(sessionId, { source: ROLE_WIDGET_RETAIN_SOURCE })
      retainedByRole.set(roleId, { sessionId, reference, references: new Set([reference]), failed: false })
      return reference
    }

    function retainRoleSessionForPanel(sessions, roleId, sessionId, retryFailed = false) {
      const retained = retainedByRole.get(roleId)
      if (retryFailed && retained?.sessionId === sessionId && retained.failed) {
        const reference = sessions.retain(sessionId, { source: ROLE_WIDGET_RETAIN_SOURCE })
        retained.reference = reference
        retained.references ??= new Set([reference])
        retained.references.add(reference)
        retained.failed = false
        return reference
      }
      return retainRoleSession(sessions, roleId, sessionId)
    }

    function retainListedRoleSession(sessions, roleId, sessionId, { onReady, onUnavailable, refresh = false } = {}) {
      let live = true
      let acquired = false
      let acquiring = false
      let missingReported = false
      let refreshRequested = false
      const list = sessions?.list
      const requestCatalogRefresh = () => {
        if (refreshRequested || typeof sessions?.refresh !== 'function') return
        refreshRequested = true
        void Promise.resolve(sessions.refresh()).catch(() => {
          if (live) onUnavailable?.('原生会话列表刷新失败，请重试。')
        })
      }
      const attempt = () => {
        if (!live || acquired || acquiring) return
        const catalog = list?.getSnapshot?.()
        if (catalog) {
          if (catalog.phase !== 'ready') {
            if (catalog.phase === 'pending') requestCatalogRefresh()
            return
          }
          if (!Array.isArray(catalog.ids) || !catalog.ids.includes(sessionId)) {
            if (!missingReported) {
              missingReported = true
              onUnavailable?.('此已绑定会话未出现在原生会话列表中。刷新后可重试；不会创建新会话。')
            }
            return
          }
          missingReported = false
        }
        acquiring = true
        try {
          const reference = retainRoleSessionForPanel(sessions, roleId, sessionId, refresh)
          if (!reference) throw new Error('session-reference-unavailable')
          acquired = true
          void reference.ready.then(() => {
            if (live) onReady?.(reference)
          }).catch(() => {
            if (live) {
              const retained = retainedByRole.get(roleId)
              if (retained?.sessionId === sessionId && retained.reference === reference) retained.failed = true
              onUnavailable?.('此会话暂时无法连接，请刷新后重试。')
            }
          })
        } catch {
          onUnavailable?.('此会话暂时无法连接，请刷新后重试。')
        } finally {
          acquiring = false
        }
      }
      const unsubscribe = list?.subscribe?.(attempt)
      attempt()
      if (refresh) requestCatalogRefresh()
      return () => {
        live = false
        unsubscribe?.()
      }
    }

    function releaseRoleSessions() {
      for (const { reference, references } of retainedByRole.values()) {
        const allReferences = references ?? (reference ? [reference] : [])
        for (const retainedReference of allReferences) retainedReference.release()
      }
      retainedByRole.clear()
    }

    function swapDockPanel(api, sourcePanel, targetPanel) {
      const sourceGroup = sourcePanel?.api?.group
      const targetGroup = targetPanel?.api?.group
      if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroup.id) return false
      const sourceIndex = sourceGroup.panels.findIndex(panel => panel.id === sourcePanel.id)
      const targetIndex = targetGroup.panels.findIndex(panel => panel.id === targetPanel.id)
      if (sourceIndex < 0 || targetIndex < 0) return false
      try {
        // The source group may become empty after the first move. Keep the same
        // group object alive until the displaced target panel has moved back.
        api.updateOptions({ closeEmptyGroups: false })
        sourcePanel.api.moveTo({ group: targetGroup, index: targetIndex, skipSetActive: true })
        targetPanel.api.moveTo({ group: sourceGroup, index: sourceIndex, skipSetActive: true })
        targetPanel.api.setActive()
        sourcePanel.api.setActive()
        return true
      } finally {
        api.updateOptions({ closeEmptyGroups: true })
      }
    }

    function dockDropIntent(kind, position) {
      if (kind === 'tab' || kind === 'header_space') return { id: 'merge', label: '合并标签' }
      if (kind !== 'content') return null
      return position === 'center'
        ? { id: 'swap', label: '交换面板' }
        : { id: 'split', label: '分栏' }
    }

    const dockRenderContexts = new Map()
    const dockGroupRenderers = new Map()
    const dockActionListeners = new Map()

    function createLocalPanelExpansionController({ sceneId, getApi, getHost, isSceneActive, isNarrow, onChange }) {
      let entry = null
      let sequence = 0
      const motionDuration = 200
      const rect = element => element?.getBoundingClientRect?.()
      const asRect = value => value && ({ left: value.left, top: value.top, width: value.width, height: value.height })
      const connected = element => Boolean(element?.isConnected)
      function panelNodes(panelId) {
        const api = getApi()
        const panel = api?.getPanel?.(panelId)
        const group = panel?.api?.group?.element
        const header = group?.querySelector?.(':scope > .dv-tabs-and-actions-container')
        const content = group?.querySelector?.(':scope > .dv-content-container')
        const host = getHost()
        const overlay = [...(host?.ownerDocument?.querySelectorAll?.('.dv-render-overlay') ?? [])].find(candidate => {
          const node = candidate.querySelector?.('.tl-dock-panel[data-scene-id][data-panel-id]')
          return node?.getAttribute('data-scene-id') === sceneId && node?.getAttribute('data-panel-id') === panelId
        })
        return { api, panel, group, header, content, overlay, host }
      }
      function validTarget(panelId, nodes = panelNodes(panelId)) {
        const { api, panel, group, header, content, overlay, host } = nodes
        if (!isSceneActive() || isNarrow() || !api || !panel || !group?.isConnected || !header?.isConnected
          || !content?.isConnected || !overlay?.isConnected || !host?.isConnected || panel.api?.group?.activePanel?.id !== panelId
          || (entry?.panelId === panelId && entry.group !== group)
          || api.hasMaximizedGroup?.() || panel.api?.location?.type !== 'grid') return false
        const viewport = rect(host), bounds = rect(group), headerBounds = rect(header), contentBounds = rect(content), overlayBounds = rect(overlay)
        return Boolean(viewport?.width > 0 && viewport?.height > 0 && bounds?.width > 0 && bounds?.height > 0
          && headerBounds?.width > 0 && headerBounds?.height > 0 && contentBounds?.width > 0 && contentBounds?.height > 0
          && overlayBounds?.width > 0 && overlayBounds?.height > 0)
      }
      function cancelMotion(current) {
        if (current.frame) current.document.defaultView?.cancelAnimationFrame?.(current.frame)
        if (current.timer) clearTimeout(current.timer)
        for (const [node, handler] of current.listeners ?? []) node.removeEventListener('transitionend', handler)
        current.listeners = []
        const resolve = current.resolveMotion
        current.resolveMotion = null
        resolve?.()
        current.frame = 0
        current.timer = 0
        current.motionInFlight = false
      }
      function setMotion(current, enabled) {
        current.header.setAttribute('data-tl-local-motion', enabled ? 'on' : 'off')
        current.overlay.setAttribute('data-tl-local-motion', enabled ? 'on' : 'off')
      }
      function setRules(current, headerRect, overlayRect) {
        const h = headerRect, o = overlayRect
        current.style.textContent = `
          [data-tl-local-expansion="${current.headerMarker}"]{position:fixed!important;left:${h.left}px!important;top:${h.top}px!important;width:${h.width}px!important;height:${h.height}px!important;z-index:101!important;box-sizing:border-box;border:1px solid var(--tl-floating-accent, #74cec6);border-bottom:0;border-radius:var(--tl-corner-radius,6px) var(--tl-corner-radius,6px) 0 0;box-shadow:0 -4px 16px color-mix(in srgb,var(--tl-floating-accent, #74cec6) 22%,transparent);}
          [data-tl-local-expansion="${current.overlayMarker}"]{position:fixed!important;left:${o.left}px!important;top:${o.top}px!important;width:${o.width}px!important;height:${o.height}px!important;z-index:100!important;box-sizing:border-box;border:1px solid var(--tl-floating-accent, #74cec6);border-top:0;border-radius:0 0 var(--tl-corner-radius,6px) var(--tl-corner-radius,6px);box-shadow:0 7px 22px color-mix(in srgb,var(--tl-floating-accent, #74cec6) 22%,transparent);}
          [data-tl-local-motion="on"]{transition:top ${motionDuration}ms cubic-bezier(.2,.75,.25,1),height ${motionDuration}ms cubic-bezier(.2,.75,.25,1);}
          [data-tl-local-motion="off"]{transition:none!important;}
        `
      }
      function setPlaceholder(current, height) {
        const size = `${Math.max(0, height)}px`
        current.placeholder.style.boxSizing = 'border-box'
        current.placeholder.style.display = 'block'
        current.placeholder.style.width = '100%'
        current.placeholder.style.height = size
        current.placeholder.style.minHeight = size
        current.placeholder.style.flex = `0 0 ${size}`
        current.placeholder.style.visibility = 'hidden'
        current.placeholder.style.pointerEvents = 'none'
        current.placeholder.setAttribute('aria-hidden', 'true')
      }
      function measureNatural(current) {
        setMotion(current, false)
        current.style.textContent = ''
        current.placeholder.remove()
        void current.group.offsetWidth
        const header = asRect(rect(current.header))
        const group = asRect(rect(current.group))
        const content = asRect(rect(current.content))
        current.group.insertBefore(current.placeholder, current.header)
        setPlaceholder(current, header?.height ?? current.headerHeight)
        void current.group.offsetWidth
        return { header, group, content, viewport: asRect(rect(current.host)) }
      }
      function expandedRects(current, natural) {
        const viewport = natural.viewport
        const down = natural.group.top + natural.group.height / 2 <= viewport.top + viewport.height / 2
        const height = natural.header.height
        const header = { left:natural.header.left, top:viewport.top,
          width:natural.header.width, height }
        const overlay = { left:natural.content.left, top:header.top + height,
          width:natural.content.width, height:Math.max(0, viewport.top + viewport.height - (header.top + height)) }
        return { header, overlay, direction:down ? 'down' : 'up' }
      }
      function transitionTo(current, from, to, token) {
        cancelMotion(current)
        setMotion(current, false)
        setRules(current, from.header, from.overlay)
        void current.header.offsetWidth
        if (!current.motionEnabled()) {
          setRules(current, to.header, to.overlay)
          return Promise.resolve(true)
        }
        setMotion(current, true)
        current.motionInFlight = true
        return new Promise(resolve => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            cancelMotion(current)
            resolve(entry === current && current.generation === token)
          }
          const onEnd = event => {
            if (event.target !== event.currentTarget || !['top', 'height'].includes(event.propertyName)) return
            current.ended.add(event.currentTarget)
            if (current.ended.size >= 2) finish()
          }
          current.ended = new Set()
          current.listeners = [[current.header, onEnd], [current.overlay, onEnd]]
          for (const [node, handler] of current.listeners) node.addEventListener('transitionend', handler)
          current.resolveMotion = finish
          current.timer = setTimeout(finish, motionDuration + 100)
          current.frame = current.document.defaultView.requestAnimationFrame(() => {
            current.frame = 0
            if (entry !== current || current.generation !== token) return finish()
            setRules(current, to.header, to.overlay)
            void current.header.offsetWidth
          })
        })
      }
      function finish(current, notify = true) {
        cancelMotion(current)
        current.resizeObserver?.disconnect?.()
        current.style.remove()
        current.placeholder.remove()
        const restoreAttribute = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value)
        restoreAttribute(current.header, 'data-tl-local-expansion', current.oldHeaderMarker)
        restoreAttribute(current.overlay, 'data-tl-local-expansion', current.oldOverlayMarker)
        restoreAttribute(current.header, 'data-tl-local-motion', current.oldHeaderMotion)
        restoreAttribute(current.overlay, 'data-tl-local-motion', current.oldOverlayMotion)
        if (entry === current) entry = null
        current.restoring = false
        if (notify) onChange?.('')
      }
      function restore({ animate = false } = {}) {
        const current = entry
        if (!current) return false
        if (current.restoring) {
          if (animate) return true
          current.generation++
          cancelMotion(current)
          finish(current)
          return true
        }
        current.generation++
        cancelMotion(current)
        if (!animate || !connected(current.group) || !connected(current.header) || !connected(current.overlay)) {
          finish(current)
          return true
        }
        current.restoring = true
        const from = { header:asRect(rect(current.header)), overlay:asRect(rect(current.overlay)) }
        const natural = measureNatural(current)
        const to = { header:natural.header, overlay:natural.content }
        const token = current.generation
        void transitionTo(current, from, to, token).then(live => { if (live && entry === current) finish(current) })
        return true
      }
      function syncGeometry() {
        const current = entry
        if (!current || current.restoring) return false
        const motionWasInFlight = current.motionInFlight
        if (!validTarget(current.panelId)) { restore(); return false }
        const from = { header:asRect(rect(current.header)), overlay:asRect(rect(current.overlay)) }
        const natural = measureNatural(current)
        const to = expandedRects(current, natural)
        current.direction = to.direction
        current.headerHeight = natural.header.height
        const key = JSON.stringify({ header:natural.header, group:natural.group, content:natural.content, viewport:natural.viewport, direction:to.direction })
        if (key === current.lastGeometryKey) {
          if (motionWasInFlight) {
            const token = ++current.generation
            void transitionTo(current, from, to, token)
            return true
          }
          setRules(current, to.header, to.overlay)
          void current.header.offsetWidth
          setMotion(current, current.motionEnabled())
          return false
        }
        current.lastGeometryKey = key
        const token = ++current.generation
        void transitionTo(current, from, to, token)
        return true
      }
      function expand(panelId) {
        if (entry?.panelId === panelId) return false
        if (entry) restore()
        const nodes = panelNodes(panelId)
        if (!validTarget(panelId, nodes)) return false
        const { group, header, content, overlay, host } = nodes
        const headerRect = asRect(rect(header)), groupRect = asRect(rect(group)), contentRect = asRect(rect(content)), viewport = asRect(rect(host))
        const document = group.ownerDocument
        const token = `${sceneId}-${++sequence}-${++dockMotionSequence}`
        const placeholder = document.createElement('div')
        placeholder.setAttribute('data-tl-local-placeholder', token)
        const style = document.createElement('style')
        style.setAttribute('data-tl-local-style', token)
        document.head.append(style)
        const current = { sceneId, panelId, ...nodes, document, placeholder, style,
          headerMarker:`${token}-header`, overlayMarker:`${token}-overlay`,
          oldHeaderMarker:header.getAttribute('data-tl-local-expansion'), oldOverlayMarker:overlay.getAttribute('data-tl-local-expansion'),
          oldHeaderMotion:header.getAttribute('data-tl-local-motion'), oldOverlayMotion:overlay.getAttribute('data-tl-local-motion'),
          headerHeight:headerRect.height, generation:1, frame:0, timer:0, listeners:[], ended:new Set(),
          motionEnabled:() => {
            const preference = document.documentElement.dataset.tlWorkbenchMotion
            if (preference === 'on') return true
            if (preference === 'off') return false
            return !document.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          }, motionInFlight:false, restoring:false, resizeObserver:null }
        entry = current
        setPlaceholder(current, headerRect.height)
        group.insertBefore(placeholder, header)
        header.setAttribute('data-tl-local-expansion', current.headerMarker)
        overlay.setAttribute('data-tl-local-expansion', current.overlayMarker)
        const natural = { header:headerRect, group:groupRect, content:contentRect, viewport }
        const target = expandedRects(current, natural)
        current.direction = target.direction
        current.lastGeometryKey = JSON.stringify({ header:headerRect, group:groupRect, content:contentRect, viewport, direction:target.direction })
        const tokenGeneration = current.generation
        void transitionTo(current, { header:headerRect, overlay:contentRect }, target, tokenGeneration)
        const ResizeObserverClass = document.defaultView.ResizeObserver
        if (ResizeObserverClass) {
          current.resizeObserver = new ResizeObserverClass(() => { if (entry === current) syncGeometry() })
          for (const node of [host, group, content]) current.resizeObserver.observe(node)
        }
        onChange?.(panelId)
        return true
      }
      function handleActivePanelChange(selectedPanelId) {
        const current = entry
        if (!current) return false
        const api = getApi()
        const panel = api?.getPanel?.(current.panelId)
        const group = panel?.api?.group
        if (!panel || panel.api?.location?.type !== 'grid' || group?.element !== current.group) {
          restore()
          return true
        }
        const selectedGroup = api?.getPanel?.(selectedPanelId)?.api?.group
        if (selectedGroup?.element === current.group && group.activePanel?.id !== current.panelId) {
          restore()
          return true
        }
        return false
      }
      function handleLayoutChange() {
        const current = entry
        if (!current) return false
        const panel = getApi()?.getPanel?.(current.panelId)
        if (!panel || panel.api?.location?.type !== 'grid' || panel.api?.group?.element !== current.group
          || panel.api?.group?.activePanel?.id !== current.panelId) {
          restore()
          return true
        }
        return syncGeometry()
      }
      return {
        expand, restore, syncGeometry, handleActivePanelChange, handleLayoutChange,
        toggle(panelId) { if (entry?.panelId === panelId) return restore({ animate:true }); return expand(panelId) },
        isExpanded(panelId) { return Boolean(entry && (!panelId || entry.panelId === panelId)) },
        get activePanelId() { return entry?.panelId ?? '' },
        dispose() { if (entry) finish(entry, false) },
      }
    }

    function subscribeDockActions(sceneId, listener) {
      let listenersForScene = dockActionListeners.get(sceneId)
      if (!listenersForScene) dockActionListeners.set(sceneId, listenersForScene = new Set())
      listenersForScene.add(listener)
      return () => {
        listenersForScene.delete(listener)
        if (!listenersForScene.size) dockActionListeners.delete(sceneId)
      }
    }

    function notifyDockActions(sceneId) {
      for (const listener of dockActionListeners.get(sceneId) ?? []) listener()
    }

    const closeActionPath = 'M6 6l12 12M18 6L6 18'
    function actionIcon(path) {
      return h('svg', {
        viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: path }))
    }

    function DockGroupActions({ sceneId, ...groupProps }) {
      const state = useSnapshot()
      const [, setRevision] = React.useState(0)
      React.useEffect(() => subscribeDockActions(sceneId, () => setRevision(value => value + 1)), [sceneId])
      const context = dockRenderContexts.get(sceneId) ?? {}
      const panelId = groupProps.activePanel?.id
      const panel = context.panels?.find(item => item.id === panelId)
      if (!panel) return null
      const chatRoleId = panel.type === 'native-chat' ? roleForPanel(state.config, sceneId, panel.id) : undefined
      const boundSession = chatRoleId ? state.sessionBindings?.[chatRoleId] : undefined
      const label = chatRoleId ? assistantLabel(chatRoleId) : panel.title
      const floatingPanel = context.isPanelFloating?.(panel.id)
      const canFloat = ['native-chat', 'native-workspace', 'business-iframe'].includes(panel.type)
      const runWithoutActivatingGroup = action => event => {
        event?.stopPropagation?.()
        action?.()
      }
      const stopGroupActivation = event => event?.stopPropagation?.()
      const openPanelCount = (() => {
        const dockApi = dockviewApis.get(sceneId)
        const panelsRecord = dockApi?.toJSON?.()?.panels
        if (panelsRecord && typeof panelsRecord === 'object') return Object.keys(panelsRecord).length
        return context.panels?.length ?? 0
      })()
      const actions = [
        h('button', { type: 'button', 'data-pane-action':'refresh', title: `刷新${label}`, 'aria-label': `刷新${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.refresh?.(panel.id)) }, actionIcon('M20 11a8 8 0 1 0-2 6M20 4v7h-7'), '刷新'),
        !context.narrow && !floatingPanel ? h('button', {
          type: 'button', 'data-pane-action':'maximize', title: context.isPanelMaximized?.(panel.id) ? `还原${label}` : `展开${label}`,
          'aria-label': context.isPanelMaximized?.(panel.id) ? `还原${label}` : `展开${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.toggleMaximize?.(panel.id)),
        }, actionIcon(context.isPanelMaximized?.(panel.id) ? 'M4 10h6V4M14 4v6h6M20 14h-6v6M10 20v-6H4' : 'M4 10V4h6M14 4h6v6M20 14v6h-6M10 20H4v-6'), context.isPanelMaximized?.(panel.id) ? '还原' : '展开') : null,
        !context.narrow ? h('button', {
          type:'button', 'data-pane-action':'local-expand', title:context.isPanelLocallyExpanded?.(panel.id) ? `收起局部展开${label}` : `局部展开${label}`,
          'aria-label':context.isPanelLocallyExpanded?.(panel.id) ? `收起局部展开${label}` : `局部展开${label}`,
          'aria-pressed':Boolean(context.isPanelLocallyExpanded?.(panel.id)),
          disabled:Boolean(floatingPanel || context.isPanelMaximized?.(panel.id) || context.hasMaximizedGroup?.()),
          onPointerDown:stopGroupActivation, onMouseDown:stopGroupActivation,
          onClick:runWithoutActivatingGroup(() => context.toggleLocalExpansion?.(panel.id)),
        }, actionIcon(context.isPanelLocallyExpanded?.(panel.id)
          ? 'M4 14h6v6M20 10h-6V4M4 14l6-6M20 10l-6 6'
          : 'M4 10h6V4M20 14h-6v6M4 10l6 6M20 14l-6-6'), context.isPanelLocallyExpanded?.(panel.id) ? '收起局部展开' : '局部展开') : null,
        canFloat ? h('button', { type: 'button', 'data-pane-action':'float', title: floatingPanel ? `收回${label}` : `悬浮${label}`,
          'aria-label': floatingPanel ? `收回${label}` : `悬浮${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.toggleFloat?.(panel.id)) }, actionIcon('M4 4h16v16H4zM4 10h16M10 10v10'), floatingPanel ? '收回' : '悬浮') : null,
        canFloat && !floatingPanel ? h('button', { type: 'button', 'data-pane-action':'popout', title:`独立窗口${label}`,
          'aria-label':`独立窗口${label}`, onPointerDown:stopGroupActivation, onMouseDown:stopGroupActivation,
          onClick:runWithoutActivatingGroup(() => context.togglePopout?.(panel.id)) }, h('span', { className:'tl-dock-popout-arrow', 'aria-hidden':'true' }, '↗'), '独立窗口') : null,
        typeof context.closePanel === 'function' ? h('button', { type:'button', 'data-pane-action':'capabilities',
          title:'助手能力与已保存配置', 'aria-label':'助手能力与已保存配置',
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => {
            const view = panel?.ownerDocument?.defaultView ?? window
            view.dispatchEvent(new view.CustomEvent('tradeloom:open-agent-capabilities', { detail: { roleId: chatRoleId ?? '' } }))
          }) }, actionIcon('M12 3l2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z'), '助手能力') : null,
        openPanelCount > 1 && !floatingPanel ? h('button', { type:'button', 'data-pane-action':'close',
          title:`关闭${label}`, 'aria-label':`关闭${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.closePanel?.(panel.id)) }, actionIcon(closeActionPath), '关闭面板') : null,
        ...(context.closedPanels ?? []).map(closed => h('button', { key: `restore-${closed.id}`, type:'button',
          'data-pane-action': `restore-${closed.id}`, title: `恢复${closed.title}`, 'aria-label': `恢复${closed.title}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.selectPanel?.(closed.id)) }, actionIcon('M12 5v14M5 12h14'), `恢复${closed.title}`)),
        chatRoleId ? h('button', { type:'button', 'data-pane-action':'open-native', title:'打开此助手的完整原生会话', 'aria-label':`打开${label}原生会话`,
          disabled:!boundSession || typeof uiWorkspaceApi?.openSession !== 'function',
          onPointerDown:stopGroupActivation, onMouseDown:stopGroupActivation,
          onClick:runWithoutActivatingGroup(() => uiWorkspaceApi.openSession(boundSession)) }, actionIcon('M4 4h16v13H9l-5 4V4zM8 8h8M8 12h5'), '原生会话') : null
      ]
      const overflowId = `tl-pane-actions-${sceneId}-${panelId}`
      return h('div', { className: 'tl-dock-group-actions', role: 'toolbar', 'aria-label': `${label}面板操作` },
        h('div', { className: 'tl-dock-inline-actions' }, ...actions),
        h('button', { className: 'tl-dock-overflow-trigger', type: 'button',
          'aria-label': `${label}更多面板操作`, title: '更多面板操作', popovertarget: overflowId,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: event => {
            event.stopPropagation()
            const menu = event.currentTarget.ownerDocument.getElementById(overflowId)
            const rect = event.currentTarget.getBoundingClientRect()
            const viewport = event.currentTarget.ownerDocument.defaultView
            Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: 0,
              top: `${rect.bottom + 4}px`, left: `${rect.left}px` })
            viewport.requestAnimationFrame(() => {
              if (!menu.matches(':popover-open')) return
              const bounds = menu.getBoundingClientRect()
              Object.assign(menu.style, {
                top: `${Math.max(8, Math.min(rect.bottom + 4, viewport.innerHeight - bounds.height - 8))}px`,
                left: `${Math.max(8, Math.min(rect.right - bounds.width, viewport.innerWidth - bounds.width - 8))}px`,
              })
            })
          } }, actionIcon('M5 12h1m5 0h1m5 0h1')),
        h('div', { id: overflowId, className: 'tl-dock-overflow-menu', popover: 'auto', 'aria-label': `${label}面板操作菜单`,
          onClick: event => { if (event.target.closest('button')) event.currentTarget.hidePopover() } }, ...actions),
        chatRoleId ? h(RoleBindingDetails, { state, roleId: chatRoleId }) : null)
    }

    function notifyNarrowListeners(sceneId, narrow) {
      for (const listener of narrowListeners.get(sceneId) ?? []) listener(narrow)
    }

    function NativeChatPanel({ sceneId, panelId = 'native-chat', roleId: panelRoleId, refreshKey, SessionProvider, renderSlot, renderFactorySlot, resourceOwnerId, active = true }) {
      const state = useSnapshot()
      const roleId = panelRoleId ?? roleForScene(state.config, sceneId)
      const sessionId = roleId ? state.sessionBindings[roleId] : undefined
      const [readyReference, setReadyReference] = React.useState(null)
      const [error, setError] = React.useState('')
      const [refreshError, setRefreshError] = React.useState('')
      const readyReferenceRef = React.useRef(null)
      const [, setChatLocationRevision] = React.useState(0)
      React.useEffect(() => {
        if (resourceOwnerId) return undefined
        const stops = (state.config?.scenes ?? []).map(scene => subscribeDockActions(scene.id,
          () => setChatLocationRevision(value => value + 1)))
        return () => { for (const stop of stops) stop() }
      }, [state.config, resourceOwnerId])
      const mountedReference = !error && readyReference?.id === sessionId ? readyReference : null
      React.useLayoutEffect(() => {
        readyReferenceRef.current = mountedReference
        return () => { if (readyReferenceRef.current === mountedReference) readyReferenceRef.current = null }
      }, [mountedReference])
      React.useEffect(() => {
        let live = true
        if (!roleId) return () => { live = false }
        if (!sessionId && !panelRoleId && !resourceOwnerId) {
          void ensureRoleSession(roleId).then(value => {
            if (live && !value) setError(snapshot.sessionErrors[roleId] || '连接失败，请重试。')
          })
          return () => { live = false }
        }
        if (!sessionId) return () => { live = false }
        setError('')
        setRefreshError('')
        setReadyReference(current => current?.id === sessionId ? current : null)
        const stopWaiting = retainListedRoleSession(sessionsApi, roleId, sessionId, {
          refresh: refreshKey > 0,
          onReady(reference) {
            if (live) { setError(''); setRefreshError(''); setReadyReference({ id: sessionId, reference }) }
          },
          onUnavailable(message) {
            if (live) {
              if (readyReferenceRef.current?.id === sessionId) setRefreshError(message)
              else { setError(message); setReadyReference(null) }
            }
          },
        })
        return () => {
          live = false
          stopWaiting?.()
        }
      }, [roleId, sessionId, panelRoleId, refreshKey, resourceOwnerId])
      // A Session owns one Lexical input root. Keep its retained scope alive, but
      // release a hidden chat view before another scene mounts that same input.
      // Resource surfaces have independent owner ids and stay resident.
      const popoutOwner = !resourceOwnerId && sessionId && state.config?.scenes.flatMap(scene => scene.panels
        .filter(panel => panel.type === 'native-chat'
          && dockviewApis.get(scene.id)?.getPanel?.(panel.id)?.api?.location?.type === 'popout'
          && state.sessionBindings[roleForPanel(state.config, scene.id, panel.id)] === sessionId)
        .map(panel => ({ sceneId: scene.id, panelId: panel.id })))[0]
      const ownsPopout = popoutOwner?.sceneId === sceneId && popoutOwner?.panelId === panelId
      if (popoutOwner && !ownsPopout) return active
        ? h(PaneState, { title: '会话已在独立窗口打开', description: '收回独立窗口后，可在这里继续编辑同一会话。' }) : null
      const activeScene = state.config?.scenes.find(item => item.id === state.activeSceneId)
      const sharesActiveChat = sessionId && activeScene?.panels.some(panel => panel.type === 'native-chat'
        && (!panel.optional || dockviewApis.get(activeScene.id)?.getPanel?.(panel.id))
        && state.sessionBindings[roleForPanel(state.config, activeScene.id, panel.id)] === sessionId)
      if (!resourceOwnerId && !ownsPopout && !active && sharesActiveChat) return null
      if (!error && sessionId && readyReference?.id === sessionId) {
        const context = dockRenderContexts.get(sceneId) ?? {}
        return h(SessionProvider, { session: readyReference.reference }, h(React.Fragment, { key: sessionId },
          resourceOwnerId ? (typeof renderFactorySlot === 'function'
            ? renderFactorySlot('sidebar.surface', { ownerId: resourceOwnerId, active, initialKind: 'files' }, { fallback: h(PaneState, { title: '原生资源组件尚未就绪', description: '当前运行时尚未提供项目文件组件，请更新工作站后重试。' }) })
            : h(PaneState, { title: '原生资源组件尚未就绪', description: '当前运行时尚未提供项目文件组件，请更新工作站后重试。' }))
            : renderSlot('scene.workbench.chat', { requestFileExport: context.requestFileExport }),
          refreshError ? h('p', { role: 'alert', className: 'tl-native-refresh-error' }, refreshError) : null))
      }
      const busy = !error && (Boolean(sessionId) || (!panelRoleId && !resourceOwnerId))
      const title = error ? '连接失败' : sessionId ? '正在连接助手…' : panelRoleId || resourceOwnerId ? '尚无已连接会话' : '正在准备助手…'
      const description = error || (sessionId ? '正在连接已绑定的原生会话。'
        : panelRoleId || resourceOwnerId ? '该助手尚无已连接会话。' : '正在准备助手…')
      const retry = error && !panelRoleId && !resourceOwnerId
        ? { label: '重试连接', onClick: () => { setError(''); void ensureRoleSession(roleId) } }
        : undefined
      return h(PaneState, { title, description, role: error ? 'alert' : 'status', tone: error ? 'error' : 'neutral',
        busy, action: retry })
    }

    /** Reuse the native role reference without creating a new conversation for a file pane. */
    function NativeWorkspacePanel({ sceneId, panelId, roleId, refreshKey, SessionProvider, renderFactorySlot, active }) {
      return h(NativeChatPanel, { sceneId, roleId, refreshKey, SessionProvider, renderFactorySlot, active,
        resourceOwnerId: `${sceneId}:${panelId}` })
    }

    /** Copy only the native slot's verified path, using the document that owns the clicked control. */
    function NativePathCopyAction({ absolutePath }) {
      const [feedback, setFeedback] = React.useState('')
      const currentPath = React.useRef(absolutePath)
      currentPath.current = absolutePath
      React.useEffect(() => { setFeedback('') }, [absolutePath])
      React.useEffect(() => {
        if (!['copied', 'failed'].includes(feedback)) return
        const timer = setTimeout(() => setFeedback(''), 2000)
        return () => clearTimeout(timer)
      }, [feedback])
      if (typeof absolutePath !== 'string' || !absolutePath) return null
      const message = feedback === 'copied' ? '完整路径已复制' : feedback === 'failed' ? '复制失败，请重试' : ''
      const copy = async event => {
        event.stopPropagation()
        const path = absolutePath
        const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator?.clipboard
        setFeedback('pending')
        try {
          if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard-unavailable')
          await clipboard.writeText(path)
          if (currentPath.current === path) setFeedback('copied')
        } catch {
          if (currentPath.current === path) setFeedback('failed')
        }
      }
      return h('span', { className:'tl-native-path-copy-wrap' },
        h('button', { type:'button', className:'tl-native-path-copy', 'data-tl-copy-path':'',
          'aria-label':'复制完整路径', title:message || absolutePath, disabled:feedback === 'pending',
          onPointerDown:event => event.stopPropagation(), onClick:copy },
          h('svg', { viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:1.5, 'aria-hidden':'true' },
            h('path', { d:feedback === 'copied' ? 'M5 12l4 4L19 6' : 'M9 9h11v11H9zM15 5V3H3v12h2' }))),
        h('span', { className:'tl-native-path-copy-status', role:'status', 'aria-live':'polite' }, message))
    }

    function SceneDockPanel(props) {
      const sceneId = props.sceneId
      const state = useSnapshot()
      const scene = state.config?.scenes.find(item => item.id === sceneId)
      const panelId = props.params?.panelId ?? props.api?.id ?? props.id
      const panel = scene?.panels.find(item => item.id === panelId)
      const context = dockRenderContexts.get(sceneId) ?? {}
      const [narrow, setNarrow] = React.useState(() => Boolean(context.narrow))
      const refreshKey = state.panelRefreshKeys?.[sceneId]?.[panelId] ?? 0
      const roleId = roleForPanel(state.config, sceneId, panelId) ?? roleForScene(state.config, sceneId)
      const selection = fileSelectionByScene.get(sceneId)
      const selectionGeneration = state.fileSelectionGenerations?.[sceneId] ?? 0
      const activeScene = state.activeSceneId === sceneId
      React.useEffect(() => {
        const update = value => setNarrow(Boolean(value))
        let listeners = narrowListeners.get(sceneId)
        if (!listeners) narrowListeners.set(sceneId, listeners = new Set())
        listeners.add(update)
        update(Boolean(dockRenderContexts.get(sceneId)?.narrow))
        return () => {
          listeners.delete(update)
          if (listeners.size === 0) narrowListeners.delete(sceneId)
        }
      }, [sceneId])
      if (!panel) return null
      let content = null
      if (panel.type === 'business-iframe') {
        const path = panel.id === 'business-main' ? state.businessPathsByScene?.[sceneId] ?? panel.path : panel.path
        const standardWorkflow = isStandardWorkflowScene(state.config, scene)
        const proposalPanelId = standardWorkflow ? 'business-plan' : 'business-main'
        const proposalHref = path === '/agent-center' && panel.id === proposalPanelId ? state.proposalHrefsByScene?.[sceneId] ?? '' : ''
        if (panel.id === 'preview' && selection?.kind === 'artifact' && selection.previewMime === 'text/markdown') {
          content = h(ArtifactMarkdownPreview, { key: `${sceneId}:${selectionGeneration}:${selection.id}`,
            sceneId, selection, generation: selectionGeneration, activeScene,
            requestFileExport: context.requestFileExport,
            requestFileFocus: context.requestFileFocus,
            openFilesPanel: context.openFilesPanel,
            closePanel: () => context.closePanel?.(panel.id) })
        } else if (standardWorkflow && panel.id === 'business-main' && path === '/agent-center') {
          content = h(WorkflowCanvasPane, { refreshRequest: refreshKey })
        } else content = Array.isArray(panel.frontendTabs) && panel.frontendTabs.some(tab => tab.view === 'workflow-canvas')
          ? h(BusinessPaneTabs, { panel, path, proposalHref, refreshKey, sceneId, viewIntent: state.businessViewIntentsByScene?.[sceneId] })
          : h(BusinessFrame, { panel, path, proposalHref, refreshKey })
      } else if (panel.type === 'placeholder') content = h(Placeholder, { panel })
      else if (panel.type === 'erpnext-status') content = h(ERPNextStatus, { refreshKey })
      else if (panel.type === 'native-workspace') content = h(NativeWorkspacePanel, {
        sceneId, panelId: panel.id, roleId, refreshKey, SessionProvider: context.SessionProvider,
        renderFactorySlot: context.renderFactorySlot, active: activeScene,
      })
      else if (panel.type === 'native-chat') content = h(NativeChatPanel, {
        sceneId, panelId: panel.id, roleId: panel.roleId, refreshKey, SessionProvider: context.SessionProvider, renderSlot: context.renderSlot,
        active: activeScene,
      })
      return h('div', { className: 'tl-dock-panel', 'data-scene-id': sceneId, 'data-panel-id': panel.id, 'data-panel-type': panel.type },
        h('div', { className: `tl-dock-panel-body${panel.type === 'native-chat' ? ' is-native-chat' : ''}` }, content))
    }

    function stableDockComponents(sceneId) {
      if (!dockviewRenderers.has(sceneId)) {
        const types = ['business-iframe', 'placeholder', 'native-chat', 'native-workspace', 'erpnext-status']
        dockviewRenderers.set(sceneId, Object.fromEntries(types.map(type => [type, props => h(SceneDockPanel, { ...props, sceneId })])))
      }
      return dockviewRenderers.get(sceneId)
    }

    function stableDockGroupActions(sceneId) {
      if (!dockGroupRenderers.has(sceneId)) dockGroupRenderers.set(sceneId, props => h(DockGroupActions, { ...props, sceneId }))
      return dockGroupRenderers.get(sceneId)
    }

    function SceneDock({ scene, active, SessionProvider, renderSlot, renderFactorySlot, dockviewModule }) {
      const state = useSnapshot()
      const hostRef = React.useRef(null)
      const apiRef = React.useRef(null)
      const localPanelExpansionRef = React.useRef(null)
      const localExpansionGuardRef = React.useRef({ active, narrow: false, maximized: false })
      const fileBridgeRef = React.useRef(null)
      const popoutListenersRef = React.useRef(new Map())
      const popoutAddEventRef = React.useRef(null)
      const popoutRemoveEventRef = React.useRef(null)
      const popoutWillCloseEventRef = React.useRef(null)
      const activeRef = React.useRef(active)
      activeRef.current = active
      const restoredRef = React.useRef(false)
      const narrowRef = React.useRef(false)
      const layoutEventRef = React.useRef(null)
      const sashKeyboardCleanupRef = React.useRef(null)
      const sashKeyboardRefreshRef = React.useRef(null)
      const activePanelEventRef = React.useRef(null)
      const maximizeEventRef = React.useRef(null)
      const dropEventRef = React.useRef(null)
      const dropEndEventRef = React.useRef(null)
      const overlayEventRef = React.useRef(null)
      const dragStartEventRef = React.useRef(null)
      const groupDragStartEventRef = React.useRef(null)
      const headerDoubleClickRef = React.useRef(null)
      const maximizeAnimationRef = React.useRef(null)
      const maximizeStartFrameRef = React.useRef(0)
      const dropGeometryStartRef = React.useRef(null)
      const dropIntentRef = React.useRef(null)
      const dropIntentCleanupTimerRef = React.useRef(0)
      const dropIntentObserverRef = React.useRef(null)
      const maximizeRestoreLayoutRef = React.useRef(null)
      const lastWideLayoutRef = React.useRef(null)
      const savingPresetRef = React.useRef(false)
      const layoutTransitionRef = React.useRef(false)
      const initialGeometryPendingRef = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      const [height, setHeight] = React.useState(0)
      const [activePanelId, setActivePanelId] = React.useState('')
      const [maximized, setMaximized] = React.useState(false)
      const [, setLocallyExpandedPanelId] = React.useState('')
      const [closedPanelIds, setClosedPanelIds] = React.useState([])
      const [error, setError] = React.useState('')
      const roleId = roleForScene(state.config, scene.id)
      if (!fileBridgeRef.current || fileBridgeRef.current.sceneId !== scene.id) {
        fileBridgeRef.current = {
          sceneId: scene.id,
          handler: createFileSelectionMessageHandler(scene, () => [
            ...(hostRef.current?.querySelectorAll?.('iframe[data-tradeloom-business-frame]') ?? []),
            ...registeredPopoutBusinessFrames(scene.id),
          ], window.location.origin, () => snapshot.businessPathsByScene?.[scene.id] ?? ''),
        }
      }
      const record = state.dockLayouts?.scenes?.[scene.id]
      const api = apiRef.current
      const minimumCanvasWidth = scene.layoutProfile?.minimumWidth ?? 1143
      const minimumCanvasHeight = scene.layoutProfile?.minimumHeight ?? 250
      const narrow = width > 0 && height > 0 && (width < minimumCanvasWidth || height < minimumCanvasHeight)
      localExpansionGuardRef.current = { active, narrow, maximized }
      if (!localPanelExpansionRef.current) localPanelExpansionRef.current = createLocalPanelExpansionController({
        sceneId: scene.id,
        getApi: () => apiRef.current,
        getHost: () => hostRef.current,
        isSceneActive: () => localExpansionGuardRef.current.active,
        isNarrow: () => localExpansionGuardRef.current.narrow,
        onChange: panelId => { setLocallyExpandedPanelId(panelId); notifyDockActions(scene.id) },
      })
      function activeViewport() {
        if (!activeRef.current) return null
        const viewport = hostRef.current?.getBoundingClientRect()
        return viewport?.width > 0 && viewport?.height > 0 ? viewport : null
      }
      function activeWideViewport() {
        const viewport = activeViewport()
        return viewport && viewport.width >= minimumCanvasWidth && viewport.height >= minimumCanvasHeight ? viewport : null
      }
      function dockviewVisualParts(element) {
        if (!element?.querySelectorAll || !element.ownerDocument) return element ? [element] : []
        const ids = new Set([...element.querySelectorAll('.dv-tab[aria-selected="true"][data-tab-panel-id]')]
          .map(tab => tab.getAttribute('data-tab-panel-id')))
        const overlays = [...element.ownerDocument.querySelectorAll('.dv-render-overlay')].filter(overlay => {
          const content = overlay.querySelector('.tl-dock-panel[data-panel-id]')
          return content?.getAttribute('data-scene-id') === scene.id && ids.has(content?.getAttribute('data-panel-id')) && overlay.getBoundingClientRect().width > 0
        })
        return [element, ...overlays]
      }
      function measureDockviewGroup(element) {
        if (!element?.getBoundingClientRect) return null
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          parts: dockviewVisualParts(element).map(part => ({ element: part, rect: part.getBoundingClientRect() })) }
      }
      function clearMaximizeAnimation() {
        if (maximizeStartFrameRef.current) cancelAnimationFrame(maximizeStartFrameRef.current)
        maximizeStartFrameRef.current = 0
        const running = maximizeAnimationRef.current
        if (!running) return
        if (running.frame) cancelAnimationFrame(running.frame)
        if (running.finishFrame) cancelAnimationFrame(running.finishFrame)
        if (running.timeout) clearTimeout(running.timeout)
        running.element.removeEventListener('transitionend', running.onTransitionEnd)
        for (const part of running.parts ?? [running]) {
          part.element.style.transition = 'none'
          part.element.style.transform = part.previousTransform
          part.element.style.transformOrigin = part.previousTransformOrigin
          void part.element.offsetWidth
          part.element.style.transition = part.previousTransition
        }
        for (const part of running.parts ?? []) {
          if (!part.geometryMarker) continue
          // The renderer may have queued coordinates measured while the group
          // was transformed. End at the real untransformed reference rectangle.
          const box = running.element.querySelector('.dv-content-container')?.getBoundingClientRect()
          const parentBox = part.element.parentElement?.getBoundingClientRect()
          if (box && parentBox) Object.assign(part.element.style, { left: `${box.left - parentBox.left}px`,
            top: `${box.top - parentBox.top}px`, width: `${box.width}px`, height: `${box.height}px` })
          part.element.removeAttribute('data-tl-geometry-part')
        }
        running.geometryStyles?.remove()
        for (const view of running.clippedViews ?? []) view.element.style.overflow = view.overflow
        if (running.host) running.host.style.overflow = running.previousHostOverflow
        maximizeAnimationRef.current = null
      }
      function workbenchMotionEnabled() {
        const preference = window.document?.documentElement?.dataset?.tlWorkbenchMotion
        if (preference === 'on') return true
        if (preference === 'off') return false
        return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      }
      function settleDockviewElement(element) {
        if (!element?.isConnected || !workbenchMotionEnabled() || typeof element.animate !== 'function') return
        const animation = element.animate([{ opacity: 0.78 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
        animation.finished?.catch?.(() => {})
      }
      function animateDockviewGeometry(element, before) {
        if (!element || !before || !workbenchMotionEnabled()) return
        const host = hostRef.current
        const previousHostOverflow = host?.style.overflow ?? ''
        if (host) host.style.overflow = 'clip'
        const clippedViews = []
        for (let parent = element.parentElement; parent && parent !== host; parent = parent.parentElement) {
          if (!parent.classList.contains('dv-view')) continue
          clippedViews.push({ element: parent, overflow: parent.style.overflow })
          parent.style.overflow = 'clip'
        }
        const after = element.getBoundingClientRect()
        if (!before.width || !before.height || !after.width || !after.height) {
          for (const view of clippedViews) view.element.style.overflow = view.overflow
          if (host) host.style.overflow = previousHostOverflow
          return
        }
        if (Math.abs(before.left - after.left) < 0.5 && Math.abs(before.top - after.top) < 0.5
          && Math.abs(before.width - after.width) < 0.5 && Math.abs(before.height - after.height) < 0.5) {
          for (const view of clippedViews) view.element.style.overflow = view.overflow
          if (host) host.style.overflow = previousHostOverflow
          return
        }
        const contentTarget = element.querySelector('.dv-content-container')?.getBoundingClientRect()
        const previous = {
          transition: element.style.transition,
          transform: element.style.transform,
          transformOrigin: element.style.transformOrigin,
        }
        element.style.transition = 'none'
        element.style.transformOrigin = 'top left'
        element.style.transform = `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})`
        void element.offsetWidth
        const running = { element, previousTransition: previous.transition, previousTransform: previous.transform,
          previousTransformOrigin: previous.transformOrigin, frame: 0, finishFrame: 0, timeout: 0, onTransitionEnd: null }
        running.clippedViews = clippedViews
        running.host = host
        running.previousHostOverflow = previousHostOverflow
        running.parts = [running]
        running.geometryStyles = element.ownerDocument.createElement('style')
        element.ownerDocument.head.append(running.geometryStyles)
        for (const overlay of dockviewVisualParts(element).slice(1)) {
          const target = contentTarget ?? overlay.getBoundingClientRect()
          const marker = String(++dockMotionSequence)
          overlay.setAttribute('data-tl-geometry-part', marker)
          running.geometryStyles.textContent += `[data-tl-geometry-part="${marker}"]{position:fixed!important;left:${target.left}px!important;top:${target.top}px!important;width:${target.width}px!important;height:${target.height}px!important;}`
          const source = before.parts?.find(part => part.element === overlay)?.rect ?? {
            left: before.left + (target.left - after.left) * before.width / after.width,
            top: before.top + (target.top - after.top) * before.height / after.height,
            width: target.width * before.width / after.width, height: target.height * before.height / after.height,
          }
          running.parts.push({ element: overlay, geometryMarker: marker, previousTransition: overlay.style.transition,
            previousTransform: overlay.style.transform, previousTransformOrigin: overlay.style.transformOrigin })
          overlay.style.transition = 'none'
          overlay.style.transformOrigin = 'top left'
          overlay.style.transform = `translate(${source.left - target.left}px, ${source.top - target.top}px) scale(${source.width / target.width}, ${source.height / target.height})`
        }
        const finish = () => {
          if (maximizeAnimationRef.current !== running) return
          clearMaximizeAnimation()
        }
        running.onTransitionEnd = event => { if (event.target === element && event.propertyName === 'transform') finish() }
        maximizeAnimationRef.current = running
        element.addEventListener('transitionend', running.onTransitionEnd)
        running.frame = requestAnimationFrame(() => {
          if (maximizeAnimationRef.current !== running) return
          for (const part of running.parts) part.element.style.transition = 'transform 200ms cubic-bezier(.2,.75,.25,1)'
          running.finishFrame = requestAnimationFrame(() => {
            if (maximizeAnimationRef.current === running) {
              for (const part of running.parts) part.element.style.transform = part.previousTransform
              running.timeout = setTimeout(finish, 260)
            }
          })
        })
      }
      function rememberRestorableLayout(currentApi, preferWide = false) {
        if (!currentApi || !activeViewport() || currentApi.hasMaximizedGroup?.()) return
        maximizeRestoreLayoutRef.current = JSON.parse(JSON.stringify(preferWide && lastWideLayoutRef.current || currentApi.toJSON()))
      }
      function restoreGridGeometry(currentApi, layout) {
        const target = activeViewport()
        if (!target || !layout?.grid?.root) return
        const scaled = JSON.parse(JSON.stringify(layout))
        scaled.grid.width = Math.round(target.width)
        scaled.grid.height = Math.round(target.height)
        const scaleNode = (node, extent) => {
          node.size = extent
          if (node.type === 'leaf') return
          const children = node.data ?? []
          const total = children.reduce((sum, child) => sum + child.size, 0)
          if (!total) return
          for (const child of children) scaleNode(child, child.size / total * extent)
        }
        scaleNode(scaled.grid.root, scaled.grid.orientation === 'VERTICAL' ? scaled.grid.height : scaled.grid.width)
        currentApi.fromJSON(scaled, { reuseExistingPanels: true })
      }
      function applyInitialGeometry(currentApi, viewport) {
        const canonical = initialGeometryPendingRef.current
        if (!canonical || !currentApi || !viewport) return false
        if (!activeWideViewport()) lastWideLayoutRef.current = JSON.parse(JSON.stringify(canonical))
        layoutTransitionRef.current = true
        try {
          currentApi.layout(Math.round(viewport.width), Math.round(viewport.height), true)
          restoreGridGeometry(currentApi, canonical)
          initialGeometryPendingRef.current = null
        } finally { layoutTransitionRef.current = false }
        if (activeWideViewport() && !currentApi.hasMaximizedGroup?.()) {
          lastWideLayoutRef.current = JSON.parse(JSON.stringify(currentApi.toJSON()))
          void persistCurrentLayout()
        }
        return true
      }
      function restoreMaximizedLayout(currentApi) {
        const viewport = activeViewport()
        if (!currentApi || !viewport) return
        const layout = maximizeRestoreLayoutRef.current
        maximizeRestoreLayoutRef.current = null
        layoutTransitionRef.current = true
        try {
          currentApi.layout(Math.round(viewport.width), Math.round(viewport.height), true)
          currentApi.exitMaximizedGroup?.()
          if (layout) restoreGridGeometry(currentApi, layout)
        } finally { layoutTransitionRef.current = false }
        if (activeWideViewport() && !currentApi.hasMaximizedGroup?.()) {
          lastWideLayoutRef.current = JSON.parse(JSON.stringify(currentApi.toJSON()))
          void persistCurrentLayout()
        }
      }
      function toggleDockPanel(panel) {
        if (!panel) return
        localPanelExpansionRef.current?.restore()
        const currentApi = apiRef.current
        const before = measureDockviewGroup(panel.api.group?.element)
        clearMaximizeAnimation()
        if (panel.api.isMaximized()) restoreMaximizedLayout(currentApi)
        else {
          if (currentApi?.hasMaximizedGroup()) restoreMaximizedLayout(currentApi)
          rememberRestorableLayout(currentApi)
          panel.api.maximize()
        }
        if (before) {
          const animateRestoredGroup = remainingFrames => {
            const restoredGroupElement = currentApi.getPanel(panel.id)?.api.group?.element ?? panel.api.group?.element
            if (restoredGroupElement?.isConnected) {
              const rect = restoredGroupElement.getBoundingClientRect()
              if (rect.width > 0 && rect.height > 0) {
                maximizeStartFrameRef.current = 0
                animateDockviewGeometry(restoredGroupElement, before)
                return
              }
            }
            if (remainingFrames > 0) {
              maximizeStartFrameRef.current = requestAnimationFrame(() => animateRestoredGroup(remainingFrames - 1))
            } else maximizeStartFrameRef.current = 0
          }
          maximizeStartFrameRef.current = requestAnimationFrame(() => animateRestoredGroup(3))
        }
      }
      function toggleInAppFloatingPanel(panel) {
        const api = apiRef.current
        if (!panel || !api || narrowRef.current) return
        if (panel.api.location?.type === 'popout') { void toggleFloatingPanel(panel); return }
        if (api.getPopouts?.().length || pendingPopoutRestoreByScene.has(scene.id)) { setError('请先收回独立窗口，再调整应用内悬浮面板。'); return }
        const origins = floatingOriginsByScene.get(scene.id) ?? new Map()
        if (panel.api.location?.type === 'grid' && origins.has(panel.id)) { setError('面板已回坞，但布局校验未完成，请检查当前布局。'); return }
        if (panel.api.location?.type === 'floating') {
          const origin = origins.get(panel.id)
          if (!origin || origin.phase === 'returning') { setError('无法确认悬浮面板原位置，请检查布局。'); return }
          const groups = api.groups?.filter(group => group.api?.location?.type === 'grid') ?? []
          const group = groups.find(item => item.id === origin.groupId)
          let destination
          if (group) {
            const current = (group.panels ?? []).map(item => item.id).filter(id => id !== panel.id)
            const at = origin.views.indexOf(panel.id)
            const next = origin.views.slice(at + 1).find(id => current.includes(id))
            const previous = origin.views.slice(0, at).reverse().find(id => current.includes(id))
            const index = previous && next && current.indexOf(previous) > current.indexOf(next) ? current.indexOf(previous) + 1
              : next ? current.indexOf(next) : previous ? current.indexOf(previous) + 1 : current.length ? -1 : 0
            if (at < 0 || index < 0) { setError('原标签位置已变化，请检查布局。'); return }
            destination = { group, index, skipSetActive:true }
          } else {
            const saved = origin.anchor
            const siblings = saved?.siblings?.map(item => ({ ...item, group:groups.find(group => group.id === item.id) })).filter(item => item.group) ?? []
            const neighbor = siblings.sort((a,b) => Math.abs(a.index-saved.index) - Math.abs(b.index-saved.index))[0]
            if (neighbor && saved.flat && saved.slotWeight > 0 && saved.slotWeight < 1) {
              const dimension = saved.dimension
              const direction = dimension === 'width' ? (neighbor.index < saved.index ? 'right' : 'left') : (neighbor.index < saved.index ? 'below' : 'above')
              const groupSize = item => findSerializedLeafByGroupId(api.toJSON().grid?.root, item.group.id)?.size ?? 0
              const total = siblings.reduce((sum, item) => sum + groupSize(item), 0)
              const absentWeight = saved.siblings.filter(item => !groups.some(group => group.id === item.id)).reduce((sum, item) => sum + item.weight, 0)
              const effectiveWeight = saved.slotWeight / (1 - absentWeight)
              if (!(total > 0 && effectiveWeight > 0 && effectiveWeight < 1)) { setError('无法读取分栏尺寸，面板保持悬浮。'); return }
              origin.resize = {dimension, target:total * effectiveWeight, weight:effectiveWeight, siblings:siblings.map(item => ({group:item.group, size:groupSize(item)})), total}
              destination = { group:neighbor.group, position:direction, skipSetActive:true }
            } else if (!groups.length) destination = { group:api.addGroup(), index:0, skipSetActive:true }
            else { setError('原布局已变化，无法确定悬浮面板回收位置。'); return }
          }
          const unchangedSingle = !group && origins.size === 1 && JSON.stringify(api.toJSON().grid) === origin.openGrid
          origin.phase = 'returning'
          try {
            panel.api.moveTo(destination)
            if (api.getPanel(panel.id) !== panel || panel.api.location?.type !== 'grid') throw new Error('return incomplete')
            if (unchangedSingle) restoreGridGeometry(api, origin.layout)
            else if (!group && origin.resize) {
              const {dimension,weight,siblings,total} = origin.resize
              const groups = [panel.api.group, ...siblings.map(item => item.group)]
              const weights = [weight, ...siblings.map(item => (1 - weight) * item.size / total)]
              const currentSizes = () => groups.map(item => findSerializedLeafByGroupId(api.toJSON().grid?.root, item.id)?.size ?? NaN)
              const available = currentSizes().reduce((sum, size) => sum + size, 0)
              const targets = weights.map(weight => available * weight)
              // Splitview distributes its inter-group margins evenly across visible views.
              // setSize consumes the underlying view size, whereas serialized leaves
              // report the margin-reduced size.
              const grid = api.toJSON().grid
              const splitExtent = dimension === 'width' ? grid.width : grid.height
              const marginShare = (splitExtent - available) / groups.length
              if (!Number.isFinite(marginShare) || marginShare < 0) throw new Error('invalid split geometry')
              const ordered = grid.root.data.map(node => groups.findIndex(item => item.id === node.data?.id))
              if (ordered.length !== groups.length || ordered.some(index => index < 0)) throw new Error('split topology changed')
              for (const index of ordered.slice(0, -1)) {
                groups[index].api.setSize({[dimension]: targets[index] + marginShare})
              }
              const residual = Math.max(...currentSizes().map((size,index) => Math.abs(size-targets[index])))
              if (!(residual <= 1)) throw new Error(`geometry residual ${residual}`)
            }
            const returnedGroupId = panel.api.group?.id
            for (const other of origins.values()) {
              if (other === origin || !returnedGroupId || !other.anchor) continue
              for (const sibling of other.anchor.siblings ?? []) if (sibling.id === origin.groupId) sibling.id = returnedGroupId
              if (other.anchor.anchorId === origin.groupId) other.anchor.anchorId = returnedGroupId
            }
            origins.delete(panel.id)
            if (!origins.size) floatingOriginsByScene.delete(scene.id)
            void persistCurrentLayout()
          } catch (error) {
            if (panel.api.location?.type === 'grid') { origins.delete(panel.id); if (!origins.size) floatingOriginsByScene.delete(scene.id) }
            else origin.phase = 'open'
            setError(`悬浮面板回收未完成：${error?.message ?? '未知错误'}`)
          }
          return
        }
        if (panel.api.location?.type !== 'grid') { setError('请先收回独立窗口。'); return }
        const liveLayout = api.toJSON()
        const layout = origins.size ? origins.values().next().value.layout : liveLayout
        const group = findSerializedLeafForPanel(layout.grid?.root, panel.id)?.data
        if (!group) { setError('无法确定面板原位置。'); return }
        const origin = {groupId:group.id, views:[...group.views], anchor:captureFloatingPanelReturnAnchor(layout.grid,panel.id), layout:JSON.parse(JSON.stringify(layout)), phase:'open'}
        origins.set(panel.id, origin); floatingOriginsByScene.set(scene.id, origins)
        try { api.addFloatingGroup(panel); if (panel.api.location?.type !== 'floating') throw new Error('float incomplete'); origin.openGrid = JSON.stringify(api.toJSON().grid) }
        catch { origins.delete(panel.id); if (!origins.size) floatingOriginsByScene.delete(scene.id); setError('无法悬浮面板，请重试。') }
      }
      async function toggleFloatingPanel(panel) {
        const currentApi = apiRef.current
        if (!panel || !scene.panels.some(item => item.id === panel.id && ['native-chat', 'native-workspace', 'business-iframe'].includes(item.type))
          || !currentApi || narrowRef.current) return
        if (localPanelExpansionRef.current?.activePanelId === panel.id) localPanelExpansionRef.current.restore()
        if (panel.api.location?.type === 'popout') {
          const popout = currentApi.getPopouts?.().find(item => item.group === panel.api.group || item.group?.id === panel.api.group?.id)
          if (typeof popout?.window?.close === 'function') popout.window.close()
          else if (popout?.group) {
            const target = currentApi.getPanel('business-main')?.id !== panel.id
              ? currentApi.getPanel('business-main')
              : currentApi.getPanels?.().find(item => item.id !== panel.id && item.api?.location?.type === 'grid')
            if (target?.api?.group) panel.api.moveTo({ group: target.api.group, position: 'right' })
          }
          return
        }
        if (panel.api.location?.type === 'floating') {
          const restore = snapshot.dockLayouts?.scenes?.[scene.id]?.floatingRestore
          if (restore?.dockview && serializeDockGridWithoutPanel(currentApi.toJSON(), panel.id)
            === serializeDockGridWithoutPanel(restore.dockview, panel.id)) {
            try {
              currentApi.fromJSON(restore.dockview, { reuseExistingPanels: true })
              syncClosedPanels(currentApi)
              return
            } catch { /* Keep the safe docking fallback available if an older saved snapshot cannot be restored. */ }
          }
          const target = currentApi.getPanel('business-main')?.id !== panel.id
            ? currentApi.getPanel('business-main')
            : currentApi.panels.find(item => item.id !== panel.id && item.api?.location?.type !== 'floating')
          if (target?.api?.group) panel.api.moveTo({ group: target.api.group, position: 'right' })
          return
        }
        if (pendingPopoutRestoreByScene.has(scene.id) || currentApi.toJSON().floatingGroups?.length || currentApi.getPopouts?.().length > 0) { setError('请先收回已有浮动面板或独立窗口。'); return }
        const bounds = hostRef.current?.getBoundingClientRect()
        if (!(bounds?.width > 0 && bounds?.height > 0)) return
        const width = Math.round(Math.min(window.innerWidth * 0.56, window.innerWidth - 24))
        const height = Math.round(Math.min(window.innerHeight * 0.94, window.innerHeight - 16))
        const original = currentApi.toJSON()
        const returnGroup = findSerializedLeafForPanel(original.grid?.root, panel.id)?.data
        pendingPopoutRestoreByScene.set(scene.id, {
          panelId: panel.id,
          dockview: JSON.parse(JSON.stringify(original)),
          returnGroupId: returnGroup?.id ?? '',
          returnPanelIds: [...(returnGroup?.views ?? [])],
          returnActiveView: returnGroup?.activeView ?? '',
          closedPanelIds: scene.panels.filter(item => !currentApi.getPanel(item.id)).map(item => item.id),
        })
        const descriptor = scene.panels.find(item => item.id === panel.id)
        const isPreview = descriptor?.type === 'business-iframe' && descriptor.path === '/artifacts#preview'
        const top = window.screenY + Math.max(0, Math.round(bounds.top ?? 0)) + 8
        const left = isPreview
          ? window.screenX + Math.max(0, Math.round(bounds.left ?? 0)) + 8
          : window.screenX + Math.max(0, window.innerWidth - width - 8)
        let popoutUrl = ''
        try { popoutUrl = validDesktopPopoutUrl(await window.dshDesktop?.panePopout?.getUrl?.()) }
        catch { popoutUrl = '' }
        if (!popoutUrl) {
          pendingPopoutRestoreByScene.delete(scene.id)
          setError('无法获取独立工作面板授权，请重试。')
          return
        }
        Promise.resolve(currentApi.addPopoutGroup(panel, {
          popoutUrl,
          position: { left, top, width, height },
        })).then(opened => {
          if (opened !== false) {
            const restore = pendingPopoutRestoreByScene.get(scene.id)
            if (restore) restore.openLayout = serializeDockGridWithoutPanel(currentApi.toJSON(), panel.id)
          }
          if (opened === false && pendingPopoutRestoreByScene.has(scene.id)) {
            pendingPopoutRestoreByScene.delete(scene.id)
            setError('无法打开独立工作面板，请重试。')
          }
        }).catch(() => {
          pendingPopoutRestoreByScene.delete(scene.id)
          setError('无法打开独立工作面板，请重试。')
        })
      }

      function restorePopoutLayout(currentApi) {
        if (!pendingPopoutRestoreByScene.has(scene.id)) return
        const restore = pendingPopoutRestoreByScene.get(scene.id)
        const run = () => {
          if (pendingPopoutRestoreByScene.get(scene.id) !== restore || apiRef.current !== currentApi
            || currentApi.getPopouts?.().length || !activeWideViewport()) return
          pendingPopoutRestoreByScene.delete(scene.id)
          try {
            const mergedReturnLayout = reconstructPopoutReturnLayout(restore.returnLayout, restore)
            // Hidden placeholder sizes are not the original split ratios: its
            // visible sibling expands while the pane is outside the window.
            // Restore the original snapshot only when the remaining layout is
            // exactly the post-open baseline (including the live panel set).
            const unchanged = restore.openLayout && restore.openLayout === serializeDockGridWithoutPanel(restore.returnLayout, restore.panelId)
            const returnLayout = unchanged ? restore.dockview : mergedReturnLayout
            if (returnLayout && !unchanged) {
              // An empty hidden slot has a cached size while its siblings fill
              // all available space. Once visible again those weights must fit
              // the parent together; preserve their ratios and topology.
              const normalizeSizes = (node, vertical, width, height) => {
                if (node.type === 'leaf') return
                const children = node.data ?? []
                const available = Math.max(0, (vertical ? height : width) - dockviewTheme(activeColorScheme).gap * Math.max(0, children.length - 1))
                const total = children.reduce((sum, child) => sum + child.size, 0)
                for (const child of children) {
                  child.size = total ? child.size / total * available : available / children.length
                  normalizeSizes(child, !vertical, vertical ? width : child.size, vertical ? child.size : height)
                }
              }
              normalizeSizes(returnLayout.grid.root, returnLayout.grid.orientation === 'VERTICAL', returnLayout.grid.width, returnLayout.grid.height)
            }
            if (returnLayout) {
              currentApi.fromJSON(returnLayout, { reuseExistingPanels: true })
              // Reused panels retain their live constraints. Apply the saved
              // group dimensions after deserialization has attached every view,
              // so an early layout against an incomplete split cannot skew it.
              restoreGridGeometry(currentApi, returnLayout)
            }
            const returned = currentApi.getPanel(restore.panelId)
            if (returned?.api?.location?.type !== 'grid') {
              const target = currentApi.getPanel('business-main')?.id !== restore.panelId
                ? currentApi.getPanel('business-main')
                : currentApi.getPanels?.().find(item => item.id !== restore.panelId && item.api?.location?.type === 'grid')
              if (returned?.api?.group && target?.api?.group) returned.api.moveTo({ group: target.api.group, position: 'right' })
            }
            syncClosedPanels(currentApi)
            const selected = currentApi.activePanel ?? currentApi.getPanel(scene.panels[0]?.id)
            if (selected) setActivePanelId(selected.id)
            setError('')
            settleDockviewElement(currentApi.getPanel(restore.panelId)?.api?.group?.element)
            void persistCurrentLayout()
          } catch { setError('工作面板已返回，但原布局无法恢复，请使用“重置布局”。') }
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run)
        else setTimeout(run, 0)
      }

      function attachPopoutWindow(popoutWindow) {
        if (!trustedDesktopPopoutWindow(popoutWindow) || popoutListenersRef.current.has(popoutWindow)) return
        const messageHandler = fileBridgeRef.current?.handler
        const onFrameLoad = event => {
          if (event.target?.matches?.('iframe[data-tradeloom-business-frame]')) notifyBusinessPopoutFramesChanged()
        }
        if (messageHandler) popoutWindow.addEventListener('message', messageHandler)
        popoutWindow.document.addEventListener('click', onDockTabClose, true)
        popoutWindow.document.addEventListener('load', onFrameLoad, true)
        popoutListenersRef.current.set(popoutWindow, { messageHandler, onDockTabClose, onFrameLoad })
        syncPopoutDocumentTheme(popoutWindow)
        scheduleOwnerDocumentRefresh(popoutWindow)
        notifyBusinessPopoutFramesChanged()
      }

      function detachPopoutWindow(popoutWindow) {
        const listeners = popoutListenersRef.current.get(popoutWindow)
        if (!listeners) return
        try { if (listeners.messageHandler) popoutWindow.removeEventListener('message', listeners.messageHandler) } catch { /* Closed window. */ }
        try { popoutWindow.document.removeEventListener('click', listeners.onDockTabClose, true) } catch { /* Closed window. */ }
        try { popoutWindow.document.removeEventListener('load', listeners.onFrameLoad, true) } catch { /* Closed window. */ }
        popoutListenersRef.current.delete(popoutWindow)
        scheduleOwnerDocumentRefresh(window)
        notifyBusinessPopoutFramesChanged()
      }
      function clearDropIntent() {
        if (dropIntentCleanupTimerRef.current) clearTimeout(dropIntentCleanupTimerRef.current)
        dropIntentCleanupTimerRef.current = 0
        dropIntentObserverRef.current?.disconnect?.()
        dropIntentObserverRef.current = null
        dropIntentRef.current?.remove()
        dropIntentRef.current = null
      }
      function scheduleDropIntentCleanup() {
        if (dropIntentCleanupTimerRef.current) clearTimeout(dropIntentCleanupTimerRef.current)
        dropIntentCleanupTimerRef.current = setTimeout(() => {
          dropIntentCleanupTimerRef.current = 0
          clearDropIntent()
        }, 0)
      }
      function removeDropIntentBeforeOverlayUpdate() {
        dropIntentObserverRef.current?.disconnect?.()
        dropIntentObserverRef.current = null
        dropIntentRef.current?.remove()
        dropIntentRef.current = null
      }
      dockRenderContexts.set(scene.id, {
        SessionProvider, renderSlot, renderFactorySlot, narrow, panels: scene.panels, assistantLabel: assistantLabel(roleId),
        requestFileExport: fileBridgeRef.current?.handler?.requestFileExport,
        requestFileFocus: fileBridgeRef.current?.handler?.requestFileFocus,
        closedPanels: scene.panels.filter(panel => panel.optional !== true && closedPanelIds.includes(panel.id)),
        assistantOptions: scene.panels.filter(panel => panel.optional === true && panel.type === 'native-chat'
          && panel.roleId !== roleId && closedPanelIds.includes(panel.id) && Boolean(state.sessionBindings[panel.roleId])),
        saveError: state.dockSaveErrors?.[scene.id], error,
        refresh: panelId => refreshScenePanel(scene.id, panelId),
        resetLayout: () => applyLayoutPreset(snapshot.dockDefaults?.[scene.id]), selectPanel: panelId => selectPanel(panelId),
        saveLayoutPreset,
        applyLayoutPreset: () => applyLayoutPreset(snapshot.dockLayouts?.scenes?.[scene.id]?.preset),
        addAssistantPanel: panelId => addAssistantPanel(panelId),
        retrySave: () => { void persistCurrentLayout() },
        isPanelMaximized: panelId => {
          const currentApi = apiRef.current
          const panel = currentApi?.getPanel(panelId)
          return Boolean(panel && panel.api.isMaximized())
        },
        hasMaximizedGroup: () => Boolean(apiRef.current?.hasMaximizedGroup?.()),
        isPanelLocallyExpanded: panelId => localPanelExpansionRef.current?.isExpanded(panelId),
        toggleLocalExpansion: panelId => localPanelExpansionRef.current?.toggle(panelId),
        isPanelFloating: panelId => ['floating', 'popout'].includes(apiRef.current?.getPanel(panelId)?.api?.location?.type),
        hasFloatingPanel: () => Boolean(apiRef.current?.toJSON()?.floatingGroups?.length || apiRef.current?.getPopouts?.().length),
        toggleFloat: panelId => toggleInAppFloatingPanel(apiRef.current?.getPanel(panelId)),
        togglePopout: panelId => toggleFloatingPanel(apiRef.current?.getPanel(panelId)),
        toggleMaximize: panelId => {
          const currentApi = apiRef.current
          const panel = currentApi?.getPanel(panelId)
          toggleDockPanel(panel)
        },
        closePanel,
        openFilesPanel: () => selectPanel('files'),
      })

      const closedPanelSignature = closedPanelIds.join('|')
      React.useEffect(() => { notifyDockActions(scene.id) }, [scene.id, narrow, maximized, closedPanelSignature, state.dockSaveErrors?.[scene.id], error, roleId])

      React.useEffect(() => {
        const controller = localPanelExpansionRef.current
        if (!active || narrow || maximized || apiRef.current?.hasMaximizedGroup?.()) controller?.restore()
        else controller?.syncGeometry()
      }, [active, narrow, maximized, width, height, activeColorScheme,
        activeUiTokens.dockTabHeight, activeUiTokens.fontBody, activeUiTokens.fontCompact])

      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        const interrupt = event => {
          if (event.type === 'pointerdown' || event.type === 'mousedown') {
            if (event.target?.closest?.('.dv-sash.dv-enabled')) localPanelExpansionRef.current?.restore()
            return
          }
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
          const sash = event.target?.closest?.('.dv-sash.dv-enabled')
          const split = sash?.closest?.('.dv-split-view-container')
          const sizeKey = split?.classList?.contains('dv-horizontal')
            ? ['ArrowLeft', 'ArrowRight'].includes(event.key)
            : split?.classList?.contains('dv-vertical') && ['ArrowUp', 'ArrowDown'].includes(event.key)
          if (sizeKey) localPanelExpansionRef.current?.restore()
        }
        host.addEventListener('pointerdown', interrupt, true)
        host.addEventListener('mousedown', interrupt, true)
        host.addEventListener('keydown', interrupt, true)
        return () => {
          host.removeEventListener('pointerdown', interrupt, true)
          host.removeEventListener('mousedown', interrupt, true)
          host.removeEventListener('keydown', interrupt, true)
        }
      }, [scene.id])

      React.useEffect(() => { sashKeyboardRefreshRef.current?.() }, [active, narrow, maximized])

      React.useEffect(() => {
        for (const panel of scene.panels.filter(item => item.type === 'native-chat')) {
          const chatPanel = apiRef.current?.getPanel(panel.id)
          const panelRoleId = roleForPanel(snapshot.config, scene.id, panel.id)
          if (chatPanel && panelRoleId) chatPanel.api.setTitle(assistantLabel(panelRoleId))
        }
      }, [roleId, scene.id])

      React.useEffect(() => {
        const element = hostRef.current
        if (!element || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(entries => {
          const entry = entries.find(item => item.target === element)
          if (!activeRef.current || !entry) return
          const nextWidth = entry.contentRect?.width ?? element.clientWidth ?? 0
          const nextHeight = entry.contentRect?.height ?? element.clientHeight ?? 0
          if (nextWidth > 0 && nextHeight > 0) {
            setWidth(nextWidth)
            setHeight(nextHeight)
          }
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        if (!active || !apiRef.current) return undefined
        const frame = requestAnimationFrame(() => {
          const rect = hostRef.current?.getBoundingClientRect()
          if (activeRef.current && rect?.width > 0 && rect?.height > 0) {
            setWidth(rect.width)
            setHeight(rect.height)
            if (!applyInitialGeometry(apiRef.current, rect)) apiRef.current.layout(Math.round(rect.width), Math.round(rect.height), true)
            if (pendingPopoutRestoreByScene.has(scene.id)) restorePopoutLayout(apiRef.current)
          }
        })
        return () => cancelAnimationFrame(frame)
      }, [active])

      React.useEffect(() => {
        if (!hostRef.current || typeof window === 'undefined') return undefined
        const handleMessage = fileBridgeRef.current?.handler
        if (!handleMessage) return undefined
        window.addEventListener('message', handleMessage)
        return () => {
          window.removeEventListener('message', handleMessage)
          handleMessage.dispose?.()
        }
      }, [scene])

      React.useEffect(() => {
        const currentApi = apiRef.current
        const viewport = activeViewport()
        if (!active) localPanelExpansionRef.current?.restore()
        if (!active || !currentApi || !restoredRef.current || !viewport) return
        if (narrow !== (viewport.width < minimumCanvasWidth || viewport.height < minimumCanvasHeight)) return
        applyInitialGeometry(currentApi, viewport)
        notifyNarrowListeners(scene.id, narrow)
        if (narrow && !narrowRef.current) {
          narrowRef.current = true
          const panel = currentApi.getPanel(activePanelId) ?? currentApi.getPanel(currentApi.activePanel?.id) ?? currentApi.getPanel(scene.panels[0]?.id)
          if (panel) { panel.api.setActive(); rememberRestorableLayout(currentApi, true); panel.api.maximize() }
        } else if (!narrow && narrowRef.current) {
          narrowRef.current = false
          if (currentApi.hasMaximizedGroup()) restoreMaximizedLayout(currentApi)
        }
        if (!narrow && pendingPopoutRestoreByScene.has(scene.id)) restorePopoutLayout(currentApi)
      }, [active, width, height, narrow, activePanelId, scene.id])

      React.useEffect(() => () => {
        localPanelExpansionRef.current?.dispose()
        localPanelExpansionRef.current = null
        layoutEventRef.current?.dispose?.()
        sashKeyboardCleanupRef.current?.()
        sashKeyboardCleanupRef.current = null
        sashKeyboardRefreshRef.current = null
        activePanelEventRef.current?.dispose?.()
        maximizeEventRef.current?.dispose?.()
        popoutAddEventRef.current?.dispose?.()
        popoutRemoveEventRef.current?.dispose?.()
        popoutWillCloseEventRef.current?.dispose?.()
        for (const popoutWindow of popoutListenersRef.current.keys()) detachPopoutWindow(popoutWindow)
        popoutListenersRef.current.clear()
        dropEventRef.current?.dispose?.()
        dropEndEventRef.current?.dispose?.()
        overlayEventRef.current?.dispose?.()
        dragStartEventRef.current?.dispose?.()
        groupDragStartEventRef.current?.dispose?.()
        headerDoubleClickRef.current?.()
        clearMaximizeAnimation()
        dropGeometryStartRef.current = null
        clearDropIntent()
        dockviewApis.delete(scene.id)
      }, [scene.id])

      function persistCurrentLayout() {
        const currentApi = apiRef.current
        if (!currentApi || localPanelExpansionRef.current?.isExpanded() || layoutTransitionRef.current
          || !activeWideViewport() || narrowRef.current || currentApi.hasMaximizedGroup?.()) return Promise.resolve(false)
        const origins = floatingOriginsByScene.get(scene.id)
        if (origins?.size) {
          const projected = projectFloatingGroupsIntoSavedGrid(currentApi.toJSON(), origins)
          if (!projected) { setError('布局已变化，无法安全保存悬浮面板；请先收回后重试。'); return Promise.resolve(false) }
          return queueDockLayoutSave(scene.id, projected)
        }
        const popoutRestore = pendingPopoutRestoreByScene.get(scene.id)
        if (popoutRestore) return queueDockLayoutSave(scene.id, popoutRestore.dockview)
        const dockview = currentApi.toJSON()
        return queueDockLayoutSave(scene.id, dockview)
      }

      function syncClosedPanels(currentApi) {
        const next = scene.panels.filter(panel => !currentApi?.getPanel(panel.id)).map(panel => panel.id)
        setClosedPanelIds(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next)
      }

      function findSashNeighbors(sash, currentApi) {
        const split = sash.parentElement?.parentElement
        const splitOnX = split?.classList?.contains('dv-horizontal')
        if (!split || typeof splitOnX !== 'boolean') return null
        const axis = splitOnX ? 'x' : 'y'
        const dockRoot = hostRef.current?.querySelector('.tl-dockview-theme')
        if (!dockRoot) return null
        const rootRect = dockRoot.getBoundingClientRect()
        const sashRect = sash.getBoundingClientRect()
        if (!(rootRect.width > 0 && rootRect.height > 0 && sashRect.width > 0 && sashRect.height > 0)) return null
        const sashCenter = axis === 'x'
          ? (sashRect.left + sashRect.right) / 2 - rootRect.left
          : (sashRect.top + sashRect.bottom) / 2 - rootRect.top
        const sashCrossStart = axis === 'x' ? sashRect.top - rootRect.top : sashRect.left - rootRect.left
        const sashCrossEnd = axis === 'x' ? sashRect.bottom - rootRect.top : sashRect.right - rootRect.left
        let best = null
        let bestScore = Number.POSITIVE_INFINITY
        for (const leading of currentApi.groups ?? []) {
          if (leading.api?.location?.type !== 'grid') continue
          const trailing = currentApi.adjacentGroupInDirection?.(leading, axis === 'x' ? 'right' : 'down')
          if (!trailing || trailing.api?.location?.type !== 'grid') continue
          const first = leading.api.boundingBox
          const second = trailing.api.boundingBox
          if (!first || !second) continue
          const firstStart = axis === 'x' ? first.left : first.top
          const firstEnd = firstStart + (axis === 'x' ? first.width : first.height)
          const secondStart = axis === 'x' ? second.left : second.top
          const secondEnd = secondStart + (axis === 'x' ? second.width : second.height)
          const firstCrossStart = axis === 'x' ? first.top : first.left
          const firstCrossEnd = firstCrossStart + (axis === 'x' ? first.height : first.width)
          const secondCrossStart = axis === 'x' ? second.top : second.left
          const secondCrossEnd = secondCrossStart + (axis === 'x' ? second.height : second.width)
          const crossOverlapStart = Math.max(firstCrossStart, secondCrossStart)
          const crossOverlapEnd = Math.min(firstCrossEnd, secondCrossEnd)
          const sashCrossCenter = (sashCrossStart + sashCrossEnd) / 2
          const sashOverlapsGroups = sashCrossEnd > crossOverlapStart && sashCrossStart < crossOverlapEnd
          if (crossOverlapEnd <= crossOverlapStart || !sashOverlapsGroups) continue
          if (Math.abs(firstEnd - sashCenter) > 16 || Math.abs(secondStart - sashCenter) > 16) continue
          const crossDistance = sashCrossCenter < crossOverlapStart ? crossOverlapStart - sashCrossCenter
            : sashCrossCenter > crossOverlapEnd ? sashCrossCenter - crossOverlapEnd : 0
          const score = Math.abs(firstEnd - sashCenter) + Math.abs(secondStart - sashCenter) + crossDistance
          if (score < bestScore) {
            bestScore = score
            best = { axis, leading, trailing, leadingSize: firstEnd - firstStart, trailingSize: secondEnd - secondStart }
          }
        }
        return best
      }

      function installSashKeyboardAccess(currentApi) {
        sashKeyboardCleanupRef.current?.()
        const host = hostRef.current
        if (!host || typeof MutationObserver !== 'function') return
        const decorated = new Map()
        const attributes = ['tabindex', 'role', 'aria-orientation', 'aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']
        const setAttributeIfChanged = (element, name, value) => {
          if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value))
        }
        const restore = (element, state) => {
          element.removeEventListener('keydown', state.onKeyDown)
          for (const [name, value] of Object.entries(state.attributes)) {
            if (value === null) element.removeAttribute(name)
            else element.setAttribute(name, value)
          }
          decorated.delete(element)
        }
        const refresh = () => {
          const eligible = activeRef.current && !narrowRef.current && !currentApi.hasMaximizedGroup?.()
          const available = new Set()
          if (eligible) {
            for (const sash of host.querySelectorAll('.dv-sash.dv-enabled')) {
              const neighbors = findSashNeighbors(sash, currentApi)
              if (!neighbors) continue
              available.add(sash)
              let state = decorated.get(sash)
              if (!state) {
                state = {
                  attributes: Object.fromEntries(attributes.map(name => [name, sash.getAttribute(name)])),
                  onKeyDown: null,
                }
                state.onKeyDown = event => {
                  if (event.altKey || event.ctrlKey || event.metaKey) return
                  const current = findSashNeighbors(sash, currentApi)
                  if (!current || narrowRef.current || currentApi.hasMaximizedGroup?.()) return
                  const positiveKey = current.axis === 'x' ? 'ArrowRight' : 'ArrowDown'
                  const negativeKey = current.axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
                  if (event.key !== positiveKey && event.key !== negativeKey) return
                  const delta = (event.key === positiveKey ? 1 : -1) * (event.shiftKey ? 64 : 24)
                  const dimension = current.axis === 'x' ? 'width' : 'height'
                  const minimum = Number(current.leading.api?.[current.axis === 'x' ? 'minimumWidth' : 'minimumHeight']) || 0
                  const maximum = Number(current.leading.api?.[current.axis === 'x' ? 'maximumWidth' : 'maximumHeight']) || Number.POSITIVE_INFINITY
                  const target = Math.max(minimum, Math.min(maximum, current.leadingSize + delta))
                  event.preventDefault()
                  event.stopPropagation()
                  if (target !== current.leadingSize) current.leading.api.setSize({ [dimension]: target })
                  refresh()
                }
                decorated.set(sash, state)
                sash.addEventListener('keydown', state.onKeyDown)
              }
              const size = Math.max(1, neighbors.leadingSize + neighbors.trailingSize)
              const value = Math.round(neighbors.leadingSize / size * 100)
              const leftRight = neighbors.axis === 'x'
              const label = leftRight ? '调整左右分栏宽度' : '调整上下分栏高度'
              setAttributeIfChanged(sash, 'tabindex', '0')
              setAttributeIfChanged(sash, 'role', 'separator')
              setAttributeIfChanged(sash, 'aria-orientation', leftRight ? 'vertical' : 'horizontal')
              setAttributeIfChanged(sash, 'aria-label', label)
              setAttributeIfChanged(sash, 'aria-valuemin', '0')
              setAttributeIfChanged(sash, 'aria-valuemax', '100')
              setAttributeIfChanged(sash, 'aria-valuenow', value)
              setAttributeIfChanged(sash, 'aria-valuetext', `${leftRight ? '左侧' : '上方'} ${value}%，${leftRight ? '右侧' : '下方'} ${100 - value}%`)
            }
          }
          for (const [sash, state] of decorated) if (!available.has(sash)) restore(sash, state)
        }
        sashKeyboardRefreshRef.current = refresh
        const observer = new MutationObserver(refresh)
        observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
        refresh()
        sashKeyboardCleanupRef.current = () => {
          observer.disconnect()
          for (const [sash, state] of [...decorated]) restore(sash, state)
          if (sashKeyboardRefreshRef.current === refresh) sashKeyboardRefreshRef.current = null
        }
      }

      function onReady({ api: readyApi }) {
        apiRef.current = readyApi
        dockviewApis.set(scene.id, readyApi)
        popoutAddEventRef.current = readyApi.onDidAddPopoutGroup?.(event => {
          const expandedPanelId = localPanelExpansionRef.current?.activePanelId
          if (expandedPanelId && (event?.group?.panels ?? []).some(panel => panel?.id === expandedPanelId)) {
            localPanelExpansionRef.current?.restore()
          }
          attachPopoutWindow(event?.window)
          settleDockviewElement(event?.group?.element)
          notifyDockActions(scene.id)
        }) ?? null
        popoutRemoveEventRef.current = readyApi.onDidRemovePopoutGroup?.(event => {
          const openWindows = new Set((readyApi.getPopouts?.() ?? []).map(popout => popout?.window).filter(Boolean))
          for (const registeredWindow of [...popoutListenersRef.current.keys()]) {
            if (registeredWindow === event?.window || !openWindows.has(registeredWindow)) detachPopoutWindow(registeredWindow)
          }
          restorePopoutLayout(readyApi)
          notifyDockActions(scene.id)
        }) ?? null
        popoutWillCloseEventRef.current = readyApi.onWillClosePopoutWindow?.(event => {
          const restore = pendingPopoutRestoreByScene.get(scene.id)
          if (!restore || !event?.window) return
          const entries = readyApi.getPopouts?.() ?? []
          const entry = entries.length === 1 ? entries[0]
            : entries.find(popout => (popout?.group?.panels ?? []).some(item => item?.id === restore.panelId))
          const groupPanelIds = (entry?.group?.panels ?? []).map(item => item?.id).filter(Boolean)
          if (!groupPanelIds.includes(restore.panelId)) return
          restore.returnLayout = JSON.parse(JSON.stringify(readyApi.toJSON()))
          restore.returnPanelIds = groupPanelIds
          restore.returnActiveView = entry?.group?.activePanel?.id ?? restore.returnActiveView
        }) ?? null
        for (const popout of readyApi.getPopouts?.() ?? []) attachPopoutWindow(popout.window)
        try {
          readyApi.fromJSON(record.dockview)
          if (activeViewport()) restoreGridGeometry(readyApi, record.dockview)
          else initialGeometryPendingRef.current = JSON.parse(JSON.stringify(record.dockview))
          if (activeWideViewport()) lastWideLayoutRef.current = JSON.parse(JSON.stringify(readyApi.toJSON()))
          restoredRef.current = true
          const requestedPanelId = pendingScenePanelFocus.get(scene.id)
          if (requestedPanelId) {
            pendingScenePanelFocus.delete(scene.id)
            if (!focusScenePanel(scene.id, requestedPanelId)) reopenScenePanel(scene.id, requestedPanelId)
          }
          syncClosedPanels(readyApi)
          const activePanel = readyApi.activePanel ?? readyApi.getPanel(scene.panels[0]?.id)
          setActivePanelId(activePanel?.id ?? scene.panels[0]?.id ?? '')
          for (const panel of scene.panels.filter(item => item.type === 'native-chat')) {
            readyApi.getPanel(panel.id)?.api.setTitle(assistantLabel(roleForPanel(snapshot.config, scene.id, panel.id)))
          }
          installSashKeyboardAccess(readyApi)
          layoutEventRef.current = readyApi.onDidLayoutChange(() => {
            const locallyExpanded = localPanelExpansionRef.current?.activePanelId
            if (locallyExpanded) localPanelExpansionRef.current?.handleLayoutChange()
            sashKeyboardRefreshRef.current?.()
            const selected = readyApi.activePanel?.id
            if (selected) setActivePanelId(selected)
            syncClosedPanels(readyApi)
            notifyDockActions(scene.id)
            const viewport = activeWideViewport()
            const localPresentationActive = localPanelExpansionRef.current?.isExpanded()
            if (!localPresentationActive && !layoutTransitionRef.current && viewport && !readyApi.hasMaximizedGroup() && !readyApi.getPopouts?.().length
              && viewport?.width >= minimumCanvasWidth && viewport?.height >= minimumCanvasHeight) {
              lastWideLayoutRef.current = JSON.parse(JSON.stringify(readyApi.toJSON()))
            }
            if (restoredRef.current && !narrowRef.current && !localPresentationActive) void persistCurrentLayout()
          })
          activePanelEventRef.current = readyApi.onDidActivePanelChange(event => {
            const selected = event?.panel?.id ?? readyApi.activePanel?.id
            if (selected) localPanelExpansionRef.current?.handleActivePanelChange(selected)
            if (selected) setActivePanelId(selected)
            notifyDockActions(scene.id)
          })
          setMaximized(Boolean(readyApi.hasMaximizedGroup?.()))
          maximizeEventRef.current = readyApi.onDidMaximizedGroupChange(() => {
            if (readyApi.hasMaximizedGroup?.()) localPanelExpansionRef.current?.restore()
            setMaximized(Boolean(readyApi.hasMaximizedGroup?.()))
            notifyDockActions(scene.id)
          })
          let dragPanelId = ''
          let dragGroupId = ''
          let liftedPane = null
          let latestPanePointer = null
          // A manual popover paints the SAME DOM in the browser top layer. It
          // escapes grid clipping without reparenting an iframe/editor or making
          // a second interactive editor. Dockview still owns the original node.
          const finishPaneLift = () => {
            latestPanePointer = null
            const lift = liftedPane
            if (!lift) return null
            liftedPane = null
            const rect = measureDockviewGroup(lift.element)
            rect.parts = lift.parts.map(part => ({ element: part.element, rect: part.element.getBoundingClientRect() }))
            for (const part of [...lift.parts].reverse()) {
              try { part.element.hidePopover() } catch { /* Already closed. */ }
              if (part.popover === null) part.element.removeAttribute('popover')
              else part.element.setAttribute('popover', part.popover)
              if (part.style === null) part.element.removeAttribute('style')
              else part.element.setAttribute('style', part.style)
              part.element.classList.remove('tl-pane-drag-lift')
              part.element.removeAttribute('data-tl-pane-lift-part')
            }
            lift.placeholder.remove()
            lift.stylesheet.remove()
            lift.document.documentElement.removeAttribute('data-tl-pane-dragging')
            return rect
          }
          const beginPaneLift = (group, nativeEvent) => {
            const currentPointer = latestPanePointer
            finishPaneLift()
            const element = group?.element
            const rect = element?.getBoundingClientRect()
            if (!rect?.width || !rect?.height || typeof element.showPopover !== 'function'
              || !Number.isFinite(nativeEvent?.clientX)) return
            const document = element.ownerDocument
            const placeholder = document.createElement('div')
            placeholder.className = 'tl-pane-drag-placeholder'
            placeholder.setAttribute('aria-hidden', 'true')
            Object.assign(placeholder.style, { position: 'absolute', inset: '0', pointerEvents: 'none',
              border: '1px dashed var(--dsh-color-primary, #36b7a2)', background: 'rgba(54,183,162,.06)' })
            const stylesheet = document.createElement('style')
            stylesheet.textContent = '.tl-pane-drag-lift, .tl-pane-drag-lift * { pointer-events:none!important; } .tl-pane-drag-lift::backdrop { pointer-events:none; background:transparent; } [data-tl-pane-dragging] .dv-tab-ghost-drag { visibility:hidden!important; }'
            document.head.append(stylesheet)
            element.parentElement.append(placeholder)
            const parts = dockviewVisualParts(element).map(part => ({ element: part, rect: part.getBoundingClientRect(),
              style: part.getAttribute('style'), popover: part.getAttribute('popover') }))
            // The always-renderer schedules its own positioning frame. Keep
            // the original rectangles authoritative during pointer movement so
            // that update cannot add the group translation a second time.
            stylesheet.textContent += parts.map((part, index) =>
              `.tl-pane-drag-lift[data-tl-pane-lift-part="${index}"]{position:fixed!important;left:${part.rect.left}px!important;top:${part.rect.top}px!important;width:${part.rect.width}px!important;height:${part.rect.height}px!important;}`).join('')
            parts.forEach((part, index) => part.element.setAttribute('data-tl-pane-lift-part', String(index)))
            liftedPane = { element, document, placeholder, stylesheet, parts,
              x: nativeEvent.clientX, y: nativeEvent.clientY, pointerId: nativeEvent.pointerId }
            try {
              for (const part of parts) {
                part.element.setAttribute('popover', 'manual')
                part.element.classList.add('tl-pane-drag-lift')
                Object.assign(part.element.style, { position: 'fixed', inset: 'auto', margin: '0', padding: '0',
                  left: `${part.rect.left}px`, top: `${part.rect.top}px`, width: `${part.rect.width}px`, height: `${part.rect.height}px`,
                  maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box', transition: 'none', transform: 'none',
                  overflow: 'hidden', border: '0', background: 'var(--tl-theme-panel, #151923)', opacity: '0.96' })
                if (part.element === element) Object.assign(part.element.style, {
                  outline: '1px solid var(--dsh-color-primary, #36b7a2)', boxShadow: '0 18px 48px rgba(0,0,0,.45)' })
                part.element.showPopover()
              }
              document.documentElement.setAttribute('data-tl-pane-dragging', '')
              if (currentPointer?.pointerId === nativeEvent.pointerId && currentPointer.timeStamp >= nativeEvent.timeStamp) {
                for (const part of parts) part.element.style.transform = `translate3d(${currentPointer.x - liftedPane.x}px, ${currentPointer.y - liftedPane.y}px, 0)`
              }
            } catch { finishPaneLift() }
          }
          const movePaneLift = event => {
            latestPanePointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timeStamp: event.timeStamp }
            const lift = liftedPane
            if (!lift || event.pointerId !== lift.pointerId) return
            for (const part of lift.parts) part.element.style.transform = `translate3d(${event.clientX - lift.x}px, ${event.clientY - lift.y}px, 0)`
          }
          const endPaneLift = event => {
            if (!liftedPane) { latestPanePointer = null; return }
            if (!liftedPane || (event.pointerId !== undefined && event.pointerId !== liftedPane.pointerId)) return
            const element = liftedPane.element
            const before = finishPaneLift()
            // At pointerup Dockview's listener runs after this capture listener.
            // Its onWillDrop hook consumes this final visual rectangle.
            const dropStart = dropGeometryStartRef.current
            if (dropStart) dropStart.rect = before
            requestAnimationFrame(() => {
              if (dropStart && dropGeometryStartRef.current === dropStart) {
                dropGeometryStartRef.current = null
                animateDockviewGeometry(element, before)
              }
            })
          }
          window.addEventListener('pointermove', movePaneLift, true)
          window.addEventListener('pointerup', endPaneLift, true)
          window.addEventListener('pointercancel', endPaneLift, true)
          const rectForGroup = group => {
            const rect = group?.element?.getBoundingClientRect?.()
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          }
          const resolveDraggedPanel = transfer => {
            if (transfer) {
              if (transfer.viewId !== readyApi.id) return null
              if (transfer.panelId) return readyApi.getPanel(transfer.panelId)
              if (transfer.groupId) {
                return readyApi.groups.find(group => group.id === transfer.groupId)?.activePanel ?? null
              }
              return null
            }
            if (dragPanelId) return readyApi.getPanel(dragPanelId)
            if (dragGroupId) return readyApi.groups.find(group => group.id === dragGroupId)?.activePanel ?? null
            return null
          }
          dragStartEventRef.current = readyApi.onWillDragPanel(event => {
            const expandedPanel = readyApi.getPanel(localPanelExpansionRef.current?.activePanelId)
            if (expandedPanel && event?.panel?.api?.group === expandedPanel.api.group) localPanelExpansionRef.current?.restore()
            clearDropIntent()
            clearMaximizeAnimation()
            dragPanelId = event?.panel?.id ?? ''
            dragGroupId = ''
            beginPaneLift(event?.panel?.api?.group, event?.nativeEvent)
            dropGeometryStartRef.current = {
              panelId: dragPanelId,
              rect: rectForGroup(event?.panel?.api?.group),
            }
          })
          groupDragStartEventRef.current = readyApi.onWillDragGroup?.(event => {
            const expandedPanel = readyApi.getPanel(localPanelExpansionRef.current?.activePanelId)
            if (expandedPanel && event?.group === expandedPanel.api.group) localPanelExpansionRef.current?.restore()
            clearDropIntent()
            clearMaximizeAnimation()
            dragPanelId = ''
            dragGroupId = event?.group?.id ?? ''
            beginPaneLift(event?.group, event?.nativeEvent)
            dropGeometryStartRef.current = {
              panelId: event?.group?.activePanel?.id ?? event?.group?.panels?.[0]?.id ?? '',
              rect: rectForGroup(event?.group),
            }
          })
          // Dockview routes same-view moves through its internal move path and
          // emits onWillDrop before that synchronous layout mutation; onDidDrop
          // is reserved for external drops. Capture the internal transfer here
          // and measure its settled group on the next frame.
          dropEndEventRef.current = readyApi.onWillDrop?.(event => {
            const transfer = event?.getData?.()
            const start = dropGeometryStartRef.current
            const panelId = transfer?.viewId === readyApi.id && transfer?.panelId
              ? transfer.panelId
              : start?.panelId
            const before = finishPaneLift() ?? start?.rect
            dropGeometryStartRef.current = null
            dragPanelId = ''
            dragGroupId = ''
            clearDropIntent()
            if (transfer?.viewId !== readyApi.id || !panelId || !before) return
            if (maximizeStartFrameRef.current) cancelAnimationFrame(maximizeStartFrameRef.current)
            maximizeStartFrameRef.current = requestAnimationFrame(() => {
              maximizeStartFrameRef.current = 0
              const droppedGroup = readyApi.getPanel(panelId)?.api?.group?.element
              if (droppedGroup?.isConnected) animateDockviewGeometry(droppedGroup, before)
            })
          }) ?? null
          overlayEventRef.current = readyApi.onWillShowOverlay(event => {
            const transfer = event.getData?.()
            const source = resolveDraggedPanel(transfer)
            const targetGroupId = event.group?.id ?? event.group?.model?.id
            const sourceGroupId = source?.api?.group?.id
            if (event.kind === 'content' && event.position === 'center' && sourceGroupId && sourceGroupId === targetGroupId) {
              event.preventDefault()
              removeDropIntentBeforeOverlayUpdate()
              return
            }
            const intent = dockDropIntent(event.kind, event.position)
            if (!intent || !event.group?.element) { removeDropIntentBeforeOverlayUpdate(); return }
            removeDropIntentBeforeOverlayUpdate()
            const hint = event.group.element.ownerDocument.createElement('div')
            hint.className = 'tl-dock-drop-intent'
            hint.dataset.intent = intent.id
            hint.textContent = intent.label
            hint.title = intent.label
            hint.setAttribute('role', 'status')
            hint.setAttribute('aria-label', intent.label)
            event.group.element.append(hint)
            dropIntentRef.current = hint
            if (typeof MutationObserver === 'function') {
              const groupElement = event.group.element
              const observer = new MutationObserver(() => {
                if (!groupElement.querySelector('.dv-drop-target')) clearDropIntent()
              })
              observer.observe(groupElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true })
              dropIntentObserverRef.current = observer
            }
          })
          dropEventRef.current = readyApi.onWillDrop(event => {
            if (event.kind !== 'content') return
            const transfer = event.getData?.()
            if (!transfer || transfer.viewId !== readyApi.id) return
            const source = resolveDraggedPanel(transfer)
            const targetPanelId = event.group?.activePanel?.id ?? event.group?.model?.activePanel?.id
            const target = targetPanelId ? readyApi.getPanel(targetPanelId) : null
            if (!source || !target) return
            if (event.position !== 'center') return
            if (source.id === target.id || source.api.group?.id === target.api.group?.id) {
              event.preventDefault()
              return
            }
            if (swapDockPanel(readyApi, source, target)) event.preventDefault()
          })
          const onHeaderDoubleClick = event => {
            if (narrowRef.current) return
            const header = event.target?.closest?.('.dv-tabs-and-actions-container')
            if (!header || !hostRef.current?.contains(header)) return
            const target = event.target?.closest?.('button,[role="button"],input,select,textarea,a,[contenteditable="true"],.dv-default-tab-action,.dv-sash,.dv-right-actions-container,.dv-left-actions-container,[class*="close"]')
            if (target) return
            const tab = event.target?.closest?.('.dv-tab[data-tab-panel-id]')
            const groupElement = header.closest('.dv-groupview')
            if (!groupElement) return
            const panelId = tab?.getAttribute('data-tab-panel-id')
            const group = panelId ? null : readyApi.groups.find(item => item.element === groupElement)
            const panel = readyApi.getPanel(panelId || group?.activePanel?.id)
            if (!panel) return
            event.preventDefault()
            toggleDockPanel(panel)
          }
          hostRef.current?.addEventListener('dblclick', onHeaderDoubleClick)
          headerDoubleClickRef.current = () => hostRef.current?.removeEventListener('dblclick', onHeaderDoubleClick)
          const clearOnDropEnd = () => scheduleDropIntentCleanup()
          window.addEventListener('pointerup', clearOnDropEnd, true)
          window.addEventListener('pointercancel', clearOnDropEnd, true)
          window.addEventListener('dragend', clearOnDropEnd, true)
          const previousHeaderCleanup = headerDoubleClickRef.current
          headerDoubleClickRef.current = () => {
            previousHeaderCleanup?.()
            finishPaneLift()
            window.removeEventListener('pointermove', movePaneLift, true)
            window.removeEventListener('pointerup', endPaneLift, true)
            window.removeEventListener('pointercancel', endPaneLift, true)
            window.removeEventListener('pointerup', clearOnDropEnd, true)
            window.removeEventListener('pointercancel', clearOnDropEnd, true)
            window.removeEventListener('dragend', clearOnDropEnd, true)
            clearDropIntent()
          }
          if (hostRef.current) {
            const rect = hostRef.current.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              readyApi.layout(Math.round(rect.width), Math.round(rect.height), true)
              setWidth(rect.width)
              setHeight(rect.height)
            }
          }
        } catch (error) {
          setError('工作区布局无法读取，请应用推荐布局后重试。')
        }
      }

      function saveNarrowDockChange(currentApi) {
        const dockview = currentApi.toJSON()
        if (!dockview.floatingGroups?.length && !dockview.popoutGroups?.length) {
          lastWideLayoutRef.current = dockview
          void queueDockLayoutSave(scene.id, dockview)
        }
        rememberRestorableLayout(currentApi)
      }

      function closePanel(panelId) {
        const currentApi = apiRef.current
        const current = currentApi?.getPanel(panelId)
        if (current?.api.location?.type !== 'grid'
          || currentApi.panels.filter(panel => panel.api.location?.type === 'grid').length <= 1) return
        localPanelExpansionRef.current?.restore()
        if (currentApi.hasMaximizedGroup()) restoreMaximizedLayout(currentApi)
        const panel = currentApi.getPanel(panelId)
        const position = captureClosedPanelPosition(currentApi.toJSON().grid, panelId)
        const record = snapshot.dockLayouts?.scenes?.[scene.id]
        const positions = pendingClosedPanelPositions.get(scene.id) ?? record?.closedPanelPositions
        if (position) pendingClosedPanelPositions.set(scene.id, { ...positions, [panelId]: position })
        panel?.api.close()
        if (narrowRef.current) {
          saveNarrowDockChange(currentApi)
          const activePanel = currentApi.activePanel
          activePanel?.api.maximize()
        }
      }

      function onDockTabClose(event) {
        if (!event.target?.closest?.('.dv-default-tab-action')) return
        const panelId = event.target.closest('[data-tab-panel-id]')?.dataset.tabPanelId
        if (!panelId) return
        event.preventDefault()
        event.stopPropagation()
        closePanel(panelId)
      }

      function selectPanel(panelId) {
        const currentApi = apiRef.current
        if (!currentApi) return false
        const reopening = !currentApi.getPanel(panelId)
        if (reopening) {
          if (currentApi.hasMaximizedGroup()) restoreMaximizedLayout(currentApi)
          reopenScenePanel(scene.id, panelId)
        }
        const panel = currentApi.getPanel(panelId)
        if (!panel) return false
        panel.api.setActive()
        setActivePanelId(panelId)
        if (narrowRef.current) {
          if (reopening) saveNarrowDockChange(currentApi)
          currentApi.maximizeGroup(panel)
        }
        return true
      }

      function addAssistantPanel(panelId) {
        const panel = scene.panels.find(item => item.id === panelId && item.optional === true && item.type === 'native-chat')
        if (!panel || !snapshot.sessionBindings[panel.roleId]) return false
        return reopenScenePanel(scene.id, panelId)
      }

      function prepareLayoutPreset() {
        const currentApi = apiRef.current
        if (!currentApi || !restoredRef.current || !activeViewport() || layoutTransitionRef.current) return undefined
        if (pendingPopoutRestoreByScene.has(scene.id) || currentApi.getPopouts?.().length
          || currentApi.toJSON().floatingGroups?.length || floatingOriginsByScene.get(scene.id)?.size) {
          setError('请先收回悬浮面板和独立窗口，再使用布局预设。')
          return undefined
        }
        localPanelExpansionRef.current?.restore()
        return currentApi
      }

      async function saveLayoutPreset() {
        if (savingPresetRef.current) return
        const currentApi = prepareLayoutPreset()
        if (!currentApi) return
        const dockview = currentApi.hasMaximizedGroup() && maximizeRestoreLayoutRef.current || currentApi.toJSON()
        const current = buildDockLayoutRecord(scene.id, dockview)
        const { closedPanelIds, closedPanelPositions, preset: previousPreset } = current
        const preset = { dockview: current.dockview, closedPanelIds, ...(closedPanelPositions ? { closedPanelPositions } : {}) }
        savingPresetRef.current = true
        try {
          if (await queueDockLayoutSave(scene.id, dockview, preset)) { setError(''); return }
          const scenes = snapshot.dockLayouts?.scenes
          if (scenes?.[scene.id]?.preset === preset) {
            const record = { ...scenes[scene.id] }
            if (previousPreset) record.preset = previousPreset
            else delete record.preset
            publish({ dockLayouts: { version: 2, scenes: { ...scenes, [scene.id]: record } } })
          }
        } finally { savingPresetRef.current = false }
      }

      function applyLayoutPreset(preset) {
        if (!preset?.dockview || savingPresetRef.current) return
        const currentApi = prepareLayoutPreset()
        if (!currentApi) return
        const wasMaximized = currentApi.hasMaximizedGroup()
        const previous = wasMaximized && maximizeRestoreLayoutRef.current || currentApi.toJSON()
        let applied = false
        layoutTransitionRef.current = true
        try {
          if (wasMaximized) currentApi.exitMaximizedGroup()
          currentApi.fromJSON(preset.dockview, { reuseExistingPanels: true })
          applied = true
        } catch {
          currentApi.fromJSON(previous, { reuseExistingPanels: true })
          setError('布局预设无法应用，已保留当前布局。')
        } finally { layoutTransitionRef.current = false }
        if (applied) {
          pendingClosedPanelPositions.set(scene.id, preset.closedPanelPositions ?? {})
          syncClosedPanels(currentApi)
          setError('')
          lastWideLayoutRef.current = currentApi.toJSON()
          void queueDockLayoutSave(scene.id, lastWideLayoutRef.current)
        }
        maximizeRestoreLayoutRef.current = null
        if (narrowRef.current || wasMaximized && !applied) {
          rememberRestorableLayout(currentApi, narrowRef.current)
          currentApi.activePanel?.api.maximize()
        }
      }

      const panels = scene.panels
      const closedPanels = panels.filter(panel => !api?.getPanel(panel.id))
      const toolbarError = [error, state.dockSaveErrors?.[scene.id]].filter(Boolean).join(' ')
      const Components = stableDockComponents(scene.id)
      const DockviewReact = dockviewModule.DockviewReact
      return h('section', { className: `tl-dock-scene${active ? ' is-active' : ''}${narrow ? ' is-narrow' : ''}`, 'aria-label': `${scene.label}工作区`, style: { display: active ? 'flex' : 'none' } },
        narrow || toolbarError ? h('header', { className: 'tl-dock-toolbar' },
          narrow ? h('label', { className: 'tl-dock-panel-picker' }, '当前面板', h('select', {
            'aria-label': '选择当前面板', value: activePanelId,
            onChange: event => selectPanel(event.currentTarget.value),
          }, panels.map(panel => h('option', { key: panel.id, value: panel.id }, `${panel.title}${closedPanels.some(item => item.id === panel.id) ? '（已关闭）' : ''}`)))) : null,
          toolbarError ? h('span', { role: 'alert', className: 'tl-dock-layout-error' }, toolbarError) : null) : null,
        h('div', { className: 'tl-dockview-host', ref: hostRef, onClickCapture: onDockTabClose }, h(DockviewReact, {
          components: Components,
          rightHeaderActionsComponent: stableDockGroupActions(scene.id),
          onReady,
          disableDnd: narrow,
          dndStrategy: 'pointer',
          disableFloatingGroups: false,
          dndEdges: false,
          dropOverlayModel: location => location === 'content' ? {
            activationSize: { type: 'percentage', value: 20 },
            size: { type: 'percentage', value: 50 },
            smallWidthBoundary: 160,
            smallHeightBoundary: 130,
          } : undefined,
          getTabContextMenuItems: () => scene.panels
            .filter(panel => panel.optional !== true && !apiRef.current?.getPanel(panel.id))
            .map(panel => ({ label: `恢复面板：${panel.title}`, action: () => selectPanel(panel.id) })),
          className: 'tl-dockview-theme dockview-spaced',
          proportionalLayout: true,
          theme: dockviewTheme(activeColorScheme),
        })),
        null)
    }

    function workbenchUiStyles(tokens = activeUiTokens) {
      const names = {
        fontFamily: 'font-family', fontBody: 'font-body', fontCompact: 'font-compact', lineHeight: 'line-height',
        topRowHeight: 'row-height', navHeight: 'nav-height', controlHeight: 'control-height', modelControl: 'model-size',
        sceneTabHeight: 'scene-tab-height', dockTabHeight: 'dock-tab-height', toolbarHeight: 'toolbar-height',
        iconSize: 'icon-size', cornerRadius: 'corner-radius',
      }
      return Object.fromEntries(Object.entries(names).flatMap(([key, cssName]) => {
        const value = tokens[key]
        if (value === undefined) return []
        return [[`--tl-${cssName}`, ['fontFamily', 'lineHeight'].includes(key) ? String(value) : `${value}px`]]
      }).concat((() => {
        const scale = (tokens.fontBody ?? 14) / 14
        return [
          ['--tl-ui-scale', String(scale)],
          ['--tl-space-1', `${Math.round(4 * scale)}px`],
          ['--tl-space-2', `${Math.round(6 * scale)}px`],
          ['--tl-space-3', `${Math.round(8 * scale)}px`],
          ['--tl-space-4', `${Math.round(10 * scale)}px`],
          ['--tl-space-5', `${Math.round(12 * scale)}px`],
        ]
      })()))
    }

    function syncPopoutDocumentTheme(popoutWindow) {
      if (!trustedDesktopPopoutWindow(popoutWindow)) return false
      try {
        const document = popoutWindow.document
        const body = document.body
        if (!body) return false
        document.documentElement?.setAttribute?.('data-tradeloom-ui', 'true')
        const palette = typeof activePalette === 'function' ? activePalette() : activePalette
        const values = {
          ...workbenchUiStyles(activeUiTokens),
          // Native popovers portal to body, outside .tl-native-conversation. Mirror
          // its font/scale and semantic aliases at this owner document root.
          '--dsh-ui-scale': 'var(--tl-ui-scale, 1)',
          '--dsh-content-font-size': 'var(--tl-font-body, 14px)',
          '--dsh-content-font-size-secondary': 'var(--tl-font-compact, 12px)',
          '--dsh-content-font-delta': 'calc(var(--tl-font-body, 14px) - 14px)',
          '--dsw-alias-bg-base': palette?.canvas, '--dsw-alias-bg-module-platform': palette?.panel,
          '--dsw-alias-bg-layer-1': palette?.panel, '--dsw-alias-bg-layer-2': palette?.header,
          '--dsw-alias-border-l1': palette?.border, '--dsw-alias-border-l2': palette?.border,
          '--dsw-alias-border-l3': palette?.border, '--dsw-alias-border-l4': palette?.border,
          '--dsw-alias-button-info-fill': palette?.accent, '--dsw-alias-button-info-hover': palette?.accentStrong,
          '--dsw-alias-interactive-bg-hover': palette?.accentSoft,
          '--dsw-alias-interactive-bg-hover-solid': palette?.header,
          '--dsw-alias-label-caption': palette?.muted, '--dsw-alias-label-dimmed': palette?.muted,
          '--dsw-alias-label-primary': palette?.text, '--dsw-alias-label-primary-bluish': palette?.accent,
          '--dsw-alias-label-primary-dimmed': palette?.muted, '--dsw-alias-label-secondary': palette?.muted,
          '--dsw-alias-label-tertiary': palette?.muted,
          '--dsw-alias-scrollbar-bg-l1': palette?.border, '--dsw-alias-scrollbar-bg-l2': palette?.border,
          '--dsw-alias-scrollbar-hover-l2': palette?.muted,
          '--dsw-alias-state-business-primary': palette?.accent,
          '--dsw-alias-state-business-tertiary': palette?.accentSoft,
          '--dsw-alias-state-error-primary': palette?.danger,
          '--tl-theme-canvas': palette?.canvas, '--tl-theme-panel': palette?.panel,
          '--tl-theme-header': palette?.header, '--tl-theme-border': palette?.border,
          '--tl-theme-button-ink': palette?.buttonInk, '--tl-theme-text': palette?.text,
          '--tl-theme-muted': palette?.muted, '--tl-theme-accent': palette?.accent,
          '--tl-theme-accent-strong': palette?.accentStrong, '--tl-theme-accent-soft': palette?.accentSoft,
          '--tl-theme-danger': palette?.danger, '--tl-theme-danger-bg': palette?.dangerBackground,
          '--tl-theme-danger-border': palette?.dangerBorder, '--tl-theme-warning': palette?.warning,
          '--tl-theme-warning-bg': palette?.warningBackground, '--tl-theme-warning-border': palette?.warningBorder,
          '--tl-theme-success': palette?.success, '--tl-theme-success-bg': palette?.successBackground,
          '--tl-accent-strong': palette?.accentStrong, '--tl-accent-soft': palette?.accentSoft,
          '--tl-danger': palette?.danger, '--tl-danger-bg': palette?.dangerBackground,
          '--tl-danger-border': palette?.dangerBorder, '--tl-warning': palette?.warning,
          '--tl-warning-bg': palette?.warningBackground, '--tl-warning-border': palette?.warningBorder,
          '--tl-success': palette?.success, '--tl-success-bg': palette?.successBackground,
          '--tl-button-hover': palette?.accentStrong,
        }
        body.classList.add('tl-workbench')
        body.classList.toggle('is-dark', activeColorScheme === 'dark')
        body.classList.toggle('is-light', activeColorScheme !== 'dark')
        // Native sheets select composer and attachment tokens with this body
        // attribute; shell classes alone leave those surfaces in the light palette.
        if (activeColorScheme === 'dark') body.setAttribute('data-ds-dark-theme', '')
        else body.removeAttribute('data-ds-dark-theme')
        Object.assign(body.style, { margin: '0', padding: '0', width: '100%', height: '100%', overflow: 'hidden', background: palette?.canvas ?? '' })
        document.documentElement.dataset.colorScheme = activeColorScheme
        document.documentElement.style.colorScheme = activeColorScheme
        document.documentElement.dataset.tlWorkbenchMotion = window.document?.documentElement?.dataset?.tlWorkbenchMotion ?? 'system'
        document.documentElement.style.width = '100%'
        document.documentElement.style.height = '100%'
        for (const [name, value] of Object.entries(values)) {
          if (value !== undefined && value !== null) body.style.setProperty(name, String(value))
        }
        // Dockview copies its theme class into the child at creation. Its own
        // color variables otherwise keep that initial palette after a switch.
        const dockviewColors = {
          '--dv-group-view-background-color': palette?.panel,
          '--dv-tabs-and-actions-container-background-color': palette?.header,
          '--dv-activegroup-visiblepanel-tab-background-color': palette?.panel,
          '--dv-activegroup-hiddenpanel-tab-background-color': palette?.header,
          '--dv-inactivegroup-visiblepanel-tab-background-color': palette?.panel,
          '--dv-inactivegroup-hiddenpanel-tab-background-color': palette?.header,
          '--dv-activegroup-visiblepanel-tab-color': palette?.text,
          '--dv-activegroup-hiddenpanel-tab-color': palette?.muted,
          '--dv-inactivegroup-visiblepanel-tab-color': palette?.muted,
          '--dv-inactivegroup-hiddenpanel-tab-color': palette?.muted,
          '--dv-tab-divider-color': palette?.border,
          '--dv-icon-hover-background-color': palette?.header,
        }
        for (const root of document.querySelectorAll('.dockview-theme-abyss, .dockview-theme-light')) {
          root.style.colorScheme = activeColorScheme
          for (const [name, value] of Object.entries(dockviewColors)) {
            if (value !== undefined && value !== null) root.style.setProperty(name, String(value))
          }
        }
        return true
      } catch { return false }
    }

    function notifyPopoutThemeChange() {
      for (const api of dockviewApis.values()) {
        for (const entry of api?.getPopouts?.() ?? []) syncPopoutDocumentTheme(entry.window)
      }
      notifyBusinessPopoutFramesChanged()
    }

    function syncPopoutMotionPreference(popoutWindow) {
      if (!trustedDesktopPopoutWindow(popoutWindow)) return false
      try {
        popoutWindow.document.documentElement.dataset.tlWorkbenchMotion = window.document?.documentElement?.dataset?.tlWorkbenchMotion ?? 'system'
        return true
      } catch { return false }
    }

    function notifyPopoutMotionPreferenceChange() {
      for (const api of dockviewApis.values()) {
        for (const entry of api?.getPopouts?.() ?? []) syncPopoutMotionPreference(entry.window)
      }
    }

    function SceneWorkbench({ SessionProvider, renderSlot, renderFactorySlot }) {
      const state = useSnapshot()
      const [mainPanelId, setMainPanelId] = React.useState(() => layoutApi?.panelInfo?.getSnapshot?.()?.activePanelId ?? null)
      const [dockviewModule, setDockviewModule] = React.useState(null)
      const [dockviewError, setDockviewError] = React.useState('')
      React.useEffect(() => {
        const panelInfo = layoutApi?.panelInfo
        if (!panelInfo?.subscribe) return undefined
        setMainPanelId(panelInfo.getSnapshot?.()?.activePanelId ?? null)
        return panelInfo.subscribe(() => setMainPanelId(panelInfo.getSnapshot?.()?.activePanelId ?? null))
      }, [])
      React.useEffect(() => {
        void loadConfig().catch(() => {})
        let live = true
        void loadDockviewChunk().then(module => { if (live) setDockviewModule(module) })
          .catch(() => { if (live) setDockviewError('工作区组件暂时无法加载，请重试。') })
        return () => { live = false }
      }, [])
      if (!state.config || !state.dockLayouts) return h('main', { className: 'tl-workbench-loading', 'aria-label': '工作场景' },
        h('p', { role: state.configError ? 'alert' : 'status' }, state.configError || '正在读取工作场景…'),
        h('button', { type: 'button', onClick: () => { void loadConfig(true).catch(() => {}) } }, '重试读取场景'))
      if (!dockviewModule) return h('main', { className: 'tl-workbench-loading', 'aria-label': '工作场景' },
        h('p', { role: dockviewError ? 'alert' : 'status' }, dockviewError || '正在准备工作区组件…'),
        dockviewError ? h('button', { type: 'button', onClick: () => { setDockviewError(''); void loadDockviewChunk().then(setDockviewModule).catch(() => setDockviewError('工作区组件暂时无法加载，请重试。')) } }, '重试加载') : null)
      const scene = state.config.scenes.find(item => item.id === state.activeSceneId)
      const visited = new Set([...(state.visitedScenes ?? []), scene.id])
      const sceneLabel = scene.label
      const resolvedPalette = typeof activePalette === 'function' ? activePalette() : activePalette
      const uiStyles = workbenchUiStyles()
      return h('main', { className: `tl-workbench ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': sceneLabel, style: {
        ...uiStyles,
        '--tl-theme-canvas': resolvedPalette?.canvas, '--tl-theme-panel': resolvedPalette?.panel,
        '--tl-theme-header': resolvedPalette?.header, '--tl-theme-border': resolvedPalette?.border,
        '--tl-theme-button-ink': resolvedPalette?.buttonInk,
        '--tl-theme-text': resolvedPalette?.text, '--tl-theme-muted': resolvedPalette?.muted,
        '--tl-theme-accent': resolvedPalette?.accent, '--tl-theme-accent-strong': resolvedPalette?.accentStrong,
        '--tl-theme-accent-soft': resolvedPalette?.accentSoft, '--tl-theme-danger': resolvedPalette?.danger,
        '--tl-theme-danger-bg': resolvedPalette?.dangerBackground, '--tl-theme-danger-border': resolvedPalette?.dangerBorder,
        '--tl-theme-warning': resolvedPalette?.warning, '--tl-theme-warning-bg': resolvedPalette?.warningBackground,
        '--tl-theme-warning-border': resolvedPalette?.warningBorder, '--tl-theme-success': resolvedPalette?.success,
        '--tl-theme-success-bg': resolvedPalette?.successBackground,
        '--tl-accent-strong': resolvedPalette?.accentStrong, '--tl-accent-soft': resolvedPalette?.accentSoft,
        '--tl-danger': resolvedPalette?.danger, '--tl-danger-bg': resolvedPalette?.dangerBackground,
        '--tl-danger-border': resolvedPalette?.dangerBorder, '--tl-warning': resolvedPalette?.warning,
        '--tl-warning-bg': resolvedPalette?.warningBackground, '--tl-warning-border': resolvedPalette?.warningBorder,
        '--tl-success': resolvedPalette?.success, '--tl-success-bg': resolvedPalette?.successBackground,
        '--tl-button-hover': resolvedPalette?.accentStrong,
      } },
        h('style', null, dockviewModule.dockviewCss),
        h('style', null, `
          .tl-workbench {
            box-sizing: border-box;
            padding: calc(6px * var(--tl-ui-scale, 1));
            --tl-floating-accent: var(--tl-theme-teal, #74cec6);
            --tl-space-1: 4px;
            --tl-space-2: 8px;
            --tl-space-3: 12px;
            --tl-space-4: 16px;
            --tl-panel-inset: var(--tl-space-2);
            --tl-toolbar-inset: var(--tl-space-2);
            --tl-canvas: var(--tl-theme-canvas);
            --tl-surface: var(--tl-theme-panel);
            --tl-surface-soft: var(--tl-theme-header);
            --tl-surface-hover: var(--tl-theme-header);
            --tl-ink: var(--tl-theme-text);
            --tl-muted: var(--tl-theme-muted);
            --tl-border: var(--tl-theme-border);
            --tl-accent: var(--tl-theme-accent);
            --tl-button-bg: var(--tl-theme-accent);
            --tl-button-ink: var(--tl-theme-button-ink);
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            color: var(--tl-ink);
            font-family: var(--tl-font-family, "Segoe UI", "Microsoft YaHei", sans-serif);
            font-size: var(--tl-font-body, inherit);
            line-height: var(--tl-line-height, inherit);
            scrollbar-color: auto;
            scrollbar-width: auto;
          }
          .tl-workbench ::-webkit-scrollbar { width: var(--tl-scrollbar-size, 5px); height: var(--tl-scrollbar-size, 5px); }
          .tl-workbench ::-webkit-scrollbar-thumb { border: 0; border-radius: 999px; background: color-mix(in srgb, var(--tl-theme-muted) 52%, transparent); background-clip: padding-box; }
          .tl-workbench ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--tl-theme-muted) 78%, transparent); background-clip: padding-box; }
          .tl-workbench ::-webkit-scrollbar-corner { background: transparent; }
          .tl-scene-docks { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; overflow: hidden; }
          .tl-dock-scene { position: absolute; inset: 0; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
          .tl-dock-toolbar {
            display: flex; align-items: center; gap: 5px; min-height: var(--tl-toolbar-height); flex: 0 0 auto;
            overflow-x: auto; white-space: nowrap; padding: 2px 4px;
            color: var(--tl-ink); font-family: inherit;
          }
          .tl-dock-toolbar button, .tl-dock-toolbar select, .tl-dock-panel-picker select {
            box-sizing: border-box; height: var(--tl-control-height); min-height: var(--tl-control-height); padding: 2px 10px; border: 1px solid var(--tl-border);
            border-radius: 7px; background: var(--tl-surface); color: var(--tl-ink);
            font-family: inherit; font-size: var(--tl-font-body); font-weight: inherit; line-height: 1.2;
          }
          .tl-dock-toolbar button { cursor: pointer; }
          .tl-dock-toolbar button:hover,
          .tl-dock-toolbar select:hover, .tl-dock-panel-picker select:hover { background: var(--tl-surface-soft); }
          .tl-dock-toolbar button:focus-visible, .tl-dock-toolbar select:focus-visible,
          .tl-dock-panel-picker select:focus-visible {
            outline: 2px solid var(--tl-accent); outline-offset: 1px;
          }
          .tl-dockview-host { flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; height: 100%; overflow: hidden; }
          .tl-dockview-host .tl-dockview-theme {
            height: 100%; width: 100%; color: var(--tl-ink); font-family: inherit; background: var(--tl-canvas);
            --dv-group-view-background-color: var(--tl-surface);
            --dv-tabs-and-actions-container-background-color: var(--tl-surface-soft);
            --dv-spacing-padding: var(--tl-space-1);
            --dv-floating-group-border: 1px solid var(--tl-border);
            --dv-tabs-and-actions-container-height: var(--tl-dock-tab-height);
            --dv-tabs-and-actions-container-font-size: var(--tl-font-compact);
            --dv-tab-font-size: var(--tl-font-compact);
            --dv-activegroup-visiblepanel-tab-background-color: var(--tl-surface);
            --dv-activegroup-hiddenpanel-tab-background-color: var(--tl-surface-soft);
            --dv-inactivegroup-visiblepanel-tab-background-color: var(--tl-surface);
            --dv-inactivegroup-hiddenpanel-tab-background-color: var(--tl-surface-soft);
            --dv-activegroup-visiblepanel-tab-color: var(--tl-ink);
            --dv-activegroup-hiddenpanel-tab-color: var(--tl-muted);
            --dv-inactivegroup-visiblepanel-tab-color: var(--tl-muted);
            --dv-inactivegroup-hiddenpanel-tab-color: var(--tl-muted);
            --dv-tab-divider-color: var(--tl-border);
            --dv-separator-border: var(--tl-border);
            --dv-sash-color: var(--tl-border);
            --dv-active-sash-color: var(--tl-accent);
            --dv-active-sash-transition-delay: 80ms;
            --dv-icon-hover-background-color: var(--tl-surface-soft);
            --dv-tab-border-radius: var(--tl-corner-radius);
            --dv-border-radius: var(--tl-corner-radius);
          }
          .tl-dockview-host .tl-dockview-theme .dv-dockview,
          .tl-dockview-host .tl-dockview-theme .dv-groupview,
          .tl-dockview-host .tl-dockview-theme .dv-content-container { height: 100%; width: 100%; color: var(--tl-ink); }
          .tl-dockview-host .tl-dockview-theme .dv-groupview {
            box-sizing: border-box; overflow: hidden; border: 1px solid var(--tl-border);
            border-radius: var(--tl-corner-radius); background: var(--tl-surface);
          }
          .tl-dockview-host .dv-shell > .dv-floating-overlay-host > .dv-resize-container {
            border: 1px solid color-mix(in srgb, var(--tl-floating-accent) 84%, var(--tl-theme-border));
            border-radius: calc(var(--tl-corner-radius) + 2px);
            box-shadow: 0 calc(12px * var(--tl-ui-scale, 1)) calc(28px * var(--tl-ui-scale, 1)) color-mix(in srgb, var(--tl-theme-canvas) 45%, transparent),
              0 0 0 1px color-mix(in srgb, var(--tl-floating-accent) 28%, transparent),
              0 0 calc(12px * var(--tl-ui-scale, 1)) color-mix(in srgb, var(--tl-floating-accent) 18%, transparent);
          }
          .tl-dockview-host .tl-dockview-theme .dv-tabs-and-actions-container {
            box-sizing: border-box; min-height: var(--tl-dock-tab-height); padding: 1px 6px;
            border-bottom: 1px solid var(--tl-border); background: linear-gradient(180deg,
              var(--tl-theme-header), color-mix(in srgb, var(--tl-theme-header) 72%, var(--tl-theme-panel))); font-family: inherit;
          }
          .tl-dockview-host .tl-dockview-theme .dv-tab { box-sizing:border-box; min-height:0; height:calc(var(--tl-dock-tab-height) - 4px); margin: 1px 2px; padding-inline:var(--tl-space-2); border:1px solid transparent; border-radius:calc(var(--tl-corner-radius) * .65); transition:background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
          .tl-dockview-host .tl-dockview-theme .dv-tab:hover { border-color: color-mix(in srgb, var(--tl-border) 80%, var(--tl-ink)); background: color-mix(in srgb, var(--tl-surface) 78%, var(--tl-theme-header)); }
          .tl-dockview-host .tl-dockview-theme .dv-tab.dv-active-tab { border-color: color-mix(in srgb, var(--tl-accent) 48%, var(--tl-border)); background: var(--tl-surface); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tl-accent) 15%, transparent), 0 0 9px color-mix(in srgb, var(--tl-accent) 12%, transparent); }
          .tl-dockview-host .tl-dockview-theme .dv-groupview.dv-active-group > .dv-tabs-and-actions-container { border-bottom-color: color-mix(in srgb, var(--tl-accent) 54%, var(--tl-border)); }
          .tl-dockview-host .tl-dockview-theme .dv-groupview.dv-inactive-group { border-color: color-mix(in srgb, var(--tl-border) 76%, transparent); }
          .tl-dockview-host .tl-dockview-theme .dv-tab:focus-visible, .tl-dockview-host .tl-dockview-theme .dv-tab:has(:focus-visible) { outline: 2px solid var(--tl-accent); outline-offset: -2px; }
          .tl-dockview-host .tl-dockview-theme .dv-right-actions-container button,
          .tl-dockview-host .tl-dockview-theme .dv-left-actions-container button {
            min-width: var(--tl-control-height); min-height: var(--tl-control-height); border-radius: var(--tl-corner-radius); color: var(--tl-muted);
          }
          .tl-dockview-host .tl-dockview-theme .dv-right-actions-container button:hover,
          .tl-dockview-host .tl-dockview-theme .dv-left-actions-container button:hover {
            background: var(--tl-surface-soft); color: var(--tl-ink);
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled::before {
            content: ''; position: absolute; z-index: 1; inset-block: 0; left: 50%; width: 10px;
            transform: translateX(-50%); background: transparent; pointer-events: auto;
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled::before {
            content: ''; position: absolute; z-index: 1; inset-inline: 0; top: 50%; height: 10px;
            transform: translateY(-50%); background: transparent; pointer-events: auto;
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container > .dv-sash-container > .dv-sash.dv-enabled::after {
            content: ''; position: absolute; z-index: 2; display: block; border-radius: 999px;
            background: var(--tl-accent); opacity: 0; transition: opacity 100ms ease-out; pointer-events: none;
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled::after {
            width: 3px; height: 30px; top: 50%; left: 50%; transform: translate(-50%, -50%);
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash.dv-enabled::after {
            width: 30px; height: 3px; top: 50%; left: 50%; transform: translate(-50%, -50%);
          }
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container > .dv-sash-container > .dv-sash.dv-enabled:hover::after,
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container > .dv-sash-container > .dv-sash.dv-enabled:active::after,
          .tl-dockview-host .tl-dockview-theme .dv-split-view-container > .dv-sash-container > .dv-sash.dv-enabled:focus-visible::after { opacity: .9; }
          .tl-dockview-host .tl-dockview-theme .dv-groupview { position: relative; }
          .tl-dockview-host .tl-dockview-theme .tl-dock-drop-intent {
            position: absolute; z-index: 1000; left: 50%; top: 50%; transform: translate(-50%, -50%);
            padding: 5px 10px; border: 1px solid var(--tl-border);
            border-radius: 6px; background: var(--tl-surface); color: var(--tl-ink); font-family: inherit; font-size: var(--tl-font-body);
            font-weight: 600; line-height: 1.2;
            white-space: nowrap; box-shadow: 0 2px 8px color-mix(in srgb, var(--tl-theme-text) 20%, transparent); pointer-events: none;
          }
          .tl-dock-scene.is-narrow .dv-tabs-and-actions-container { pointer-events: none; }
          .tl-dock-scene.is-narrow .dv-tab { pointer-events: auto; }
          .tl-dock-scene.is-narrow .tl-dock-group-actions { pointer-events: auto; }
          .tl-dock-panel {
            display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0;
            min-height: 0; overflow: hidden; background: var(--tl-surface); color: var(--tl-ink); font-family: inherit;
          }
          .tl-dockview-theme .dv-groupview { container-type: inline-size; }
          .tl-dock-group-actions { flex-shrink:0; white-space:nowrap; display:inline-flex; align-items:center; gap:var(--tl-space-1); min-width:0; padding-inline:var(--tl-space-1); font-size: var(--tl-font-body); }
          .tl-dock-inline-actions { display:inline-flex; align-items:center; gap:1px; }
          .tl-dock-group-actions .tl-dock-overflow-trigger { display:none; }
          .tl-dock-overflow-menu { box-sizing:border-box; min-width:min(160px,calc(100vw - 16px)); max-width:calc(100vw - 16px); max-height:calc(100dvh - 16px); overflow:auto; padding:var(--tl-space-1); border:1px solid var(--tl-border); border-radius:var(--tl-corner-radius); background:var(--tl-surface); color:var(--tl-ink); box-shadow:0 6px 18px color-mix(in srgb,var(--tl-ink) 18%,transparent); }
          .tl-dock-overflow-menu:popover-open { display:grid; gap:var(--tl-space-1); }
          .tl-dock-overflow-menu button { display:flex; align-items:center; gap:var(--tl-space-2); font-size:var(--tl-font-compact); white-space:nowrap; }
          .tl-dock-group-actions button svg { display:none; width:var(--tl-icon-size); height:var(--tl-icon-size); flex:none; }
          .tl-dock-group-actions button { box-sizing:border-box; min-height:var(--tl-control-height); min-width:var(--tl-control-height); padding:var(--tl-space-1) var(--tl-space-2); border:1px solid transparent; border-radius:var(--tl-corner-radius); background:transparent; color:var(--tl-muted); font-family:inherit; font-size:var(--tl-font-compact); font-weight:inherit; line-height:1.2; cursor:pointer; }
          .tl-dock-inline-actions button { display:inline-flex; align-items:center; justify-content:center; width:calc(var(--tl-dock-tab-height) - 4px); height:calc(var(--tl-dock-tab-height) - 4px); min-width:0; min-height:0; padding:2px; font-size:0; }
          .tl-dock-inline-actions button svg, .tl-dock-group-actions .tl-dock-overflow-trigger svg { display:block; }
          @container (max-width: 440px) {
            .tl-dock-group-actions, .tl-dock-inline-actions { gap:0; padding-inline:0; }
            .tl-dock-inline-actions button { display:inline-flex; align-items:center; justify-content:center; font-size:0; padding:var(--tl-space-1); }
            .tl-dock-inline-actions button svg { display:block; }
            .tl-dock-group-actions .tl-dock-binding-status { font-size:0; padding-inline:var(--tl-space-1); }
            .tl-dock-inline-actions button:not([data-pane-action="local-expand"]):not([data-pane-action="float"]) { display:none; }
            .tl-dock-group-actions .tl-dock-overflow-trigger { display:inline-flex; align-items:center; justify-content:center; width:calc(var(--tl-dock-tab-height) - 4px); height:calc(var(--tl-dock-tab-height) - 4px); min-width:0; min-height:0; padding:2px; }
            .tl-dock-binding-status::after { content:'✓'; font-size:var(--tl-font-compact); }
            .tl-dock-binding-status[data-binding-state="unbound"]::after { content:'○'; }
            .tl-dock-binding-status[data-archive-state="archived"]::after { content:'▣'; }
          }
          @container (max-width: 220px) {
            .tl-dock-inline-actions { display:none; }
            .tl-dock-group-actions .tl-dock-overflow-trigger { display:inline-flex; align-items:center; justify-content:center; }
          }
          .tl-dock-group-actions button:hover { background:var(--tl-surface-hover); border-color:var(--tl-border); color:var(--tl-ink); }
          .tl-dock-inline-actions [data-pane-action="popout"] { border-color:transparent; }
          .tl-dock-inline-actions [data-pane-action="popout"]:hover { border-color:transparent; }
          .tl-dock-inline-actions [data-pane-action="popout"] .tl-dock-popout-arrow { display:block; font-size:var(--tl-icon-size); font-weight:400; line-height:1; }
          .tl-dock-group-actions button:focus-visible { outline:2px solid var(--tl-accent); outline-offset:1px; }
          .tl-dock-binding-status { display:inline-flex; flex:0 1 auto; align-items:center; min-width:0; max-width:100%; padding-inline:calc(3px * var(--tl-ui-scale, 1)); overflow:hidden; color:var(--tl-muted); font-size:var(--tl-font-compact); line-height:1.2; white-space:nowrap; text-overflow:ellipsis; }
          .tl-dock-layout-error { color:var(--tl-muted); font-size: var(--tl-font-compact); }
          .tl-dock-panel-body {
            box-sizing: border-box; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto;
            padding: var(--tl-panel-inset); background: var(--tl-surface);
          }
          .tl-dock-panel-body:has(> .tl-markdown-preview) {
            display:flex; flex-direction:column; min-height:0; overflow:hidden; padding:0;
          }
          .tl-dock-panel-body:has(>iframe) { overflow: hidden; }
          .tl-dock-panel-body:has(>iframe) { padding: 0; }
          .tl-markdown-preview { display:flex; flex:1 1 0; width:100%; height:100%; min-width:0; min-height:0; flex-direction:column; overflow:hidden; color:var(--tl-theme-text); background:var(--tl-theme-panel); font:inherit; }
          .tl-markdown-preview-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--tl-space-1) var(--tl-space-2); flex:0 0 auto; min-height:var(--tl-control-height); padding:var(--tl-space-1) var(--tl-space-2); border-bottom:1px solid var(--tl-theme-border); background:linear-gradient(180deg,var(--tl-theme-header),color-mix(in srgb,var(--tl-theme-header) 78%,var(--tl-theme-panel))); }
          .tl-markdown-preview-header > strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--tl-font-body); font-weight:600; }
          .tl-markdown-preview-controls,.tl-markdown-preview-modes { display:inline-flex; align-items:center; gap:var(--tl-space-1); flex:0 0 auto; }
          .tl-markdown-preview-controls { flex-wrap:wrap; min-width:0; max-width:100%; }
          .tl-preview-icon-action svg { width:var(--tl-icon-size); height:var(--tl-icon-size); }
          .tl-preview-actions-menu { box-sizing:border-box; position:fixed; inset:auto; margin:0; width:calc(184px * var(--tl-ui-scale, 1)); max-width:calc(100vw - 16px); max-height:calc(100dvh - 16px); overflow-y:auto; padding:calc(4px * var(--tl-ui-scale, 1)); border:1px solid var(--tl-theme-border); border-radius:var(--tl-corner-radius); background:var(--tl-theme-panel); color:var(--tl-theme-text); box-shadow:0 8px 24px rgb(0 0 0 / 22%); font:var(--tl-font-compact)/1.4 var(--tl-font-family); }
          .tl-preview-actions-menu:popover-open { display:grid; gap:calc(2px * var(--tl-ui-scale, 1)); }
          .tl-preview-actions-menu button { justify-content:flex-start; width:100%; border:0; white-space:normal; overflow-wrap:anywhere; }
          .tl-markdown-preview-controls button,.tl-markdown-preview-controls a { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; min-height:calc(var(--tl-control-height) * .82); padding:0 var(--tl-space-2); border:1px solid var(--tl-theme-border); border-radius:var(--tl-corner-radius); color:var(--tl-theme-text); background:var(--tl-theme-panel); font:inherit; font-size:var(--tl-font-compact); line-height:1.2; text-decoration:none; white-space:nowrap; cursor:pointer; }
          .tl-markdown-preview-controls button:hover,.tl-markdown-preview-controls a:hover { border-color:var(--tl-theme-accent); background:var(--tl-theme-header); }
          .tl-markdown-preview-controls button:focus-visible,.tl-markdown-preview-controls a:focus-visible { outline:2px solid var(--tl-theme-accent); outline-offset:1px; }
          .tl-markdown-preview-modes button[aria-pressed="true"] { border-color:var(--tl-theme-accent); box-shadow:0 0 0 1px color-mix(in srgb,var(--tl-theme-accent) 35%,transparent); }
          .tl-markdown-preview-content { flex:1 1 auto; min-width:0; min-height:0; overflow:auto; padding:var(--tl-space-3); }
          .tl-markdown-preview-content.is-source { display:flex; overflow:hidden; }
          .tl-markdown-preview-source { box-sizing:border-box; flex:1 1 auto; width:100%; min-width:0; min-height:0; margin:0; padding:var(--tl-space-3); overflow:auto; border:1px solid var(--tl-theme-border); border-radius:var(--tl-corner-radius); background:var(--tl-theme-canvas); color:var(--tl-theme-text); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:var(--tl-font-compact); line-height:1.55; white-space:pre; tab-size:2; }
          .tl-dock-panel-body:has(> .tl-business-pane-tabs) { display:flex; flex-direction:column; min-height:0; overflow:hidden; padding:0; }
          .tl-business-pane-tabs { display:flex; flex-direction:column; flex:1 1 0; min-width:0; min-height:0; height:100%; }
          .tl-business-view-tabs { display:flex; flex:0 0 auto; gap:var(--tl-space-1); padding:var(--tl-space-1); background:var(--tl-theme-header); border-bottom:1px solid var(--tl-theme-border); }
          .tl-business-view-tabs button { border:1px solid transparent; border-radius:var(--tl-corner-radius); padding:var(--tl-space-1) var(--tl-space-2); color:var(--tl-theme-muted); background:transparent; font:inherit; cursor:pointer; }
          .tl-business-view-tabs button[aria-selected="true"] { color:var(--tl-theme-text); border-color:var(--tl-theme-border); background:var(--tl-theme-accent-soft); }
          .tl-business-view-tabs button:focus-visible { outline:2px solid var(--tl-theme-accent); outline-offset:1px; }
          .tl-business-view-panel { display:flex; flex:1 1 0; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
          .tl-business-view-panel[hidden] { display:none; }
          .tl-workflow-canvas-pane { display:flex; flex:1 1 0; flex-direction:column; min-width:0; min-height:0; overflow:hidden; }
          .tl-workflow-canvas-pane>.tl-wf { flex:1 1 0; min-height:0; }
          .tl-workflow-model-hint { flex:0 0 auto; margin:0; padding:var(--tl-space-1) var(--tl-space-2); color:var(--tl-theme-muted); font-size:var(--tl-font-compact); border-bottom:1px solid var(--tl-theme-border); }
          .tl-markdown-preview-reader { max-width:100%; color:var(--tl-theme-text); font:inherit; }
          .tl-markdown-preview-reader img { max-width:100%; height:auto; object-fit:contain; }
          .tl-markdown-preview-reader table { display:block; max-width:100%; overflow:auto; border-collapse:collapse; border-spacing:0; }
          .tl-markdown-preview-reader th,.tl-markdown-preview-reader td { border:1px solid var(--tl-theme-border); padding:calc(6px * var(--tl-ui-scale,1)) calc(9px * var(--tl-ui-scale,1)); text-align:left; }
          .tl-markdown-preview-reader th { background:var(--tl-theme-header); font-weight:600; }
          .tl-markdown-preview-reader td { background:transparent; }
          .tl-markdown-preview-reader :not(pre)>code { padding:1px 4px; border-radius:3px; background:var(--tl-theme-header); font-size:.92em; }
          .tl-markdown-preview-reader blockquote { margin:var(--tl-space-3) 0; padding:var(--tl-space-2) var(--tl-space-3); border-left:3px solid var(--tl-theme-accent); background:color-mix(in srgb,var(--tl-theme-accent) 12%,var(--tl-theme-canvas)); }
          .tl-markdown-preview-status { display:grid; align-content:center; min-height:100%; color:var(--tl-theme-muted); font-size:var(--tl-font-body); text-align:center; }
          .tl-markdown-preview-status.is-error { color:var(--tl-theme-warning); }
          .tl-markdown-preview-footer { display:flex; flex:0 0 auto; flex-wrap:wrap; justify-content:space-between; gap:var(--tl-space-2); padding:var(--tl-space-1) var(--tl-space-3); border-top:1px solid var(--tl-theme-border); color:var(--tl-theme-muted); font-size:var(--tl-font-compact); }
          .tl-markdown-preview-footer > * { min-width:0; max-width:100%; }
          .tl-preview-version-details > span { display:block; margin-block:var(--tl-space-1); overflow-wrap:anywhere; }
          .tl-preview-version-details summary { cursor:pointer; }
          .tl-markdown-preview-version-id,.tl-markdown-preview-version-id code { overflow-wrap:anywhere; }
          @media (max-width: 520px) {
            .tl-markdown-preview-header { flex-wrap:wrap; justify-content:flex-start; }
            .tl-markdown-preview-header > strong { flex:1 1 100%; }
            .tl-markdown-preview-controls { width:100%; justify-content:flex-end; flex-wrap:wrap; }
            .tl-markdown-preview-controls button,.tl-markdown-preview-controls a { padding-inline:var(--tl-space-1); }
          }
          .tl-pane-state {
            box-sizing:border-box; display:flex; flex:1 1 auto; min-width:0; min-height:calc(168px * var(--tl-ui-scale, 1));
            flex-direction:column; align-items:center; justify-content:center; gap:calc(7px * var(--tl-ui-scale, 1));
            padding:calc(14px * var(--tl-ui-scale, 1)); border:1px solid color-mix(in srgb,var(--tl-theme-border) 82%,transparent);
            border-radius:calc(8px * var(--tl-ui-scale, 1)); background:color-mix(in srgb,var(--tl-theme-panel) 72%,var(--tl-theme-canvas));
            color:var(--tl-theme-text); text-align:center; font-size:var(--tl-font-body);
          }
          .tl-pane-state-icon { display:grid; width:calc(34px * var(--tl-ui-scale, 1)); height:calc(34px * var(--tl-ui-scale, 1));
            flex:0 0 auto; place-items:center; color:var(--tl-theme-accent); }
          .tl-pane-state-icon > svg { display:block; width:100%; height:100%; }
          .tl-pane-state-symbol { display:inline-flex; align-items:center; justify-content:center; gap:calc(8px * var(--tl-ui-scale, 1)); }
          .tl-pane-state-spinner { box-sizing:border-box; display:block; width:calc(13px * var(--tl-ui-scale, 1)); height:calc(13px * var(--tl-ui-scale, 1));
            flex:0 0 auto; border:calc(1.5px * var(--tl-ui-scale, 1)) solid color-mix(in srgb,var(--tl-theme-accent) 28%,transparent);
            border-top-color:var(--tl-theme-accent); border-radius:50%; animation:tl-pane-state-spin 850ms linear infinite; }
          @keyframes tl-pane-state-spin { to { transform:rotate(1turn); } }
          @media (prefers-reduced-motion: reduce) { .tl-pane-state-spinner { animation:none; } }
          .tl-pane-state.is-error .tl-pane-state-icon { color:var(--tl-theme-warning); }
          .tl-pane-state-title { max-width:100%; margin:0; color:var(--tl-theme-text); font-size:calc(var(--tl-font-body) * 1.14);
            font-weight:600; line-height:1.25; overflow-wrap:anywhere; }
          .tl-pane-state-description { max-width:min(100%,42em); margin:0; color:var(--tl-theme-muted); font-size:var(--tl-font-compact); line-height:1.4; overflow-wrap:anywhere; }
          .tl-pane-state-action { box-sizing:border-box; display:inline-flex; min-height:calc(var(--tl-control-height) * .78); align-items:center; justify-content:center;
            margin-top:calc(2px * var(--tl-ui-scale, 1)); padding:0 calc(10px * var(--tl-ui-scale, 1));
            border:1px solid var(--tl-theme-accent); border-radius:calc(6px * var(--tl-ui-scale, 1));
            background:transparent; color:var(--tl-theme-text); font:inherit; font-size:var(--tl-font-compact); white-space:nowrap; cursor:pointer; }
          .tl-pane-state-action:hover:not(:disabled) { background:var(--tl-theme-accent-soft); }
          .tl-pane-state-action:focus-visible { outline:2px solid var(--tl-theme-accent); outline-offset:2px; }
          .tl-pane-state-action:disabled { opacity:.6; cursor:default; }
          .tl-dock-panel-body.is-native-chat { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
          .tl-dock-panel[data-panel-type="native-workspace"] > .tl-dock-panel-body { display:flex; flex-direction:column; overflow:hidden; padding:0; }
          .tl-dock-panel[data-panel-type="native-workspace"] [data-sidebar-surface-owner] { display:flex; flex:1 1 0; flex-direction:column; min-height:0; min-width:0; }
          .tl-dock-panel[data-panel-type="native-workspace"] [data-path-label] { font-size:var(--tl-font-compact); }
          .tl-dock-panel[data-panel-type="native-workspace"] :is([data-files-path],[data-textpreview-path]) { margin-right:var(--tl-space-2); }
          .tl-dock-panel[data-panel-type="native-workspace"] [data-textpreview-body] pre { font-size:inherit; line-height:inherit; }
          .tl-dock-panel[data-panel-type="native-workspace"] :is(div:has(> [data-files-path]),div:has(> [data-textpreview-path])) { box-sizing:border-box; flex:none; height:auto; min-height:calc(38px * var(--tl-ui-scale,1)); gap:var(--tl-space-1); padding:var(--tl-space-1) var(--tl-space-2); }
          .tl-dock-panel[data-panel-type="native-workspace"] :is([data-files-reload],[data-textpreview-tool]) { box-sizing:border-box; flex:none; width:var(--tl-control-height); height:var(--tl-control-height); padding:var(--tl-space-1); }
          .tl-dock-panel[data-panel-type="native-workspace"] :is([data-files-reload],[data-textpreview-tool]) svg { width:var(--tl-icon-size); height:var(--tl-icon-size); }
          html[data-tradeloom-ui] [data-document-zoom-controls] { box-sizing:border-box; max-width:calc(100% - var(--tl-space-2) * 2); bottom:calc(14px * var(--tl-ui-scale,1)); gap:var(--tl-space-1); padding:var(--tl-space-1) var(--tl-space-2); font-size:var(--tl-font-compact); line-height:1.4; }
          html[data-tradeloom-ui] [data-document-zoom-controls] button { box-sizing:border-box; flex:none; width:var(--tl-control-height); min-width:var(--tl-control-height); height:var(--tl-control-height); min-height:var(--tl-control-height); padding:0; font-size:inherit; line-height:inherit; }
          html[data-tradeloom-ui] [data-document-zoom-controls] button[aria-expanded] { width:auto; min-width:calc(58px * var(--tl-ui-scale,1)); padding-inline:var(--tl-space-2); }
          html[data-tradeloom-ui] [data-document-zoom-controls] svg { width:var(--tl-icon-size); height:var(--tl-icon-size); }
          html[data-tradeloom-ui] [data-menu-material][role="menu"] { box-sizing:border-box; --dsw-menu-surface-fill:var(--tl-theme-panel); --dsw-menu-backdrop-filter:none; min-width:min(calc(144px * var(--tl-ui-scale,1)),calc(100vw - 24px)); max-width:min(calc(360px * var(--tl-ui-scale,1)),calc(100vw - 24px)); padding:var(--tl-space-1); font-family:var(--tl-font-family); font-size:var(--tl-font-compact); line-height:1.4; }
          html[data-tradeloom-ui] [data-menu-material][role="menu"] [role="menuitem"] { box-sizing:border-box; min-height:var(--tl-control-height); gap:var(--tl-space-2); padding:var(--tl-space-1) var(--tl-space-2); font:inherit; }
          html[data-tradeloom-ui] [data-menu-material][role="menu"] [role="menuitem"] svg { width:var(--tl-icon-size); height:var(--tl-icon-size); }
          html[data-tradeloom-ui] [data-menu-material][role="menu"] [role="menuitem"] > span:has(> svg) { flex:none; width:var(--tl-icon-size); height:var(--tl-icon-size); }
          html[data-tradeloom-ui] [data-menu-material][role="menu"] kbd { font-size:inherit; line-height:inherit; }
          .tl-native-path-copy-wrap { position:relative; display:inline-flex; flex:none; }
          .tl-native-path-copy { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; flex:none; width:var(--tl-control-height,28px); height:var(--tl-control-height,28px); padding:var(--tl-space-1,4px); border:1px solid transparent; border-radius:var(--tl-corner-radius,4px); background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
          .tl-native-path-copy svg { width:var(--tl-icon-size,16px); height:var(--tl-icon-size,16px); }
          .tl-native-path-copy:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
          .tl-native-path-copy:focus-visible { outline:2px solid var(--tl-accent,currentColor); outline-offset:1px; }
          .tl-native-path-copy-status { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
          .tl-native-conversation { position:relative; display:flex; flex:1 1 auto; min-width:0; min-height:0; overflow:hidden; }
          /* Native stat dialogs portal to body, outside their conversation's font scope. */
          :is(body.tl-workbench,body:has(.tl-workbench)) [role="dialog"]:has([data-turn-usage-details],[data-session-stats-details]) {
            font-size:var(--tl-font-compact,12px); line-height:1.5;
            padding:calc(16px * var(--tl-ui-scale,1));
            max-height:calc(100dvh - 24px); overflow:auto; overscroll-behavior:contain;
          }
          :is(body.tl-workbench,body:has(.tl-workbench)) [role="dialog"]:has([data-turn-usage-details],[data-session-stats-details]) > div:first-child {
            flex-wrap:wrap; gap:calc(16px * var(--tl-ui-scale,1)); margin-bottom:calc(8px * var(--tl-ui-scale,1));
          }
          :is(body.tl-workbench,body:has(.tl-workbench)) [role="dialog"]:has([data-turn-usage-details],[data-session-stats-details]) svg {
            width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1));
          }
          :is(body.tl-workbench,body:has(.tl-workbench)) :is([data-turn-usage-details],[data-session-stats-details]) {
            gap:calc(6px * var(--tl-ui-scale,1)) calc(16px * var(--tl-ui-scale,1));
          }
          :is(body.tl-workbench,body:has(.tl-workbench)) :is([data-turn-usage-details],[data-session-stats-details]) dd > span {
            white-space:normal; overflow-wrap:anywhere;
          }
          .tl-native-conversation [data-approval-key] > div > div:first-child {
            font-size:calc(13px + var(--dsh-content-font-delta,0px)); line-height:calc(18px + var(--dsh-content-font-delta,0px));
            padding:calc(10px * var(--tl-ui-scale,1)) calc(16px * var(--tl-ui-scale,1)); gap:calc(8px * var(--tl-ui-scale,1));
          }
          .tl-native-conversation [data-approval-scroll] {
            gap:calc(6px * var(--tl-ui-scale,1)); padding:calc(12px * var(--tl-ui-scale,1)) calc(16px * var(--tl-ui-scale,1)) 0;
          }
          .tl-native-conversation [data-approval-scroll] > div:first-child {
            font-size:calc(15px + var(--dsh-content-font-delta,0px)); line-height:calc(24px + var(--dsh-content-font-delta,0px));
          }
          .tl-native-conversation [data-approval-scroll] > div:not(:first-child) {
            font-size:calc(13px + var(--dsh-content-font-delta,0px)); line-height:calc(20px + var(--dsh-content-font-delta,0px));
          }
          .tl-native-conversation [data-approval-key] > div > div:last-child { padding:calc(14px * var(--tl-ui-scale,1)) calc(16px * var(--tl-ui-scale,1)); }
          .tl-native-conversation div[role="status"]:has(> code) { display:flex; flex-wrap:wrap; align-items:flex-start; gap:calc(8px * var(--tl-ui-scale,1)); }
          .tl-native-conversation div[role="status"]:has(> code) > div { flex:1 1 min(18em,calc(100% - 2em)); min-width:0; }
          .tl-native-conversation div[role="status"] > code { flex:0 1 auto; min-width:0; max-width:calc(100% - 2em); font-size:var(--tl-font-compact); line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-variant="others"] [data-disclosure-row] { height:auto; min-height:calc(24px + var(--dsh-content-font-delta,0px)); overflow:visible; }
          .tl-native-conversation [data-variant="others"] [data-disclosure-row] > span:last-child { min-width:0; max-width:100%; }
          .tl-native-conversation [data-variant="others"] [data-disclosure-row] > span:last-child > span:first-child > span:first-child { min-width:0; max-width:100%; flex-shrink:1; white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-variant="others"] [data-disclosure-row] > span:last-child > span:first-child { flex-wrap:wrap; }
          .tl-native-conversation :is([data-variant="bash"],[data-variant="edit"],[data-variant="write"]) [data-disclosure-row] { height:auto; min-height:calc(24px + var(--dsh-content-font-delta,0px)); overflow:visible; }
          .tl-native-conversation :is([data-variant="bash"],[data-variant="edit"],[data-variant="write"]) [data-disclosure-row] > span:last-child { min-width:0; max-width:100%; }
          .tl-native-conversation :is([data-variant="bash"],[data-variant="edit"],[data-variant="write"]) [data-disclosure-row] > span:last-child > span:first-child { flex-wrap:wrap; }
          .tl-native-conversation :is([data-variant="bash"],[data-variant="edit"],[data-variant="write"]) [data-disclosure-row] > span:last-child > span:first-child > span:first-child { min-width:0; max-width:100%; flex-shrink:1; white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-variant="others"] pre { box-sizing:border-box; min-width:0; max-width:100%; padding:calc(12px * var(--tl-ui-scale,1)) calc(16px * var(--tl-ui-scale,1)); font-size:var(--tl-font-compact); line-height:1.5; overflow-wrap:anywhere; }
          .tl-native-conversation [data-turn-process] svg { width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-question-key] > section { display:block; max-height:min(60vh,520px,calc(100cqh - 16px * var(--tl-ui-scale,1))); overflow:auto; padding-bottom:0; }
          .tl-native-conversation [data-question-key] > section > header { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:calc(6px * var(--tl-ui-scale,1)); padding:calc(8px * var(--tl-ui-scale,1)) calc(12px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-question-key] > section > header > div { display:contents; }
          .tl-native-conversation [data-question-key] > section > header > div:first-child > div { grid-column:1; grid-row:1; min-width:0; overflow-wrap:anywhere; }
          .tl-native-conversation [data-question-key] > section > header h2 { grid-column:1 / -1; grid-row:2; min-width:0; overflow-wrap:anywhere; }
          .tl-native-conversation [data-question-key] > section > header > div:last-child > button[aria-expanded] { grid-column:2; grid-row:1; }
          .tl-native-conversation [data-question-key] > section > header > div:last-child > button[aria-label]:not([aria-expanded]) { grid-column:3; grid-row:1; }
          .tl-native-conversation [data-question-key] > section > header > div:last-child > span { grid-column:1 / -1; grid-row:3; white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-question-key] > section > header > div:last-child > button:not([aria-label]) { grid-column:1 / -1; grid-row:4; justify-self:start; }
          .tl-native-conversation [data-question-key] [data-question-scroll] { overflow:visible; }
          .tl-native-conversation [data-question-key] > section > footer { position:sticky; bottom:0; z-index:1; flex-wrap:wrap; gap:calc(6px * var(--tl-ui-scale,1)); margin-top:calc(6px * var(--tl-ui-scale,1)); padding-block:calc(6px * var(--tl-ui-scale,1)); background:var(--dsw-specific-input-major); }
          .tl-native-conversation [data-question-key] > section > footer > div:last-child > button { height:calc(28px * var(--tl-ui-scale,1)); padding-inline:calc(10px * var(--tl-ui-scale,1)); font-size:var(--tl-font-compact); line-height:1.4; }
          .tl-native-conversation [data-question-key] > section:not(:has(> footer)) > header > div:first-child > div { display:none; }
          .tl-native-conversation [data-question-key] > section:not(:has(> footer)) > header h2 { grid-column:1; grid-row:1; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .tl-native-conversation [data-tool] { --dsw-font-xs-13:var(--tl-font-body) / var(--tl-line-height) var(--tl-font-family); --tl-tool-inspect-clearance:calc(88px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] {
            --dsw-font-markdown-base:var(--tl-font-body) / var(--tl-line-height) var(--tl-font-family);
            --dsw-font-markdown-base-strong:600 var(--tl-font-body) / var(--tl-line-height) var(--tl-font-family);
            --dsw-font-markdown-h1:700 calc(21px + var(--dsh-content-font-delta,0px)) / calc(30px + var(--dsh-content-font-delta,0px)) var(--tl-font-family);
            --dsw-font-markdown-h2:700 calc(19px + var(--dsh-content-font-delta,0px)) / calc(28px + var(--dsh-content-font-delta,0px)) var(--tl-font-family);
            --dsw-font-markdown-h3:700 calc(18px + var(--dsh-content-font-delta,0px)) / calc(26px + var(--dsh-content-font-delta,0px)) var(--tl-font-family);
            --dsw-font-markdown-h4:600 var(--tl-font-body) / var(--tl-line-height) var(--tl-font-family);
            --dsw-font-markdown-table:var(--tl-font-compact) / 1.5 var(--tl-font-family);
            --dsw-font-markdown-table-head:500 var(--tl-font-compact) / 1.5 var(--tl-font-family);
            --dsw-font-markdown-code:var(--tl-font-compact) / 1.5 var(--ds-font-family-code);
            --dsw-font-markdown-code-block:var(--tl-font-compact) / 1.5 var(--ds-font-family-code);
            --dsw-font-markdown-code-block-small:var(--tl-font-compact) / 1.5 var(--ds-font-family-code);
          }
          .tl-native-conversation [data-tool] [data-terminal] { --dsl-terminal-line-height:calc(var(--tl-font-compact) * 1.5); --dsl-terminal-gutter:calc(30px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] [data-terminal] > div:first-child { gap:calc(12px * var(--tl-ui-scale,1)); padding-block:calc(9px * var(--tl-ui-scale,1)); padding-inline-end:calc(14px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] [data-terminal] > div:first-child > button { font-size:var(--tl-font-compact); }
          .tl-native-conversation [data-tool] [data-terminal] > div:first-child > span { font-size:var(--tl-font-compact); padding-inline:calc(8px * var(--tl-ui-scale,1)); }
          @container (max-width:440px) {
            .tl-native-conversation [data-tool] [data-terminal] > div:first-child { display:grid; grid-template-columns:minmax(0,1fr) auto; }
            .tl-native-conversation [data-tool] [data-terminal] > div:first-child > div:first-child { grid-column:1 / -1; grid-row:2; }
            .tl-native-conversation [data-tool] [data-terminal] > div:first-child > span { grid-column:1; grid-row:1; justify-self:start; }
            .tl-native-conversation [data-tool] [data-terminal] > div:first-child > button { grid-column:2; grid-row:1; }
            .tl-native-conversation [data-tool] [data-terminal] > div:first-child > div:first-child > div { flex-wrap:wrap; }
            .tl-native-conversation [data-tool] [data-terminal] [data-command-text] { flex:1 1 100%; }
          }
          .tl-native-conversation [data-tool] [data-code-block-banner] { gap:calc(12px * var(--tl-ui-scale,1)); padding:calc(10px * var(--tl-ui-scale,1)) calc(14px * var(--tl-ui-scale,1)); font-size:var(--tl-font-compact); line-height:1.5; }
          .tl-native-conversation [data-tool] [data-code-block-banner] button { width:calc(24px * var(--tl-ui-scale,1)); height:calc(24px * var(--tl-ui-scale,1)); flex:none; }
          .tl-native-conversation [data-tool] [data-code-block-banner] button svg { width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] [data-read] [data-code-block-banner] { flex-wrap:wrap; }
          .tl-native-conversation [data-tool] [data-read] [data-code-block-banner] > div:first-child { flex:1 1 5em; min-width:min(100%,5em); }
          .tl-native-conversation [data-tool] [data-read] [data-code-block-banner] > div:last-child { max-width:100%; flex-wrap:wrap; justify-content:flex-end; }
          .tl-native-conversation [data-tool] [data-read] [data-code-block-banner] > div:last-child > span { white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] [data-search="matches"] > div:last-child button[aria-expanded]:not([aria-label]) { width:max-content; min-width:100%; max-width:none; }
          .tl-native-conversation [data-tool] [data-search] > div:first-child > span { white-space:normal; overflow:visible; overflow-wrap:anywhere; line-height:1.5; }
          .tl-native-conversation [data-tool] [data-align] > button,
          .tl-native-conversation [data-tool] [data-align] > button > span { font-size:var(--tl-font-compact); line-height:1.5; }
          :is(body.tl-workbench,body:has(.tl-workbench)) > [role="dialog"][aria-modal="true"]:has(> div > img) > div > button {
            width:calc(36px * var(--tl-ui-scale,1)); height:calc(36px * var(--tl-ui-scale,1));
            top:calc(20px * var(--tl-ui-scale,1)); right:calc(20px * var(--tl-ui-scale,1));
          }
          :is(body.tl-workbench,body:has(.tl-workbench)) > [role="dialog"][aria-modal="true"]:has(> div > img) > div > button svg {
            width:calc(16px * var(--tl-ui-scale,1)); height:calc(16px * var(--tl-ui-scale,1));
          }
          .tl-native-conversation [data-tool] dt { overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] [data-web] { min-width:0; max-width:100%; box-sizing:border-box; font-size:var(--tl-font-compact); line-height:1.5; }
          .tl-native-conversation [data-tool] [data-web="search"] > ol > li > :is(a,span) { font-size:var(--tl-font-body); line-height:1.5; overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] [data-web="search"] > ol > li > div, .tl-native-conversation [data-tool] [data-web="search"] > div:last-child { font-size:var(--tl-font-compact); line-height:1.5; }
          .tl-native-conversation [data-tool] [data-web="fetch"] > :first-child { min-width:0; font-size:var(--tl-font-compact); line-height:1.5; overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] [data-web="fetch"] > div:last-child { flex-wrap:wrap; gap:calc(6px * var(--tl-ui-scale,1)) calc(12px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] [data-web="fetch"] > div:last-child > span { font-size:var(--tl-font-compact); line-height:1.5; overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] [data-caption] > div:first-child, .tl-native-conversation [data-tool] [data-tone], .tl-native-conversation [data-tool] li > div:not(:has(*)) { font-size:var(--tl-font-compact); line-height:1.5; }
          .tl-native-conversation [data-tool] li > div:has(> [role="img"]) > span:last-child { font-size:var(--tl-font-compact); line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
          .tl-native-conversation [data-tool] li > div:has(> [role="img"]) > button { flex-basis:min(12em,calc(100% - 24px * var(--tl-ui-scale,1))); }
          .tl-native-conversation [data-tool] li > div > [role="img"] { width:calc(14px * var(--tl-ui-scale,1)); height:calc(18px * var(--tl-ui-scale,1)); font-size:calc(16px * var(--tl-ui-scale,1)); line-height:calc(18px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] li > div > [role="img"] > svg { width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] li > div > [role="img"] > span { width:calc(10px * var(--tl-ui-scale,1)); height:calc(10px * var(--tl-ui-scale,1)); border-radius:calc(2px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] details > summary > svg { width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1)); flex:none; }
          .tl-native-conversation [data-tool] div:has(> [data-inspect]) > button { font-size:var(--tl-font-compact); line-height:1.5; }
          .tl-native-conversation [data-tool] div:has(> [data-inspect]) > button svg { width:calc(14px * var(--tl-ui-scale,1)); height:calc(14px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-tool] [data-inspect][data-caption] > div:first-child { padding-inline-end:var(--tl-tool-inspect-clearance); }
          .tl-native-conversation [data-tool][data-state] [data-inspect]:not([data-caption]) > ul > li { padding-inline-end:14px; }
          .tl-native-conversation [data-tool] [data-inspect]:not([data-caption]) { padding-block-start:calc(28px * var(--tl-ui-scale,1)); }
          .tl-chat-file-drop-overlay { position:absolute; z-index:30; inset:var(--tl-space-4); display:grid; place-items:center; border:2px dashed var(--tl-accent); border-radius:var(--tl-corner-radius); background:color-mix(in srgb, var(--tl-accent) 12%, var(--tl-surface) 82%); color:var(--tl-ink); font-size:var(--tl-font-body); font-weight:600; pointer-events:none; }
          .tl-chat-file-drop-status { position:absolute; z-index:31; inset:auto var(--tl-space-4) var(--tl-space-4); display:flex; align-items:center; justify-content:space-between; gap:var(--tl-space-4); padding:var(--tl-space-3) var(--tl-space-4); border:1px solid var(--tl-border); border-radius:var(--tl-corner-radius); background:var(--tl-surface-raised, var(--tl-surface)); color:var(--tl-ink); box-shadow:0 5px 16px rgb(0 0 0 / 20%); font-size:var(--tl-font-compact); }
          .tl-chat-file-drop-status.is-error { border-color:var(--tl-danger); }
          .tl-chat-file-drop-status button { display:inline-grid; place-items:center; flex:none; min-width:var(--tl-control-height); min-height:var(--tl-control-height); border:0; border-radius:var(--tl-corner-radius); background:transparent; color:inherit; cursor:pointer; }
          .tl-chat-file-drop-status button svg { display:block; width:var(--tl-icon-size,15px); height:var(--tl-icon-size,15px); }
          .tl-chat-file-drop-status button:hover,.tl-chat-file-drop-status button:focus-visible { background:var(--tl-surface-soft); outline:2px solid var(--tl-accent); outline-offset:1px; }
          .tl-native-conversation, .tl-dock-panel[data-panel-type="native-workspace"] {
              --dsh-ui-scale: var(--tl-ui-scale, 1);
            --dsh-content-font-size: var(--tl-font-body);
            --dsh-content-font-size-secondary: var(--tl-font-compact);
            --dsh-content-font-delta-secondary: calc(var(--tl-font-compact) - 13px);
            --dsh-content-font-delta: calc(var(--tl-font-body) - 14px);
            --dsw-alias-bg-base: var(--tl-theme-canvas);
            --dsw-alias-bg-module-platform: var(--tl-theme-panel);
            --dsw-alias-bg-layer-1: var(--tl-theme-panel);
            --dsw-alias-bg-layer-2: var(--tl-theme-header);
            --dsw-alias-border-l1: var(--tl-theme-border);
            --dsw-alias-border-l2: var(--tl-theme-border);
            --dsw-alias-border-l3: var(--tl-theme-border);
            --dsw-alias-border-l4: var(--tl-theme-border);
            --dsw-alias-button-info-fill: var(--tl-theme-accent);
            --dsw-alias-button-info-hover: var(--tl-theme-accent-strong);
            --dsw-alias-interactive-bg-hover: var(--tl-theme-accent-soft);
            --dsw-alias-interactive-bg-hover-solid: var(--tl-theme-header);
            --dsw-alias-label-caption: var(--tl-theme-muted);
            --dsw-alias-label-dimmed: var(--tl-theme-muted);
            --dsw-alias-label-primary: var(--tl-theme-text);
            --dsw-alias-label-primary-bluish: var(--tl-theme-accent);
            --dsw-alias-label-primary-dimmed: var(--tl-theme-muted);
            --dsw-alias-label-secondary: var(--tl-theme-muted);
            --dsw-alias-label-tertiary: var(--tl-theme-muted);
            --dsw-alias-scrollbar-bg-l1: var(--tl-theme-border);
            --dsw-alias-scrollbar-bg-l2: var(--tl-theme-border);
            --dsw-alias-scrollbar-hover-l2: var(--tl-theme-muted);
            --dsw-alias-state-business-primary: var(--tl-theme-accent);
            --dsw-alias-state-business-tertiary: var(--tl-theme-accent-soft);
            --dsw-alias-state-error-primary: var(--tl-theme-danger);
            display:flex; flex:1 1 auto; flex-direction:column; min-width:0; min-height:0; overflow:hidden;
            color: var(--tl-theme-text); font-family: var(--tl-font-family); font-size: var(--tl-font-body); line-height: var(--tl-line-height);
          }
          /* Keep native composer sizing and its short-pane container queries.
             Attachment dimensions belong to the attachment slot; broad title/ARIA
             selectors also matched model controls and expanded their toolbar. */
          .tl-native-conversation { container-type: size; }
          .tl-native-conversation > [data-content-phase="active"] { container-type:size; }
          .tl-native-conversation [data-composer-seat] { min-height:0; max-height:100%; overflow-y:auto; overscroll-behavior:contain; }
          .tl-native-conversation > [data-content-phase="active"] [data-composer-seat] { box-sizing:border-box; max-height:max(2lh, calc(100cqh - 2lh)); padding-block-end:var(--tl-space-1, 4px); scroll-padding-block:var(--tl-space-1, 4px); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] { --dsh-ui-scale: var(--tl-ui-scale, 1); container-type:inline-size; }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] { gap:calc(10px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div { height:calc(64px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] { width:calc(240px * var(--tl-ui-scale,1)); max-width:calc(100cqw - 20px); height:calc(64px * var(--tl-ui-scale,1)); gap:calc(10px * var(--tl-ui-scale,1)); padding-inline:calc(12px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > span:first-child { width:calc(28px * var(--tl-ui-scale,1)); height:calc(28px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > span:first-child > svg { width:100%; height:100%; }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > span:first-child > span { width:calc(20px * var(--tl-ui-scale,1)); height:calc(20px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > :nth-child(2) > span:first-child { font-size:var(--tl-font-body); line-height:1.5; }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > :nth-child(2) > span:last-child { font-size:var(--tl-font-compact); line-height:1.25; }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title]:is(:hover,:focus-within) > :nth-child(2) > span:first-child { padding-inline-end:calc(18px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > button:last-of-type { top:calc(6px * var(--tl-ui-scale,1)); right:calc(6px * var(--tl-ui-scale,1)); width:calc(18px * var(--tl-ui-scale,1)); height:calc(18px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > button:last-of-type > svg { width:calc(12px * var(--tl-ui-scale,1)); height:calc(12px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div[title] > span:last-child:not(:first-child) { left:calc(12px * var(--tl-ui-scale,1)); right:calc(12px * var(--tl-ui-scale,1)); bottom:calc(5px * var(--tl-ui-scale,1)); height:calc(2px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div:not([title]) { width:calc(64px * var(--tl-ui-scale,1)); height:calc(64px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div:not([title]) > button:first-child { width:100%; height:100%; }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div:not([title]) > button:last-child { top:calc(4px * var(--tl-ui-scale,1)); right:calc(4px * var(--tl-ui-scale,1)); width:calc(18px * var(--tl-ui-scale,1)); height:calc(18px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] [role="group"] > div > div:not([title]) > button:last-child > svg { width:calc(12px * var(--tl-ui-scale,1)); height:calc(12px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-slot="conversation.input.attachments"] div:has(> [role="group"]) > button { width:calc(24px * var(--tl-ui-scale,1)); height:calc(24px * var(--tl-ui-scale,1)); }
          .tl-native-conversation [data-composer-card] button[aria-haspopup="listbox"] {
            box-sizing:border-box; width:calc(28px * var(--tl-ui-scale, 1)); height:calc(28px * var(--tl-ui-scale, 1));
          }
          .tl-native-conversation [data-composer-card] button[aria-haspopup="menu"] {
            min-height:var(--tl-control-height); padding-inline:var(--tl-space-2);
          }
          .tl-native-conversation [data-composer-card] button:has(> svg path[d^="M8.3125 0.980183"]),
          .tl-native-conversation [data-composer-card] button:has(> svg rect[rx="3"][x="3"][y="3"]) {
            box-sizing:border-box; width:calc(34px * var(--tl-ui-scale, 1)); height:calc(34px * var(--tl-ui-scale, 1));
          }
          .tl-native-conversation [data-composer-card] button[aria-haspopup] svg,
          .tl-native-conversation [data-composer-card] button:has(> svg path[d^="M8.3125 0.980183"]) svg,
          .tl-native-conversation [data-composer-card] button:has(> svg rect[rx="3"][x="3"][y="3"]) svg {
            width:calc(16px * var(--tl-ui-scale, 1)); height:calc(16px * var(--tl-ui-scale, 1));
          }
          @container (max-height: 380px) {
            .tl-native-conversation [data-composer-seat] { --dsh-composer-card-gap:4px; }
            .tl-native-conversation [data-composer-card] > :last-child { row-gap:2px; }
          }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) {
            min-height: calc(34px * var(--tl-ui-scale, 1)); padding: 0 var(--tl-space-3); align-items: center; border-color: var(--tl-theme-border);
            color: var(--tl-theme-text); font-family: var(--tl-font-family); font-size: var(--tl-font-body); line-height: var(--tl-line-height);
          }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-conversation-header-leading] { min-height: calc(30px * var(--tl-ui-scale, 1)); align-items: center; }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-slot="conversation.session.header"] {
            min-width: 0; align-self: center; color: var(--tl-theme-text); font-size: var(--tl-font-body); line-height: var(--tl-line-height);
          }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-slot="conversation.session.header"] nav,
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-slot="conversation.session.header"] nav * {
            color: var(--tl-theme-text); font-size: var(--tl-font-body); line-height: var(--tl-line-height);
          }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-conversation-tabs] {
            gap: calc(18px * var(--tl-ui-scale, 1)); margin-top: var(--tl-space-1); padding-left: var(--tl-space-3);
          }
          :is(.tl-native-conversation > header, .tl-native-conversation [data-slot="conversation.header"] > header) [data-conversation-tabs] [role="tab"] {
            padding: 0 0 var(--tl-space-1); font-size: var(--tl-font-compact); line-height: 1.2;
          }
          .tl-native-conversation > [data-content-phase] { flex:1 1 auto; min-width:0; min-height:0; }
          .tl-dock-panel-body.is-native-chat [data-content-phase="active"] [data-conversation-scroll] > [data-slot="conversation.session"]:not(:has([data-slot="conversation.view"])) + [data-composer-seat] { margin-block-start:auto; }
          .tl-erpnext-status { display: flex; flex-direction: column; gap: 8px; min-width: 0; color: var(--tl-ink); }
          .tl-erpnext-status-heading, .tl-erpnext-controls, .tl-erpnext-pagination, .tl-erpnext-detail-heading {
            display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
          }
          .tl-erpnext-status-heading h3, .tl-erpnext-detail-heading h4 { flex: 1 1 auto; margin: 0; font-size: var(--tl-font-body); }
          .tl-erpnext-status p, .tl-erpnext-source { margin: 0; color: var(--tl-muted); font-size: var(--tl-font-compact); }
          .tl-erpnext-status a { align-self: flex-start; color: var(--tl-accent); }
          .tl-erpnext-entry-actions { display:flex; flex:0 0 auto; flex-wrap:wrap; align-items:center; gap:8px; padding:4px 0; }
          .tl-erpnext-entry-actions a { display:inline-flex; min-height:var(--tl-control-height); align-items:center; padding:0 10px; border:1px solid var(--tl-accent); border-radius:var(--tl-corner-radius); background:var(--tl-accent); color:var(--tl-surface); font-size:var(--tl-font-compact); text-decoration:none; }
          .tl-erpnext-entry-actions a:focus-visible { outline:2px solid var(--tl-accent); outline-offset:2px; }
          .tl-erpnext-browser { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; }
          .tl-erpnext-controls label { display: inline-flex; align-items: center; gap: 6px; color: var(--tl-muted); }
          .tl-erpnext-controls button, .tl-erpnext-controls select, .tl-erpnext-browser button,
          .tl-erpnext-status-heading button, .tl-erpnext-status > button, .tl-erpnext-detail-heading button {
            min-height: var(--tl-control-height); padding: 4px 9px; border: 1px solid var(--tl-border); border-radius: var(--tl-corner-radius);
            background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: var(--tl-font-compact); cursor: pointer;
          }
          .tl-erpnext-browser button:hover, .tl-erpnext-status button:hover { background: var(--tl-surface-hover); }
          .tl-erpnext-browser button:focus-visible, .tl-erpnext-status button:focus-visible,
          .tl-erpnext-controls select:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          .tl-erpnext-table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--tl-border); border-radius: 5px; }
          .tl-erpnext-table-wrap table { border-collapse: collapse; width: 100%; min-width: 640px; background: var(--tl-surface); }
          .tl-erpnext-table-wrap th, .tl-erpnext-table-wrap td { padding: 6px 8px; border-bottom: 1px solid var(--tl-border); text-align: left; white-space: nowrap; }
          .tl-erpnext-table-wrap th { position: sticky; top: 0; background: var(--tl-surface-soft); color: var(--tl-muted); font-weight: 600; }
          .tl-erpnext-pagination { justify-content: flex-end; color: var(--tl-muted); font-size: var(--tl-font-compact); }
          .tl-erpnext-detail { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding-top: 8px; border-top: 1px solid var(--tl-border); }
          .tl-erpnext-detail dl { display: grid; grid-template-columns: minmax(100px, 0.35fr) minmax(0, 1fr); gap: 4px 10px; margin: 0; }
          .tl-erpnext-detail dt { color: var(--tl-muted); }
          .tl-erpnext-detail dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
          .tl-erpnext-child-table h5 { margin: 4px 0; font-size: var(--tl-font-compact); }
          .tl-erpnext-child-table pre { max-width: 100%; overflow: auto; padding: 8px; border: 1px solid var(--tl-border); border-radius: 5px; background: var(--tl-surface-soft); color: var(--tl-ink); }
          .tl-erpnext-draft { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding-top: 8px; border-top: 1px solid var(--tl-border); }
          .tl-erpnext-draft-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
          .tl-erpnext-draft-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; color: var(--tl-muted); font-size: var(--tl-font-compact); }
          .tl-erpnext-draft-field input { box-sizing: border-box; width: 100%; min-height: var(--tl-control-height); padding: 5px 7px; border: 1px solid var(--tl-border); border-radius: var(--tl-corner-radius); background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: var(--tl-font-body); }
          .tl-erpnext-draft-field input:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          .tl-erpnext-draft-items { display: flex; flex-direction: column; gap: 6px; }
          .tl-erpnext-draft-item { display: grid; grid-template-columns: repeat(4, minmax(90px, 1fr)) auto; align-items: end; gap: 6px; }
          .tl-erpnext-draft-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
          .tl-erpnext-draft-actions button { min-height: var(--tl-control-height); padding: 4px 9px; border: 1px solid var(--tl-border); border-radius: var(--tl-corner-radius); background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: var(--tl-font-compact); cursor: pointer; }
          .tl-erpnext-draft-actions button:hover { background: var(--tl-surface-hover); }
          .tl-erpnext-draft-actions button:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          @media (max-width: 760px) { .tl-erpnext-draft-item { grid-template-columns: repeat(2, minmax(100px, 1fr)); } }
          .tl-dock-panel-picker { display: inline-flex; align-items: center; gap: 6px; color: var(--tl-muted); font-size: var(--tl-font-body); }
          @media (max-width: 760px) {
            .tl-workbench { padding: 12px; }
            .tl-workbench { --tl-panel-inset: 10px; --tl-toolbar-inset: 10px; }
            .tl-dock-toolbar { min-height: var(--tl-toolbar-height); }
          }
        `),
        h('div', { className: 'tl-scene-docks' }, state.config.scenes.filter(item => visited.has(item.id)).map(item => h(SceneDock, {
          key: item.id, scene: item, active: item.id === scene.id, SessionProvider, renderSlot, renderFactorySlot, dockviewModule,
        }))))
    }

    function assistantLabel(roleId, config = snapshot.config) {
      return config?.roles?.find(role => role.id === roleId)?.assistantLabel ?? '工作助手'
    }

    function dockviewTheme(colorScheme) {
      const dark = colorScheme === 'dark'
      return {
        name: dark ? 'abyss' : 'light',
        className: dark ? 'dockview-theme-abyss' : 'dockview-theme-light',
        colorScheme: dark ? 'dark' : 'light',
        gap: 10,
        tabGroupIndicator: 'none',
      }
    }

    return {
      SceneTabs, AIWebRail, ModelDirectoryRail, ModelDirectoryFailure, SceneWorkbench, SceneChatPanel, NativeChatPanel, NativeWorkspacePanel, PaneState, ArtifactMarkdownPreview, ERPNextStatus, ERPNextQuotationDraft, retainRoleSession, retainListedRoleSession, releaseRoleSessions, modelDirectoryEntries, providerBadgeLabel, currentModelLabel, modelDirectoryDiagnostic, workbenchUiStyles,
      useRoleModelGroups, WorkflowCanvasPane, BusinessPaneTabs,
      PANEL_REGISTRY: Object.freeze({ 'business-iframe': BusinessFrame, placeholder: Placeholder, 'native-chat': SceneChatPanel, 'native-workspace': NativeWorkspacePanel, 'erpnext-status': ERPNextStatus }),
      bindSession, roleBindingStatus, RoleBindingDetails, rememberLayout, roleForScene, roleForPanel, selectScene, updatePanelLayout, createFileSelectionMessageHandler,
      selectRole, bindRoleSession, navigateBusiness, navigateScene, sceneNavigationItems, sceneTabsNeedCompact, assistantLabel,
      ensureRoleSession,
      createLocalPanelExpansionController,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      retryLoadConfig: () => loadConfig(true),
      getDockviewApi: sceneId => dockviewApis.get(sceneId),
      getPopoutBusinessFrames: () => registeredPopoutBusinessFrames(),
      getFileSelection: sceneId => fileSelectionByScene.get(sceneId) ?? null,
      getSnapshot: () => snapshot,
      register(ctx, onBusinessOrigin, onRoleMetadataState, palette = {}, uiTokens = {}, { registerWorkbenchRoot = true } = {}) {
        activeUiTokens = uiTokens
        activePalette = palette
        layoutApi = ctx.layout
        uiWorkspaceApi = ctx.uiWorkspace
        sessionsApi = ctx.sessions
        modelDirectoriesApi = ctx.modelDirectories
        themeApi = ctx.theme
        activeColorScheme = ctx.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
        const updateColorScheme = theme => {
          const colorScheme = theme?.active?.colorScheme ?? ctx.theme?.getTheme?.()?.active?.colorScheme
          activeColorScheme = colorScheme === 'dark' ? 'dark' : 'light'
          notifyPopoutThemeChange()
          publish({ themeRevision: (snapshot.themeRevision ?? 0) + 1 })
        }
        const updateMotionPreference = () => notifyPopoutMotionPreferenceChange()
        const canListenForMotionPreference = typeof window.addEventListener === 'function'
        if (canListenForMotionPreference) window.addEventListener('tradeloom:workbench-motion-preference-change', updateMotionPreference)
        // Cordis owns ctx.on() listeners on this plugin fiber and disposes them automatically.
        ctx.on?.('theme/change', updateColorScheme)
        businessOriginCallback = onBusinessOrigin
        roleDefinitionsCallback = onRoleMetadataState
        if (snapshot.config?.roles) roleDefinitionsCallback?.({
          status: 'ready', error: '',
          roles: snapshot.config.roles.map(({ id, label, assistantLabel }) => ({ id, label, assistantLabel })),
        })
        else roleDefinitionsCallback?.({ status: 'loading', error: '', roles: null })
        ctx.effect?.(() => () => {
          if (canListenForMotionPreference && typeof window.removeEventListener === 'function') {
            window.removeEventListener('tradeloom:workbench-motion-preference-change', updateMotionPreference)
          }
          businessOriginCallback = undefined
          roleDefinitionsCallback = undefined
          releaseRoleSessions()
          dockviewApis.clear()
          pendingPopoutRestoreByScene.clear()
          pendingScenePanelFocus.clear()
          pendingClosedPanelPositions.clear()
          dockviewRenderers.clear()
          dockGroupRenderers.clear()
          dockRenderContexts.clear()
          narrowListeners.clear()
        }, 'tradeloom scene workbench role sessions')
        if (registerWorkbenchRoot) {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: 'scene-workbench',
            children: { 'scene.workbench.chat': { kind: 'single', scope: 'session' } },
          }, SceneWorkbench))
        }
        for (const name of ['sidebar.right.tab.files.actions', 'sidebar.right.tab.document.actions']) {
          ctx.slots.inject(name, () => ctx.slots.register({ name, id:'tradeloom-copy-path', order:-20 }, NativePathCopyAction))
        }
        ctx.slots.inject('scene.workbench.chat', () => ctx.slots.register({
          name: 'scene.workbench.chat',
          inject: sessionId => ({
            nativeHeaderFactoryAvailable: ctx.slots.snapshot?.().some(node => node.type === 'factory' && node.name === 'conversation.header.frame') === true,
            onAddFiles: files => {
              if (typeof sessionId !== 'string' || !Array.isArray(files) || files.length === 0) return false
              const scope = sessionsApi?.scope?.(sessionId)
              const conversation = scope?.get?.('conversation')
              return typeof conversation?.addDraftFiles === 'function' ? conversation.addDraftFiles(files) : false
            },
          }),
        }, SceneChatPanel))
      },
    }
  },
})
