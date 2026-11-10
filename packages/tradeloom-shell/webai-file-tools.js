import { isAbsolute } from 'node:path'

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 64 * 1024
const MAX_LIST_ENTRIES = 200
const MAX_PATH_LENGTH = 1024
const MAX_REQUEST_ID_LENGTH = 128
const GRANT_TTL_MS = 5 * 60 * 1000
const MAX_GRANT_TTL_MS = 5 * 60 * 1000
const MAX_CACHED_REQUESTS = 64
const MAX_TEXT_BINARY_SAMPLE_BYTES = 8192

const grantRecords = new WeakMap()

function toolError(code, message) {
  return { ok: false, error: { code, message } }
}

function validOpaque(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function throwIfAborted(signal) {
  if (signal?.aborted) signal.throwIfAborted()
}

function validateRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) throw new Error('INVALID_PATH')
  if (path === '.') return []
  if (path.includes('\\') || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('\0')) throw new Error('INVALID_PATH')
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part))) throw new Error('INVALID_PATH')
  if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error('INVALID_PATH')
  return parts
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_REQUEST')
  const keys = Object.keys(request).sort().join(',')
  if (keys !== 'op,path,requestId' && keys !== 'content,op,path,requestId') throw new Error('INVALID_REQUEST')
  if (!validOpaque(request.requestId) || request.requestId.length > MAX_REQUEST_ID_LENGTH) throw new Error('INVALID_REQUEST')
  const parts = validateRelativePath(request.path)
  if (request.op === 'list' || request.op === 'read') {
    if ('content' in request) throw new Error('INVALID_REQUEST')
  } else if (request.op === 'write_new') {
    if (typeof request.content !== 'string' || Buffer.byteLength(request.content, 'utf8') > MAX_WRITE_BYTES) throw new Error('WRITE_TOO_LARGE')
  } else throw new Error('INVALID_REQUEST')
  return parts
}

function mapError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'FS_ABORTED') return toolError('CANCELLED', '操作已取消。')
  const code = error?.code
  if (code === 'FS_NOT_OBSERVED' || code === 'EEXIST') return toolError('ALREADY_EXISTS', '目标已存在，未覆盖。')
  if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return toolError('NOT_FOUND', '目标不存在。')
  if (code === 'ENOTDIR') return toolError('NOT_DIRECTORY', '路径中的目录无效。')
  if (code === 'FS_TOO_LARGE') return toolError('TOO_LARGE', '目标超过允许的大小。')
  if (code === 'FS_NOT_TEXT') return toolError('BINARY_OR_INVALID_UTF8', '目标不是有效的 UTF-8 文本。')
  if (code === 'FS_NOT_REGULAR_FILE') return toolError('NOT_FILE', '目标不是普通文件。')
  if (code === 'FS_NOT_DIRECTORY') return toolError('NOT_DIRECTORY', '目标不是目录。')
  return toolError('IO_ERROR', '文件操作失败。')
}

function runtimeError(code) {
  const messages = { TOOL_UNAVAILABLE: '当前助手尚未提供此文件操作。', TOOL_DENIED: '当前角色或沙箱策略不允许此操作。', CANCELLED: '操作已取消。', INVALID_GRANT: '访问授权无效。', GRANT_EXPIRED: '访问授权已过期。', INVALID_PATH: '路径无效或超出授权目录。', TOO_LARGE: '目标超过允许的大小。', ALREADY_EXISTS: '目标已存在，未覆盖。', NOT_FOUND: '目标不存在。', NOT_DIRECTORY: '目标不是目录。', NOT_FILE: '目标不是普通文件。', BINARY_OR_INVALID_UTF8: '目标不是有效的 UTF-8 文本。', TOO_MANY_ENTRIES: '目录项目过多，已拒绝返回。' }
  return toolError(Object.hasOwn(messages, code) ? code : 'IO_ERROR', messages[code] ?? '文件操作失败。')
}

/**
 * Build a narrow executor around the existing DSH FileSystem seam.
 * `issueGrant` is the trusted native-only entry point; never expose it to page code.
 */
export function createWebAiFileTools({ fs, now = Date.now, grantTtlMs = GRANT_TTL_MS, createScopedExecutor } = {}) {
  if (!Number.isSafeInteger(grantTtlMs) || grantTtlMs < 1 || grantTtlMs > MAX_GRANT_TTL_MS) throw new TypeError('grantTtlMs must be a positive integer within the supported maximum')
  if (createScopedExecutor !== undefined && typeof createScopedExecutor !== 'function') throw new TypeError('Trusted executor factory required')
  const required = createScopedExecutor ? ['resolve', 'processPath', 'stat'] : ['resolve', 'contains', 'processPath', 'stat', 'lstat', 'readBytes', 'writeText', 'listDirBounded']
  if (!fs || !required.every(key => typeof fs[key] === 'function')) {
    throw new TypeError('A DSH FileSystem provider is required')
  }
  const issued = new WeakSet()
  const resultsByGrant = new WeakMap()

  async function issueGrant({ providerId, windowId, conversationId, root, signal, isCurrent } = {}) {
    if (!validOpaque(providerId) || !validOpaque(windowId) || !validOpaque(conversationId) || typeof root !== 'string' || !root) {
      throw new TypeError('Trusted grant binding is incomplete')
    }
    if (createScopedExecutor && typeof isCurrent !== 'function') throw new TypeError('Runtime owner lifecycle callback required')
    isCurrent ??= () => true
    if (typeof isCurrent !== 'function') throw new TypeError('Trusted current callback required')
    throwIfAborted(signal)
    const grant = Object.freeze(Object.create(null))
    const rootTarget = await fs.resolve(root, { signal })
    const canonicalRootPath = fs.processPath(rootTarget)
    if (typeof canonicalRootPath !== 'string' || !isAbsolute(canonicalRootPath) || (await fs.stat(rootTarget, signal))?.type !== 'directory') throw new TypeError('Grant root must resolve to a canonical absolute directory')
    const revocation = new AbortController()
    const record = { providerId, windowId, conversationId, rootTarget, canonicalRootPath, expiresAt: now() + grantTtlMs, revocation, revoked: false, isCurrent }
    grantRecords.set(grant, record)
    issued.add(grant)
    resultsByGrant.set(grant, new Map())
    record.onAbort = () => createScopedExecutor ? revoke(grant) : revocation.abort()
    record.sourceSignal = signal
    signal?.addEventListener('abort', record.onAbort, { once: true })
    record.expiryTimer = setTimeout(() => createScopedExecutor ? revoke(grant) : revocation.abort(), grantTtlMs)
    record.expiryTimer.unref?.()
    try {
      if (createScopedExecutor) {
        record.runtime = await createScopedExecutor(Object.freeze({ providerId, windowId, conversationId, root: canonicalRootPath, expiresAt: record.expiresAt, ttlMs: grantTtlMs, signal: revocation.signal, isCurrent }))
        if (!record.runtime || typeof record.runtime.execute !== 'function' || typeof record.runtime.revoke !== 'function') throw new TypeError('Trusted executor incomplete')
      }
      if (!issued.has(grant) || signal?.aborted || !isCurrent()) throw new TypeError('Grant no longer current')
    } catch (error) {
      if (!revoke(grant)) record.runtime?.revoke?.()
      throw error
    }
    return grant
  }

  async function resolveChecked(rootTarget, rootPath, parts, signal, { allowMissingFinal = false } = {}) {
    let current = rootTarget
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i]
      const lstat = await fs.lstat(path, { cwd: rootPath }, signal)
      throwIfAborted(signal)
      if (lstat?.type === 'symlink' || lstat?.type === 'other') throw Object.assign(new Error('unsafe path'), { code: 'INVALID_PATH' })
      const target = await fs.resolve(path, { cwd: rootPath, signal })
      throwIfAborted(signal)
      if (!fs.contains(rootTarget, target)) throw Object.assign(new Error('outside root'), { code: 'INVALID_PATH' })
      if (!lstat && !(allowMissingFinal && i === parts.length - 1)) throw Object.assign(new Error('missing path'), { code: 'ENOENT' })
      current = target
    }
    return current
  }

  function revoke(grant) {
    if (!issued.has(grant)) return false
    const binding = grantRecords.get(grant)
    binding.revoked = true
    binding.sourceSignal?.removeEventListener('abort', binding.onAbort)
    try { binding.runtime?.revoke() } catch { /* Local grant cleanup still completes. */ }
    clearTimeout(binding.expiryTimer)
    binding.revocation.abort()
    issued.delete(grant)
    resultsByGrant.get(grant)?.clear()
    resultsByGrant.delete(grant)
    grantRecords.delete(grant)
    return true
  }

  // `nativeContext` must be constructed by the native bridge from trusted provider/window/conversation state.
  // Never derive it from page JSON or fields in `request`.
  async function execute(grant, nativeContext, request) {
    if (!issued.has(grant)) return toolError('INVALID_GRANT', '访问授权无效。')
    const binding = grantRecords.get(grant)
    if (!nativeContext || nativeContext.providerId !== binding.providerId || nativeContext.windowId !== binding.windowId || nativeContext.conversationId !== binding.conversationId) {
      return toolError('GRANT_MISMATCH', '当前会话与授权不匹配。')
    }
    if (!binding.isCurrent()) { revoke(grant); return toolError('INVALID_GRANT', '访问授权已失效。') }
    if (binding.revoked) return toolError('INVALID_GRANT', '访问授权已撤销。')
    if (now() >= binding.expiresAt) {
      if (binding.runtime) revoke(grant)
      else binding.revocation.abort()
      return toolError('GRANT_EXPIRED', '访问授权已过期。')
    }
    if (binding.revocation.signal.aborted) return toolError('INVALID_GRANT', '访问授权已撤销。')
    if (nativeContext.signal?.aborted) return toolError('CANCELLED', '操作已取消。')
    let parts
    try { parts = validateRequest(request) } catch (error) {
      return toolError(error.message === 'WRITE_TOO_LARGE' ? 'TOO_LARGE' : error.message, error.message === 'WRITE_TOO_LARGE' ? '写入内容超过允许的大小。' : '请求格式或路径无效。')
    }
    const cache = resultsByGrant.get(grant)
    const fingerprint = JSON.stringify(request)
    if (cache.has(request.requestId)) {
      const existing = cache.get(request.requestId)
      if (existing.fingerprint !== fingerprint) return toolError('REQUEST_ID_REUSED', 'requestId 已用于另一项请求。')
      return existing.result
    }
    if (cache.size >= MAX_CACHED_REQUESTS) return toolError('REQUEST_LIMIT', '此授权的请求次数已达上限。')

    const signal = nativeContext.signal ? AbortSignal.any([binding.revocation.signal, nativeContext.signal]) : binding.revocation.signal
    const promise = (async () => {
      try {
        if (binding.runtime) {
          const onCancel = () => revoke(grant)
          nativeContext.signal?.addEventListener('abort', onCancel, { once: true })
          try {
            const result = await binding.runtime.execute(request)
            if (signal.aborted || !issued.has(grant) || !binding.isCurrent() || now() >= binding.expiresAt) { revoke(grant); return toolError('CANCELLED', '操作已取消。') }
            if (!result || result.ok !== true) return runtimeError(result?.error?.code)
            if (request.op === 'read' && typeof result.content === 'string' && Buffer.byteLength(result.content, 'utf8') <= MAX_READ_BYTES) return { ok: true, content: result.content }
            if (request.op === 'write_new' && result.created === true) return { ok: true, created: true }
            if (request.op === 'list' && Array.isArray(result.entries) && result.entries.length <= MAX_LIST_ENTRIES) return { ok: true, entries: result.entries.map(entry => ({ name: entry.name, type: entry.type, ...(Number.isSafeInteger(entry.size) ? { size: entry.size } : {}) })) }
            return runtimeError()
          } finally { nativeContext.signal?.removeEventListener('abort', onCancel) }
        }
        const rootTarget = binding.rootTarget
        const rootInfo = await fs.stat(rootTarget, signal)
        throwIfAborted(signal)
        if (rootInfo?.type !== 'directory') return toolError('INVALID_GRANT', '授权目录不可用。')
        const target = await resolveChecked(rootTarget, binding.canonicalRootPath, parts, signal, { allowMissingFinal: request.op === 'write_new' })
        const info = await fs.stat(target, signal)
        throwIfAborted(signal)
        if (request.op === 'list') {
          if (info?.type !== 'directory') return toolError('NOT_DIRECTORY', '目标不是目录。')
          const entries = await fs.listDirBounded(target, { rootTarget, rootPath: binding.canonicalRootPath, maxEntries: MAX_LIST_ENTRIES + 1, signal })
          throwIfAborted(signal)
          if (entries.length > MAX_LIST_ENTRIES) return toolError('TOO_MANY_ENTRIES', '目录项目过多，已拒绝返回。')
          return { ok: true, entries: entries.map(entry => ({ name: entry.name, type: entry.type, ...(Number.isSafeInteger(entry.size) ? { size: entry.size } : {}) })) }
        }
        if (request.op === 'read') {
          if (info?.type !== 'file') return toolError(info ? 'NOT_FILE' : 'NOT_FOUND', info ? '目标不是普通文件。' : '目标不存在。')
          if (info.size > MAX_READ_BYTES) return toolError('TOO_LARGE', '目标超过允许的大小。')
          const bytes = await fs.readBytes(target, signal, MAX_READ_BYTES)
          throwIfAborted(signal)
          if (bytes.byteLength > MAX_READ_BYTES) return toolError('TOO_LARGE', '目标超过允许的大小。')
          let content
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return toolError('BINARY_OR_INVALID_UTF8', '目标不是有效的 UTF-8 文本。') }
          if (bytes.subarray(0, MAX_TEXT_BINARY_SAMPLE_BYTES).includes(0)) return toolError('BINARY_OR_INVALID_UTF8', '目标不是有效的 UTF-8 文本。')
          return { ok: true, content }
        }
        if (info) return toolError('ALREADY_EXISTS', '目标已存在，未覆盖。')
        const outcome = await fs.writeText(target, request.content, { kind: 'createIfAbsent' }, signal)
        // If cancellation wins immediately after publication, the file may already exist;
        // this response cannot promise to undo a completed atomic create.
        throwIfAborted(signal)
        if (outcome?.operation !== 'create') return toolError('ALREADY_EXISTS', '目标已存在，未覆盖。')
        return { ok: true, created: true }
      } catch (error) {
        if (error?.code === 'INVALID_PATH') return toolError('INVALID_PATH', '路径无效或超出授权目录。')
        return mapError(error)
      }
    })()
    const cached = { fingerprint, result: promise }
    cache.set(request.requestId, cached)
    const result = await promise
    cached.result = result
    return result
  }

  return Object.freeze({ issueGrant, execute, revoke })
}

export const WEB_AI_FILE_TOOL_LIMITS = Object.freeze({ maxReadBytes: MAX_READ_BYTES, maxWriteBytes: MAX_WRITE_BYTES, maxListEntries: MAX_LIST_ENTRIES, grantTtlMs: GRANT_TTL_MS })

