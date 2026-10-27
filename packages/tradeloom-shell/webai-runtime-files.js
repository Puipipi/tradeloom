import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { createLocalDirectoryLister } from './webai-local-directory.js'

export const WEB_AI_RUNTIME_LIST_TOOL = 'tradeloom_webai_list_directory'
export const WEB_AI_RUNTIME_READ_TOOL = 'tradeloom_webai_read_file'
const READ_CAP = 256 * 1024
const WRITE_CAP = 64 * 1024
const DENIAL = 'This file operation is unavailable for this caller.'
const error = code => ({ ok: false, error: { code } })
const codeMap = Object.freeze({
  UNKNOWN_TOOL: 'TOOL_UNAVAILABLE',
  FS_NOT_TEXT: 'BINARY_OR_INVALID_UTF8', FS_TOO_LARGE: 'TOO_LARGE',
  FS_NOT_FOUND: 'NOT_FOUND', FS_NOT_REGULAR_FILE: 'NOT_FILE',
  FS_NOT_DIRECTORY: 'NOT_DIRECTORY', FS_NOT_OBSERVED: 'ALREADY_EXISTS',
  FS_STALE_VERSION: 'ALREADY_EXISTS', FS_SANDBOX_DENIED: 'TOOL_DENIED',
  FS_ABORTED: 'CANCELLED', ABORTED: 'CANCELLED', ABORTED_BEFORE_DISPATCH: 'CANCELLED',
  O07_GRANT: 'INVALID_GRANT', O07_SIZE: 'TOO_LARGE', O07_EXISTS: 'ALREADY_EXISTS',
})
function validRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false
  const fields = request.op === 'write_new' ? 'content,op,path,requestId' : 'op,path,requestId'
  if (Object.keys(request).sort().join(',') !== fields || !['read', 'list', 'write_new'].includes(request.op)
    || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128
    || typeof request.path !== 'string' || !request.path || request.path.length > 1024) return false
  const path = request.path
  if (path !== '.' && (path.includes('\\') || isAbsolute(path) || path.includes('\0')
    || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p)))) return false
  return request.op !== 'write_new' || typeof request.content === 'string' && Buffer.byteLength(request.content) <= WRITE_CAP
}

/** Native Host assembly only. SDK dependencies must come from its mounted runtime.
 * Mount FileSystem before the standard tool-fs plugin. This is not a page API.
 * Request-id replay remains owned by the existing filetools/envelope ledger.
 */
export function createWebAiRuntimeFiles(ctx, { ToolRuntime, LocalFileSystem, SandboxedFileSystem, FsError, scopeOf, standardFsTools }, { enableFullRead = false, enableStandardWrite = false } = {}) {
  if (!(ctx.tools instanceof ToolRuntime) || !(SandboxedFileSystem.prototype instanceof LocalFileSystem)
    || typeof FsError !== 'function' || typeof scopeOf !== 'function' || typeof ctx.agents?.get !== 'function'
    || typeof enableFullRead !== 'boolean' || typeof enableStandardWrite !== 'boolean'
    || enableStandardWrite && typeof standardFsTools?.apply !== 'function') throw new TypeError('Actual runtime services are required')
  const fail = code => { throw new FsError('File operation unavailable', code) }
  const liveExecutions = new WeakSet()
  const grants = new WeakMap()
  const owned = new Set()
  const pending = new Map()
  const scopes = new Map()
  const active = new AsyncLocalStorage()
  let closed = false
  const alive = grant => {
    try {
      return !closed && !grant.revoked && Date.now() < grant.expiresAt
        && !grant.exec.signal.aborted && liveExecutions.has(grant.exec)
        && ctx.agents.get(grant.agent.id) === grant.agent && grant.agent.session === grant.session
        && scopeOf(grant.agent.ctx) === grant.agent && grant.isCurrent() === true
        && resolve(grant.getRoot()) === grant.rootPath
    } catch { return false }
  }
  const denied = item => {
    try {
      const names = item.grant.getDeniedTools()
      if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) return true
      return item.name === WEB_AI_RUNTIME_LIST_TOOL
        ? ['read', 'glob', WEB_AI_RUNTIME_LIST_TOOL].some(name => names.includes(name))
        : item.name === WEB_AI_RUNTIME_READ_TOOL ? ['read', WEB_AI_RUNTIME_READ_TOOL].some(name => names.includes(name))
        : names.includes(item.name)
    } catch { return true }
  }
  const assertLive = (grant, signal) => { signal?.throwIfAborted(); if (!alive(grant)) fail('O07_GRANT') }
  async function checkTarget(fs, target, item, signal) {
    assertLive(item.grant, signal)
    if (item.name === WEB_AI_RUNTIME_READ_TOOL || item.name === 'write') {
      if ((await fs.lstat(item.grant.rootPath, {}, signal))?.type !== 'directory') fail('O07_GRANT')
      const parts = item.path === '.' ? [] : item.path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const info = await fs.lstat(parts.slice(0, i).join('/'), { cwd: item.grant.rootPath }, signal)
        assertLive(item.grant, signal)
        if (info?.type === 'symlink' || info?.type === 'other'
          || !info && !(item.name === 'write' && i === parts.length)) fail('O07_GRANT')
      }
    }
    const root = await fs.resolve(item.grant.rootPath, { signal })
    const fresh = await fs.resolve(target.displayPath, { signal })
    assertLive(item.grant, signal)
    if (root.targetKey !== item.grant.rootTarget.targetKey || !fs.contains(root, fresh)) fail('O07_GRANT')
    return fresh
  }
  const unguard = ctx.tools.guard(exec => {
    const item = pending.get(exec.callId)
    return item && exec.agent === item.grant.agent && (!alive(item.grant) || denied(item)) ? DENIAL : undefined
  })
  const unaround = ctx.on('tools/execute', async (exec, next) => {
    liveExecutions.add(exec)
    const item = pending.get(exec.callId)
    const originalSignal = exec.signal
    try {
      if (item) {
        if (exec.agent !== item.grant.agent || exec.parent !== item.grant.exec.token
          || exec.rootCallId !== item.grant.exec.rootCallId || exec.name !== item.name
          || JSON.stringify(exec.arguments) !== JSON.stringify(item.args) || item.consumed) fail('O07_GRANT')
        item.consumed = true
        item.exec = exec
        exec.signal = AbortSignal.any([originalSignal, item.grant.controller.signal])
      }
      const result = await active.run(item, next)
      if (item && !result.isError) item.bodySnapshot = JSON.stringify({ value: result.value, content: result.content })
      return result
    } finally {
      exec.signal = originalSignal
      liveExecutions.delete(exec)
      for (const grant of owned) if (grant.exec === exec) revokeGrant(grant)
    }
  })
  class RuntimeFiles extends SandboxedFileSystem {
    async writeText(target, content, intent, signal, sandboxPolicy) {
      const item = active.getStore()
      if (item?.name !== 'write') return super.writeText(target, content, intent, signal, sandboxPolicy)
      const fresh = await checkTarget(this, target, item, signal)
      if (!sandboxPolicy) fail('O07_GRANT')
      if (intent !== undefined && intent.kind !== 'createIfAbsent') fail('O07_EXISTS')
      assertLive(item.grant, signal)
      return super.writeText(fresh, content, { kind: 'createIfAbsent' }, signal, sandboxPolicy)
    }
  }
  async function ensureListScope(agent) {
    if (scopes.has(agent)) return scopes.get(agent)
    let scopedContext
    const mounting = agent.ctx.plugin({
      name: 'tradeloom-webai-runtime-files', inject: ['tools', 'agents', 'fs'],
      async apply(scoped) {
        if (scopeOf(scoped) !== agent || !(scoped.tools instanceof ToolRuntime) || !(scoped.fs instanceof RuntimeFiles)) fail('O07_GRANT')
        scopedContext = scoped
        // Optional native assembly, never a global tool enablement. Existing
        // definitions retain their original scope, guards and lifetime.
        if (enableStandardWrite && scoped.tools.get('write', agent) === undefined) {
          scoped.tools.guard(exec => {
            if (exec.name !== 'write') return undefined
            const item = pending.get(exec.callId)
            return !item || item.name !== 'write' || item.consumed || exec.agent !== agent
              || item.grant.agent !== agent || !alive(item.grant) || denied(item)
              || exec.parent !== item.grant.exec.token || exec.rootCallId !== item.grant.exec.rootCallId
              || JSON.stringify(exec.arguments) !== JSON.stringify(item.args) ? DENIAL : undefined
          })
          await scoped.plugin(standardFsTools, { read: false, readImage: false, write: true, edit: false })
        }
        const list = createLocalDirectoryLister(scoped.fs, LocalFileSystem)
        scoped.tools.guard(exec => [WEB_AI_RUNTIME_LIST_TOOL, WEB_AI_RUNTIME_READ_TOOL].includes(exec.name) && (!pending.has(exec.callId) || denied(pending.get(exec.callId))) ? DENIAL : undefined)
        if (enableFullRead) scoped.tools.register({
          name: WEB_AI_RUNTIME_READ_TOOL,
          description: 'Native-owned full UTF-8 file read, bounded to 256 KiB. Requires explicit full-file approval and a live directory grant.',
          parameters: { path: { type: 'string', required: true, description: 'Granted relative file path; reads the complete file up to 256 KiB.' } },
          output: {
            schema: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string' } } },
            render: (_args, value) => [{ type: 'text', text: value.content }],
          },
          async execute(args, exec) {
            const item = pending.get(exec.callId)
            if (!item || item.exec !== exec || exec.agent !== agent || args.path !== item.path) fail('O07_GRANT')
            const target = await scoped.fs.resolve(args.path, { cwd: item.grant.rootPath, signal: exec.signal })
            const fresh = await checkTarget(scoped.fs, target, item, exec.signal)
            const info = await scoped.fs.stat(fresh, exec.signal)
            if (!info || info.type !== 'file') fail(info ? 'FS_NOT_REGULAR_FILE' : 'FS_NOT_FOUND')
            const bytes = await scoped.fs.readBytes(fresh, exec.signal, READ_CAP)
            assertLive(item.grant, exec.signal)
            if (bytes.byteLength > READ_CAP) fail('O07_SIZE')
            let content
            try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('FS_NOT_TEXT') }
            if (bytes.subarray(0, 8192).includes(0)) fail('FS_NOT_TEXT')
            scoped.emit('fs/observed', fresh, { kind: 'present', version: info.version }, exec)
            return { content }
          },
        })
        scoped.tools.register({
          name: WEB_AI_RUNTIME_LIST_TOOL, description: 'Native-owned bounded directory operation.',
          parameters: { path: { type: 'string', required: true } },
          output: {
            schema: {
              type: 'object', additionalProperties: false, required: ['items'],
              properties: { items: { type: 'array', items: {
                type: 'object', additionalProperties: false, required: ['name', 'type'],
                properties: { name: { type: 'string' }, type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] }, size: { type: 'integer' } },
              } } },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args, exec) {
            const item = pending.get(exec.callId)
            if (!item || item.exec !== exec || exec.agent !== agent || args.path !== item.path) fail('O07_GRANT')
            assertLive(item.grant, exec.signal)
            const rootPath = item.grant.rootPath
            if ((await scoped.fs.lstat(rootPath, {}, exec.signal))?.type !== 'directory') fail('O07_GRANT')
            const parts = args.path === '.' ? [] : args.path.split('/')
            for (let i = 1; i <= parts.length; i++) {
              if ((await scoped.fs.lstat(parts.slice(0, i).join('/'), { cwd: rootPath }, exec.signal))?.type !== 'directory') fail('O07_GRANT')
              assertLive(item.grant, exec.signal)
            }
            const target = await scoped.fs.resolve(args.path, { cwd: rootPath, signal: exec.signal })
            await checkTarget(scoped.fs, target, item, exec.signal)
            const items = await list(target, { rootTarget: item.grant.rootTarget, rootPath, maxEntries: 201, signal: exec.signal })
            assertLive(item.grant, exec.signal)
            if (items.length > 200) fail('O07_SIZE')
            item.listValue = { items }
            return item.listValue
          },
        })
      },
    })
    const registration = Promise.resolve(mounting).then(fiber => {
      if (!scopedContext) fail('O07_GRANT')
      return { context: scopedContext, dispose: () => fiber.dispose() }
    })
    scopes.set(agent, registration)
    try { return await registration } catch (err) { scopes.delete(agent); throw err }
  }
  function revokeGrant(grant) {
    grant.revoked = true; grant.controller.abort(); clearTimeout(grant.timer)
    owned.delete(grant); grants.delete(grant.capability)
  }
  function revoke(capability) {
    const grant = grants.get(capability)
    if (!grant) return false
    revokeGrant(grant)
    return true
  }
  let disposal
  const dispose = () => disposal ??= (async () => {
    closed = true
    for (const grant of owned) revokeGrant(grant)
    owned.clear(); unaround(); unguard()
    for (const registration of scopes.values()) { try { await (await registration).dispose() } catch {} }
    scopes.clear()
  })()
  ctx.effect(() => dispose)
  return Object.freeze({
    FileSystem: RuntimeFiles,
    async bind({ exec, root, getRoot, isCurrent, getDeniedTools, ttlMs = 300000 }) {
      if (closed || !liveExecutions.has(exec) || !exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent
        || typeof getRoot !== 'function' || typeof isCurrent !== 'function' || typeof getDeniedTools !== 'function'
        || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) fail('O07_GRANT')
      const { context: scoped } = await ensureListScope(exec.agent)
      if (!(scoped.fs instanceof RuntimeFiles)) fail('O07_GRANT')
      const rootTarget = await scoped.fs.resolve(root, { signal: exec.signal })
      const grant = { exec, agent: exec.agent, session: exec.agent.session, rootTarget, rootPath: scoped.fs.processPath(rootTarget), getRoot, isCurrent, getDeniedTools, expiresAt: Date.now() + ttlMs, controller: new AbortController(), revoked: false }
      if ((await scoped.fs.stat(rootTarget, exec.signal))?.type !== 'directory' || !alive(grant)) fail('O07_GRANT')
      assertLive(grant, exec.signal)
      const capability = Object.freeze(Object.create(null))
      grant.capability = capability
      grant.timer = setTimeout(() => revokeGrant(grant), ttlMs)
      grant.timer.unref?.(); grants.set(capability, grant); owned.add(grant)
      return capability
    },
    async execute(capability, request) {
      const grant = grants.get(capability)
      if (!grant || !alive(grant)) return error('INVALID_GRANT')
      if (!validRequest(request)) return error('INVALID_REQUEST')
      if (request.op === 'read' && !enableFullRead) return error('TOOL_UNAVAILABLE')
      const name = request.op === 'list' ? WEB_AI_RUNTIME_LIST_TOOL : request.op === 'read' ? WEB_AI_RUNTIME_READ_TOOL : 'write'
      const path = resolve(grant.rootPath, request.path)
      const args = request.op === 'write_new' ? { file_path: path, content: request.content } : { path: request.path }
      const callId = `webai-files:${randomUUID()}`
      const item = { grant, name, args, path: request.path, consumed: false }
      pending.set(callId, item)
      try {
        const result = await ctx.tools.execute({ callId, name, arguments: args, agent: grant.agent, signal: AbortSignal.any([grant.exec.signal, grant.controller.signal]), parent: grant.exec.token, rootCallId: grant.exec.rootCallId })
        if (result.isError) return error(codeMap[result.error?.info?.code] ?? 'TOOL_FAILED')
        if (!alive(grant) || !item.consumed) return error('INVALID_GRANT')
        if (!item.bodySnapshot || JSON.stringify({ value: result.value, content: result.content }) !== item.bodySnapshot) return error('TOOL_FAILED')
        if (request.op === 'read') return typeof result.value?.content === 'string' ? { ok: true, content: result.value.content } : error('TOOL_FAILED')
        if (request.op === 'write_new') return result.value?.operation === 'create' ? { ok: true, created: true } : error('TOOL_FAILED')
        if (!item.listValue || JSON.stringify(result.value) !== JSON.stringify(item.listValue)) return error('TOOL_FAILED')
        return { ok: true, entries: result.value.items }
      } catch { return error('TOOL_FAILED') }
      finally { pending.delete(callId); item.bodySnapshot = undefined }
    },
    revoke,
    dispose,
  })
}
