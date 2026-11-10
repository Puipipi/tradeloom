import { randomUUID } from 'node:crypto'
import {
  WEB_AI_NATIVE_PATH, WEB_AI_NATIVE_HEADER, WEB_AI_NATIVE_MAX_LONG_POLL_MS,
  parseHostCommand, assertSafeWireValue,
} from './wire.mjs'

export const WEB_AI_PROVIDER_ORIGINS = Object.freeze({
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
})

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const destroyed = value => !value || typeof value.isDestroyed !== 'function' || value.isDestroyed()
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

/** Main-process half. hostFetch is a trusted wrapper around the existing Host forwarder. */
export function createMainWebAiTransport({
  nativeBridgeKey, hostFetch, publishProgress = () => {}, providerOrigins = WEB_AI_PROVIDER_ORIGINS,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (typeof nativeBridgeKey !== 'string' || nativeBridgeKey.length < 16 || typeof hostFetch !== 'function') {
    return Object.freeze({ available: false, dispose: async () => {} })
  }
  const mainInstanceId = randomUUID()
  const targets = new Map()
  const providerRecords = new WeakMap()
  const physicalTails = new WeakMap()
  const jobs = new Map()
  const pollControllers = new Set()
  let hostInstanceId
  let disposed = false

  async function requestHost(message, signal) {
    assertSafeWireValue(message)
    const response = await hostFetch(WEB_AI_NATIVE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WEB_AI_NATIVE_HEADER]: nativeBridgeKey },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    })
    const body = await response.json()
    if (!response.ok || body?.ok !== true) throw Object.assign(new Error(body?.error?.code ?? `HOST_HTTP_${response.status}`), { code: body?.error?.code ?? 'HOST_UNAVAILABLE' })
    return body
  }

  function current(record, generation) {
    return !disposed && targets.get(record.targetId) === record && record.generation === generation
      && record.available && !destroyed(record.webContents) && allowedOrigin(record)
  }

  function allowedOrigin(record) {
    try { return new URL(record.webContents.getURL()).origin === providerOrigins[record.providerId] } catch { return false }
  }

  async function syncTarget(record) {
    if (!hostInstanceId) return
    await requestHost({ type: 'target', hostInstanceId, targetId: record.targetId, generation: record.generation,
      providerId: record.providerId, windowId: String(record.webContents.id), conversationId: record.conversationId, available: record.available,
      ...(record.reason ? { reason: record.reason } : {}) })
  }

  async function start() {
    if (disposed) throw new Error('MAIN_CLOSED')
    const greeting = await requestHost({ type: 'hello', mainInstanceId })
    if (!validId(greeting.hostInstanceId)) throw new Error('INVALID_HOST_HELLO')
    if (hostInstanceId && hostInstanceId !== greeting.hostInstanceId) {
      for (const job of jobs.values()) {
        job.controller.abort('HOST_EPOCH_CHANGED')
        job.wake.resolve({ type: 'cancel' })
      }
    }
    hostInstanceId = greeting.hostInstanceId
    for (const record of targets.values()) await syncTarget(record)
    return hostInstanceId
  }

  async function attachTarget({ targetId, providerId, ownerWebContents, webContents, adapter }) {
    if (disposed) throw new Error('MAIN_CLOSED')
    if (!validId(targetId) || !validId(providerId) || !ownerWebContents || !webContents
      || !Number.isSafeInteger(webContents.id) || webContents.id < 1 || destroyed(webContents)
      || !adapter || typeof adapter.inspect !== 'function' || typeof adapter.ask !== 'function'
      || typeof adapter.onConversationChange !== 'function') throw new Error('TARGET_UNAVAILABLE')
    const origin = new URL(webContents.getURL()).origin
    if (origin !== providerOrigins[providerId]) throw new Error('PROVIDER_ORIGIN_DENIED')
    if (providerRecords.has(webContents)) throw new Error('TARGET_ALREADY_ATTACHED')
    if (targets.has(targetId)) throw new Error('TARGET_ID_ALREADY_ATTACHED')
    const record = { targetId, providerId, ownerWebContents, webContents, adapter, generation: 1, conversationId: null, available: false, reason: 'CONVERSATION_UNKNOWN', unsubscribe: undefined, navStart: undefined, navDone: undefined }
    providerRecords.set(webContents, record)
    targets.set(targetId, record)
    const reportConversation = value => {
      if (!allowedOrigin(record)) {
        record.generation++; record.conversationId = null; record.available = false; record.reason = 'PROVIDER_ORIGIN_DENIED'
        for (const job of jobs.values()) if (job.record === record) { job.controller.abort('PROVIDER_ORIGIN_DENIED'); job.wake.resolve({ type: 'cancel' }) }
        void syncTarget(record).catch(() => {})
        return
      }
      const conversationId = typeof value === 'string' ? value : value?.conversationId
      if (!validId(conversationId) || destroyed(record.webContents)) {
        record.generation++; record.conversationId = null; record.available = false; record.reason = 'CONVERSATION_UNKNOWN'
      } else if (record.conversationId !== conversationId || !record.available) {
        record.generation++; record.conversationId = conversationId; record.available = true; record.reason = undefined
      }
      for (const job of jobs.values()) if (job.record === record && job.generation !== record.generation) job.controller.abort('CONVERSATION_CHANGED')
      void syncTarget(record).catch(() => { record.available = false; record.reason = 'HOST_UNAVAILABLE' })
    }
    record.unsubscribe = adapter.onConversationChange(reportConversation)
    record.navStart = (_event, details) => {
      if (details?.isMainFrame === false) return
      record.generation++; record.conversationId = null; record.available = false; record.reason = 'NAVIGATION_CHANGED'
      for (const job of jobs.values()) if (job.record === record) { job.controller.abort('NAVIGATION_CHANGED'); job.wake.resolve({ type: 'cancel' }) }
      void syncTarget(record).catch(() => {})
    }
    record.navDone = async (_event, details) => {
      if (details?.isMainFrame === false || destroyed(record.webContents) || !allowedOrigin(record)) return
      const generation = record.generation
      try {
        const inspected = await adapter.inspect({ signal: new AbortController().signal })
        if (targets.get(targetId) !== record || record.generation !== generation || destroyed(record.webContents)) return
        reportConversation(inspected?.conversationId)
      } catch { if (record.generation === generation) { record.reason = 'INSPECT_FAILED'; void syncTarget(record).catch(() => {}) } }
    }
    webContents.on?.('did-start-navigation', record.navStart)
    webContents.on?.('did-navigate', record.navDone)
    webContents.on?.('did-navigate-in-page', record.navDone)
    try {
      const generation = record.generation
      const initial = await adapter.inspect({ signal: new AbortController().signal })
      if (targets.get(targetId) === record && record.generation === generation && allowedOrigin(record)) reportConversation(initial?.conversationId)
    } catch { if (targets.get(targetId) === record) { record.available = false; record.conversationId = null; record.reason = 'INSPECT_FAILED' } }
    if (typeof webContents.once === 'function') webContents.once('destroyed', () => { void detachTarget(targetId, webContents) })
    await syncTarget(record)
    return Object.freeze({ targetId, generation: record.generation, conversationId: record.conversationId, available: record.available })
  }

  async function updateConversation(targetId, conversationId) {
    const record = targets.get(targetId)
    if (!record) throw new Error('TARGET_UNKNOWN')
    if (record.conversationId === conversationId && record.available === validId(conversationId)) return
    record.generation++
    record.conversationId = validId(conversationId) ? conversationId : null
    record.available = record.conversationId !== null
    record.reason = record.available ? undefined : 'CONVERSATION_UNKNOWN'
    for (const job of jobs.values()) if (job.record === record) {
      job.controller.abort('CONVERSATION_CHANGED')
      job.wake.resolve({ type: 'cancel' })
    }
    await syncTarget(record)
  }

  async function detachTarget(targetId, expectedWebContents) {
    const record = targets.get(targetId)
    if (!record || (expectedWebContents && record.webContents !== expectedWebContents)) return false
    record.generation++
    record.available = false; record.conversationId = null; record.reason = 'TARGET_REMOVED'
    for (const job of jobs.values()) if (job.record === record) {
      job.controller.abort('TARGET_REMOVED')
      job.wake.resolve({ type: 'cancel' })
    }
    if (hostInstanceId) { try { await requestHost({ type: 'remove-target', hostInstanceId, targetId, generation: record.generation }) } catch {} }
    try { record.unsubscribe?.() } catch {}
    record.webContents.removeListener?.('did-start-navigation', record.navStart)
    record.webContents.removeListener?.('did-navigate', record.navDone)
    record.webContents.removeListener?.('did-navigate-in-page', record.navDone)
    targets.delete(targetId)
    providerRecords.delete(record.webContents)
    return true
  }

  function transferOwner({ targetId, currentOwner, newOwner }) {
    const record = targets.get(targetId)
    if (!record || !currentOwner || !newOwner || destroyed(newOwner) || record.ownerWebContents !== currentOwner) throw new Error('OWNER_TRANSFER_DENIED')
    record.ownerWebContents = newOwner
    return true
  }

  function statusForOwner(ownerWebContents, targetId) {
    if (!ownerWebContents || destroyed(ownerWebContents)) return { available: false, reason: 'OWNER_UNAVAILABLE' }
    const record = targets.get(targetId)
    if (!record || record.ownerWebContents !== ownerWebContents) return { available: false, reason: 'OWNER_UNAVAILABLE' }
    return { targetId, providerId: record.providerId, generation: record.generation, conversationId: record.conversationId,
      available: record.available && !destroyed(record.webContents) && allowedOrigin(record), ...(record.reason ? { reason: record.reason } : {}) }
  }

  function sendEvent(job, kind, details = {}) {
    if (hostInstanceId !== job.hostInstanceId) return Promise.resolve(false)
    const message = { type: 'event', hostInstanceId: job.hostInstanceId, jobId: job.jobId,
      targetId: job.record.targetId, generation: job.generation, requestId: job.requestId, taskNonce: job.taskNonce,
      kind, ...details }
    assertSafeWireValue(message)
    return requestHost(message).then(() => true, () => false)
  }

  function acceptCommand(raw) {
    const command = parseHostCommand(raw)
    if (command.hostInstanceId !== hostInstanceId) return false
    if (command.type === 'ask') return launchAsk(command)
    const job = jobs.get(command.jobId)
    if (!job || job.targetId !== command.targetId || job.generation !== command.generation
      || job.requestId !== command.requestId || job.taskNonce !== command.taskNonce) return false
    if (command.type === 'cancel') { job.controller.abort('HOST_CANCELLED'); job.wake.resolve({ type: 'cancel' }) }
    if (command.type === 'tool-result' && command.taskId === job.fileTask?.taskId) job.wake.resolve(command)
    if (command.type === 'release') { job.released = true; job.releaseCompleted = command.completed; job.wake.resolve(command) }
    return true
  }

  function launchAsk(command) {
    const record = targets.get(command.targetId)
    if (!record || !current(record, command.generation) || !record.conversationId || !record.available) return false
    if (jobs.has(command.jobId)) return false
    if (Boolean(command.fileTask) !== Boolean(command.fileTask?.taskId)) return false
    const controller = new AbortController()
    const job = { ...command, record, hostInstanceId, controller, wake: deferred(), released: false, releaseCompleted: false }
    jobs.set(command.jobId, job)
    const previous = physicalTails.get(record.webContents) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => runAsk(job))
    const settled = operation.catch(() => {}).finally(() => { if (physicalTails.get(record.webContents) === settled) physicalTails.delete(record.webContents) })
    physicalTails.set(record.webContents, settled)
    void settled
    return true
  }

  async function runAsk(job) {
    const { record, generation, controller } = job
    try {
      if (controller.signal.aborted || !current(record, generation)) throw new Error('TARGET_CHANGED')
      const progress = phase => {
        if (!['started', 'generating'].includes(phase) || !current(record, generation)) return
        if (!destroyed(record.ownerWebContents)) { try { publishProgress(record.ownerWebContents, { targetId: record.targetId, providerId: record.providerId, requestId: job.requestId, phase }) } catch {} }
        void sendEvent(job, phase)
      }
      const checked = await record.adapter.inspect({ signal: controller.signal })
      if (controller.signal.aborted || !current(record, generation) || checked?.conversationId !== record.conversationId
        || typeof checked?.draftText !== 'string' || checked.draftText.length > 0
        || !Number.isSafeInteger(checked?.attachmentCount) || checked.attachmentCount !== 0) throw new Error('DRAFT_OR_TARGET_CHANGED')
      let observation = await record.adapter.ask({
        requestId: job.requestId, prompt: job.prompt, signal: controller.signal,
        conversationId: record.conversationId, taskNonce: job.taskNonce,
        ...(job.fileTask ? { fileTask: job.fileTask } : {}), onProgress: progress,
      })
      while (true) {
        if (controller.signal.aborted || !current(record, generation)) throw new Error('TARGET_CHANGED')
        if (!observation || observation.requestId !== job.requestId || observation.taskNonce !== job.taskNonce
          || observation.conversationId !== record.conversationId || observation.source !== 'native-assistant-observation'
          || observation.role !== 'assistant' || observation.isNew !== true || !(observation.complete === true || observation.generating === false)) throw new Error('INCOMPLETE_RESPONSE')
        if (!await sendEvent(job, 'assistant', { observation })) throw new Error('HOST_UNAVAILABLE')
        while (true) {
          if (controller.signal.aborted) throw new Error('CANCELLED')
          const control = await job.wake.promise
          job.wake = deferred()
          if (control.type === 'release') {
            if (!job.releaseCompleted) throw new Error('RELEASE_BEFORE_FINAL')
            if (!destroyed(record.ownerWebContents)) { try { publishProgress(record.ownerWebContents, { targetId: record.targetId, providerId: record.providerId, requestId: job.requestId, phase: 'completed' }) } catch {} }
            return
          }
          if (control.type === 'cancel') throw new Error('CANCELLED')
          if (control.type === 'tool-result') {
            if (typeof record.adapter.continueWithToolResult !== 'function') throw new Error('ADAPTER_UNAVAILABLE')
            observation = await record.adapter.continueWithToolResult({
              requestId: job.requestId, taskId: control.taskId, taskNonce: job.taskNonce,
              conversationId: record.conversationId, result: control.result, signal: controller.signal,
            })
            break
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && current(record, generation)) await sendEvent(job, 'error', { errorCode: /INCOMPLETE_RESPONSE/.test(error?.message) ? 'INCOMPLETE_RESPONSE' : 'ADAPTER_UNAVAILABLE' })
    } finally {
      await sendEvent(job, 'settled')
      jobs.delete(job.jobId)
    }
  }

  async function pollOnce({ timeoutMs = 0 } = {}) {
    if (disposed) return false
    if (!hostInstanceId) await start()
    const timeout = Math.max(0, Math.min(WEB_AI_NATIVE_MAX_LONG_POLL_MS, timeoutMs))
    let response
    const pollController = new AbortController()
    pollControllers.add(pollController)
    try { response = await requestHost({ type: 'next', hostInstanceId, timeoutMs: timeout }, pollController.signal) }
    catch (error) {
      if (disposed && pollController.signal.aborted) return false
      if (error?.code !== 'HOST_EPOCH_MISMATCH') throw error
      await start()
      return false
    }
    finally { pollControllers.delete(pollController) }
    if (disposed) return false
    if (response.hostInstanceId !== hostInstanceId) {
      await start()
      return false
    }
    return response.command ? acceptCommand(response.command) : false
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    for (const controller of pollControllers) controller.abort('MAIN_CLOSED')
    for (const job of jobs.values()) {
      job.controller.abort('MAIN_CLOSED')
      job.wake.resolve({ type: 'cancel' })
    }
    const records = [...targets.values()]
    await Promise.allSettled(records.map(record => detachTarget(record.targetId, record.webContents)))
  }

  return Object.freeze({ available: true, start, attachTarget, updateConversation, detachTarget, transferOwner, statusForOwner, pollOnce, dispose, targets, jobs })
}

