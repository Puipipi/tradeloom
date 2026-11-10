import { timingSafeEqual } from 'node:crypto'

export const WEB_AI_NATIVE_PATH = '/api/tradeloom.webai-native'
export const WEB_AI_NATIVE_HEADER = 'X-TradeLoom-Native-Bridge'
export const WEB_AI_NATIVE_MAX_BODY_BYTES = 1024 * 1024
export const WEB_AI_NATIVE_MAX_LONG_POLL_MS = 20_000

const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const validText = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max
const validId = (value, max = 256) => validText(value, max) && !/[\u0000-\u001f\u007f]/.test(value)
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function assertSafeWireValue(value) {
  if (Array.isArray(value)) { for (const item of value) assertSafeWireValue(item); return value }
  if (!object(value)) return value
  for (const [key, child] of Object.entries(value)) {
    if (/^(exec|fs|root|getRoot|grant|capability|signal|webContents|ownerWebContents|isCurrent|authorizeNativeToolRun)$/i.test(key)) fail('WIRE_FORBIDDEN_FIELD')
    assertSafeWireValue(child)
  }
  return value
}

function exactKeys(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) fail('INVALID_MESSAGE')
}

export function parseMainMessage(value) {
  if (!object(value) || typeof value.type !== 'string') fail('INVALID_MESSAGE')
  switch (value.type) {
    case 'hello':
      exactKeys(value, ['type', 'mainInstanceId'])
      if (!validId(value.mainInstanceId)) fail('INVALID_MESSAGE')
      break
    case 'target':
      exactKeys(value, ['type', 'hostInstanceId', 'targetId', 'generation', 'providerId', 'windowId', 'conversationId', 'available', 'reason'], ['type', 'hostInstanceId', 'targetId', 'generation', 'providerId', 'windowId', 'conversationId', 'available'])
      if (!validId(value.hostInstanceId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !validId(value.providerId) || !validId(value.windowId) || !(value.conversationId === null || validId(value.conversationId))
        || typeof value.available !== 'boolean' || (value.reason !== undefined && !validId(value.reason, 80))) fail('INVALID_MESSAGE')
      if (value.available && value.conversationId === null) fail('INVALID_MESSAGE')
      break
    case 'remove-target':
      exactKeys(value, ['type', 'hostInstanceId', 'targetId', 'generation'])
      if (!validId(value.hostInstanceId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation) || value.generation < 1) fail('INVALID_MESSAGE')
      break
    case 'next':
      exactKeys(value, ['type', 'hostInstanceId', 'timeoutMs'], ['type', 'hostInstanceId', 'timeoutMs'])
      if (!validId(value.hostInstanceId) || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 0 || value.timeoutMs > WEB_AI_NATIVE_MAX_LONG_POLL_MS) fail('INVALID_MESSAGE')
      break
    case 'event':
      exactKeys(value, ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'kind', 'observation', 'errorCode'],
        ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'kind'])
      if (!validId(value.hostInstanceId) || !validId(value.jobId) || !validId(value.targetId)
        || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !validId(value.requestId, 128) || !validId(value.taskNonce, 128)
        || !['started', 'generating', 'assistant', 'error', 'settled'].includes(value.kind)) fail('INVALID_MESSAGE')
      if (value.kind === 'assistant') {
        const row = value.observation
        if (!object(row) || Object.keys(row).some(key => !['source', 'role', 'isNew', 'complete', 'generating', 'messageId', 'conversationId', 'taskNonce', 'requestId', 'content'].includes(key))
          || row.source !== 'native-assistant-observation' || row.role !== 'assistant' || row.isNew !== true
          || !validId(row.messageId) || !validId(row.conversationId) || !validId(row.taskNonce, 128) || !validId(row.requestId, 128)
          || typeof row.content !== 'string' || !(row.complete === true || row.generating === false)) fail('INVALID_MESSAGE')
        assertSafeWireValue(row)
      }
      if (value.kind === 'error' && !validId(value.errorCode, 80)) fail('INVALID_MESSAGE')
      break
    default: fail('INVALID_MESSAGE')
  }
  return value
}

export function parseHostCommand(value) {
  if (!object(value) || typeof value.type !== 'string') fail('INVALID_COMMAND')
  switch (value.type) {
    case 'ask':
      exactKeys(value, ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'prompt', 'fileTask'],
        ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'prompt'])
      if (!validId(value.hostInstanceId) || !validId(value.jobId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation) || value.generation < 1
        || !validId(value.requestId, 128) || !validId(value.taskNonce, 128) || !validText(value.prompt, 64 * 1024)
        || Buffer.byteLength(value.prompt, 'utf8') > 64 * 1024) fail('INVALID_COMMAND')
      if (value.fileTask !== undefined) {
        exactKeys(value.fileTask, ['taskId', 'taskNonce', 'manifest'])
        const manifest = value.fileTask.manifest
        if (!validId(value.fileTask.taskId) || value.fileTask.taskNonce !== value.taskNonce
          || !object(manifest) || Object.keys(manifest).some(key => !['version', 'kind', 'authorizationNotice', 'tools'].includes(key))
          || manifest.version !== 1 || manifest.kind !== 'tradeloom-file-task' || !validText(manifest.authorizationNotice, 1000)
          || !Array.isArray(manifest.tools) || manifest.tools.length < 1 || manifest.tools.length > 8
          || manifest.tools.some(tool => !object(tool) || Object.keys(tool).some(key => !['name', 'description', 'arguments'].includes(key))
            || !validId(tool.name, 80) || !validText(tool.description, 500) || !Array.isArray(tool.arguments)
            || tool.arguments.length > 16 || !tool.arguments.every(argument => validId(argument, 80)))) fail('INVALID_COMMAND')
        assertSafeWireValue(manifest)
      }
      break
    case 'tool-result':
      exactKeys(value, ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'taskId', 'result'])
      if (!validId(value.hostInstanceId) || !validId(value.jobId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation)
        || !validId(value.requestId, 128) || !validId(value.taskNonce, 128) || !validId(value.taskId) || !object(value.result)) fail('INVALID_COMMAND')
      assertSafeWireValue(value.result)
      break
    case 'cancel':
      exactKeys(value, ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce'])
      if (!validId(value.hostInstanceId) || !validId(value.jobId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation)
        || !validId(value.requestId, 128) || !validId(value.taskNonce, 128)) fail('INVALID_COMMAND')
      break
    case 'release':
      exactKeys(value, ['type', 'hostInstanceId', 'jobId', 'targetId', 'generation', 'requestId', 'taskNonce', 'completed'])
      if (!validId(value.hostInstanceId) || !validId(value.jobId) || !validId(value.targetId) || !Number.isSafeInteger(value.generation)
        || !validId(value.requestId, 128) || !validId(value.taskNonce, 128) || typeof value.completed !== 'boolean') fail('INVALID_COMMAND')
      break
    default: fail('INVALID_COMMAND')
  }
  return value
}

export async function readMainRequest(request, nativeBridgeKey) {
  if (typeof nativeBridgeKey !== 'string' || nativeBridgeKey.length < 16) fail('BRIDGE_UNAVAILABLE')
  const supplied = request.headers.get(WEB_AI_NATIVE_HEADER) ?? ''
  const expectedBytes = Buffer.from(nativeBridgeKey, 'utf8')
  const suppliedBytes = Buffer.from(supplied, 'utf8')
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) fail('UNAUTHORIZED')
  if (request.method !== 'POST' || new URL(request.url).pathname !== WEB_AI_NATIVE_PATH) fail('NOT_FOUND')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > WEB_AI_NATIVE_MAX_BODY_BYTES) fail('BODY_TOO_LARGE')
  let parsed
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('INVALID_JSON') }
  return parseMainMessage(parsed)
}

export function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

