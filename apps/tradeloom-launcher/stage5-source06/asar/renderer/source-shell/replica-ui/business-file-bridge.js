/* Fixed same-origin file selection bridge for the source-shell business panes. */
(() => {
  const FILE_EXPORT_TIMEOUT_MS = 15000
  const FILE_FOCUS_TIMEOUT_MS = 5000
  const selectionsByScene = new Map()

  function filePanelRole(panel) {
    if (panel?.type !== 'business-iframe') return ''
    if (panel.path === '/artifacts#files') return 'files'
    if (panel.path === '/artifacts#preview') return 'preview'
    if (panel.path === '/artifacts#deliverables' && panel.id === 'business-main') return 'deliverables'
    return ''
  }

  function canonicalOrigin(value) {
    if (value && value !== 'null') return value
    if (window.location.protocol === 'dsh-app:' && window.location.host === 'app') return 'dsh-app://app'
    return window.location.origin
  }

  function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(value)
  }

  function create(options = {}) {
    const { scene, getFrames, getBusinessPath = () => '', onSelection = () => {} } = options
    const origin = canonicalOrigin(options.origin)
    const sceneId = scene?.id
    const panels = Array.isArray(scene?.panels) ? scene.panels : null
    const state = typeof sceneId === 'string' && sceneId
      ? (selectionsByScene.get(sceneId) ?? { selection: null, generation: 0, source: null })
      : { selection: null, generation: 0, source: null }
    if (typeof sceneId === 'string' && sceneId) selectionsByScene.set(sceneId, state)

    const pendingExports = new Map()
    const pendingFocus = new Map()
    let requestSequence = 0
    let disposed = false

    const framesNow = () => {
      if (!panels || typeof getFrames !== 'function') return []
      let frames
      try { frames = Array.from(getFrames() ?? []) } catch { return [] }
      return frames.filter(frame => frame?.tagName === 'IFRAME' && frame.isConnected
        && panels.some(panel => panel.id === frame.dataset?.tradeloomPanelId && panel.type === 'business-iframe'))
    }
    const send = (frame, message) => {
      if (disposed || !frame?.isConnected || typeof frame.contentWindow?.postMessage !== 'function') return false
      try { frame.contentWindow.postMessage(message, origin); return true } catch { return false }
    }

    function frameRole(frame) {
      if (!frame?.isConnected || frame.tagName !== 'IFRAME' || !frame.src || !panels) return ''
      const panel = panels.find(item => item.id === frame.dataset?.tradeloomPanelId && item.type === 'business-iframe')
      if (!panel) return ''
      let frameUrl
      try { frameUrl = new URL(frame.src, origin) } catch { return '' }
      const frameOrigin = frameUrl.protocol === 'dsh-app:' && frameUrl.host === 'app' ? 'dsh-app://app' : frameUrl.origin
      if (frameOrigin !== origin) return ''

      if (panel.id === 'business-main' && sceneId === 'agent-center') {
        let businessPath
        try { businessPath = getBusinessPath?.() || panel.path } catch { businessPath = panel.path }
        if (businessPath && frameUrl.pathname === `/business${businessPath.split('#')[0]}` && frameUrl.hash === '') {
          return /^\/workflow-tasks\/[A-Za-z0-9_-]{1,128}$/.test(businessPath) ? 'workflow-tasks' : ''
        }
      }
      if (frameUrl.pathname !== `/business${panel.path?.split('#')[0]}`
        || frameUrl.hash !== (panel.path?.includes('#') ? `#${panel.path.split('#')[1]}` : '')) return ''
      return filePanelRole(panel)
    }

    function requestFileExport(kind, id, onResult) {
      if (disposed || !['source', 'artifact'].includes(kind) || !validId(id) || typeof onResult !== 'function') return false
      const currentFrames = framesNow()
      const candidates = currentFrames.filter(frame => {
        const role = frameRole(frame)
        return kind === 'source' ? role === 'files' : ['files', 'deliverables'].includes(role)
      })
      const selectedSource = state.source?.kind === kind && state.source.id === id ? state.source : null
      const target = selectedSource && candidates.find(frame => frame === selectedSource.frame
        && frame.contentWindow === selectedSource.contentWindow)
      if (!target) return false
      const nonce = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID() : `tradeloom-${Date.now()}-${++requestSequence}`
      const timeout = window.setTimeout(() => {
        const pending = pendingExports.get(nonce)
        if (!pending) return
        pendingExports.delete(nonce)
        pending.onResult({ ok: false, error: '文件导出超时，请重试。' })
      }, FILE_EXPORT_TIMEOUT_MS)
      pendingExports.set(nonce, { kind, id, source: target.contentWindow, onResult, timeout })
      if (!send(target, { type: 'tradeloom:file-export-request', kind, id, nonce })) {
        pendingExports.delete(nonce)
        window.clearTimeout(timeout)
        return false
      }
      return true
    }

    function requestFileFocus(kind, id, onResult) {
      if (disposed || !['source', 'artifact'].includes(kind) || !validId(id) || typeof onResult !== 'function'
        || state.selection?.kind !== kind || state.selection.id !== id) return false
      const frame = framesNow().find(item => frameRole(item) === 'files') ?? null
      const nonce = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID() : `tradeloom-focus-${Date.now()}-${++requestSequence}`
      const generation = state.generation
      const timeout = window.setTimeout(() => {
        const pending = pendingFocus.get(nonce)
        if (!pending) return
        pendingFocus.delete(nonce)
        pending.onResult({ ok: false, found: false, error: '文件栏未能定位到此版本，请重试。' })
      }, FILE_FOCUS_TIMEOUT_MS)
      const pending = { kind, id, source: null, targetFrame: frame, generation, onResult, timeout }
      pendingFocus.set(nonce, pending)
      if (frame?.contentWindow) {
        pending.source = frame.contentWindow
        if (!send(frame, { type: 'tradeloom:file-focus', kind, id, nonce })) {
          pendingFocus.delete(nonce)
          window.clearTimeout(timeout)
          return false
        }
      }
      return true
    }

    function handleMessage(event) {
      if (disposed || !sceneId || !panels || event?.origin !== origin) return false
      const frames = framesNow()
      const frame = frames.find(item => item.contentWindow === event.source)
      const role = frameRole(frame)
      if (!role || !frame?.src) return false
      const data = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false
      const exact = keys => Object.keys(data).sort().join(',') === [...keys].sort().join(',')
      const sendSelection = target => state.selection ? send(target, { type: 'tradeloom:file-selection', ...state.selection }) : false

      if (data.type === 'tradeloom:file-export-response') {
        const exactSuccess = exact(['type', 'kind', 'id', 'nonce', 'name', 'mimeType', 'lastModified', 'blob'])
        const exactFailure = exact(['type', 'kind', 'id', 'nonce', 'error'])
        const pending = typeof data.nonce === 'string' ? pendingExports.get(data.nonce) : null
        if ((!exactSuccess && !exactFailure) || typeof data.nonce !== 'string' || data.nonce.length > 128
          || !['source', 'artifact'].includes(data.kind) || !validId(data.id)) return false
        if (!pending || pending.source !== event.source || pending.kind !== data.kind || pending.id !== data.id
          || !['files', 'deliverables', 'workflow-tasks'].includes(role)) return false
        if (pending.kind === 'source' && role !== 'files') return false
        if (pending.kind === 'artifact' && !['files', 'deliverables', 'workflow-tasks'].includes(role)) return false
        pendingExports.delete(data.nonce)
        window.clearTimeout(pending.timeout)
        if (exactFailure && typeof data.error === 'string' && data.error.trim()) {
          pending.onResult({ ok: false, error: data.error.slice(0, 240) })
          return true
        }
        if (!(data.blob instanceof window.Blob) || !Number.isSafeInteger(data.blob.size) || data.blob.size < 0
          || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 255
          || typeof data.mimeType !== 'string' || data.mimeType.length > 128
          || !Number.isSafeInteger(data.lastModified) || data.lastModified < 0) {
          pending.onResult({ ok: false, error: '文件数据无效，未添加到会话。' })
          return false
        }
        let file
        try { file = new window.File([data.blob], data.name, { type: data.mimeType, lastModified: data.lastModified }) }
        catch { pending.onResult({ ok: false, error: '无法创建附件文件，未添加到会话。' }); return false }
        pending.onResult({ ok: true, file, blobMimeType: typeof data.blob.type === 'string' ? data.blob.type : '' })
        return true
      }

      if (data.type === 'tradeloom:file-focus-result') {
        if (!exact(['type', 'kind', 'id', 'nonce', 'found']) || role !== 'files'
          || !['source', 'artifact'].includes(data.kind) || !validId(data.id)
          || typeof data.nonce !== 'string' || data.nonce.length > 128 || typeof data.found !== 'boolean') return false
        const pending = pendingFocus.get(data.nonce)
        if (!pending || pending.source !== event.source || pending.kind !== data.kind || pending.id !== data.id) return false
        pendingFocus.delete(data.nonce)
        window.clearTimeout(pending.timeout)
        if (pending.generation !== state.generation || state.selection?.kind !== pending.kind || state.selection.id !== pending.id) {
          pending.onResult({ ok: false, found: false, error: '所选版本已变化，请重新定位。' })
          return false
        }
        if (data.found) state.source = { ...state.selection, frame, contentWindow: event.source }
        pending.onResult({ ok: true, found: data.found })
        return true
      }

      if (role === 'files' && data.type === 'tradeloom:files-ready' && exact(['type'])) {
        sendSelection(frame)
        for (const [nonce, pending] of pendingFocus) {
          if ((pending.targetFrame && pending.targetFrame !== frame) || pending.generation !== state.generation
            || state.selection?.kind !== pending.kind || state.selection.id !== pending.id) continue
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
      if (['files', 'deliverables', 'workflow-tasks'].includes(role) && data.type === 'tradeloom:file-selection'
        && validSelectionShape && (role === 'files' || data.kind === 'artifact')
        && ['source', 'artifact'].includes(data.kind) && validId(data.id)
        && (selectionKeys === 'id,kind,type' || data.kind === 'artifact' && data.previewMime === 'text/markdown')) {
        state.selection = { kind: data.kind, id: data.id,
          ...(data.previewMime === 'text/markdown' ? { previewMime: 'text/markdown' } : {}) }
        state.source = { ...state.selection, frame, contentWindow: event.source }
        state.generation++
        for (const [nonce, pending] of pendingFocus) {
          if (pending.generation === state.generation) continue
          pendingFocus.delete(nonce)
          window.clearTimeout(pending.timeout)
          pending.onResult({ ok: false, found: false, error: '所选版本已变化，请重新定位。' })
        }
        try { onSelection({ ...state.selection }, { sceneId, generation: state.generation }) } catch {}
        for (const candidate of frames) {
          if (candidate === frame) continue
          const candidateRole = frameRole(candidate)
          if (candidateRole === 'preview' || candidateRole === 'files'
            || candidateRole === 'deliverables' && state.selection.kind === 'artifact') sendSelection(candidate)
        }
        return true
      }

      if (role === 'preview' && data.type === 'tradeloom:file-request-selection' && exact(['type'])) {
        sendSelection(frame)
        if (!state.selection) {
          for (const candidate of frames) {
            if (['files', 'deliverables'].includes(frameRole(candidate))) send(candidate, { type: 'tradeloom:file-request-selection' })
          }
        }
        return true
      }
      return false
    }

    handleMessage.requestFileExport = requestFileExport
    handleMessage.requestFileFocus = requestFileFocus
    handleMessage.dispose = () => {
      if (disposed) return
      disposed = true
      for (const pending of pendingExports.values()) {
        window.clearTimeout(pending.timeout)
        pending.onResult({ ok: false, error: '场景已切换，文件导入已取消。' })
      }
      pendingExports.clear()
      for (const pending of pendingFocus.values()) {
        window.clearTimeout(pending.timeout)
        pending.onResult({ ok: false, found: false, error: '场景已切换，文件定位已取消。' })
      }
      pendingFocus.clear()
    }
    return handleMessage
  }

  window.TradeLoomBusinessFileBridge = Object.freeze({ create })
})()
