export const NATIVE_WORKFLOW_READINESS = 'nativeWorkflowReadiness'

const fail = code => Object.assign(new Error(code), { code })
const ORIGINAL = Symbol.for('cordis.original')

function providerIdentity(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try { return value[ORIGINAL] ?? value } catch { return value }
}

export function nativeWorkflowDjangoPort(config = {}, env = process.env) {
  const value = config.djangoPort ?? env.TRADELOOM_DJANGO_PORT ?? 3090
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^[1-9][0-9]{0,4}$/.test(value))
    || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new TypeError('Invalid trusted Django port')
  }
  return Number(value)
}

/** One Host-lifetime startup attempt; per-call abort only cancels that wait. */
export function createNativeWorkflowReadiness() {
  const startupController = new AbortController()
  let state = 'pending'
  let started = false
  let wake
  const settled = new Promise(resolve => { wake = resolve })

  function finish(next) {
    if (state !== 'pending') return
    state = next
    wake()
  }

  function startRecovery(recover) {
    if (started) return recovery
    if (state === 'closed') return Promise.resolve()
    started = true
    recovery = Promise.resolve().then(() => {
      if (state === 'closed' || startupController.signal.aborted) return
      return recover(startupController.signal)
    }).then(
      () => finish('ready'),
      () => finish(state === 'closed' ? 'closed' : 'failed'),
    )
    return recovery
  }

  let recovery

  function wait(signal) {
    if (signal?.aborted) return Promise.reject(fail('operation_aborted'))
    if (state === 'pending') {
      if (!signal) return settled.then(() => wait())
      let abort = () => {}
      const waiting = new Promise((resolve, reject) => {
        abort = () => reject(fail('operation_aborted'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        settled.then(resolve, reject)
      })
      return waiting.finally(() => signal.removeEventListener('abort', abort)).then(() => wait(signal))
    }
    if (state !== 'ready') return Promise.reject(fail('native_workflow_unavailable'))
    if (signal?.aborted) return Promise.reject(fail('operation_aborted'))
    return Promise.resolve()
  }

  function close() {
    if (state === 'closed') return
    if (state === 'pending') finish('closed')
    else state = 'closed'
    startupController.abort(fail('service_closed'))
  }

  return Object.freeze({
    startRecovery,
    wait,
    close,
    get state() { return state },
    get signal() { return startupController.signal },
  })
}

/** Resolve at call time so early role compositions cannot capture a missing gate. */
export async function awaitNativeWorkflowReadiness(ctx, signal) {
  if (signal?.aborted) throw fail('operation_aborted')
  let initial
  try { initial = ctx?.get?.(NATIVE_WORKFLOW_READINESS) } catch { initial = undefined }
  if (!initial || typeof initial.wait !== 'function' || typeof initial.close !== 'function') {
    throw fail('native_workflow_unavailable')
  }
  await initial.wait(signal)
  if (signal?.aborted) throw fail('operation_aborted')
  let current
  try { current = ctx?.get?.(NATIVE_WORKFLOW_READINESS) } catch { current = undefined }
  if (!current || providerIdentity(current) !== providerIdentity(initial) || current.state !== 'ready') {
    throw fail('native_workflow_unavailable')
  }
  return current
}

/** Recheck at the actual operation boundary, then invoke without another await. */
export async function runWhenNativeWorkflowReady(ctx, signal, operation) {
  if (typeof operation !== 'function') throw new TypeError('native workflow operation must be callable')
  const initial = await awaitNativeWorkflowReadiness(ctx, signal)
  if (signal?.aborted) throw fail('operation_aborted')
  let current
  try { current = ctx?.get?.(NATIVE_WORKFLOW_READINESS) } catch { current = undefined }
  if (!current || providerIdentity(current) !== providerIdentity(initial) || current.state !== 'ready') {
    throw fail('native_workflow_unavailable')
  }
  return operation()
}
