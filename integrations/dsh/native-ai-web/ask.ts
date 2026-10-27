/** Shared control flow for asking an already-owned native BrowserWindow. */

export type NativeAiWebPhase = 'queued' | 'checking' | 'submitted' | 'first-chunk' | 'completed'

export type NativeAiWebFailureCode =
  | 'cancelled' | 'timeout' | 'first-chunk-timeout' | 'window-closed' | 'not-logged-in'
  | 'input-unavailable' | 'answer-unavailable' | 'draft-present'
  | 'attachments-present' | 'send-failed' | 'answer-too-long'
  | 'adapter-failed' | 'invalid-request'

const FAILURE_MESSAGES: Readonly<Record<NativeAiWebFailureCode, string>> = {
  cancelled: '网页询问已取消',
  timeout: '网页询问超过总时限',
  'first-chunk-timeout': '网页 AI 未在首段时限内开始回答',
  'window-closed': '网页窗口已关闭',
  'not-logged-in': '网页 AI 未登录；请在该窗口手动登录后重试',
  'input-unavailable': '网页输入框不可用；站点页面结构可能已变化',
  'answer-unavailable': '网页回答区域不可用；站点页面结构可能已变化',
  'draft-present': '输入框已有内容；为保留用户内容，本次未发送',
  'attachments-present': '输入框已有附件；为保留用户内容，本次未发送',
  'send-failed': '网页 adapter 未能确认本次提问已提交',
  'answer-too-long': '网页 AI 回答超过长度上限',
  'adapter-failed': '网页 adapter 操作失败；详细错误仅保留在本地诊断中',
  'invalid-request': '网页询问参数无效',
}

export class NativeAiWebAskError extends Error {
  readonly code: NativeAiWebFailureCode
  constructor(code: NativeAiWebFailureCode) {
    super(FAILURE_MESSAGES[code])
    this.code = code
    this.name = 'NativeAiWebAskError'
  }
}

export interface NativeAiWebMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** Actual DOM turn key, correlated with a newly submitted user turn. */
  readonly turnId?: string
  /** Only explicit false is evidence that generation has ended. */
  readonly generating?: boolean
}

export interface NativeAiWebSnapshot {
  readonly open: boolean
  readonly loggedIn: boolean
  readonly inputAvailable: boolean
  readonly answerAvailable: boolean
  readonly draftText: string
  readonly attachmentCount: number
  readonly messages: readonly NativeAiWebMessage[]
}

/**
 * Site-specific code is injected by the owner. It must observe actual DOM
 * state, honor AbortSignal, report genuine turn IDs, and perform a final
 * atomic empty-composer/no-attachment check in send() immediately before the
 * send gesture. If an aborted send rejects, the site effect must be stopped.
 */
export interface NativeAiWebAdapter {
  readonly provider: string
  readonly origin: string
  inspect(signal: AbortSignal): Promise<NativeAiWebSnapshot>
  send(question: string, signal: AbortSignal): Promise<{ readonly turnId: string }>
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

export interface NativeAiWebAskOptions {
  /** Active execution budget; queue wait is excluded. Integer 1..600000 ms. */
  readonly timeoutMs?: number
  /** Time from confirmed submission to the first correlated non-empty text. */
  readonly firstChunkTimeoutMs?: number
  readonly stableMs?: number
  readonly pollMs?: number
  readonly maxAnswerChars?: number
  readonly signal?: AbortSignal
  readonly onPhase?: (phase: NativeAiWebPhase) => void
}

export interface NativeAiWebAskResult {
  readonly provider: string
  readonly origin: string
  readonly turnId: string
  readonly text: string
  readonly answerMessageId: string
  readonly firstChunkAt: number
  readonly completedAt: number
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new NativeAiWebAskError('cancelled')); return }
  const onAbort = (): void => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    reject(new NativeAiWebAskError('cancelled'))
  }
  const finish = (): void => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }
  const timer = setTimeout(finish, ms)
  signal.addEventListener('abort', onAbort, { once: true })
})

function fail(code: NativeAiWebFailureCode): never {
  throw new NativeAiWebAskError(code)
}

function boundedInteger(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/** Race each adapter wait against cancellation/deadline without exposing its error. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new NativeAiWebAskError('cancelled'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new NativeAiWebAskError('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, () => {
      signal.removeEventListener('abort', onAbort)
      reject(new NativeAiWebAskError('adapter-failed'))
    })
  })
}

/**
 * Same-provider calls queue in FIFO order. A timed-out send keeps the queue
 * locked until its underlying adapter promise settles, so it cannot overlap a
 * later send even when an adapter violates its cancellation contract.
 */
export function createNativeAiWebAskController(adapter: NativeAiWebAdapter) {
  let tail: Promise<void> = Promise.resolve()

  const ask = (question: string, options: NativeAiWebAskOptions = {}): Promise<NativeAiWebAskResult> => {
    const prompt = question.trim()
    if (!prompt || prompt.length > 60_000) return Promise.reject(new NativeAiWebAskError('invalid-request'))
    const timeoutMs = options.timeoutMs ?? 180_000
    const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? 120_000
    const stableMs = options.stableMs ?? 1_200
    const pollMs = options.pollMs ?? 200
    const maxAnswerChars = options.maxAnswerChars ?? 60_000
    if (!boundedInteger(timeoutMs, 1, 600_000)
      || !boundedInteger(firstChunkTimeoutMs, 1, 600_000)
      || !boundedInteger(stableMs, 0, 10_000)
      || !boundedInteger(pollMs, 1, 5_000)
      || !boundedInteger(maxAnswerChars, 1, 60_000)) {
      return Promise.reject(new NativeAiWebAskError('invalid-request'))
    }

    let sendDrain: Promise<void> = Promise.resolve()
    const run = tail.then(() => execute(prompt, options, {
      timeoutMs, firstChunkTimeoutMs, stableMs, pollMs, maxAnswerChars,
      holdQueueUntilSendSettles: promise => { sendDrain = promise.then(() => undefined, () => undefined) },
    }))
    // Do not release the per-site queue when an aborted send is still in flight.
    tail = run.then(() => sendDrain, () => sendDrain).then(() => undefined)

    const externalSignal = options.signal
    if (externalSignal === undefined) return run
    if (externalSignal.aborted) return Promise.reject(new NativeAiWebAskError('cancelled'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        externalSignal.removeEventListener('abort', onAbort)
        reject(new NativeAiWebAskError('cancelled'))
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
      run.then(value => {
        externalSignal.removeEventListener('abort', onAbort)
        resolve(value)
      }, error => {
        externalSignal.removeEventListener('abort', onAbort)
        reject(error)
      })
    })
  }

  async function execute(
    prompt: string,
    options: NativeAiWebAskOptions,
    config: {
      timeoutMs: number
      firstChunkTimeoutMs: number
      stableMs: number
      pollMs: number
      maxAnswerChars: number
      holdQueueUntilSendSettles: (promise: Promise<unknown>) => void
    },
  ): Promise<NativeAiWebAskResult> {
    const externalSignal = options.signal
    if (externalSignal?.aborted) fail('cancelled')
    const abort = new AbortController()
    const abortFromCaller = (): void => abort.abort()
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true })
    let timeoutCode: 'timeout' | 'first-chunk-timeout' | undefined
    const totalTimer = setTimeout(() => { timeoutCode = 'timeout'; abort.abort() }, config.timeoutMs)
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined
    const sleep = adapter.sleep ?? defaultSleep
    const phase = (value: NativeAiWebPhase): void => {
      try { options.onPhase?.(value) } catch { /* Observer errors cannot alter a submitted turn. */ }
    }

    const checkAbort = (): void => {
      if (externalSignal?.aborted) fail('cancelled')
      if (timeoutCode !== undefined) fail(timeoutCode)
      if (abort.signal.aborted) fail('cancelled')
    }
    const inspect = async (): Promise<NativeAiWebSnapshot> => {
      checkAbort()
      let state: NativeAiWebSnapshot
      try { state = await abortable(adapter.inspect(abort.signal), abort.signal) }
      catch (error) { checkAbort(); throw error instanceof NativeAiWebAskError ? error : new NativeAiWebAskError('adapter-failed') }
      checkAbort()
      if (!state.open) fail('window-closed')
      if (!state.loggedIn) fail('not-logged-in')
      if (!state.inputAvailable) fail('input-unavailable')
      if (!state.answerAvailable) fail('answer-unavailable')
      return state
    }
    const verifyComposer = (state: NativeAiWebSnapshot): void => {
      // Whitespace is user content too. Never trim it away or overwrite it.
      if (state.draftText.length !== 0) fail('draft-present')
      if (state.attachmentCount !== 0) fail('attachments-present')
    }

    try {
      phase('queued')
      phase('checking')
      const initial = await inspect()
      verifyComposer(initial)
      // Recheck immediately before send; adapter must also make this check
      // atomically with its send gesture to close the remaining DOM race.
      const beforeSend = await inspect()
      verifyComposer(beforeSend)
      const baselineIds = new Set(beforeSend.messages.map(message => message.id))
      const baselineTurns = new Set(beforeSend.messages.map(message => message.turnId).filter((id): id is string => Boolean(id)))

      checkAbort()
      const sendOperation = Promise.resolve().then(() => {
        checkAbort()
        return adapter.send(prompt, abort.signal)
      })
      config.holdQueueUntilSendSettles(sendOperation)
      let sent: { readonly turnId: string }
      try { sent = await abortable(sendOperation, abort.signal) }
      catch (error) { checkAbort(); throw error instanceof NativeAiWebAskError ? error : new NativeAiWebAskError('adapter-failed') }
      checkAbort()
      if (!sent?.turnId || baselineTurns.has(sent.turnId)) fail('send-failed')
      phase('submitted')

      firstChunkTimer = setTimeout(() => { timeoutCode = 'first-chunk-timeout'; abort.abort() }, config.firstChunkTimeoutMs)
      let firstChunkAt = 0
      let candidate: NativeAiWebMessage | undefined
      let lastText = ''
      let stableSince = 0
      for (;;) {
        checkAbort()
        const state = await inspect()
        const answer = state.messages.find(message => message.role === 'assistant'
          && message.turnId === sent.turnId
          && !baselineIds.has(message.id)
          && !baselineTurns.has(message.turnId!))
        if (answer === undefined) {
          await abortable(sleep(config.pollMs, abort.signal), abort.signal)
          continue
        }
        const text = answer.text.trim()
        if (text.length > config.maxAnswerChars) fail('answer-too-long')
        if (!text) {
          await abortable(sleep(config.pollMs, abort.signal), abort.signal)
          continue
        }
        if (!firstChunkAt) {
          firstChunkAt = Date.now()
          if (firstChunkTimer !== undefined) clearTimeout(firstChunkTimer)
          phase('first-chunk')
        }
        if (answer.generating !== false) {
          candidate = answer
          lastText = text
          stableSince = 0
        } else if (candidate?.id !== answer.id || text !== lastText || stableSince === 0) {
          candidate = answer
          lastText = text
          stableSince = Date.now()
        } else if (Date.now() - stableSince >= config.stableMs) {
          phase('completed')
          return {
            provider: adapter.provider,
            origin: adapter.origin,
            turnId: sent.turnId,
            text,
            answerMessageId: answer.id,
            firstChunkAt,
            completedAt: Date.now(),
          }
        }
        await abortable(sleep(config.pollMs, abort.signal), abort.signal)
      }
    } catch (error) {
      checkAbort()
      if (error instanceof NativeAiWebAskError) throw error
      return fail('adapter-failed')
    } finally {
      clearTimeout(totalTimer)
      if (firstChunkTimer !== undefined) clearTimeout(firstChunkTimer)
      externalSignal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return { ask }
}
