import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as standardFsTools from '@deepseek-ai/dsh-tool-fs'
import { createWebAiRuntimeFiles } from './webai-runtime-files.js'
import { deniedToolsForScope } from './tool-policy.js'
import { createHash, randomUUID } from 'node:crypto'
import { createWebAiToolEnvelope, WEB_AI_TOOL_MANIFEST } from './webai-tool-envelope.js'
import { executeNativeTool } from './workflow-native-command-attribution.js'

export const WEB_AI_TASK_ROUTE = '/tradeloom/webai-task'

const fail = code => Object.assign(Error(code), { code })
const ownerKeys = ['guestId', 'generation', 'sceneId', 'panelId', 'roleId', 'sessionId', 'bindingRevision', 'operationId']
const targetKeys = ['targetId', 'providerId', 'windowId', 'conversationId', 'generation']
const same = (a, b, keys) => a && b && keys.every(key => a[key] === b[key])

/** Main-only control plane + actual scoped ToolsService/LocalFileSystem data
 * plane. No HTTP/renderer field can supply a directory or mint a mount. A
 * provider's live pending native-ask operation is mandatory, not a busy URL. */
export function createWebAiDirectoryHost(ctx, { getAuthority, assertBinding, now = Date.now }) {
  if (typeof getAuthority !== 'function' || typeof assertBinding !== 'function') throw new TypeError('Live Host origin/binding authority required')
  const mounts = new Map(), tasks = new Map(), finishedTasks = new Map()
  let runtime, closed = false, disposal
  const taskCurrent = task => !!task && !closed && tasks.get(task.id) === task && !task.controller.signal.aborted
    && task.expiresAt > now() && ctx.agents.get(task.actor.id) === task.actor && task.actor.session?.id === task.owner.sessionId
  async function assertTask(task, source) {
    if (!taskCurrent(task) || source && !same(task.owner, source, ownerKeys.filter(key => key !== 'operationId'))) throw fail('webai_task_unavailable')
    const authority = await getAuthority()
    authority.captureQueuedOrigin(task.origin, task.work, task.actor)
    await assertBinding(task.owner)
    if (!taskCurrent(task)) throw fail('webai_task_unavailable')
    return authority
  }
  const envelope = createWebAiToolEnvelope({ fileTools: {
    async execute(task, _nativeContext, request) {
      const authority = await assertTask(task)
      if (!task.mount || mounts.get(task.mount.id) !== task.mount) throw fail('webai_directory_grant_denied')
      const work = authority.retainOriginWork(task.origin, { kind: 'queue', owner: task.actor })
      try {
        const result = await authority.withVerifiedRequestOrigin(task.origin, () => executeNativeTool(ctx.tools, {
          name: 'tradeloom_webai_file', arguments: { grantId: task.mount.id, request }, callId: `webai-${randomUUID()}`,
          agent: task.actor, signal: task.controller.signal, operationOrigin: task.origin, operationOriginWorkId: work,
        }))
        await assertTask(task)
        return result.isError ? { ok: false, error: { code: result.error?.code ?? 'TOOL_UNAVAILABLE' } } : result.value
      } finally { await authority.releaseOriginWork(task.origin, work, 'webai-file-ended', task.actor) }
    },
    revoke(task) { if (task.mount) revoke(task.mount.id) },
  } })
  async function finishTask(task, reason = 'cancelled') {
    if (tasks.get(task.id) !== task) { const previous = finishedTasks.get(task.id); if (previous) { await previous.done; if (previous.failed) throw fail('webai_task_cleanup_failed') }; return false }
    let resolveDone
    const previous = { owner: task.owner, failed: false, done: new Promise(resolve => { resolveDone = resolve }) }
    finishedTasks.set(task.id, previous)
    tasks.delete(task.id); task.controller.abort(); clearTimeout(task.timer)
    let failure
    try {
      if (task.capability) envelope.revokeTask(task.capability)
      const authority = await getAuthority()
      await authority.cancelOrigin(task.origin, [task.work], task.actor, reason)
    }
    catch (error) { failure = error }
    await task.tail
    previous.failed = !!failure; resolveDone()
    while (finishedTasks.size > 64) finishedTasks.delete(finishedTasks.keys().next().value)
    if (failure) throw fail('webai_task_cleanup_failed')
    return true
  }
  const files = () => runtime ??= createWebAiRuntimeFiles(ctx, {
    ToolRuntime: ToolsService, ToolExecutionPipeline, LocalFileSystem, SandboxedFileSystem, FsError, scopeOf, standardFsTools,
  }, { enableFullRead: true, enableStandardWrite: true, useMountedFileSystem: true })
  async function assertExecution(record, exec) {
    if (closed || mounts.get(record.id) !== record || record.controller.signal.aborted || record.expiresAt <= now()
      || exec.signal.aborted || ctx.agents.get(exec.agent?.id) !== exec.agent || scopeOf(exec.agent.ctx) !== exec.agent
      || exec.agent.session?.id !== record.owner.sessionId) throw fail('webai_directory_grant_denied')
    const authority = await getAuthority()
    const origin = authority.currentToolExecution()?.operationOrigin
    // The public operation DTO deliberately omits Main's guest id/generation;
    // those come only from sourceForOrigin's private verified issuer tuple.
    if (!origin || origin !== exec.operationOrigin || !same(origin, record.owner, ownerKeys.filter(key => !['guestId', 'generation'].includes(key)))) throw fail('webai_directory_grant_denied')
    const source = authority.sourceForOrigin(origin)
    if (!same(source, record.owner, ownerKeys.filter(key => key !== 'operationId'))) throw fail('webai_directory_grant_denied')
    await assertBinding(record.owner)
    if (mounts.get(record.id) !== record || record.controller.signal.aborted || exec.signal.aborted) throw fail('webai_directory_grant_denied')
  }
  function revoke(id) {
    const record = mounts.get(id)
    if (!record) return false
    mounts.delete(id); record.controller.abort(); clearTimeout(record.timer)
    for (const task of tasks.values()) if (task.mount === record) { task.controller.abort(); task.cleanup = finishTask(task).catch(error => { task.cleanupFailure = error?.code ?? 'webai_task_cleanup_failed' }) }
    for (const capability of record.capabilities) runtime?.revoke(capability)
    record.capabilities.clear(); return true
  }
  const unregister = ctx.tools.register({ name: 'tradeloom_webai_file',
    description: 'Use one explicit task-directory grant of the current native website request. No grant means no files. Existing files are never overwritten.',
    parameters: { type: 'object', additionalProperties: false, required: ['grantId', 'request'], properties: {
      grantId: { type: 'string', maxLength: 128 }, request: { type: 'object', required: ['op', 'path', 'requestId'], properties: {
        op: { type: 'string', enum: ['list', 'read', 'write_new'] }, path: { type: 'string' }, requestId: { type: 'string' }, content: { type: 'string' },
      } },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const record = mounts.get(args.grantId)
      if (!record || args.request?.op === 'write_new' && !record.write) throw fail('webai_directory_grant_denied')
      await assertExecution(record, exec)
      const bridge = files()
      const capability = await bridge.bind({ exec, root: record.rootPath, getRoot: () => record.rootPath,
        isCurrent: () => mounts.get(record.id) === record && !record.controller.signal.aborted && record.expiresAt > now(),
        getDeniedTools: () => [...deniedToolsForScope(exec.agent), ...(record.write ? [] : ['write'])], ttlMs: Math.min(300000, record.expiresAt - now()) })
      record.capabilities.add(capability)
      const abort = () => bridge.revoke(capability)
      record.controller.signal.addEventListener('abort', abort, { once: true })
      try { await assertExecution(record, exec); const result = await bridge.execute(capability, args.request); await assertExecution(record, exec); return result }
      finally { record.controller.signal.removeEventListener('abort', abort); bridge.revoke(capability); record.capabilities.delete(capability) }
    },
  })
  return Object.freeze({
    // Called only after the ordinary authenticated HTTP/body-bound grant route
    // has minted a canonical origin. No renderer-supplied owner is accepted.
    async createTask(origin, input) {
      if (!input || Object.keys(input).sort().join(',') !== 'id,prompt,providerId' || !['deepseek', 'doubao'].includes(input.providerId)
        || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 12000) throw fail('invalid_arguments')
      const authority = await getAuthority(), source = authority.sourceForOrigin(origin), actor = ctx.agents.get(origin.sessionId)
      if (!actor || actor.id !== origin.sessionId || actor.session?.id !== origin.sessionId) throw fail('webai_task_agent_unavailable')
      const owner = Object.freeze({ ...source, operationId: origin.operationId })
      await assertBinding(owner)
      const work = authority.retainOriginWork(origin, { kind: 'queue', owner: actor })
      const task = { id: randomUUID(), nonce: randomUUID(), providerId: input.providerId, prompt: input.prompt, owner,
        origin, actor, work, expiresAt: origin.activeUntil, controller: new AbortController(), tail: Promise.resolve() }
      tasks.set(task.id, task)
      task.timer = setTimeout(() => { task.cleanup = finishTask(task, 'expired').catch(error => { task.cleanupFailure = error?.code ?? 'webai_task_cleanup_failed' }) }, Math.max(1, task.expiresAt - now())); task.timer.unref?.()
      return { taskId: task.id }
    },
    // This method is reachable solely through the existing private Main child
    // control channel, after host.js revalidates its trusted source descriptor.
    async taskControl(input, source) {
      if (!input || !['task-read', 'task-observe', 'task-cancel'].includes(input.action) || typeof input.taskId !== 'string') throw fail('invalid_arguments')
      const previous = finishedTasks.get(input.taskId)
      if (previous) {
        if (!same(previous.owner, source, ownerKeys.filter(key => key !== 'operationId'))) throw fail('webai_task_unavailable')
        await previous.done
        if (previous.failed) throw fail('webai_task_cleanup_failed')
        if (input.action === 'task-cancel' && Object.keys(input).sort().join(',') === 'action,taskId') return { cancelled: true }
        throw fail('webai_task_unavailable')
      }
      const task = tasks.get(input.taskId)
      // Revocation may target a now-stale binding, but only the exact private
      // issuer of this existing capability. It cannot mint or execute work.
      if (input.action === 'task-cancel') {
        if (Object.keys(input).sort().join(',') !== 'action,taskId' || !task || !same(task.owner, source, ownerKeys.filter(key => key !== 'operationId'))) throw fail('webai_task_unavailable')
        return { cancelled: await finishTask(task) }
      }
      await assertTask(task, source)
      if (input.action === 'task-read') {
        if (Object.keys(input).sort().join(',') !== 'action,taskId') throw fail('invalid_arguments')
        return { taskId: task.id, taskNonce: task.nonce, providerId: task.providerId, prompt: task.prompt, owner: task.owner, expiresAt: task.expiresAt, manifest: WEB_AI_TOOL_MANIFEST }
      }
      if (Object.keys(input).sort().join(',') !== 'action,observation,taskId' || !task.capability) throw fail('webai_directory_grant_denied')
      const run = async () => {
        await assertTask(task, source)
        const observation = input.observation
        const response = await envelope.observeAssistantMessage(task.capability, observation)
        await assertTask(task, source)
        return response
      }
      const pending = task.tail.then(run); task.tail = pending.catch(() => {})
      return pending
    },
    // Called solely inside sceneMemoryOriginAuthority's trusted Main control.
    acceptControl(input, source) {
      if (closed || !input || !['mount', 'revoke'].includes(input.action)) throw fail('webai_directory_grant_denied')
      if (input.action === 'revoke') {
        const record = mounts.get(input.id)
        if (record && !same(record.owner, source, ownerKeys.filter(key => key !== 'operationId'))) throw fail('webai_directory_grant_denied')
        return revoke(input.id)
      }
      if (Object.keys(input).sort().join(',') !== 'action,expiresAt,id,owner,rootPath,target,write'
        || typeof input.id !== 'string' || mounts.has(input.id) || typeof input.rootPath !== 'string'
        || typeof input.write !== 'boolean' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now() || input.expiresAt > now() + 15 * 60000
        || !same(input.owner, source, ownerKeys.filter(key => key !== 'operationId')) || typeof input.owner.operationId !== 'string'
        || targetKeys.some(key => input.target?.[key] === undefined) || !['deepseek', 'doubao'].includes(input.target.providerId)) throw fail('webai_directory_grant_denied')
      const record = { ...input, owner: Object.freeze({ ...input.owner }), target: Object.freeze({ ...input.target }), controller: new AbortController(), capabilities: new Set() }
      // Install the execution observer before admission of the first tool body.
      // Creating it inside execute() misses that body's already-entered around hook.
      files()
      record.timer = setTimeout(() => revoke(record.id), input.expiresAt - now()); record.timer.unref?.()
      mounts.set(record.id, record)
      const task = [...tasks.values()].find(value => value.owner.operationId === record.owner.operationId)
      if (task) {
        if (!taskCurrent(task) || task.mount || task.providerId !== record.target.providerId) { revoke(record.id); throw fail('webai_directory_grant_denied') }
        task.mount = record
        task.capability = envelope.issueTask({ taskId: task.id, taskNonce: task.nonce, providerId: task.providerId,
          windowId: record.target.windowId, conversationId: record.target.conversationId, grant: task,
          nativeContext: { providerId: task.providerId, windowId: record.target.windowId, conversationId: record.target.conversationId }, isCurrent: () => taskCurrent(task) && mounts.get(record.id) === record })
      }
      return true
    },
    dispose() { return disposal ??= (async () => { closed = true; unregister(); const failures = []; for (const task of [...tasks.values()]) try { await finishTask(task) } catch (error) { failures.push(error) }; await Promise.all([...finishedTasks.values()].map(row => row.done)); for (const id of [...mounts.keys()]) revoke(id); if (runtime) await runtime.dispose(); if (failures.length || [...finishedTasks.values()].some(row => row.failed)) throw new AggregateError(failures, 'webai_task_cleanup_failed') })() },
  })
}

/** Existing authenticated connection + Main-issued, body-bound origin grant.
 * The returned id is an opaque handle, not authority to issue task observations. */
export function createWebAiTaskHandler(ctx, authority, host) {
  return async (req, res) => {
    const respond = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)) }
    const rejected = ctx.connection.requestRejection(req)
    if (rejected !== undefined) return respond(rejected, { ok: false, error_code: 'request_forbidden' })
    if (req.method !== 'POST') return respond(405, { ok: false, error_code: 'method_not_allowed' })
    try {
      let size = 0; const chunks = []
      for await (const part of req) { const b = Buffer.from(part); size += b.length; if (size > 16000) throw fail('invalid_arguments'); chunks.push(b) }
      const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8')), endpoint = WEB_AI_TASK_ROUTE.slice(1)
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw fail('invalid_arguments')
      const origin = await authority.verifyRequest({ token: req.headers['x-tradeloom-origin'], endpoint, routePath: endpoint, httpMethod: 'POST', method: endpoint,
        rpcId: input.id, bodyBytes: bytes, bodyDigest: createHash('sha256').update(bytes).digest('hex'), peerId: 'desktop-webai-task', peerPrincipal: 'owner' })
      const result = await authority.withVerifiedRequestOrigin(origin, () => host.createTask(origin, input))
      respond(200, { ok: true, result })
    } catch (error) { respond(409, { ok: false, error_code: ['invalid_arguments', 'webai_task_agent_unavailable', 'stale_role_binding'].includes(error?.code) ? error.code : 'webai_task_unavailable' }) }
  }
}
