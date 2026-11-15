import { ROLE_PRESETS } from './roles.js'
import { AsyncLocalStorage } from 'node:async_hooks'
const rejected = () => { throw Object.assign(new Error('native_task_origin_required'), { code: 'native_task_origin_required' }) }
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return rejected()
}
const fingerprint = value => JSON.stringify(canonical(value))
const COMMAND = 'tradeloom_native_task'
// Native-only composition. UI provenance comes from the shared gate; neither
// a command id, source:user nor a serializable scope string is authority.
export function createWorkflowNativeCommandAttribution(ctx, { uiGate, createStateStore, toolModes = { tradeloom_wf_native_submit: 'submit', tradeloom_wf_native_resume: 'resume', tradeloom_wf_native_review: 'review' } }) {
  if (!uiGate?.consume || !uiGate?.assertCurrent || typeof createStateStore !== 'function') rejected()
  const modes = new Map(Object.entries(toolModes))
  if (!modes.size || [...modes.values()].some(x => !['submit', 'resume', 'review'].includes(x))) rejected()
  const commands = ctx.commands, agents = ctx.agents, tools = ctx.tools
  const batchExecution = typeof tools.selectExecutor === 'function'
  const singleExecution = typeof tools.prepareExecution === 'function' && typeof tools.completeScheduledExecution === 'function'
  if (batchExecution === singleExecution) throw new Error('native task tool executor contract is unsupported or ambiguous')
  const frames = new AsyncLocalStorage(), intents = new WeakMap(), leases = new WeakMap(), owned = new Set(), observed = new WeakSet(), children = new WeakMap()
  let disposed = false
  const exact = agent => agent?.session && agents.get(agent.id) === agent && agent.session.id === agent.id
  const current = item => !disposed && !item.closed && exact(item.agent) && item.agent.session === item.session && item.isCurrent() === true
  async function executeOne(input) {
    const argumentsJson = JSON.stringify(canonical(input.arguments))
    if (singleExecution) return tools.execute(input)
    const batch = await tools.execute({
      agent: input.agent, signal: input.signal,
      ...(input.toolSet === undefined ? {} : { toolSet: input.toolSet }),
      calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: argumentsJson }],
    })
    if (!Array.isArray(batch?.results) || batch.results.length !== 1) throw new Error('native task tool result did not match its call')
    const [entry] = batch.results
    if (entry?.callId !== input.callId || typeof entry.result?.isError !== 'boolean' || !Array.isArray(entry.result?.content)) throw new Error('native task tool result did not match its call')
    return entry.result
  }
  const matching = (f, exec) => exact(exec?.agent) && exec.agent === f.agent && exec.agent.session === f.session
    && exec.name === f.name && exec.callId === f.callId && exec.signal === f.signal && fingerprint(exec.arguments) === f.args
  const stopEvent = ctx.on('session/event', (session, event) => {
    const f = frames.getStore()
    if (!f || f.kind !== 'command' || f.entered || f.event || session !== f.session || event.type !== 'command/run') return
    if (event.data.name === COMMAND && event.data.source?.kind === 'user' && event.data.args === undefined) f.event = event
  }, { global: true })
  const stopPre = ctx.on('tools/pre-execute', async (exec, next) => {
    if (exact(exec.agent)) observed.add(exec)
    const f = frames.getStore()
    if (f?.kind === 'task' && matching(f, exec)) f.exec = exec
    return next()
  }, { global: true, prepend: true })
  const stopAround = ctx.on('tools/execute', async (exec, next) => {
    const f = frames.getStore()
    const task = f?.kind === 'task' && f.exec === exec ? f : undefined
    const info = task?.info ?? children.get(exec.agent)?.info
    if (info && (!current(info) || !exact(exec.agent) || exec.signal.aborted)) rejected()
    if (task) {
      task.bodyLive = true
      try { return await next() } finally { task.bodyLive = false }
    }
    return next()
  }, { global: true })
  const unregister = commands.register({ name: COMMAND, description: 'Native authenticated workflow task admission', recordInput: false,
    async handler(invocation) {
      const f = frames.getStore()
      if (!f || f.kind !== 'command' || f.entered || !f.event || f.event.data.commandId !== invocation.commandId
        || invocation.agent !== f.agent || invocation.rawInput !== '' || invocation.signal !== f.signal
        || invocation.attachments.length !== 0 || !current(f) || f.signal.aborted) rejected()
      f.entered = true
      f.invocation = invocation
      try {
        f.result = await executeOne({ agent: f.agent, name: f.name, callId: f.callId, arguments: f.arguments, signal: f.signal })
        return { kind: f.result.isError ? 'error' : 'success', text: f.result.isError ? 'Native task admission was refused.' : 'Native task admission completed.' }
      } finally { f.invocation = null }
    },
  })
  async function scopesFor(info) {
    const state = await (await createStateStore()).read()
    const row = state.budgetScopes?.tasks?.[info.runId]
    if (!row || row.identity !== info.identity || row.parentAgentId !== info.agent.id || row.sessionId !== info.session.id
      || !Array.isArray(row.scopes) || !row.scopes.length || row.scopes.some(x => typeof x !== 'string' || !x)) rejected()
    return [...row.scopes]
  }
  const api = {
    prepareTask(input) {
      if (disposed || !exact(input?.agent) || input.agent.session.header.agentPreset !== ROLE_PRESETS.center
        || input.agent.session.header.parentSession !== undefined || (input.agent.session.header.delegationDepth ?? 0) > 1 || typeof input.runId !== 'string' || !input.runId
        || typeof input.isCurrent !== 'function' || typeof input.abortTask !== 'function') rejected()
      const intent = Object.freeze({})
      intents.set(intent, { ...input, session: input.agent.session, identity: fingerprint(input.identity), used: false })
      return intent
    },
    async executeCommand(input) {
      if (disposed || !exact(input?.agent) || typeof input.runId !== 'string' || !input.runId
        || typeof input.name !== 'string' || !modes.has(input.name) || typeof input.callId !== 'string' || !input.callId
        || typeof input.isCurrent !== 'function' || typeof input.abortTask !== 'function' || !input.signal || input.signal.aborted) rejected()
      const intent = intents.get(input.taskLease)
      if (!intent || intent.used || intent.agent !== input.agent || intent.session !== input.agent.session
        || intent.runId !== input.runId || intent.identity !== fingerprint(input.identity)
        || intent.isCurrent !== input.isCurrent || intent.abortTask !== input.abortTask) rejected()
      intent.used = true
      const f = { ...input, kind: 'command', mode: modes.get(input.name), intent: input.taskLease, session: input.agent.session, identity: intent.identity, args: fingerprint(input.arguments), entered: false, closed: false }
      if (!current(f)) rejected()
      try {
        await frames.run(f, () => commands.execute(f.agent, `/${COMMAND}`, [], f.signal))
        if (!f.entered || !f.result) rejected()
        if (f.result.isError && f.lease) api.revoke(f.lease)
        return f.result
      } catch (error) {
        try { if (f.lease) api.revoke(f.lease) } finally { throw error }
      } finally { f.closed = true }
    },
    async bindTask(exec, expectedTask) {
      const f = frames.getStore()
      if (!f || f.kind !== 'command' || !f.entered || !f.invocation || f.bound || !current(f) || !matching(f, exec) || exec.signal.aborted) rejected()
      if (!expectedTask || Object.keys(expectedTask).length !== 2 || !Object.hasOwn(expectedTask, 'runId')
        || !Object.hasOwn(expectedTask, 'identity') || expectedTask.runId !== f.runId
        || fingerprint(expectedTask.identity) !== f.identity) rejected()
      const witness = uiGate.consume(exec)
      if (witness.taskLease !== f.intent) rejected()
      uiGate.assertCurrent(witness, exec)
      f.bound = true
      const scope = JSON.stringify(['human-command', f.session.id, f.invocation.commandId])
      const store = await createStateStore()
      await store.transact(state => {
        uiGate.assertCurrent(witness, exec)
        if (!current(f) || f.signal.aborted) rejected()
        state.budgetScopes ??= { sessions: {}, conflicts: {}, histories: {}, messages: {} }
        state.budgetScopes.tasks ??= {}
        const existing = state.budgetScopes.tasks[f.runId]
        if (existing) {
          if (existing.schemaVersion !== 1 || !Array.isArray(existing.scopes) || !existing.scopes.length) rejected()
          if (existing.identity !== f.identity || existing.parentAgentId !== f.agent.id || existing.sessionId !== f.session.id) rejected()
          return
        }
        if (f.mode !== 'submit') rejected()
        state.budgetScopes.tasks[f.runId] = { schemaVersion: 1, identity: f.identity, parentAgentId: f.agent.id, sessionId: f.session.id,
          scopes: [scope], origin: { kind: 'human-command', commandId: f.invocation.commandId, commandName: COMMAND, eventSeq: f.event.seq } }
      })
      uiGate.assertCurrent(witness, exec)
      if (!current(f) || f.signal.aborted) rejected()
      const lease = Object.freeze({})
      const info = { agent: f.agent, session: f.session, runId: f.runId, identity: f.identity, isCurrent: f.isCurrent, abortTask: f.abortTask, closed: false }
      info.lease = lease
      leases.set(lease, info); owned.add(lease); f.lease = lease
      return lease
    },
    async executeTask(lease, input) {
      const info = leases.get(lease)
      if (!info || !current(info) || input.agent !== info.agent || input.signal?.aborted || !['subagent', 'send_message'].includes(input.name)) rejected()
      const scopes = await scopesFor(info)
      if (!current(info) || input.signal.aborted) rejected()
      const f = { ...input, kind: 'task', session: info.session, args: fingerprint(input.arguments), scopes, info, exec: null, bodyLive: false }
      return frames.run(f, () => executeOne(input))
    },
    attributionFor(exec) {
      if (!observed.has(exec)) return null
      const f = frames.getStore()
      const child = children.get(exec.agent)
      const info = f?.kind === 'task' && f.exec === exec ? f.info : child?.info
      if (!info) return null
      if (!current(info) || exec.signal.aborted || !exact(exec.agent)) return { scopes: [], abort: () => {} }
      const scopes = f?.kind === 'task' && f.exec === exec ? f.scopes : child.scopes
      return { scopes: [...scopes], abort: () => api.revoke(info.lease) }
    },
    scopesForChild(parent, childId) {
      const f = frames.getStore(), child = agents.get(childId)
      if (!f || f.kind !== 'task') return undefined
      if (!f.bodyLive || f.agent !== parent || !current(f.info)
        || !exact(child) || child.session.header.parentSession !== parent.id || !agents.isOwnedBy(child.id, parent)) return []
      children.set(child, { info: f.info, scopes: [...f.scopes] })
      return [...f.scopes]
    },
    revoke(lease) {
      const info = leases.get(lease)
      if (!info || info.closed) return false
      info.closed = true
      if (lease) owned.delete(lease)
      info.abortTask()
      return true
    },
    release(lease) { const info = leases.get(lease); if (!info) return false; info.closed = true; owned.delete(lease); return true },
    dispose() { if (disposed) return; disposed = true; for (const lease of [...owned]) api.revoke(lease); unregister(); stopEvent(); stopPre(); stopAround() },
  }
  return Object.freeze(api)
}
