import { createStateStore } from './state.js'
import { ROLE_PRESETS } from './roles.js'

export const BUDGET_LIMITS = Object.freeze({ delegations: 4, messages: 16 })
export const name = '@tradeloom/dsh-business-shell/policy'
export const inject = ['tools', 'agents']
export const BUSINESS_PRESETS = new Set(Object.values(ROLE_PRESETS))
const CHILD_PRESETS = new Set(Object.values(ROLE_PRESETS).filter(id => id !== ROLE_PRESETS.center))

const sourceOf = message => message?.source
const rpcScope = (sessionId, rpcId) => JSON.stringify(['human-rpc', sessionId, rpcId])
const validScopeList = value => Array.isArray(value) && value.every(scope => typeof scope === 'string')

function ensureBudgetScopes(state) {
  state.budgetScopes ??= { sessions: {}, conflicts: {}, histories: {}, messages: {} }
  state.budgetScopes.sessions ??= {}
  state.budgetScopes.conflicts ??= {}
  state.budgetScopes.histories ??= {}
  state.budgetScopes.messages ??= {}
  return state.budgetScopes
}

function rememberScopes(attribution, sessionId, scopes) {
  attribution.histories[sessionId] = [...new Set([...(attribution.histories[sessionId] ?? []), ...scopes])].slice(0, 2).sort()
}

function scopesForMessage(state, sessionId, message) {
  const source = sourceOf(message)
  const attribution = ensureBudgetScopes(state)
  if (attribution.conflicts[sessionId]) return undefined
  const snapshots = attribution.messages[sessionId]
  if (snapshots && Object.hasOwn(snapshots, message?.id)) {
    const snapshot = snapshots[message.id]
    return validScopeList(snapshot) && snapshot.length > 0 ? snapshot : undefined
  }
  if (source?.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId.length > 0) {
    return [rpcScope(sessionId, source.rpcId)]
  }
  if ((source?.kind === 'agent-message' || source?.kind === 'subagent-settled')
    && typeof source.senderSessionId === 'string' && source.senderSessionId.length > 0) {
    if (attribution.conflicts[source.senderSessionId]) return undefined
    const inherited = attribution.sessions[source.senderSessionId]
    const history = attribution.histories[source.senderSessionId]
    return validScopeList(history) && history.length > 1
      ? undefined
      : validScopeList(inherited) ? inherited : undefined
  }
  if (attribution.conflicts[sessionId]) return undefined
  const inherited = attribution.sessions[sessionId]
  return validScopeList(inherited) ? inherited : undefined
}

function makeAttributor() {
  const active = new WeakMap()
  const activeById = new Map()
  const pending = new Map()
  const pendingMessages = new Map()

  return {
    active,
    forget(agent) {
      active.delete(agent)
      const current = activeById.get(agent.id)
      if (current?.agent === agent) {
        // AgentManager emits `agent/disposed` before it inserts the final
        // settlement notice. Retain only the scalar attribution needed by
        // that immediately following insertion, never the Agent/turn object.
        activeById.set(agent.id, { scopes: [...current.scopes], unowned: current.unowned })
      }
    },
    async resolve(store, agent, messages, turn) {
      // `subagent/start` is an emit event: its async listener is not awaited by
      // the publisher. Join the synchronous in-memory reservation before the
      // child's first turn reads durable attribution.
      await pending.get(agent.id)?.catch(() => undefined)
      await Promise.all((messages ?? []).map(message => pendingMessages.get(`${agent.id}\0${message?.id}`)?.catch(() => undefined)))
      const previous = active.get(agent)
      const priorScopes = previous?.turn === turn ? previous.scopes : []
      const nextScopes = new Set(priorScopes)
      let unowned = previous?.turn === turn ? previous.unowned : false

      await store.transact(state => {
        const attribution = ensureBudgetScopes(state)
        for (const message of messages ?? []) {
          const scopes = scopesForMessage(state, agent.id, message)
          const snapshots = attribution.messages[agent.id]
          if (snapshots) {
            delete snapshots[message?.id]
            if (Object.keys(snapshots).length === 0) delete attribution.messages[agent.id]
          }
          if (scopes === undefined || scopes.length === 0) {
            unowned = true
            continue
          }
          for (const scope of scopes) nextScopes.add(scope)
        }
        const resolved = [...nextScopes]
        if (resolved.length > 0 && !unowned && !attribution.conflicts[agent.id]) {
          attribution.sessions[agent.id] = resolved
          rememberScopes(attribution, agent.id, resolved)
        }
      })

      const scopes = [...nextScopes]
      active.set(agent, { turn, scopes, unowned })
      activeById.set(agent.id, { agent, turn, scopes, unowned })
      return { scopes, unowned }
    },
    captureInserted(storeFactory, receiver, message) {
      const source = sourceOf(message)
      const sender = (source?.kind === 'agent-message' || source?.kind === 'subagent-settled')
        && typeof source.senderSessionId === 'string'
        ? activeById.get(source.senderSessionId)
        : undefined
      const disposedSnapshot = sender && !Object.hasOwn(sender, 'agent')
      const senderSnapshot = sender && (!disposedSnapshot || source.kind === 'subagent-settled')
        ? sender.unowned || sender.scopes.length === 0 ? [] : [...sender.scopes]
        : undefined
      if (disposedSnapshot && source.kind === 'subagent-settled' && activeById.get(source.senderSessionId) === sender) {
        activeById.delete(source.senderSessionId)
      }
      const key = `${receiver.id}\0${message?.id}`
      const reservation = Promise.resolve().then(async () => {
        // A newly started child receives its initial user-source inbox item
        // immediately after the non-awaiting start emit. Wait for that session
        // mapping before snapshotting its message scope.
        await pending.get(receiver.id)?.catch(() => undefined)
        const store = await storeFactory()
        let scopes = senderSnapshot
        if (scopes === undefined) {
          const state = await store.read()
          scopes = scopesForMessage(state, receiver.id, message)
        }
        return await store.transact(state => {
          const attribution = ensureBudgetScopes(state)
          attribution.messages[receiver.id] ??= {}
          attribution.messages[receiver.id][message.id] = validScopeList(scopes) && scopes.length > 0
            ? [...new Set(scopes)].sort()
            : null
        })
      })
      pendingMessages.set(key, reservation)
      void reservation.finally(() => {
        if (pendingMessages.get(key) === reservation) pendingMessages.delete(key)
      }).catch(() => undefined)
      return reservation
    },
    inherit(storeFactory, parentAgent, childId, taskScopes) {
      const current = active.get(parentAgent)
      let scopes = taskScopes ?? current?.scopes
      const unowned = taskScopes === undefined ? current?.unowned === true : !validScopeList(taskScopes) || taskScopes.length === 0
      const reservation = Promise.resolve().then(async () => {
        const store = await storeFactory()
        if (!unowned && (!validScopeList(scopes) || scopes.length === 0)) {
          const state = await store.read()
          const attribution = ensureBudgetScopes(state)
          if (attribution.conflicts[parentAgent.id]) return false
          const stored = attribution.sessions[parentAgent.id]
          scopes = validScopeList(stored) ? stored : []
        }
        return await store.transact(state => {
          const attribution = ensureBudgetScopes(state)
          if (unowned || attribution.conflicts[childId]) {
            attribution.conflicts[childId] = true
            return false
          }
          if (!validScopeList(scopes) || scopes.length === 0) return false
          const incoming = [...new Set(scopes)].sort()
          const existing = attribution.sessions[childId]
          if (existing !== undefined) {
            if (!validScopeList(existing)) {
              attribution.conflicts[childId] = true
              return false
            }
            rememberScopes(attribution, childId, existing)
          }
          rememberScopes(attribution, childId, incoming)
          attribution.sessions[childId] = incoming
          return true
        })
      })
      pending.set(childId, reservation)
      void reservation.finally(() => {
        if (pending.get(childId) === reservation) pending.delete(childId)
      }).catch(() => undefined)
      return reservation
    },
  }
}

export async function chargeToolAttempt(store, exec, scopes) {
  const agent = exec?.agent
  if (!agent?.id || !agent?.session?.header) return { kind: 'deny', reason: 'TradeLoom policy requires an attached Agent session.' }
  const header = agent.session.header
  if ((header.delegationDepth ?? 0) > 1) return { kind: 'deny', reason: 'TradeLoom delegation is limited to direct expert sessions.' }
  if (exec.name === 'subagent' && (header.agentPreset !== ROLE_PRESETS.center || header.parentSession !== undefined)) {
    return { kind: 'deny', reason: 'Only the TradeLoom center session may delegate.' }
  }
  if (exec.name === 'interrupt_agent') return { kind: 'deny', reason: 'TradeLoom sessions do not expose agent interruption.' }
  if (exec.name === 'send_message' && header.agentPreset !== ROLE_PRESETS.center
    && (!CHILD_PRESETS.has(header.agentPreset) || header.parentSession === undefined)) {
    return { kind: 'deny', reason: 'Messages are limited to the TradeLoom center and its direct expert sessions.' }
  }
  if (exec.name !== 'subagent' && exec.name !== 'send_message') return null
  if (!validScopeList(scopes) || scopes.length === 0) {
    return { kind: 'deny', reason: 'TradeLoom cannot attribute this tool attempt to a human request budget.' }
  }

  const field = exec.name === 'subagent' ? 'delegations' : 'messages'
  try {
    const exceeded = await store.transact(state => {
      let overLimit = false
      for (const scope of new Set(scopes)) {
        const row = state.budgets[scope] ??= { delegations: 0, messages: 0 }
        row[field] += 1
        if (row[field] > BUDGET_LIMITS[field]) overLimit = true
      }
      return overLimit
    })
    if (exceeded) return {
      kind: 'deny',
      reason: `TradeLoom human request ${field} budget (${BUDGET_LIMITS[field]}) is exhausted.`,
      budgetExceeded: true,
    }
    return null
  } catch {
    return { kind: 'deny', reason: 'TradeLoom budget state is unavailable; the tool call was refused.' }
  }
}

export function apply(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const attribution = makeAttributor()

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    if (!BUSINESS_PRESETS.has(agent?.session?.header?.agentPreset)) return await next()
    try {
      const store = await storeFactory()
      await attribution.resolve(store, agent, messages, turn)
    } catch {
      return { kind: 'reject' }
    }
    return await next()
  }, { global: true })

  ctx.on('agent/created', ({ agent }) => {
    if (!BUSINESS_PRESETS.has(agent?.session?.header?.agentPreset)) return
    // Register under the exact parent Agent scope. The event's opaque carrier
    // cannot be used to infer a parent identity after the fact.
    agent.ctx.on('subagent/start', info => {
      if (ctx.agents.get(info.id)?.session?.header?.parentSession !== agent.id) return
      // Reserve synchronously: @mode emit does not await async listeners.
      void attribution.inherit(storeFactory, agent, info.id, dependencies.taskAttribution?.scopesForChild(agent, info.id)).catch(() => {
        // The child's first pre-step will fail closed if attribution is absent.
      })
    }, { global: true })
    agent.ctx.on('agent/inbox/inserted', ({ message }) => {
      // Snapshot the sender's active scopes at insertion time, before this
      // durable queue item can wait across a later human request.
      void attribution.captureInserted(storeFactory, agent, message).catch(() => {
        // The claimed message will have no usable snapshot and fail closed.
      })
    })
  }, { global: true })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!BUSINESS_PRESETS.has(exec?.agent?.session?.header?.agentPreset)) return await next()
    let store
    try {
      store = await storeFactory()
    } catch {
      return { kind: 'deny', reason: 'TradeLoom budget state is unavailable; the tool call was refused.' }
    }
    const current = exec?.agent && attribution.active.get(exec.agent)
    const task = dependencies.taskAttribution?.attributionFor(exec)
    const decision = await chargeToolAttempt(store, exec, task ? task.scopes : current?.unowned ? [] : current?.scopes)
    if (decision?.budgetExceeded) {
      if (task) task.abort()
      else exec.agent.cancel({ kind: 'hook', reason: 'execution budget exhausted' }, { keepInbox: true })
      return { kind: 'deny', reason: decision.reason }
    }
    if (decision !== null) return decision
    return await next()
  }, { global: true })

  ctx.on('agent/disposed', ({ agent }) => attribution.forget(agent), { global: true })
}
