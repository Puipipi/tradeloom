import { isMainFrameNavigation } from './webai-native-site-adapter.js'

// Upstream sending/new-message/completion patterns reviewed:
// https://github.com/mashanglinyu/luanyujia-workbench/blob/ee87f1cfb05e7203062818a59bcb4554a2848fe7/12-源码照搬/外壳/renderer/webai-bridge.js#L194
// Generic DOM/text changes do not prove assistant role or conversation identity.
// A production producer must wait for the actual two-site protocol observation.
const providers = ['deepseek', 'doubao']
const fail = code => Object.assign(Error(code), { code })

export function createWebAiSiteTransport({ providerId, site, window }) {
  if (!providers.includes(providerId)) throw fail('webai_site_adapter_unavailable')
  const contents = window.webContents
  let closed = false
  function unsupported() {
    if (closed || window.isDestroyed() || contents.isDestroyed() || site.liveWindow() !== window) throw fail('webai_target_unavailable')
    // No random IDs, inferred role, DOM writes, or authorization fallback.
    throw fail('webai_site_protocol_unverified')
  }
  return Object.freeze({
    protocolReady: false,
    unavailableReason: 'webai_site_protocol_unverified',
    inspect: async () => unsupported(),
    send: async () => unsupported(),
    onAssistantMessage() { return () => {} },
    onConversationChange() { return () => {} },
    dispose() { closed = true },
  })
}

// Existing Main windows only; never opens a window/profile or changes login.
// Registered-but-unverified is explicitly distinct from ready/connected.
export function connectWebAiSiteTransports({ targets, aiWebWindows }) {
  const registrations = new Map()
  function dispose(provider) {
    const entry = registrations.get(provider)
    if (!entry) return
    registrations.delete(provider)
    try { entry.unregister() }
    finally {
      entry.window.removeListener('closed', entry.closed)
      entry.window.webContents.removeListener('did-start-navigation', entry.navigated)
      entry.window.webContents.removeListener('destroyed', entry.closed)
      entry.transport.dispose()
    }
  }
  return Object.freeze({
    sync() {
      for (const providerId of providers) {
        const site = aiWebWindows.windows.get(providerId), window = site?.liveWindow()
        const previous = registrations.get(providerId)
        if (previous?.window === window && window && !window.isDestroyed() && !window.webContents.isDestroyed()) continue
        if (previous) dispose(providerId)
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) continue
        const transport = createWebAiSiteTransport({ providerId, site, window })
        try {
          const unregister = targets.register(providerId, transport), closed = () => dispose(providerId)
          const navigated = (...args) => { if (isMainFrameNavigation(...args)) dispose(providerId) }
          registrations.set(providerId, { window, transport, unregister, closed, navigated })
          window.once('closed', closed)
          window.webContents.on('did-start-navigation', navigated)
          window.webContents.once('destroyed', closed)
        } catch (error) { transport.dispose(); throw error }
      }
    },
    dispose() {
      const failures = []
      for (const providerId of [...registrations.keys()]) try { dispose(providerId) } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'webai_site_cleanup_failed')
    },
  })
}
