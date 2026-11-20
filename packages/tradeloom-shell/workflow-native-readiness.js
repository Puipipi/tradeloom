export const NATIVE_WORKFLOW_READINESS = 'nativeWorkflowReadiness'
const fail = code => Object.assign(new Error(code), { code })
const original = value => value?.[Symbol.for('cordis.original')] ?? value

/** A Host-owned gate observes the existing service recovery; it never dispatches
 * workflow nodes. A preset replacement must acquire a new recovery epoch. */
export function createNativeWorkflowReadiness() {
  let state = 'pending', owner = null, epoch = 0, wake
  let settled = new Promise(resolve => { wake = resolve })
  const notify = () => { wake(); settled = new Promise(resolve => { wake = resolve }) }
  function attach(service) {
    if (state === 'closed') throw fail('service_closed')
    if (owner) throw fail('recovery_owner_conflict')
    if (typeof service?.recover !== 'function') throw new TypeError('Recovery requires the native workflow service')
    const current = ++epoch
    owner = service
    state = 'pending'
    notify()
    Promise.resolve().then(() => {
      if (owner !== service || epoch !== current || state === 'closed') throw fail('service_closed')
      return service.recover()
    }).then(result => {
      if (result?.ready !== true) throw fail('native_workflow_recovery_unconfirmed')
      if (owner === service && epoch === current && state !== 'closed') { state = 'ready'; notify() }
    }).catch(() => {
      if (owner === service && epoch === current && state !== 'closed') { state = 'failed'; notify() }
    })
    return () => {
      if (owner !== service || epoch !== current) return
      owner = null
      ++epoch
      if (state !== 'closed') state = 'failed'
      notify()
    }
  }
  async function wait(signal) {
    let current = owner ? epoch : null
    while (state === 'pending') {
      if (signal?.aborted) throw fail('operation_aborted')
      let abort
      try {
        await Promise.race([settled, new Promise((_, reject) => {
          if (!signal) return
          abort = () => reject(fail('operation_aborted'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })])
      } finally { if (abort) signal.removeEventListener('abort', abort) }
      if (current === null && owner) current = epoch
      else if (current !== null && current !== epoch) throw fail('native_workflow_unavailable')
    }
    if (signal?.aborted) throw fail('operation_aborted')
    if (state !== 'ready') throw fail('native_workflow_unavailable')
    return epoch
  }
  return Object.freeze({ attach, wait,
    close() { owner = null; ++epoch; state = 'closed'; notify() },
    get state() { return state }, get epoch() { return epoch },
  })
}

export async function runWhenNativeWorkflowReady(ctx, signal, operation) {
  const gate = ctx.get?.(NATIVE_WORKFLOW_READINESS)
  if (!gate || typeof gate.wait !== 'function') throw fail('native_workflow_unavailable')
  const epoch = await gate.wait(signal)
  const current = ctx.get?.(NATIVE_WORKFLOW_READINESS)
  if (signal?.aborted) throw fail('operation_aborted')
  if (original(current) !== original(gate) || current.state !== 'ready' || current.epoch !== epoch) throw fail('native_workflow_unavailable')
  return operation()
}
