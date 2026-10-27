import type { NativeAiWebAskResult, NativeAiWebFailureCode } from './ask.ts'

export type NativeAiWebProvider = 'deepseek' | 'doubao'

export type HostAskMessage = {
  readonly type: 'ai-web-ask'
  readonly requestId: number
  readonly provider: NativeAiWebProvider
  readonly question: string
}

export type HostCancelMessage = { readonly type: 'ai-web-ask-cancel'; readonly requestId: number }

export type HostResultMessage =
  | { readonly type: 'ai-web-ask-result'; readonly requestId: number; readonly ok: true; readonly result: NativeAiWebAskResult }
  | { readonly type: 'ai-web-ask-result'; readonly requestId: number; readonly ok: false; readonly errorCode: NativeAiWebFailureCode }

export type BridgeMessage = HostAskMessage | HostCancelMessage | HostResultMessage
export type Unsubscribe = () => void

const PROVIDERS = new Set<unknown>(['deepseek', 'doubao'])
const ORIGINS: Readonly<Record<NativeAiWebProvider, string>> = {
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
}
const FAILURE_CODES = new Set<unknown>([
  'cancelled', 'timeout', 'first-chunk-timeout', 'window-closed', 'not-logged-in',
  'input-unavailable', 'answer-unavailable', 'draft-present', 'attachments-present',
  'send-failed', 'answer-too-long', 'adapter-failed', 'invalid-request',
])
const MAX_PROMPT_CHARS = 60_000
const MAX_ANSWER_CHARS = 60_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function validRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function validAsk(value: unknown): value is HostAskMessage {
  return record(value) && exactKeys(value, ['type', 'requestId', 'provider', 'question'])
    && value.type === 'ai-web-ask' && validRequestId(value.requestId)
    && PROVIDERS.has(value.provider) && typeof value.question === 'string'
    && value.question.trim().length > 0 && value.question.length <= MAX_PROMPT_CHARS
}

function validCancel(value: unknown): value is HostCancelMessage {
  return record(value) && exactKeys(value, ['type', 'requestId'])
    && value.type === 'ai-web-ask-cancel' && validRequestId(value.requestId)
}

function safeResult(result: NativeAiWebAskResult, provider: NativeAiWebProvider): NativeAiWebAskResult | undefined {
  if (!record(result) || !exactKeys(result, [
    'provider', 'origin', 'turnId', 'text', 'answerMessageId', 'firstChunkAt', 'completedAt',
  ])) return undefined
  if (result.provider !== provider || typeof result.origin !== 'string'
    || result.origin !== ORIGINS[provider]
    || typeof result.turnId !== 'string' || result.turnId.length < 1 || result.turnId.length > 256
    || typeof result.answerMessageId !== 'string' || result.answerMessageId.length < 1 || result.answerMessageId.length > 256
    || typeof result.text !== 'string' || result.text.length > MAX_ANSWER_CHARS
    || !Number.isFinite(result.firstChunkAt) || !Number.isFinite(result.completedAt)) return undefined
  return result
}

export interface HostBridgeChannel {
  /** Subscribe to messages received from this one child process only. */
  subscribe(listener: (message: unknown) => void): Unsubscribe
  /** Send only on this child's private IPC channel; false means unavailable. */
  send(message: BridgeMessage): Promise<boolean>
  onDisconnect(listener: () => void): Unsubscribe
}

export interface HostBridgeOptions {
  readonly channel: HostBridgeChannel
  readonly ask: (provider: NativeAiWebProvider, question: string, signal: AbortSignal) => Promise<NativeAiWebAskResult>
  /** Bound to the owning AI window/application lifetime by the caller. */
  readonly ownerClosed?: AbortSignal
}

/** One broker instance must be created per owned Host child handle. */
export function createHostAiWebBridge(options: HostBridgeOptions): { close(): void; readonly pendingCount: number } {
  const pending = new Map<number, { controller: AbortController; provider: NativeAiWebProvider; settled: boolean }>()
  let closed = false
  let highestRequestId = 0
  let stopMessages: Unsubscribe = () => undefined
  let stopDisconnect: Unsubscribe = () => undefined

  const reject = (requestId: number, errorCode: NativeAiWebFailureCode): void => {
    void options.channel.send({ type: 'ai-web-ask-result', requestId, ok: false, errorCode }).catch(() => undefined)
  }
  const onMessage = (message: unknown): void => {
    if (closed || !record(message) || typeof message.type !== 'string') return
    if (message.type === 'ai-web-ask-cancel') {
      if (!validCancel(message)) return
      const entry = pending.get(message.requestId)
      if (entry !== undefined && !entry.settled) {
        entry.settled = true
        entry.controller.abort()
        reject(message.requestId, 'cancelled')
      }
      return
    }
    if (message.type !== 'ai-web-ask') return
    if (!validAsk(message)) {
      if (validRequestId(message.requestId)) reject(message.requestId, 'invalid-request')
      return
    }
    if (message.requestId <= highestRequestId) {
      // Child IDs are strictly increasing. Reject replay without invoking the
      // site again; if it collides with live work, settle that ID only once.
      const existing = pending.get(message.requestId)
      if (existing !== undefined) {
        if (!existing.settled) {
          existing.settled = true
          existing.controller.abort()
          reject(message.requestId, 'invalid-request')
        }
        return
      }
      reject(message.requestId, 'invalid-request')
      return
    }
    highestRequestId = message.requestId
    const controller = new AbortController()
    const entry = { controller, provider: message.provider, settled: false }
    pending.set(message.requestId, entry)
    const onOwnerClosed = (): void => controller.abort()
    options.ownerClosed?.addEventListener('abort', onOwnerClosed, { once: true })
    void Promise.resolve().then(() => options.ask(message.provider, message.question, controller.signal)).then(async result => {
      if (closed || pending.get(message.requestId) !== entry || entry.settled) return
      const safe = safeResult(result, message.provider)
      entry.settled = true
      if (safe === undefined) reject(message.requestId, 'adapter-failed')
      else await options.channel.send({ type: 'ai-web-ask-result', requestId: message.requestId, ok: true, result: safe }).catch(() => false)
    }, error => {
      if (closed || pending.get(message.requestId) !== entry || entry.settled) return
      entry.settled = true
      const code = record(error) && FAILURE_CODES.has(error.code) ? error.code as NativeAiWebFailureCode : 'adapter-failed'
      reject(message.requestId, code)
    }).finally(() => {
      options.ownerClosed?.removeEventListener('abort', onOwnerClosed)
      if (pending.get(message.requestId) === entry) pending.delete(message.requestId)
    })
  }
  const disconnect = (): void => close()
  const onOwnerClosed = (): void => close()

  function close(): void {
    if (closed) return
    closed = true
    for (const item of pending.values()) item.controller.abort()
    pending.clear()
    stopMessages()
    stopDisconnect()
    options.ownerClosed?.removeEventListener('abort', onOwnerClosed)
  }
  if (options.ownerClosed?.aborted) close()
  else {
    stopMessages = options.channel.subscribe(onMessage)
    stopDisconnect = options.channel.onDisconnect(disconnect)
    options.ownerClosed?.addEventListener('abort', onOwnerClosed, { once: true })
  }
  return { close, get pendingCount() { return pending.size } }
}

export interface ChildIpcChannel {
  readonly connected: boolean
  send(message: BridgeMessage, callback: (error: Error | null) => void): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/** Thin ChildProcess/process adapter. Instantiate separately in parent and child. */
export function childProcessChannel(child: ChildIpcChannel): HostBridgeChannel {
  const subscribe = (listener: (message: unknown) => void): Unsubscribe => {
    child.on('message', listener)
    return () => child.off('message', listener)
  }
  const onDisconnect = (listener: () => void): Unsubscribe => {
    child.on('disconnect', listener)
    return () => child.off('disconnect', listener)
  }
  return {
    subscribe,
    onDisconnect,
    send: message => new Promise(resolve => {
      if (!child.connected) { resolve(false); return }
      try { child.send(message, error => resolve(error === null)) }
      catch { resolve(false) }
    }),
  }
}

export interface ChildAskChannel {
  readonly connected: boolean
  send(message: BridgeMessage, callback: (error: Error | null) => void): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'disconnect', listener: () => void): unknown
}

/** Child-side correlator. Unknown/duplicate results are ignored; no control message is consumed. */
export function createChildAiWebAskClient(channel: ChildAskChannel): {
  ask(provider: NativeAiWebProvider, question: string, signal?: AbortSignal): Promise<NativeAiWebAskResult>
  close(): void
} {
  let nextId = 1
  const pending = new Map<number, { provider: NativeAiWebProvider; resolve(value: NativeAiWebAskResult): void; reject(error: NativeAiWebFailureCode): void; cleanup(): void }>()
  let closed = false
  const onMessage = (value: unknown): void => {
    if (!record(value) || value.type !== 'ai-web-ask-result' || !validRequestId(value.requestId)) return
    const entry = pending.get(value.requestId)
    if (!entry) return
    if (value.ok === true) {
      if (!exactKeys(value, ['type', 'requestId', 'ok', 'result'])) return
      const result = safeResult(value.result as NativeAiWebAskResult, entry.provider)
      if (result === undefined) { entry.reject('adapter-failed'); return }
      pending.delete(value.requestId); entry.cleanup(); entry.resolve(result)
    } else if (value.ok === false && exactKeys(value, ['type', 'requestId', 'ok', 'errorCode']) && FAILURE_CODES.has(value.errorCode)) {
      pending.delete(value.requestId); entry.cleanup(); entry.reject(value.errorCode as NativeAiWebFailureCode)
    }
  }
  const disconnect = (): void => { closed = true; for (const entry of pending.values()) { entry.cleanup(); entry.reject('window-closed') }; pending.clear() }
  channel.on('message', onMessage); channel.on('disconnect', disconnect)

  const send = (message: BridgeMessage): Promise<boolean> => new Promise(resolve => {
    if (closed || !channel.connected) { resolve(false); return }
    try { channel.send(message, error => resolve(error === null)) } catch { resolve(false) }
  })
  return {
    ask(provider, question, signal) {
      if (!PROVIDERS.has(provider) || typeof question !== 'string' || question.trim().length === 0 || question.length > MAX_PROMPT_CHARS) {
        return Promise.reject(new Error('invalid-request'))
      }
      if (closed || !channel.connected || signal?.aborted) return Promise.reject(new Error(signal?.aborted ? 'cancelled' : 'window-closed'))
      const requestId = nextId++
      if (!Number.isSafeInteger(requestId)) return Promise.reject(new Error('invalid-request'))
      return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = (): void => { signal?.removeEventListener('abort', abort) }
        const finishError = (code: NativeAiWebFailureCode): void => {
          if (settled) return
          settled = true; pending.delete(requestId); cleanup(); reject(new Error(code))
        }
        const abort = (): void => { void send({ type: 'ai-web-ask-cancel', requestId }); finishError('cancelled') }
        pending.set(requestId, {
          provider,
          resolve(value) { if (!settled) { settled = true; cleanup(); resolve(value) } },
          reject: finishError,
          cleanup,
        })
        signal?.addEventListener('abort', abort, { once: true })
        void send({ type: 'ai-web-ask', requestId, provider, question }).then(ok => {
          if (!ok) finishError('window-closed')
        })
      })
    },
    close() { if (!closed) { disconnect(); channel.off('message', onMessage); channel.off('disconnect', disconnect) } },
  }
}
