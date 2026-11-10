// Explicit instance only: the authenticated Host handler and registered tool must
// receive this same object. UI provenance is not human-scope or budget authority.
const deny = () => { throw Object.assign(new Error('ui_origin_required'), { code: 'ui_origin_required' }) }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return deny()
}
const fingerprint = value => JSON.stringify(canonical(value))

export function createWorkflowNativeUiGate(ctx) {
  const pending = new Map(), live = new WeakSet(), witnesses = new WeakMap()
  let disposed = false
  function valid(item) {
    if (disposed || !item.open || item.signal.aborted || item.agent.session !== item.session) return false
    try { return item.isCurrent() === true } catch { return false }
  }
  function matches(item, exec) {
    return valid(item) && !exec.signal.aborted && exec.agent === item.agent
      && exec.name === item.name && exec.callId === item.callId && fingerprint(exec.arguments) === item.args
  }
  const unobserve = ctx.on('tools/execute', async (exec, next) => {
    live.add(exec)
    try { return await next() } finally { live.delete(exec) }
  })
  function assertCurrent(witness, exec) {
    const item = witnesses.get(witness)
    if (!item || item.exec !== exec || !live.has(exec) || !matches(item, exec)) deny()
    return witness
  }
  return Object.freeze({
    async withPending(input, dispatch) {
      if (disposed || !input?.agent?.session || typeof input.name !== 'string' || !input.name
        || typeof input.callId !== 'string' || !input.callId || typeof input.isCurrent !== 'function'
        || !input.signal || typeof input.signal.addEventListener !== 'function' || typeof dispatch !== 'function'
        || pending.has(input.callId)) deny()
      const item = { agent: input.agent, session: input.agent.session, name: input.name, callId: input.callId,
        args: fingerprint(input.arguments), signal: input.signal, isCurrent: input.isCurrent,
        taskLease: input.taskLease, open: true, consumed: false }
      if (!valid(item)) deny()
      const revoke = () => { item.open = false }
      item.signal.addEventListener('abort', revoke, { once: true })
      pending.set(item.callId, item)
      try { return await dispatch() } finally {
        item.open = false
        item.signal.removeEventListener('abort', revoke)
        pending.delete(item.callId)
      }
    },
    consume(exec) {
      if (!exec || !live.has(exec)) deny()
      const item = pending.get(exec.callId)
      if (!item || item.consumed || !matches(item, exec)) deny()
      item.consumed = true
      item.exec = exec
      const witness = Object.freeze({ taskLease: item.taskLease })
      witnesses.set(witness, item)
      return witness
    },
    assertCurrent,
    dispose() {
      if (disposed) return
      disposed = true
      for (const item of pending.values()) item.open = false
      pending.clear()
      unobserve()
    },
  })
}
