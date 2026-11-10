'use strict'

const CHANNELS = Object.freeze({
  STATUS: 'tradeloom:webai:status',
  PROGRESS: 'tradeloom:webai:progress',
})

function safeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = ['targetId', 'providerId', 'requestId', 'phase', 'code']
  const result = {}
  for (const key of allowed) {
    if (typeof value[key] === 'string') result[key] = value[key]
  }
  if (!result.targetId || !result.providerId || !result.phase) return null
  return Object.freeze(result)
}

/** Merge this API into the existing app preload object; never expose a second app object. */
function createWebAiPreloadApi(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function'
    || typeof ipcRenderer.on !== 'function' || typeof ipcRenderer.removeListener !== 'function') {
    throw new TypeError('IPC_UNAVAILABLE')
  }
  return Object.freeze({
    getStatus(targetId) {
      if (typeof targetId !== 'string' || !targetId) return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST' } })
      return ipcRenderer.invoke(CHANNELS.STATUS, targetId)
    },
    onProgress(targetId, listener) {
      if (typeof targetId !== 'string' || !targetId || typeof listener !== 'function') return () => {}
      const handler = (_event, payload) => {
        const safe = safeProgress(payload)
        if (safe?.targetId === targetId) listener(safe)
      }
      ipcRenderer.on(CHANNELS.PROGRESS, handler)
      return () => ipcRenderer.removeListener(CHANNELS.PROGRESS, handler)
    },
  })
}

module.exports = { CHANNELS, createWebAiPreloadApi }
