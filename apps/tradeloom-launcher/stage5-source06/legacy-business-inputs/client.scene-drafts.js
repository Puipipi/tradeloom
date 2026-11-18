window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.scene-drafts.js',
  factory(require) {
    const React = require('react'), h = React.createElement
    const same = (current, expected) => current && Object.keys(current).length === Object.keys(expected).length && Object.keys(expected).every(key => current[key] === expected[key])
    /** The official InputActions own text/reference serialization and its
     * session-specific store. Do not serialize DOM or attachment object URLs. */
    function createBoundDraftActions({ expected, sessionId, inputActions, readDescriptor, alive }) {
      async function assertCurrent() {
        if (!alive() || sessionId !== expected.sessionId || !same(await readDescriptor(), expected) || !alive()) throw Error('draft_binding_changed')
      }
      return {
        async save() {
          await assertCurrent()
          if (typeof inputActions.persistDraftVerified !== 'function') throw Error('draft_persistence_receipt_unavailable')
          const receipt = await inputActions.persistDraftVerified(sessionId)
          await assertCurrent()
          if (receipt?.persisted !== true || receipt.sessionId !== sessionId || !Number.isSafeInteger(receipt.draftRevision)) throw Error('draft_persistence_unconfirmed')
        },
        async discard() {
          await assertCurrent()
          if (typeof inputActions.discardDraftVerified !== 'function') throw Error('draft_persistence_receipt_unavailable')
          // The versioned checked action uses the original serializer and
          // restores its complete text/reference/quote draft on failure.
          const receipt = await inputActions.discardDraftVerified(sessionId)
          await assertCurrent()
          if (receipt?.persisted !== true || receipt.sessionId !== sessionId || !Number.isSafeInteger(receipt.draftRevision)) throw Error('draft_persistence_unconfirmed')
        },
      }
    }
    function register(ctx, descriptor, bridge) {
      if (descriptor.kind !== 'role' || descriptor.surface !== 'chat') return
      const expected = Object.freeze({ ...descriptor })
      function DraftLifecycle({ sessionId, inputActions, locked }) {
        const live = React.useRef(false)
        React.useEffect(() => {
          live.current = true
          const stop = bridge.onNativeSurfaceChanged(next => { if (next && !same(next, expected)) live.current = false })
          const stopFlush = bridge.onSceneDraftFlushRequested(async request => {
            if (!same(request.descriptor, expected)) return
            let saved = false
            try { await actions.save(); saved = true } catch { /* report failure; never acknowledge an unpersisted draft */ }
            if (live.current) await bridge.sceneDraftFlushResult({ requestId: request.requestId, saved }).catch(() => {})
          })
          return () => { live.current = false; stop(); stopFlush() }
        }, [])
        if (sessionId !== expected.sessionId || typeof inputActions?.persistDraft !== 'function') return null
        const actions = createBoundDraftActions({ expected, sessionId, inputActions, readDescriptor: () => bridge.nativeSurfaceDescriptor(), alive: () => live.current })
        // The native composer owns editing/clearing and automatic persistence.
        // This invisible binding exists only for checked flush on a real
        // scene/configuration transition. It adds no controls or layout nodes.
        return null
      }
      return ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'tradeloom-bound-draft-lifecycle' }, DraftLifecycle))
    }
    return { register, createBoundDraftActions }
  },
})
