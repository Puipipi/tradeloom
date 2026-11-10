import { randomUUID } from 'node:crypto'
import {
  WEB_AI_NATIVE_PATH, WEB_AI_NATIVE_HEADER, readMainRequest, jsonResponse,
  parseHostCommand, assertSafeWireValue, WEB_AI_NATIVE_MAX_LONG_POLL_MS,
} from './webai-native-wire.js'

const jsonError = (status, code) => jsonResponse(status, { ok: false, error: { code } })
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const TARGETS_OUTPUT = { schema: { type: 'object', additionalProperties: false, required: ['targets'], properties: {
  targets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['targetId', 'providerId', 'conversationId'], properties: {
    targetId: { type: 'string' }, providerId: { type: 'string' }, conversationId: { type: 'string' },
  } } },
} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const ASK_OUTPUT = { schema: { type: 'object', additionalProperties: false, required: ['answer', 'requestId'], properties: {
  answer: { type: 'string' }, requestId: { type: 'string' },
} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
function projectToolManifest(manifest) {
  return { version: manifest.version, kind: manifest.kind, authorizationNotice: manifest.authorizationNotice,
    tools: manifest.tools.map(tool => ({ name: tool.name, description: tool.description, arguments: [...tool.arguments] })) }
}

/** Host-process transport. All native authorization, ToolRun objects, grants and filesystem access stay here. */
export function createHostWebAiTransport({
  ctx, nativeBridgeKey, authorizeNativeToolRun, listAuthorizedTargets = () => [],
  runtimeFiles, createFileTools, createToolEnvelope, toolManifest,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!ctx?.connection?.fetch?.register || !ctx?.tools?.register) throw new TypeError('Host connection and ToolRuntime are required')
  if (typeof nativeBridgeKey !== 'string' || nativeBridgeKey.length < 16) {
    return Object.freeze({ available: false, hostInstanceId: null, dispose: async () => {} })
  }
  if (typeof authorizeNativeToolRun !== 'function') throw new TypeError('Native ToolRun authorization is required')
  const hostInstanceId = randomUUID()
  const targets = new Map()
  const jobs = new Map()
  const commands = []
  const nextWaiters = []
  const requestCache = new WeakMap()
  let closed = false

  function enqueue(command) {
    assertSafeWireValue(command)
    parseHostCommand(command)
    const waiter = nextWaiters.shift()
    if (waiter) waiter.resolve(command)
    else commands.push(command)
  }

  async function nextCommand(timeoutMs, signal) {
    const queued = commands.shift()
    if (queued) return queued
    if (timeoutMs === 0 || closed || signal?.aborted) return null
    const waiter = deferred()
    let timer
    const timeout = new Promise(resolve => { timer = setTimer(() => resolve(null), Math.min(timeoutMs, WEB_AI_NATIVE_MAX_LONG_POLL_MS)) })
    nextWaiters.push(waiter)
    let onAbort
    const aborted = new Promise(resolve => {
      onAbort = () => resolve(null)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([waiter.promise, timeout, aborted]) }
    finally { clearTimer(timer); signal?.removeEventListener('abort', onAbort); const index = nextWaiters.indexOf(waiter); if (index >= 0) nextWaiters.splice(index, 1) }
  }

  function jobForEvent(message) {
    const job = jobs.get(message.jobId)
    if (!job || job.hostInstanceId !== hostInstanceId || job.targetId !== message.targetId
      || job.generation !== message.generation || job.requestId !== message.requestId || job.taskNonce !== message.taskNonce) return undefined
    if (message.kind === 'settled') return job
    const target = targets.get(job.targetId)
    if (!target || !target.available || target.generation !== job.generation || target.conversationId !== job.conversationId) return undefined
    if (job.isCurrent() !== true) return undefined
    return job
  }

  function acceptTarget(message) {
    if (message.hostInstanceId !== hostInstanceId) return jsonError(409, 'HOST_EPOCH_MISMATCH')
    const previous = targets.get(message.targetId)
    if (previous && message.generation < previous.generation) return jsonError(409, 'STALE_TARGET')
    if (previous && message.generation === previous.generation
      && (previous.providerId !== message.providerId || previous.windowId !== message.windowId
        || previous.conversationId !== message.conversationId || previous.available !== message.available)) {
      return jsonError(409, 'TARGET_GENERATION_REQUIRED')
    }
    targets.set(message.targetId, {
      targetId: message.targetId, generation: message.generation, providerId: message.providerId,
      windowId: message.windowId, conversationId: message.conversationId, available: message.available, reason: message.reason,
    })
    if (previous && message.generation > previous.generation) {
      for (const job of jobs.values()) if (job.targetId === message.targetId && !job.nativeEnded) {
        job.controller.abort('TARGET_CHANGED')
        enqueue({ type: 'cancel', hostInstanceId, jobId: job.jobId, targetId: job.targetId, generation: job.generation, requestId: job.requestId, taskNonce: job.taskNonce })
        enqueue({ type: 'release', hostInstanceId, jobId: job.jobId, targetId: job.targetId, generation: job.generation, requestId: job.requestId, taskNonce: job.taskNonce, completed: false })
        job.observation.resolve({ kind: 'error', errorCode: 'TARGET_CHANGED' })
      }
    }
    return jsonResponse(200, { ok: true })
  }

  async function handleRequest(request) {
    let message
    try { message = await readMainRequest(request, nativeBridgeKey) }
    catch (error) {
      const code = error?.code ?? 'INVALID_MESSAGE'
      const status = code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'BODY_TOO_LARGE' ? 413 : code === 'BRIDGE_UNAVAILABLE' ? 503 : 400
      return jsonError(status, code)
    }
    if (message.type === 'hello') return closed ? jsonError(503, 'BRIDGE_CLOSED') : jsonResponse(200, { ok: true, hostInstanceId })
    if (closed) return jsonError(503, 'BRIDGE_CLOSED')
    if (message.hostInstanceId !== hostInstanceId) return jsonError(409, 'HOST_EPOCH_MISMATCH')
    if (message.type === 'target') return acceptTarget(message)
    if (message.type === 'remove-target') {
      const previous = targets.get(message.targetId)
      if (previous && message.generation < previous.generation) return jsonError(409, 'STALE_TARGET')
      targets.delete(message.targetId)
      for (const job of jobs.values()) if (job.targetId === message.targetId && !job.physicalSettled) {
        job.controller.abort('TARGET_REMOVED')
        job.observation.resolve({ kind: 'error', errorCode: 'TARGET_REMOVED' })
      }
      return jsonResponse(200, { ok: true })
    }
    if (message.type === 'next') {
      const command = await nextCommand(message.timeoutMs, request.signal)
      return jsonResponse(200, { ok: true, hostInstanceId, command })
    }
    if (message.type === 'event') {
      const job = jobForEvent(message)
      if (!job) return jsonError(409, 'STALE_JOB')
      if (message.kind === 'assistant') {
        const observation = message.observation
        if (observation.conversationId !== job.conversationId || observation.taskNonce !== job.taskNonce || observation.requestId !== job.requestId) return jsonError(409, 'EVENT_CORRELATION_MISMATCH')
        const fingerprint = JSON.stringify([observation.source, observation.role, observation.isNew, observation.complete,
          observation.generating, observation.messageId, observation.conversationId, observation.taskNonce,
          observation.requestId, observation.content])
        if (job.messageIds.has(observation.messageId)) {
          if (job.messageIds.get(observation.messageId) === fingerprint) return jsonResponse(200, { ok: true, duplicate: true })
          return jsonError(409, 'MESSAGE_ID_CONFLICT')
        }
        job.messageIds.set(observation.messageId, fingerprint)
        job.observation.resolve({ kind: 'assistant', observation })
      } else if (message.kind === 'error') job.observation.resolve({ kind: 'error', errorCode: message.errorCode })
      else if (message.kind === 'settled') {
        job.physicalSettled = true
        if (job.nativeEnded) jobs.delete(job.jobId)
      }
      job.progress?.({ phase: message.kind })
      return jsonResponse(200, { ok: true })
    }
    return jsonError(400, 'INVALID_MESSAGE')
  }

  const unregisterRoute = ctx.connection.fetch.register({
    path: WEB_AI_NATIVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handleRequest,
  })

  async function createTask(binding, exec, target, job) {
    if (!runtimeFiles?.bind || !runtimeFiles?.execute || !runtimeFiles?.revoke
      || typeof createFileTools !== 'function' || typeof createToolEnvelope !== 'function' || !object(toolManifest) || !Array.isArray(toolManifest.tools)) {
      throw Object.assign(new Error('FILE_TOOLS_UNAVAILABLE'), { code: 'FILE_TOOLS_UNAVAILABLE' })
    }
    if (typeof binding.root !== 'string' || !binding.root || typeof binding.getRoot !== 'function'
      || typeof binding.isCurrent !== 'function' || typeof binding.getDeniedTools !== 'function' || !binding.fs) {
      throw Object.assign(new Error('NATIVE_WORKSPACE_UNAVAILABLE'), { code: 'NATIVE_WORKSPACE_UNAVAILABLE' })
    }
    const isCurrent = () => !exec.signal?.aborted && binding.isCurrent() === true
      && targets.get(target.targetId)?.generation === target.generation
    let runtimeCapability
    const fileTools = createFileTools({
      fs: binding.fs,
      createScopedExecutor: async grant => {
        runtimeCapability = await runtimeFiles.bind({
          exec, root: grant.root, getRoot: (...args) => binding.getRoot(...args), isCurrent,
          getDeniedTools: (...args) => binding.getDeniedTools(...args), ttlMs: grant.ttlMs,
        })
        return {
          execute: request => runtimeFiles.execute(runtimeCapability, request),
          revoke: () => runtimeFiles.revoke(runtimeCapability),
        }
      },
    })
    let grant
    try {
      grant = await fileTools.issueGrant({
      providerId: target.providerId, windowId: target.windowId, conversationId: target.conversationId,
      root: binding.root, signal: exec.signal, isCurrent,
      })
      const envelope = createToolEnvelope({ fileTools })
      if (!envelope || typeof envelope.issueTask !== 'function' || typeof envelope.observeAssistantMessage !== 'function' || typeof envelope.revokeTask !== 'function') {
        throw Object.assign(new Error('FILE_TOOLS_UNAVAILABLE'), { code: 'FILE_TOOLS_UNAVAILABLE' })
      }
      const taskId = randomUUID()
      const taskNonce = job.taskNonce
      const capability = envelope.issueTask({
        taskId, taskNonce, providerId: target.providerId, windowId: target.windowId,
        conversationId: target.conversationId, grant,
        nativeContext: { providerId: target.providerId, windowId: target.windowId, conversationId: target.conversationId, signal: exec.signal },
        isCurrent,
      })
      return { taskId, taskNonce, capability, envelope, fileTools, grant }
    } catch (error) {
      if (grant) { try { fileTools.revoke(grant) } catch {} }
      else if (runtimeCapability) { try { runtimeFiles.revoke(runtimeCapability) } catch {} }
      throw error
    }
  }

  async function executeAsk(args, exec, progress) {
    if (closed) throw Object.assign(new Error('BRIDGE_CLOSED'), { code: 'BRIDGE_CLOSED' })
    if (!exec || typeof exec !== 'object' || typeof exec.callId !== 'string' || !exec.callId || !exec.signal || typeof exec.signal.aborted !== 'boolean') {
      throw Object.assign(new Error('NATIVE_EXEC_UNAVAILABLE'), { code: 'NATIVE_EXEC_UNAVAILABLE' })
    }
    const requestId = exec.callId
    if (!validId(requestId, 128)) throw Object.assign(new Error('NATIVE_EXEC_UNAVAILABLE'), { code: 'NATIVE_EXEC_UNAVAILABLE' })
    if (!object(args) || Object.keys(args).some(key => !['targetId', 'prompt', 'withFiles', 'timeoutMs'].includes(key))
      || !validId(args.targetId) || typeof args.prompt !== 'string' || !args.prompt.trim()
      || Buffer.byteLength(args.prompt, 'utf8') > 64 * 1024
      || (args.withFiles !== undefined && typeof args.withFiles !== 'boolean')
      || (args.timeoutMs !== undefined && !Number.isSafeInteger(args.timeoutMs))) throw Object.assign(new Error('INVALID_ARGUMENTS'), { code: 'INVALID_ARGUMENTS' })
    const targetId = args.targetId
    const fingerprint = JSON.stringify(args)
    let cache = requestCache.get(exec)
    if (!cache) { cache = new Map(); requestCache.set(exec, cache) }
    const previous = cache.get(requestId)
    if (previous) {
      let current = false
      try { current = !exec.signal.aborted && previous.isCurrent() === true } catch {}
      if (!current) { cache.delete(requestId); throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' }) }
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('REQUEST_ID_REUSED'), { code: 'REQUEST_ID_REUSED' })
      return previous.promise
    }
    const record = { fingerprint, promise: undefined, isCurrent: () => !exec.signal.aborted }
    record.promise = (async () => {
      const target = targets.get(targetId)
      if (!target?.available || !target.conversationId) throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' })
      const binding = await authorizeNativeToolRun({ exec, targetId })
      if (!binding || binding.exec !== exec || binding.targetId !== targetId
        || binding.providerId !== target.providerId || binding.conversationId !== target.conversationId
        || typeof binding.isCurrent !== 'function' || binding.isCurrent() !== true) {
        throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
      }
      record.isCurrent = () => binding.isCurrent()
      return runAsk(args, exec, requestId, progress, target, binding)
    })()
    cache.set(requestId, record)
    try { return await record.promise }
    finally { if (exec.signal.aborted || record.isCurrent() !== true) cache.delete(requestId) }
  }

  async function waitObservation(job, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => { clearTimer(timer); signal?.removeEventListener('abort', onAbort); job.controller.signal.removeEventListener('abort', onAbort) }
      const done = callback => value => { cleanup(); callback(value) }
      const onAbort = done(() => reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })))
      if (signal?.aborted || job.controller.signal.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimer(done(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }))), timeoutMs)
      job.observation.promise.then(done(resolve), done(reject))
    })
  }

  async function runAsk(args, exec, requestId, progress, target, binding) {
    const targetId = args.targetId
    if (!validId(targetId) || typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt, 'utf8') > 64 * 1024) {
      throw Object.assign(new Error('INVALID_ARGUMENTS'), { code: 'INVALID_ARGUMENTS' })
    }
    const job = {
      hostInstanceId, jobId: randomUUID(), targetId, generation: target.generation,
      requestId, taskNonce: randomUUID(), conversationId: target.conversationId,
      controller: new AbortController(), observation: deferred(), isCurrent: () => binding.isCurrent(),
      progress, nativeEnded: false, physicalSettled: false, messageIds: new Map(),
    }
    const onAbort = () => job.controller.abort('EXEC_ABORTED')
    exec.signal.addEventListener('abort', onAbort, { once: true })
    jobs.set(job.jobId, job)
    let task
    let completed = false
    try {
      if (exec.signal.aborted || !binding.isCurrent()) throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
      if (args.withFiles === true) task = await createTask(binding, exec, target, job)
      if (exec.signal.aborted || binding.isCurrent() !== true || targets.get(targetId) !== target
        || !target.available || target.generation !== job.generation || target.conversationId !== job.conversationId) {
        throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
      }
      enqueue({
        type: 'ask', hostInstanceId, jobId: job.jobId, targetId, generation: target.generation,
        requestId, taskNonce: job.taskNonce, prompt: args.prompt,
        ...(task ? { fileTask: { taskId: task.taskId, taskNonce: task.taskNonce, manifest: projectToolManifest(toolManifest) } } : {}),
      })
      const timeoutMs = Math.max(1_000, Math.min(120_000, Number.isSafeInteger(args.timeoutMs) ? args.timeoutMs : 60_000))
      const expires = Date.now() + timeoutMs
      while (true) {
        if (exec.signal.aborted || !binding.isCurrent()) throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
        const remaining = expires - Date.now()
        if (remaining <= 0) throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })
        const event = await waitObservation(job, exec.signal, remaining)
        job.observation = deferred()
        if (event.kind === 'error') throw Object.assign(new Error(event.errorCode || 'UNAVAILABLE'), { code: event.errorCode || 'UNAVAILABLE' })
        if (task) {
          const result = await task.envelope.observeAssistantMessage(task.capability, event.observation)
          if ((result.status === 'completed' || result.status === 'failed') && result.requestId) {
            if (exec.signal.aborted || !binding.isCurrent()) throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
            enqueue({ type: 'tool-result', hostInstanceId, jobId: job.jobId, targetId, generation: target.generation,
              requestId, taskNonce: job.taskNonce, taskId: task.taskId, result })
            continue
          }
          const claimsFileTask = /"kind"\s*:\s*"tradeloom-file-task"/.test(event.observation.content)
          if (result.status !== 'rejected' || result.error?.code !== 'INVALID_ENVELOPE' || claimsFileTask) {
            throw Object.assign(new Error(result.error?.code ?? `FILE_TASK_${String(result.status).toUpperCase()}`), { code: result.error?.code ?? 'INVALID_FILE_TASK_RESPONSE' })
          }
        }
        if (exec.signal.aborted || !binding.isCurrent()) throw Object.assign(new Error('NATIVE_AUTH_DENIED'), { code: 'NATIVE_AUTH_DENIED' })
        completed = true
        return { answer: event.observation.content, requestId }
      }
    } catch (error) {
      enqueue({ type: 'cancel', hostInstanceId, jobId: job.jobId, targetId, generation: target.generation, requestId, taskNonce: job.taskNonce })
      throw error
    } finally {
      exec.signal.removeEventListener('abort', onAbort)
      if (task) {
        try { task.envelope.revokeTask(task.capability) } catch {}
        try { task.fileTools.revoke(task.grant) } catch {}
      }
      enqueue({ type: 'release', hostInstanceId, jobId: job.jobId, targetId, generation: target.generation, requestId, taskNonce: job.taskNonce, completed })
      job.nativeEnded = true
      if (job.physicalSettled) jobs.delete(job.jobId)
    }
  }

  const unregisterTools = []
  unregisterTools.push(ctx.tools.register({
    name: 'tradeloom_webai_targets', description: 'List authorized WebAI targets available to this native session.',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: TARGETS_OUTPUT,
    async execute(_args, exec) {
      if (closed || !object(_args) || Object.keys(_args).length) throw Object.assign(new Error('INVALID_ARGUMENTS'), { code: 'INVALID_ARGUMENTS' })
      const rows = await listAuthorizedTargets({ exec })
      if (!Array.isArray(rows)) return { targets: [] }
      return { targets: rows.flatMap(row => {
        const target = targets.get(row?.targetId)
        if (!target?.available || target.generation !== row.generation || target.conversationId !== row.conversationId) return []
        return [{ targetId: target.targetId, providerId: target.providerId, conversationId: target.conversationId }]
      }) }
    },
  }))
  unregisterTools.push(ctx.tools.register({
    name: 'tradeloom_webai_ask', description: 'Ask one explicitly selected authorized WebAI target.',
    parameters: { type: 'object', additionalProperties: false, required: ['targetId', 'prompt'], properties: {
      targetId: { type: 'string', minLength: 1, maxLength: 256 }, prompt: { type: 'string', minLength: 1, maxLength: 65_536 }, withFiles: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1_000, maximum: 120_000 },
    } }, output: ASK_OUTPUT,
    execute: (args, exec) => executeAsk(args, exec, progress => ctx.emit?.('tradeloom-webai/progress', progress, exec)),
  }))

  async function dispose() {
    if (closed) return
    closed = true
    for (const job of jobs.values()) {
      job.controller.abort('HOST_CLOSED')
      job.observation.resolve({ kind: 'error', errorCode: 'HOST_CLOSED' })
    }
    for (const waiter of nextWaiters.splice(0)) waiter.resolve(null)
    commands.length = 0
    for (const unregister of unregisterTools) { try { await unregister?.() } catch {} }
    await unregisterRoute?.()
  }

  return Object.freeze({ available: true, hostInstanceId, handleRequest, dispose, targets, jobs })
}

