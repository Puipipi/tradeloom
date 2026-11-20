window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.session-audio.js',
  factory(require) {
    const React = require('react'), h = React.createElement
    const matchesSurfaceDescriptor = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(key => a[key] === b[key])
    function register(ctx, descriptor, bridge, reportNotice) {
      if (descriptor.kind !== 'role' || descriptor.surface !== 'chat') return
      const expected = Object.freeze({ ...descriptor })
      function SessionAudio({ sessionId }) {
        const [enabled, setEnabled] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
        const current = React.useRef(null), live = React.useRef(false), confirmed = React.useRef(null)
        const [controlsOpen, setControlsOpen] = React.useState(false)
        // The existing parent panel menu sends a fixed, Main-checked UI intent.
        const menuAction = React.useRef(null)
        // An IPC notification carries no guest transient user activation. It
        // only opens controls; the guest button below owns start()/resume().
        menuAction.current = () => { confirmed.current = expected; setControlsOpen(true) }
        React.useEffect(() => {
          if (sessionId !== expected.sessionId) return
          let active = true
          const stopIntent = bridge.onNativeUtilityRequested(request => {
            if (!active || request?.action !== 'session-speech' || !matchesSurfaceDescriptor(request.descriptor, expected)) return
            void Promise.resolve(bridge.nativeSurfaceDescriptor()).then(current => {
              if (!active || !matchesSurfaceDescriptor(current, expected)) return
              return menuAction.current?.()
            }).catch(() => { if (active) reportNotice?.('当前会话操作未完成，请重新打开菜单。') })
          })
          return () => { active = false; stopIntent() }
        }, [sessionId])
        React.useEffect(() => { if (error) reportNotice?.('回复朗读未完成，请检查语音设置或当前会话。') }, [error])
        async function request(action, lease, signal) {
          const stopping = action === 'stop'
          const before = await bridge.nativeSurfaceDescriptor()
          if (stopping ? before?.kind !== 'role' : !live.current || sessionId !== expected.sessionId || !matchesSurfaceDescriptor(before, expected)) throw Error('session_speech_binding_changed')
          const body = JSON.stringify({ id: crypto.randomUUID(), action, ...(lease ? { lease } : {}) })
          const grant = await bridge.issueSceneMemoryOriginGrant({ endpoint: 'tradeloom/session-audio', httpMethod: 'POST', bodyBytes: new TextEncoder().encode(body) })
          if (!grant?.token || !stopping && (!live.current || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected))) throw Error('session_speech_binding_changed')
          const response = await fetch('/tradeloom/session-audio', { method: 'POST', credentials: 'same-origin', signal,
            headers: { 'content-type': 'application/json', 'x-tradeloom-origin': grant.token }, body })
          const result = await response.json()
          if (!response.ok || result.ok !== true) throw Error(result.error_code || 'session_speech_unavailable')
          if (!stopping && (!live.current || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected))) throw Error('session_speech_binding_changed')
          return result.result
        }
        async function stop(notify = true) {
          const active = current.current
          if (!active) return
          current.current = null
          clearTimeout(active.timer); active.abort.abort(); active.queue.length = 0
          let cleanupFailed = false
          try { active.source?.stop() } catch { cleanupFailed = true }
          try { await active.audio.close() } catch { cleanupFailed = true }
          // Unmounted/changed frames cannot mint another grant; the Host's
          // expiring subscription still joins its worker if this request fails.
          if (notify && active.lease) await request('stop', active.lease).catch(() => {})
          if (cleanupFailed && live.current) setError('session_speech_playback_cleanup_failed')
          if (live.current) setEnabled(false)
        }
        React.useEffect(() => {
          live.current = true
          const dispose = bridge.onNativeSurfaceChanged(next => { if (!matchesSurfaceDescriptor(next, expected)) { confirmed.current = null; setControlsOpen(false); void stop(); if (next) live.current = false } })
          return () => { live.current = false; confirmed.current = null; void stop(); dispose() }
        }, [])
        async function start() {
          if (!live.current || sessionId !== expected.sessionId || !matchesSurfaceDescriptor(confirmed.current, expected) || current.current || busy) return
          // Resume on the actual user gesture; later owned WAVs use this same
          // context, rather than depending on an autoplay exemption.
          const audio = new AudioContext()
          const active = { audio, abort: new AbortController(), queue: [], source: null, lease: null, timer: null }
          current.current = active; setBusy(true); setError('')
          function playNext() {
            if (current.current !== active || active.source || !active.queue.length) return
            const source = audio.createBufferSource(); source.buffer = active.queue.shift(); source.connect(audio.destination)
            active.source = source
            source.onended = () => { source.disconnect(); active.source = null; playNext() }
            source.start()
          }
          async function poll() {
            if (current.current !== active || !live.current) return
            try {
              const result = await request('poll', active.lease, active.abort.signal)
              if (current.current !== active) return
              if (result.error) setError(result.error)
              if (result.audio) {
                if (result.audio.mimeType !== 'audio/wav' || result.audio.bytes.length > 34 * 1024 * 1024 || active.queue.length >= 2) throw Error('session_speech_audio_limit')
                const bytes = Uint8Array.from(atob(result.audio.bytes), char => char.charCodeAt(0))
                const buffer = await audio.decodeAudioData(bytes.buffer)
                if (current.current !== active || !matchesSurfaceDescriptor(await bridge.nativeSurfaceDescriptor(), expected)) return
                active.queue.push(buffer); playNext()
              }
              if (current.current === active) active.timer = setTimeout(() => void poll(), 2_000)
            } catch (failure) {
              if (current.current !== active) return
              setError(failure.message); await stop()
            }
          }
          try {
            // resume() starts synchronously in the real guest click, before
            // any descriptor/Host await. No autoplay override is installed.
            const resumed = audio.resume()
            await resumed
            if (current.current !== active || !live.current || !matchesSurfaceDescriptor(confirmed.current, expected)) { await stop(false); return }
            const result = await request('start', null, active.abort.signal)
            if (current.current !== active) return
            active.lease = result.lease; setEnabled(true); void poll()
          } catch (failure) { if (live.current) setError(failure.message); await stop() }
          finally { if (live.current) setBusy(false) }
        }
        if (sessionId !== expected.sessionId || !controlsOpen) return null
        return h('dialog', { open: true, 'aria-label': '当前会话回复朗读', style: { position: 'fixed', inset: '12%', maxHeight: '76vh', overflow: 'auto', color: 'var(--tl-theme-text)', background: 'var(--tl-theme-panel)', border: '1px solid var(--tl-theme-border)' } },
          h('h3', null, '当前会话回复朗读'),
          h('button', { type: 'button', disabled: busy, 'aria-pressed': enabled, onClick: () => { if (enabled) void stop(); else void start() } }, enabled ? '停止朗读' : '开始朗读'),
          h('button', { type: 'button', onClick: () => { confirmed.current = null; setControlsOpen(false) } }, '关闭'),
          enabled ? h('p', { role: 'status' }, '已启用此会话后续完整回复的朗读。') : null,
          error ? h('p', { role: 'alert' }, '回复朗读未完成，请检查语音设置或当前会话。') : null)
      }
      return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tradeloom-session-audio' }, SessionAudio))
    }
    return { register }
  },
})
