const MAX_ENVELOPE_BYTES = 96 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_TASK_ID_LENGTH = 128
const MAX_NONCE_LENGTH = 128
const MAX_MESSAGE_ID_LENGTH = 256
const MAX_REQUESTS_PER_TASK = 64
const MAX_MESSAGES_PER_TASK = 128
const MAX_PATH_LENGTH = 1024
const MAX_WRITE_BYTES = 64 * 1024
const MAX_READ_BYTES = 256 * 1024
const MAX_LIST_ENTRIES = 200

const SAFE_TOOL_CODES = new Set([
  'TOOL_DENIED', 'TOOL_UNAVAILABLE', 'CANCELLED', 'INVALID_GRANT', 'GRANT_MISMATCH', 'GRANT_EXPIRED', 'REQUEST_ID_REUSED', 'REQUEST_LIMIT',
  'INVALID_PATH', 'TOO_LARGE', 'ALREADY_EXISTS', 'NOT_FOUND', 'NOT_DIRECTORY', 'NOT_FILE',
  'BINARY_OR_INVALID_UTF8', 'TOO_MANY_ENTRIES', 'IO_ERROR',
])

export const WEB_AI_TOOL_MANIFEST = Object.freeze({
  version: 1,
  kind: 'tradeloom-file-task',
  authorizationNotice: '仅在用户明确选择任务目录并授权后，才可在该目录内列出、读取或新建文件；不会覆盖文件。',
  tools: Object.freeze([
    Object.freeze({ name: 'list', description: '列出已授权任务目录中的相对路径。', arguments: Object.freeze(['path']) }),
    Object.freeze({ name: 'read', description: '读取已授权任务目录中的 UTF-8 文本文件。', arguments: Object.freeze(['path']) }),
    Object.freeze({ name: 'write_new', description: '在已授权任务目录中新建 UTF-8 文件；若文件已存在则拒绝。', arguments: Object.freeze(['path', 'content']) }),
  ]),
})

function opaque(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

function parseWholeMessage(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_ENVELOPE_BYTES) return null
  let candidate = content.trim()
  const fence = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(candidate)
  if (fence) candidate = fence[1].trim()
  try { return JSON.parse(candidate) } catch { return null }
}

function validateEnvelope(parsed, expectedTaskId) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'INVALID_ENVELOPE' }
  const common = ['version', 'kind', 'taskId', 'requestId', 'op', 'path']
  const expected = parsed.op === 'write_new' ? [...common, 'content'] : common
  if (!hasExactKeys(parsed, expected) || parsed.version !== 1 || parsed.kind !== 'tradeloom-file-task') return { error: 'INVALID_ENVELOPE' }
  if (!opaque(parsed.taskId, MAX_TASK_ID_LENGTH) || parsed.taskId !== expectedTaskId) return { error: 'TASK_MISMATCH' }
  if (!opaque(parsed.requestId, 128)) return { error: 'INVALID_ENVELOPE' }
  if (!['list', 'read', 'write_new'].includes(parsed.op)) return { error: 'INVALID_ENVELOPE' }
  if (typeof parsed.path !== 'string' || parsed.path.length < 1 || parsed.path.length > MAX_PATH_LENGTH) return { error: 'INVALID_ENVELOPE' }
  if (parsed.op === 'write_new' && (typeof parsed.content !== 'string' || Buffer.byteLength(parsed.content, 'utf8') > MAX_WRITE_BYTES)) return { error: 'INVALID_ENVELOPE' }
  return { request: parsed }
}

function toolRequest(envelope) {
  return envelope.op === 'write_new'
    ? { requestId: envelope.requestId, op: envelope.op, path: envelope.path, content: envelope.content }
    : { requestId: envelope.requestId, op: envelope.op, path: envelope.path }
}

function canonicalFingerprint(envelope) {
  return JSON.stringify(toolRequest(envelope))
}

function resultError(code) {
  return { ok: false, error: { code: SAFE_TOOL_CODES.has(code) ? code : 'TOOL_FAILED' } }
}

function projectToolResult(op, raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') return resultError('TOOL_FAILED')
  if (!raw.ok) return resultError(raw.error?.code)
  if (op === 'write_new') return raw.created === true ? { ok: true, created: true } : resultError('TOOL_FAILED')
  if (op === 'read') {
    if (typeof raw.content !== 'string' || Buffer.byteLength(raw.content, 'utf8') > MAX_READ_BYTES) return resultError('TOO_LARGE')
    return { ok: true, content: raw.content }
  }
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_LIST_ENTRIES) return resultError('TOO_MANY_ENTRIES')
  const entries = []
  for (const entry of raw.entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length < 1 || entry.name.length > 255
      || !['file', 'directory', 'symlink', 'other'].includes(entry.type)) return resultError('TOOL_FAILED')
    entries.push({ name: entry.name, type: entry.type, ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}) })
  }
  return { ok: true, entries }
}

function responseBase(taskId, status) {
  return { version: 1, taskId, source: 'native-assistant-observation', status }
}

function isTaskCurrent(binding) {
  try { return binding.isCurrent() === true } catch { return false }
}

function boundedResponse(response) {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') <= MAX_RESPONSE_BYTES) return response
  return { ...responseBase(response.taskId, 'failed'), requestId: response.requestId, operation: response.operation, result: resultError('TOO_LARGE') }
}

/**
 * Native-only envelope decoder/ledger. Keep this object in trusted host code;
 * never expose issueTask or observeAssistantMessage as a page/RPC endpoint.
 * The adapter callback must supply only a newly observed assistant message.
 */
export function createWebAiToolEnvelope({ fileTools } = {}) {
  if (!fileTools || typeof fileTools.execute !== 'function' || typeof fileTools.revoke !== 'function') {
    throw new TypeError('Existing WebAI file tools are required')
  }
  const capabilities = new WeakMap()
  const grantsUsed = new WeakSet()

  function issueTask({ taskId, taskNonce, providerId, windowId, conversationId, grant, nativeContext, isCurrent } = {}) {
    if (!opaque(taskId, MAX_TASK_ID_LENGTH) || !opaque(taskNonce, MAX_NONCE_LENGTH)
      || !opaque(providerId, 256) || !opaque(windowId, 256) || !opaque(conversationId, 256)
      || !grant || typeof grant !== 'object' || !nativeContext || typeof nativeContext !== 'object' || typeof isCurrent !== 'function') {
      throw new TypeError('Trusted task binding is incomplete')
    }
    if (nativeContext.providerId !== providerId || nativeContext.windowId !== windowId
      || nativeContext.conversationId !== conversationId) throw new TypeError('Trusted task binding is inconsistent')
    if (grantsUsed.has(grant)) throw new TypeError('A file grant can belong to only one task')
    const capability = Object.freeze(Object.create(null))
    capabilities.set(capability, {
      taskId, taskNonce, providerId, windowId, conversationId, grant, nativeContext, isCurrent,
      revoked: false, observedMessages: new Set(), requests: new Map(),
    })
    grantsUsed.add(grant)
    return capability
  }

  function revokeTask(capability) {
    const binding = capabilities.get(capability)
    if (!binding || binding.revoked) return false
    binding.revoked = true
    binding.observedMessages.clear()
    binding.requests.clear()
    capabilities.delete(capability)
    fileTools.revoke(binding.grant)
    return true
  }

  async function observeAssistantMessage(capability, observation) {
    const binding = capabilities.get(capability)
    if (!binding || binding.revoked || !isTaskCurrent(binding)) return { ...responseBase(binding?.taskId ?? '', 'rejected'), error: { code: 'TASK_NOT_CURRENT' } }
    if (!observation || observation.source !== 'native-assistant-observation' || observation.role !== 'assistant'
      || observation.isNew !== true || observation.conversationId !== binding.conversationId
      || observation.taskNonce !== binding.taskNonce || !opaque(observation.messageId, MAX_MESSAGE_ID_LENGTH)
      || typeof observation.content !== 'string'
      || !(observation.complete === true || observation.generating === false)) return responseBase(binding.taskId, 'ignored')
    if (binding.observedMessages.has(observation.messageId)) return responseBase(binding.taskId, 'duplicate-message')
    if (binding.observedMessages.size >= MAX_MESSAGES_PER_TASK) return { ...responseBase(binding.taskId, 'rejected'), error: { code: 'MESSAGE_LIMIT' } }
    binding.observedMessages.add(observation.messageId)
    if (Buffer.byteLength(observation.content, 'utf8') > MAX_ENVELOPE_BYTES) return { ...responseBase(binding.taskId, 'rejected'), error: { code: 'ENVELOPE_TOO_LARGE' } }

    const validation = validateEnvelope(parseWholeMessage(observation.content), binding.taskId)
    if (!validation.request) return { ...responseBase(binding.taskId, 'rejected'), error: { code: validation.error } }
    const request = validation.request
    const fingerprint = canonicalFingerprint(request)
    const previous = binding.requests.get(request.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ...responseBase(binding.taskId, 'rejected'), requestId: request.requestId, error: { code: 'REQUEST_ID_REUSED' } }
      return previous.promise
    }
    if (binding.requests.size >= MAX_REQUESTS_PER_TASK) return { ...responseBase(binding.taskId, 'rejected'), requestId: request.requestId, error: { code: 'REQUEST_LIMIT' } }
    if (!isTaskCurrent(binding)) return { ...responseBase(binding.taskId, 'rejected'), requestId: request.requestId, error: { code: 'TASK_NOT_CURRENT' } }

    const operation = request.op
    const promise = (async () => {
      let raw
      try { raw = await fileTools.execute(binding.grant, binding.nativeContext, toolRequest(request)) }
      catch { raw = resultError('TOOL_FAILED') }
      if (binding.revoked || capabilities.get(capability) !== binding || !isTaskCurrent(binding)) {
        return { ...responseBase(binding.taskId, 'rejected'), requestId: request.requestId, error: { code: 'TASK_NOT_CURRENT' } }
      }
      const result = projectToolResult(operation, raw)
      return boundedResponse({
        ...responseBase(binding.taskId, result.ok ? 'completed' : 'failed'),
        requestId: request.requestId,
        operation,
        result,
      })
    })()
    binding.requests.set(request.requestId, { fingerprint, promise })
    return promise
  }

  return Object.freeze({ issueTask, observeAssistantMessage, revokeTask })
}

export const WEB_AI_TOOL_ENVELOPE_LIMITS = Object.freeze({
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxRequestsPerTask: MAX_REQUESTS_PER_TASK,
  maxMessagesPerTask: MAX_MESSAGES_PER_TASK,
  maxWriteBytes: MAX_WRITE_BYTES,
  maxReadBytes: MAX_READ_BYTES,
  maxListEntries: MAX_LIST_ENTRIES,
})
