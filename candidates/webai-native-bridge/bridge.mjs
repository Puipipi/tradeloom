import { randomUUID } from 'node:crypto'

export const WEB_AI_IPC = Object.freeze({
  STATUS: 'tradeloom:webai:status',
  PROGRESS: 'tradeloom:webai:progress',
})

export const WEB_AI_PROVIDER_ORIGINS = Object.freeze({
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
})

const MAX_REQUEST_ID = 128
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 10 * 60 * 1000
const TASK_LIMIT = 64

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code }
}

function fail(code) { throw new BridgeError(code) }
function validId(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
function actualOrigin(webContents) {
  try { return new URL(webContents.getURL()).origin } catch { return '' }
}
function isDestroyed(webContents) {
  try { return !webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed() } catch { return true }
}
function completeAdapter(adapter) {
  return !!adapter && typeof adapter.inspect === 'function'
    && typeof adapter.ask === 'function' && typeof adapter.onConversationChange === 'function'
}
function safeFailure(error) {
  const code = error instanceof BridgeError ? error.code : 'UNAVAILABLE'
  return { ok: false, error: { code } }
}
function boundedObservation(value, conversationId, taskNonce, requestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.source !== 'native-assistant-observation' || value.role !== 'assistant'
    || value.isNew !== true || value.conversationId !== conversationId
    || !validId(taskNonce, 128) || value.taskNonce !== taskNonce
    || !validId(requestId, MAX_REQUEST_ID) || value.requestId !== requestId || !validId(value.messageId)
    || typeof value.content !== 'string'
    || !(value.complete === true || value.generating === false)) fail('INCOMPLETE_RESPONSE')
  return value
}

/**
 * Main-process-only candidate. Provider adapters are injected by the trusted
 * controller; they must observe real site state and never accept page-supplied
 * exec, filesystem root, owner, or webContents identifiers.
 */
export function createWebAiNativeBridge({
  authorizeNativeToolRun,
  runtimeFiles,
  createFileTools,
  createToolEnvelope,
  toolManifest,
  providerOrigins = WEB_AI_PROVIDER_ORIGINS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const targets = new Map()
  const physical = new WeakMap()
  const fileTasks = new Map()

  function getPhysical(webContents) {
    let state = physical.get(webContents)
    if (!state) {
      state = { tail: Promise.resolve() }
      physical.set(webContents, state)
    }
    return state
  }

  function requestExecutionInvalid(request) {
    if (request.exec?.signal?.aborted) return true
    try { return request.isCurrent() === false } catch { return false }
  }

  function pruneRequests(entry) {
    for (const [requestId, request] of entry.requests) {
      if (request.settled && requestExecutionInvalid(request)
        && entry.requests.get(requestId) === request) {
        entry.requests.delete(requestId)
      }
    }
  }

  function originAllowed(entry) {
    return !isDestroyed(entry.webContents)
      && actualOrigin(entry.webContents) === entry.allowedOrigin
  }

  function emit(entry, payload) {
    if (!entry.ownerActive || isDestroyed(entry.ownerWebContents)) return
    try {
      entry.ownerWebContents.send(WEB_AI_IPC.PROGRESS, Object.freeze({
        targetId: entry.targetId,
        providerId: entry.providerId,
        ...payload,
      }))
    } catch { /* A destroyed owner is handled by its lifecycle event. */ }
  }

  function isEntryCurrent(entry, generation, conversationId) {
    return targets.get(entry.targetId) === entry && !entry.detached
      && !entry.navigating && !entry.unavailable && entry.generation === generation && !isDestroyed(entry.webContents)
      && originAllowed(entry) && (!conversationId || entry.conversationId === conversationId)
  }

  function watchOwner(entry, ownerWebContents) {
    entry.ownerWebContents = ownerWebContents
    entry.ownerActive = true
    const onDestroyed = () => {
      if (entry.ownerWebContents !== ownerWebContents) return
      entry.ownerActive = false
      entry.ownerListenerOff?.()
      entry.ownerListenerOff = undefined
    }
    ownerWebContents.on('destroyed', onDestroyed)
    entry.ownerListenerOff = () => ownerWebContents.removeListener?.('destroyed', onDestroyed)
  }

  function revokeTask(task) {
    if (!task || task.revoked) return false
    task.revoked = true
    fileTasks.delete(task.token)
    if (task.entry.preparedToken === task.token) task.entry.preparedToken = undefined
    if (task.timer) clearTimer(task.timer)
    try {
      const result = task.envelope.revokeTask(task.capability)
      if (result && typeof result.then === 'function') result.catch(() => {})
    } catch { /* Existing factory owns revocation. */ }
    return true
  }

  function invalidate(entry, reason) {
    if (!entry || entry.detached) return
    entry.generation += 1
    entry.conversationId = undefined
    entry.preparingToken = undefined
    for (const job of entry.jobs) {
      try { job.controller.abort() } catch { /* Abort is best-effort; the physical queue remains occupied until settle. */ }
      if (job.fileTask) revokeTask(job.fileTask)
    }
    for (const task of [...fileTasks.values()]) if (task.entry === entry) revokeTask(task)
    emit(entry, { phase: 'error', code: reason })
  }

  function detachProvider(targetId, webContents) {
    const entry = targets.get(targetId)
    if (!entry || webContents !== entry.webContents) return { ok: false, error: { code: 'FORBIDDEN' } }
    invalidate(entry, 'DETACHED')
    entry.detached = true
    targets.delete(targetId)
    entry.ownerActive = false
    entry.ownerListenerOff?.()
    entry.ownerListenerOff = undefined
    for (const off of entry.listeners.splice(0)) { try { off() } catch {} }
    return { ok: true }
  }

  function transferOwner({ targetId, currentOwner, newOwner } = {}) {
    const entry = targets.get(targetId)
    if (!entry || entry.ownerWebContents !== currentOwner) return { ok: false, error: { code: 'FORBIDDEN' } }
    if (!newOwner || typeof newOwner.send !== 'function' || typeof newOwner.on !== 'function'
      || typeof newOwner.removeListener !== 'function' || isDestroyed(newOwner)) {
      return { ok: false, error: { code: 'INVALID_OWNER' } }
    }
    if (currentOwner === newOwner && entry.ownerActive) return { ok: true, targetId }
    entry.ownerListenerOff?.()
    entry.ownerListenerOff = undefined
    watchOwner(entry, newOwner)
    return { ok: true, targetId }
  }

  function attachProvider({ providerId, ownerWebContents, webContents, adapter } = {}) {
    const allowedOrigin = providerOrigins?.[providerId]
    if (!validId(providerId) || typeof allowedOrigin !== 'string') fail('UNKNOWN_PROVIDER')
    if (!ownerWebContents || !webContents || ownerWebContents === webContents
      || typeof ownerWebContents.send !== 'function' || typeof ownerWebContents.on !== 'function'
      || typeof ownerWebContents.removeListener !== 'function' || typeof webContents.getURL !== 'function'
      || typeof webContents.on !== 'function') fail('INVALID_OWNER')
    if (isDestroyed(ownerWebContents)) fail('INVALID_OWNER')
    if (isDestroyed(webContents)) fail('TARGET_DESTROYED')
    if (typeof webContents.id !== 'number' || !Number.isSafeInteger(webContents.id) || webContents.id < 1) fail('TARGET_ID_UNAVAILABLE')
    if (actualOrigin(webContents) !== allowedOrigin) fail('ORIGIN_NOT_ALLOWED')
    if ([...targets.values()].some(item => item.webContents === webContents)) fail('ALREADY_ATTACHED')

    const targetId = randomUUID()
    const entry = {
      targetId, providerId, allowedOrigin, ownerWebContents: undefined, ownerActive: false, ownerListenerOff: undefined, webContents,
      windowId: String(webContents.id), adapter: adapter ?? null,
      physical: getPhysical(webContents), generation: 0, conversationId: undefined,
      jobs: new Set(), listeners: [], detached: false, unavailable: undefined,
      navigating: false, pending: 0, requests: new Map(), preparedToken: undefined,
      adapterReady: false,
      preparingToken: undefined,
    }
    targets.set(targetId, entry)

    const onNavigation = () => {
      entry.navigating = true
      invalidate(entry, 'NAVIGATION_CHANGED')
    }
    const onNavigated = () => {
      invalidate(entry, 'NAVIGATION_CHANGED')
      entry.navigating = false
      entry.unavailable = actualOrigin(webContents) === allowedOrigin
        ? (entry.adapterReady ? undefined : 'ADAPTER_UNAVAILABLE')
        : 'ORIGIN_NOT_ALLOWED'
    }
    const onProcessGone = () => { entry.unavailable = 'PROVIDER_UNAVAILABLE'; onNavigation() }
    const onDestroyed = () => { detachProvider(targetId, webContents) }
    webContents.on('will-navigate', onNavigation)
    webContents.on('did-redirect-navigation', onNavigation)
    webContents.on('did-navigate', onNavigated)
    webContents.on('did-navigate-in-page', onNavigated)
    webContents.on('render-process-gone', onProcessGone)
    webContents.on('destroyed', onDestroyed)
    entry.listeners.push(
      () => webContents.removeListener?.('will-navigate', onNavigation),
      () => webContents.removeListener?.('did-redirect-navigation', onNavigation),
      () => webContents.removeListener?.('did-navigate', onNavigated),
      () => webContents.removeListener?.('did-navigate-in-page', onNavigated),
      () => webContents.removeListener?.('render-process-gone', onProcessGone),
      () => webContents.removeListener?.('destroyed', onDestroyed),
    )
    watchOwner(entry, ownerWebContents)

    if (!completeAdapter(adapter)) {
      entry.unavailable = 'ADAPTER_UNAVAILABLE'
    } else {
      entry.adapterReady = true
      try {
        const off = adapter.onConversationChange(value => {
          const next = typeof value === 'string' ? value : value?.conversationId
          if (!entry.adapterReady || entry.navigating || !originAllowed(entry)) return
          if (!validId(next)) return invalidate(entry, 'CONVERSATION_UNAVAILABLE')
          if (entry.conversationId && next !== entry.conversationId) invalidate(entry, 'CONVERSATION_CHANGED')
          entry.conversationId = next
        })
        if (typeof off === 'function') entry.listeners.push(off)
        else { entry.adapterReady = false; entry.unavailable = 'ADAPTER_UNAVAILABLE' }
      } catch { entry.adapterReady = false; entry.unavailable = 'ADAPTER_UNAVAILABLE' }
    }
    const ready = !entry.unavailable && !entry.navigating && entry.adapterReady
      && !!entry.conversationId && originAllowed(entry)
    return Object.freeze({ targetId, providerId, available: ready, reason: ready ? undefined : statusReason(entry) })
  }

  function statusReason(entry) {
    if (entry.unavailable) return entry.unavailable
    if (entry.navigating) return 'NAVIGATION_CHANGED'
    if (!originAllowed(entry)) return 'ORIGIN_NOT_ALLOWED'
    if (!entry.adapterReady) return 'ADAPTER_UNAVAILABLE'
    if (!entry.conversationId) return 'CONVERSATION_UNAVAILABLE'
    return undefined
  }

  function statusForOwner(sender, targetId) {
    const entry = targets.get(targetId)
    if (!entry || !entry.ownerActive || isDestroyed(entry.ownerWebContents)
      || sender !== entry.ownerWebContents) return { ok: false, error: { code: 'FORBIDDEN' } }
    const available = !entry.unavailable && !entry.navigating && entry.adapterReady
      && !!entry.conversationId && originAllowed(entry)
    return {
      ok: true,
      status: Object.freeze({
        targetId: entry.targetId,
        providerId: entry.providerId,
        available,
        reason: available ? undefined : statusReason(entry),
        busy: entry.pending > 0,
      }),
    }
  }

  function registerIpc(ipcMain) {
    if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.removeHandler !== 'function') fail('IPC_UNAVAILABLE')
    const handler = (event, targetId) => statusForOwner(event?.sender, targetId)
    ipcMain.handle(WEB_AI_IPC.STATUS, handler)
    return () => ipcMain.removeHandler(WEB_AI_IPC.STATUS)
  }

  async function inspectEntry(entry, signal) {
    if (entry.unavailable || entry.navigating || !entry.adapterReady || !originAllowed(entry)) fail(entry.unavailable ?? statusReason(entry) ?? 'ADAPTER_UNAVAILABLE')
    const generation = entry.generation
    const conversationAtStart = entry.conversationId
    let snapshot
    try { snapshot = await entry.adapter.inspect({ signal }) } catch { fail('PROVIDER_UNAVAILABLE') }
    if (signal?.aborted || targets.get(entry.targetId) !== entry || entry.detached
      || entry.generation !== generation || entry.navigating) fail('TASK_NOT_CURRENT')
    if (!originAllowed(entry)) fail('ORIGIN_NOT_ALLOWED')
    if (!snapshot || typeof snapshot !== 'object') fail('PROVIDER_UNAVAILABLE')
    if (!validId(snapshot.conversationId)) fail('CONVERSATION_UNAVAILABLE')
    if (typeof snapshot.draftText !== 'string') fail('DRAFT_STATE_UNAVAILABLE')
    if (snapshot.draftText.length > 0) fail('DRAFT_PRESENT')
    if (!Number.isSafeInteger(snapshot.attachmentCount) || snapshot.attachmentCount < 0) fail('ATTACHMENT_STATE_UNAVAILABLE')
    if (snapshot.attachmentCount !== 0) fail('ATTACHMENTS_PRESENT')
    if (entry.conversationId && entry.conversationId !== snapshot.conversationId) {
      if (entry.conversationId === conversationAtStart) {
        invalidate(entry, 'CONVERSATION_CHANGED')
        entry.conversationId = snapshot.conversationId
      }
      fail('CONVERSATION_CHANGED')
    }
    entry.conversationId = snapshot.conversationId
    return snapshot.conversationId
  }

  async function authorize(exec, providerId) {
    if (typeof authorizeNativeToolRun !== 'function') fail('NATIVE_AUTH_UNAVAILABLE')
    let context
    try { context = await authorizeNativeToolRun({ exec, providerId }) } catch { fail('NATIVE_AUTH_DENIED') }
    if (!context || context.exec !== exec || !context.webContents
      || typeof context.isCurrent !== 'function') fail('NATIVE_AUTH_DENIED')
    const entry = [...targets.values()].find(item => item.providerId === providerId && item.webContents === context.webContents)
    if (!entry) fail('PROVIDER_UNAVAILABLE')
    if (!context.isCurrent()) fail('NATIVE_AUTH_DENIED')
    return { entry, context }
  }

  async function makeFileTask(entry, context, exec, conversationId) {
    if (!runtimeFiles || typeof runtimeFiles.bind !== 'function' || typeof runtimeFiles.execute !== 'function'
      || typeof runtimeFiles.revoke !== 'function' || typeof createFileTools !== 'function'
      || typeof createToolEnvelope !== 'function' || !toolManifest) fail('FILE_TOOLS_UNAVAILABLE')
    if (typeof context.fs?.resolve !== 'function' || typeof context.fs?.processPath !== 'function'
      || typeof context.fs?.stat !== 'function' || typeof context.getRoot !== 'function'
      || typeof context.getDeniedTools !== 'function') fail('NATIVE_WORKSPACE_UNAVAILABLE')
    const root = context.getRoot()
    if (typeof root !== 'string' || !root) fail('NATIVE_WORKSPACE_UNAVAILABLE')
    const generation = entry.generation
    const isCurrent = () => isEntryCurrent(entry, generation, conversationId) && context.isCurrent() === true
    if (!isCurrent()) fail('TASK_NOT_CURRENT')
    let fileTools
    try {
      fileTools = createFileTools({
        fs: context.fs,
        createScopedExecutor: async binding => {
          const capability = await runtimeFiles.bind({
            exec,
            root: binding.root,
            getRoot: context.getRoot,
            isCurrent,
            getDeniedTools: context.getDeniedTools,
            ttlMs: binding.ttlMs,
          })
          return {
            execute: request => runtimeFiles.execute(capability, request),
            revoke: () => runtimeFiles.revoke(capability),
          }
        },
      })
    } catch { fail('FILE_TOOLS_UNAVAILABLE') }
    if (!fileTools || typeof fileTools.issueGrant !== 'function' || typeof fileTools.revoke !== 'function') fail('FILE_TOOLS_UNAVAILABLE')

    const taskId = randomUUID()
    const taskNonce = randomUUID()
    const nativeContext = {
      providerId: entry.providerId,
      windowId: entry.windowId,
      conversationId,
      signal: exec.signal,
    }
    let grant
    let envelope
    let capability
    try {
      grant = await fileTools.issueGrant({
        providerId: entry.providerId,
        windowId: entry.windowId,
        conversationId,
        root,
        signal: exec.signal,
        isCurrent,
      })
      if (!isCurrent()) fail('TASK_NOT_CURRENT')
      envelope = createToolEnvelope({ fileTools })
      if (!envelope || typeof envelope.issueTask !== 'function' || typeof envelope.observeAssistantMessage !== 'function'
        || typeof envelope.revokeTask !== 'function') fail('FILE_TOOLS_UNAVAILABLE')
      capability = envelope.issueTask({
        taskId, taskNonce,
        providerId: entry.providerId,
        windowId: entry.windowId,
        conversationId,
        grant,
        nativeContext,
        isCurrent,
      })
    } catch {
      try { if (grant) await fileTools.revoke(grant) } catch {}
      fail('FILE_TASK_UNAVAILABLE')
    }
    const task = {
      token: randomUUID(), taskId, taskNonce, entry, exec, root, generation,
      conversationId, fileTools, envelope, capability, revoked: false,
    }
    return task
  }

  function beginFileTask({ exec, providerId } = {}) {
    return (async () => {
      if (!exec?.signal || typeof exec.signal.addEventListener !== 'function'
        || typeof exec.signal.removeEventListener !== 'function') fail('NATIVE_AUTH_DENIED')
      if (exec.signal.aborted) fail('CANCELLED')
      const { entry } = await authorize(exec, providerId)
      if (exec.signal.aborted) fail('CANCELLED')
      if (entry.pending) fail('TARGET_BUSY')
      if (entry.preparedToken || entry.preparingToken) fail('FILE_TASK_PENDING')
      const reservation = randomUUID()
      entry.preparingToken = reservation
      const operation = entry.physical.tail.catch(() => undefined).then(async () => {
        try {
          if (entry.preparingToken !== reservation || !isEntryCurrent(entry, entry.generation)) fail('TASK_NOT_CURRENT')
          const { context } = await authorize(exec, providerId)
          if (exec.signal.aborted || !context.isCurrent()) fail('TASK_NOT_CURRENT')
          if (context.webContents !== entry.webContents) fail('NATIVE_AUTH_DENIED')
          const generation = entry.generation
          const conversationId = await inspectEntry(entry, exec?.signal)
          if (!isEntryCurrent(entry, generation, conversationId) || entry.preparingToken !== reservation
            || exec.signal.aborted || !context.isCurrent()) fail('TASK_NOT_CURRENT')
          const task = await makeFileTask(entry, context, exec, conversationId)
          if (!isEntryCurrent(entry, generation, conversationId) || entry.preparingToken !== reservation
            || exec.signal.aborted || !context.isCurrent()) {
            try { await task.envelope.revokeTask(task.capability) } catch {}
            fail('TASK_NOT_CURRENT')
          }
          task.timer = setTimer(() => revokeTask(task), 300000)
          task.timer?.unref?.()
          fileTasks.set(task.token, task)
          entry.preparedToken = task.token
          entry.preparingToken = undefined
          return {
            ok: true,
            fileTaskToken: task.token,
            taskId: task.taskId,
            taskNonce: task.taskNonce,
            manifest: toolManifest,
          }
        } finally {
          if (entry.preparingToken === reservation) entry.preparingToken = undefined
        }
      })
      entry.physical.tail = operation.then(() => undefined, () => undefined)
      const caller = callerResult(operation, new AbortController(), MAX_TIMEOUT_MS, [exec.signal])
      return caller.then(result => {
        if (!result?.ok && entry.preparingToken === reservation) entry.preparingToken = undefined
        return result
      })
    })().catch(safeFailure)
  }

  function revokeFileTask({ exec, fileTaskToken } = {}) {
    const task = fileTasks.get(fileTaskToken)
    if (!task || task.exec !== exec) return { ok: false, error: { code: 'FORBIDDEN' } }
    revokeTask(task)
    return { ok: true }
  }

  function validateObservation(entry, job, observation) {
    if (!isEntryCurrent(entry, job.generation, job.conversationId)) fail('TASK_NOT_CURRENT')
    return boundedObservation(observation, job.conversationId, job.taskNonce, job.requestId)
  }

  async function runJob(entry, job, input) {
    const { controller } = job
    const signal = controller.signal
    try {
      if (!isEntryCurrent(entry, job.generation)) fail('TASK_NOT_CURRENT')
      const { context } = await authorize(input.exec, input.providerId)
      if (signal.aborted || !isEntryCurrent(entry, job.generation) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
      if (context.webContents !== entry.webContents) fail('NATIVE_AUTH_DENIED')
      if (targets.get(entry.targetId) !== entry) fail('TARGET_DETACHED')
      const conversationId = await inspectEntry(entry, signal)
      if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
      job.conversationId = conversationId

      let task
      if (input.fileTaskToken) {
        task = fileTasks.get(input.fileTaskToken)
        if (!task || task.revoked || task.entry !== entry || task.exec !== input.exec
          || task.generation !== entry.generation || task.conversationId !== conversationId) fail('FILE_TASK_UNAVAILABLE')
        job.fileTask = task
      }
      if (!isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
      job.taskNonce = task?.taskNonce ?? job.taskNonce
      job.requestId = input.requestId

      emit(entry, { requestId: input.requestId, phase: 'started' })
      const fileTask = task ? {
        taskId: task.taskId,
        taskNonce: task.taskNonce,
        manifest: toolManifest,
      } : undefined
      let observation
      try {
        observation = await entry.adapter.ask({
          requestId: input.requestId,
          prompt: input.prompt,
          signal,
          conversationId,
          taskNonce: job.taskNonce,
          fileTask,
          onProgress: event => {
            if (!isEntryCurrent(entry, job.generation, conversationId)) return
            const phase = event?.phase
            if (phase === 'waiting') emit(entry, { requestId: input.requestId, phase })
          },
        })
      } catch { fail(signal.aborted ? 'CANCELLED' : 'PROVIDER_UNAVAILABLE') }
      if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
      observation = validateObservation(entry, job, observation)

      if (task) {
        let finalAnswer = false
        for (let count = 0; count < TASK_LIMIT; count += 1) {
          if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId)) fail('TASK_NOT_CURRENT')
          let result
          try { result = await task.envelope.observeAssistantMessage(task.capability, observation) } catch { fail('FILE_TOOL_FAILED') }
          if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
          if (result?.status === 'rejected' && result.error?.code === 'INVALID_ENVELOPE') { finalAnswer = true; break }
          if (result?.status !== 'completed' && result?.status !== 'failed') fail(result?.error?.code ?? 'FILE_TOOL_FAILED')
          if (typeof entry.adapter.continueWithToolResult !== 'function') fail('ADAPTER_UNAVAILABLE')
          if (!isEntryCurrent(entry, job.generation, conversationId)) fail('TASK_NOT_CURRENT')
          try {
            observation = await entry.adapter.continueWithToolResult({
              requestId: input.requestId,
              taskId: task.taskId,
              taskNonce: task.taskNonce,
              conversationId,
              result,
              signal,
            })
          } catch { fail(signal.aborted ? 'CANCELLED' : 'PROVIDER_UNAVAILABLE') }
          if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
          observation = validateObservation(entry, job, observation)
        }
        if (!finalAnswer) fail('TOOL_REQUEST_LIMIT')
      }

      if (signal.aborted || !isEntryCurrent(entry, job.generation, conversationId) || !context.isCurrent()) fail('TASK_NOT_CURRENT')
      emit(entry, { requestId: input.requestId, phase: 'completed' })
      return { ok: true, requestId: input.requestId, providerId: entry.providerId, conversationId, text: observation.content }
    } catch (error) {
      const result = safeFailure(error)
      emit(entry, { requestId: input.requestId, phase: 'error', code: result.error.code })
      return result
    } finally {
      if (job.fileTask) revokeTask(job.fileTask)
      entry.jobs.delete(job)
    }
  }

  function callerResult(operation, controller, timeoutMs, externalSignals = []) {
    let timer
    const signals = externalSignals.filter(Boolean)
    let onAbort
    const abortPromise = new Promise(resolve => {
      onAbort = () => resolve({ aborted: true })
      if (signals.some(item => item.aborted)) onAbort()
      else for (const item of signals) item.addEventListener('abort', onAbort, { once: true })
    })
    timer = setTimer(() => onAbort(), timeoutMs)
    return Promise.race([
      operation,
      abortPromise.then(() => {
        controller.abort()
        return { ok: false, error: { code: signals.some(item => item.aborted) ? 'CANCELLED' : 'TIMEOUT' } }
      }),
    ]).finally(() => {
      clearTimer(timer)
      for (const item of signals) item.removeEventListener('abort', onAbort)
    })
  }

  function askFromNative({ exec, providerId, requestId, prompt, fileTaskToken, timeoutMs = 120000, signal } = {}) {
    return (async () => {
      if (!exec || !exec.signal || typeof exec.signal.addEventListener !== 'function'
        || typeof exec.signal.removeEventListener !== 'function') fail('NATIVE_AUTH_DENIED')
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) fail('INVALID_REQUEST')
      if (exec.signal.aborted || signal?.aborted) fail('CANCELLED')
      if (!validId(requestId, MAX_REQUEST_ID) || typeof prompt !== 'string'
        || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) fail('INVALID_REQUEST')
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail('INVALID_REQUEST')
      const { entry, context } = await authorize(exec, providerId)
      if (exec.signal.aborted || signal?.aborted) fail('CANCELLED')
      if (entry.preparingToken) fail('FILE_TASK_PENDING')
      if (entry.preparedToken && entry.preparedToken !== fileTaskToken) fail('FILE_TASK_PENDING')
      pruneRequests(entry)
      const fingerprint = JSON.stringify({ providerId, prompt, fileTaskToken: fileTaskToken ?? null })
      const previous = entry.requests.get(requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.generation !== entry.generation || previous.exec !== exec) fail('REQUEST_ID_REUSED')
        return callerResult(previous.operation, previous.controller, timeoutMs, [signal, exec.signal])
      }
      const controller = new AbortController()
      if (exec.signal.aborted || signal?.aborted) fail('CANCELLED')
      const abortFromParent = () => controller.abort()
      exec.signal?.addEventListener('abort', abortFromParent, { once: true })
      signal?.addEventListener('abort', abortFromParent, { once: true })
      const attachedTask = fileTaskToken ? fileTasks.get(fileTaskToken) : undefined
      const job = {
        controller,
        generation: entry.generation,
        requestId,
        taskNonce: attachedTask?.taskNonce ?? randomUUID(),
        conversationId: entry.conversationId,
        fileTask: attachedTask,
      }
      entry.jobs.add(job)
      entry.pending += 1
      const request = {
        fingerprint, generation: entry.generation, operation: undefined,
        controller, exec, isCurrent: () => context.isCurrent(), settled: false,
      }
      const operation = entry.physical.tail.catch(() => undefined).then(() => {
        if (controller.signal.aborted) return { ok: false, error: { code: 'CANCELLED' } }
        return runJob(entry, job, { exec, providerId, requestId, prompt, fileTaskToken })
      }).finally(() => {
        exec.signal?.removeEventListener('abort', abortFromParent)
        signal?.removeEventListener('abort', abortFromParent)
        if (job.fileTask) revokeTask(job.fileTask)
        entry.jobs.delete(job)
        entry.pending -= 1
        request.settled = true
        pruneRequests(entry)
      })
      request.operation = operation
      entry.physical.tail = operation.then(() => undefined, () => undefined)
      entry.requests.set(requestId, request)
      return callerResult(operation, controller, timeoutMs, [signal, exec.signal])
    })().catch(safeFailure)
  }

  return Object.freeze({
    attachProvider,
    detachProvider,
    transferOwner,
    statusForOwner,
    registerIpc,
    beginFileTask,
    revokeFileTask,
    askFromNative,
  })
}
