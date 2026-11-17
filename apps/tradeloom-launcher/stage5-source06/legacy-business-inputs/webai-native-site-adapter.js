const fail = code => Object.assign(Error(code), { code })
const providers = ['deepseek', 'doubao']
const same = (a, b, keys) => a && b && keys.every(key => a[key] === b[key])
const ownerKeys = ['guestId', 'generation', 'sceneId', 'panelId', 'roleId', 'sessionId', 'bindingRevision', 'operationId']

// Electron current details object and its legacy positional event signature.
// Subframe navigation cannot change the website conversation's owner.
export function isMainFrameNavigation(event, details, sameDocument, mainFrame) {
  const value = details && typeof details === 'object' ? details : event && typeof event.isMainFrame === 'boolean' ? event : null
  return (value ? value.isMainFrame : mainFrame) !== false
}

/** Main-owned text transport, not a requirement for website-native tool calls.
 * Concrete send/observation implementations still require real site evidence.
 * No URL-derived owner, guessed selectors or renderer-issued observation. */
export function createWebAiNativeTargets({ findWindow, revokeTarget, now = Date.now }) {
  const entries = new Map()
  let closed = false
  function invalidate(entry) {
    entry.pending?.controller.abort()
    entry.generation++; entry.pending = null
    revokeTarget(entry.targetId)
  }
  function live(entry) {
    const window = findWindow(entry.providerId)
    if (closed || !window || window !== entry.window || window.isDestroyed() || window.webContents.isDestroyed()) throw fail('webai_target_unavailable')
    return window
  }
  return Object.freeze({
    register(providerId, adapter) {
      if (closed || !providers.includes(providerId) || entries.has(providerId)
        || ['inspect', 'send', 'onAssistantMessage', 'onConversationChange'].some(key => typeof adapter?.[key] !== 'function')) throw fail('webai_site_adapter_unavailable')
      const window = findWindow(providerId)
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw fail('webai_target_unavailable')
      const entry = { providerId, adapter, window, targetId: `${providerId}:${window.webContents.id}`, generation: 1, pending: null }
      const changed = () => invalidate(entry)
      const stop = adapter.onConversationChange(window.webContents, changed)
      if (typeof stop !== 'function') throw fail('webai_site_adapter_unavailable')
      entries.set(providerId, entry)
      const navigated = (...args) => { if (isMainFrameNavigation(...args)) changed() }
      window.webContents.on('did-start-navigation', navigated); window.webContents.once('destroyed', changed)
      const dispose = () => {
        if (entries.get(providerId) !== entry) return
        const failures = []
        for (const cleanup of [() => invalidate(entry), stop,
          () => window.webContents.removeListener('did-start-navigation', navigated),
          () => window.webContents.removeListener('destroyed', changed), () => entries.delete(providerId)]) {
          try { cleanup() } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, 'webai_target_cleanup_failed')
      }
      entry.dispose = dispose
      return dispose
    },
    // Owner comes from Host's canonical authenticated task, never page JSON.
    async beginOperation(providerId, verifiedOwner) {
      const entry = entries.get(providerId)
      if (!entry || ownerKeys.some(key => verifiedOwner?.[key] === undefined)) throw fail('webai_target_unavailable')
      if (entry.adapter.protocolReady === false) throw fail(entry.adapter.unavailableReason || 'webai_site_protocol_unverified')
      live(entry)
      const observation = await entry.adapter.inspect(entry.window.webContents)
      live(entry)
      if (!observation || typeof observation.conversationId !== 'string' || !observation.conversationId
        || !Number.isFinite(observation.observedAt) || now() - observation.observedAt > 2000 || observation.observedAt > now()) throw fail('webai_observation_stale')
      invalidate(entry)
      entry.pending = { owner: Object.freeze({ ...verifiedOwner }), conversationId: observation.conversationId, generation: entry.generation, controller: new AbortController() }
      return entry.targetId
    },
    async runFileTask(task, { authorize, observe, cancel }) {
      const targetId = await this.beginOperation(task.providerId, task.owner)
      const entry = entries.get(task.providerId), pending = entry.pending
      let stop = () => {}, tail = Promise.resolve(), settled = false, rejectDone, resolveDone
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
      // An abort before awaiting done must not become an unhandled rejection.
      void done.catch(() => {})
      const end = error => { if (settled) return; settled = true; error ? rejectDone(error) : resolveDone({ completed: true }) }
      const aborted = () => end(fail('webai_task_cancelled'))
      pending.controller.signal.addEventListener('abort', aborted, { once: true })
      const current = async () => {
        const value = await this.read(targetId)
        if (entry.pending !== pending || pending.controller.signal.aborted || !same(value.owner, task.owner, ownerKeys)) throw fail('webai_task_cancelled')
        return value
      }
      const replied = new Set()
      let primaryFailure
      try {
        await authorize(await current()); await current()
        const receive = observation => {
          // Only the concrete Main adapter invokes this callback. All message
          // text is nevertheless an untrusted request checked again in Host.
          const run = async () => {
            await current()
            if (typeof observation?.errorCode === 'string' && /^webai_[a-z_]+$/.test(observation.errorCode)) throw fail(observation.errorCode)
            if (!observation || observation.conversationId !== pending.conversationId || observation.role !== 'assistant'
              || observation.isNew !== true || typeof observation.messageId !== 'string' || !observation.messageId
              || typeof observation.content !== 'string' || observation.content.length > 96 * 1024
              || !(observation.complete === true || observation.generating === false)) return
            const response = await observe({ ...observation, source: 'native-assistant-observation', taskNonce: task.taskNonce })
            await current()
            if (response.status === 'duplicate-message' || response.status === 'ignored') return
            if (response.status === 'rejected' && response.error?.code === 'INVALID_ENVELOPE') { end(); return }
            if (!['completed', 'failed'].includes(response.status) || typeof response.requestId !== 'string') throw fail('webai_task_response_rejected')
            if (replied.has(response.requestId)) return
            replied.add(response.requestId)
            const content = JSON.stringify(response)
            if (content.length > 64 * 1024) throw fail('webai_task_response_too_large')
            await entry.adapter.send(entry.window.webContents, { conversationId: pending.conversationId, content, signal: pending.controller.signal })
            await current()
          }
          tail = tail.then(run).catch(error => { end(error) })
        }
        stop = entry.adapter.onAssistantMessage(entry.window.webContents, receive)
        if (typeof stop !== 'function') throw fail('webai_site_adapter_unavailable')
        const content = `${task.prompt}\n\n${JSON.stringify({ taskId: task.taskId, ...task.manifest })}\n需要文件时仅回复一个完整JSON封套：{version:1,kind:"tradeloom-file-task",taskId,requestId,op,path,content(仅write_new)}。目录与权限由宿主决定。收到宿主结果后继续；最终分析用普通文本。`
        await entry.adapter.send(entry.window.webContents, { conversationId: pending.conversationId, content, signal: pending.controller.signal })
        await current()
        return await done
      } catch (error) { primaryFailure = error; throw error }
      finally {
        const failures = []
        const cleanup = async action => { try { await action() } catch (error) { failures.push(error) } }
        await cleanup(() => stop())
        await cleanup(() => pending.controller.signal.removeEventListener('abort', aborted))
        await cleanup(() => { if (entry.pending === pending) invalidate(entry) })
        await cleanup(() => tail)
        await cleanup(cancel)
        if (failures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], 'webai_task_cleanup_failed')
      }
    },
    cancelOperation(owner) {
      const entry = [...entries.values()].find(value => same(value.pending?.owner, owner, ownerKeys))
      if (!entry) return false
      invalidate(entry); return true
    },
    async read(targetId) {
      const entry = [...entries.values()].find(item => item.targetId === targetId)
      if (!entry?.pending) throw fail('webai_target_unavailable')
      live(entry)
      const pending = entry.pending, observation = await entry.adapter.inspect(entry.window.webContents)
      live(entry)
      if (entry.pending !== pending || !observation || observation.conversationId !== pending.conversationId
        || !Number.isFinite(observation.observedAt) || now() - observation.observedAt > 2000 || observation.observedAt > now()) { invalidate(entry); throw fail('webai_observation_stale') }
      return Object.freeze({ targetId, providerId: entry.providerId, windowId: String(entry.window.id), conversationId: pending.conversationId,
        generation: pending.generation, available: true, owner: pending.owner })
    },
    async assertOwner(owner) {
      const entry = [...entries.values()].find(item => same(item.pending?.owner, owner, ownerKeys))
      if (!entry || !same((await this.read(entry.targetId)).owner, owner, ownerKeys)) throw fail('webai_directory_owner_unavailable')
    },
    status() { return providers.map(providerId => { const entry = entries.get(providerId), ready = !!entry && entry.adapter.protocolReady !== false; return { providerId, targetId: entry?.targetId ?? null, available: !!entry?.pending,
      registered: !!entry, transportReady: ready, reason: ready ? null : entry?.adapter.unavailableReason || 'site_transport_unavailable' } }) },
    dispose() { closed = true; const failures = []; for (const entry of [...entries.values()]) try { entry.dispose() } catch (error) { failures.push(error) }; if (failures.length) throw new AggregateError(failures, 'webai_targets_cleanup_failed') },
  })
}
