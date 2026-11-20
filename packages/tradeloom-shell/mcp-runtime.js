import { randomUUID, createHash } from 'node:crypto'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { scopeOf } from '@deepseek-ai/dsh-scope'

export const name = '@tradeloom/dsh-business-shell/mcp-runtime'
// Preset configuration is the official client's schema. This wrapper owns
// runtime controls and observations for one mounted client.
export const Config = McpClient.Config
export const inject = [...McpClient.inject, 'mcpRuntime']
export const MCP_RUNTIME_ROUTE = '/tradeloom/mcp-runtime'
const MCP_RUNTIME_ENDPOINT = MCP_RUNTIME_ROUTE.slice(1)
const original = value => value?.[Symbol.for('cordis.original')] ?? value
const fail = code => Object.assign(new Error(code), { code })
const SERVER = /^[A-Za-z0-9_-]{1,32}$/
const PHASES = new Set(['closed', 'waiting-credentials', 'connecting', 'connected', 'reconnecting', 'failed'])
const REASONS = new Set(['gave-up', 'reconnect-disabled', 'unclosed-generation'])
const LABELS = { closed: '连接已关闭', 'waiting-credentials': '等待凭据，请在原生设置配置', connecting: '正在连接', connected: '已连接', reconnecting: '正在重新连接', failed: '连接失败', unknown: '连接状态未识别' }
const REASON_LABELS = { 'gave-up': '重试次数已用尽', 'reconnect-disabled': '自动重连已关闭', 'unclosed-generation': '旧连接清理未确认，禁止重挂' }

function displayConnectionState(status, phaseOverride, reasonOverride) {
  const phase = phaseOverride ?? (PHASES.has(status?.state) ? status.state : 'unknown')
  const reason = reasonOverride ?? (phase === 'failed' && REASONS.has(status?.reason) ? status.reason : null)
  return { phase, reason, statusLabel: LABELS[phase], reasonLabel: reason ? REASON_LABELS[reason] : null }
}

/** Only opaque SDK scopes register here. This registry observes the official
 * client; transport, tools, cancellation and credential handling remain DSH's. */
export function createMcpRuntimeRegistry(ctx) {
  const entries = new Map()
  let closed = false
  function currentAgent(agent) { return agent?.session?.id === agent.id && original(ctx.agents.get(agent.id)) === original(agent) }
  return Object.freeze({
    register(owner, serverName, handle) {
      if (closed || !SERVER.test(serverName) || (owner !== ctx.root && !currentAgent(owner))) throw fail('mcp_runtime_owner_unavailable')
      const key = original(owner), rows = entries.get(key) ?? new Map()
      if (rows.has(serverName)) throw fail('mcp_runtime_duplicate_registration')
      rows.set(serverName, handle); entries.set(key, rows)
      return () => { if (rows.get(serverName) !== handle) return; rows.delete(serverName); if (!rows.size) entries.delete(key) }
    },
    list(agent) {
      if (closed || !currentAgent(agent)) throw fail('mcp_runtime_owner_unavailable')
      const schemas = ctx.tools.schemas(agent)
      if (!Array.isArray(schemas)) throw fail('mcp_runtime_tools_unavailable')
      const visible = new Set(schemas.map(row => row.name))
      const group = (owner, scope) => [...(entries.get(original(owner)) ?? [])].map(([serverName, handle]) => ({
        scope, serverName, ...handle.snapshot(),
        visibleTools: [...visible].filter(tool => tool.startsWith(`mcp__${serverName}__`)),
      }))
      return [...group(ctx.root, 'global'), ...group(agent, 'agent')]
    },
    async control(agent, serverName, action, instanceId, assertCurrent) {
      if (closed || !currentAgent(agent) || !['restart', 'enable', 'disable'].includes(action)) throw fail('mcp_runtime_control_denied')
      const handle = entries.get(original(agent))?.get(serverName)
      if (!handle || handle.snapshot().instanceId !== instanceId) throw fail('mcp_runtime_instance_changed')
      await assertCurrent()
      if (!currentAgent(agent) || entries.get(original(agent))?.get(serverName) !== handle) throw fail('mcp_runtime_owner_unavailable')
      return handle.control(action, instanceId, async () => {
        await assertCurrent()
        if (closed || !currentAgent(agent) || entries.get(original(agent))?.get(serverName) !== handle) throw fail('mcp_runtime_owner_unavailable')
      })
    },
    close() { closed = true; entries.clear() },
  })
}

/** One managed preset row wraps one genuine client fiber. A replacement cannot
 * mount until the official status handle confirms old transport cleanup. */
export async function apply(ctx, config) {
  const owner = scopeOf(ctx) ?? ctx.root
  const registry = ctx.get('mcpRuntime')
  let fiber, status, instanceId = randomUUID(), enabled = true, closed = false, blocked = false
  let tail = Promise.resolve()
  async function unmount() {
    const previous = fiber
    if (!previous) return
    fiber = undefined
    await previous.dispose()
    const result = status?.current()
    if (result?.state !== 'closed' || result.result?.closeConfirmed !== true || result.result.cleanupError !== undefined) {
      blocked = true
      throw fail('mcp_runtime_cleanup_unconfirmed')
    }
  }
  async function mount() {
    if (closed || blocked) throw fail('mcp_runtime_cleanup_unconfirmed')
    instanceId = randomUUID()
    status = undefined
    fiber = ctx.plugin(McpClient, config)
    await fiber
    status = McpClient.connectionStatusOf(fiber)
    if (!status || typeof status.current !== 'function') throw fail('mcp_runtime_status_unavailable')
  }
  const handle = {
    snapshot() {
      const value = status?.current()
      const state = displayConnectionState(value, blocked ? 'failed' : closed || !enabled ? 'closed' : undefined,
        blocked ? 'unclosed-generation' : undefined)
      return { instanceId, enabled, ...state,
        statusLabel: !enabled ? '已禁用' : state.statusLabel,
        canRestart: !closed && !blocked && state.phase !== 'waiting-credentials',
        connected: !closed && enabled && value?.state === 'connected',
        registeredToolCount: Number.isSafeInteger(value?.toolCount) ? value.toolCount : null,
        cleanupConfirmed: value?.state === 'closed' ? value.result?.closeConfirmed === true && value.result?.cleanupError === undefined : null }
    },
    control(action, expected, assertCurrent) {
      const task = tail.then(async () => {
        await assertCurrent()
        if (closed || expected !== instanceId) throw fail('mcp_runtime_instance_changed')
        if (action === 'restart' && !handle.snapshot().canRestart) throw fail('mcp_runtime_control_denied')
        if (action === 'enable' && enabled) return handle.snapshot()
        if (action === 'disable') {
          enabled = false; await unmount(); await assertCurrent(); return handle.snapshot()
        }
        await unmount()
        await assertCurrent()
        enabled = true; await mount(); await assertCurrent()
        return handle.snapshot()
      })
      tail = task.catch(() => {})
      return task
    },
  }
  const unregister = registry.register(owner, config.serverName, handle)
  ctx.effect(() => async () => { closed = true; unregister(); await tail; await unmount() })
  try { await mount() }
  catch (error) { unregister(); throw error }
}

export function createMcpRuntimeHandler(ctx, authority, registry) {
  return async (req, res) => {
    const respond = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)) }
    const rejected = ctx.connection.requestRejection(req)
    if (rejected !== undefined) return respond(rejected, { ok: false, error_code: 'request_forbidden' })
    if (req.method !== 'POST') return respond(405, { ok: false, error_code: 'method_not_allowed' })
    const controller = new AbortController(), abort = () => controller.abort()
    const disconnected = () => { if (!res.writableEnded) abort() }
    req.on?.('aborted', abort); res.on?.('close', disconnected)
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 2048) throw fail('invalid_arguments'); chunks.push(bytes) }
      const bytes = Buffer.concat(chunks), input = JSON.parse(bytes.toString('utf8'))
      if (!input || Object.keys(input).some(key => !['id', 'action', 'serverName', 'instanceId'].includes(key))
        || !/^[a-f0-9-]{36}$/.test(input.id ?? '') || !['list', 'restart', 'enable', 'disable'].includes(input.action)) throw fail('invalid_arguments')
      const origin = await authority.verifyRequest({ token: req.headers['x-tradeloom-origin'], endpoint: MCP_RUNTIME_ENDPOINT,
        routePath: MCP_RUNTIME_ENDPOINT, httpMethod: 'POST', method: MCP_RUNTIME_ENDPOINT,
        rpcId: input.id, bodyBytes: bytes, bodyDigest: createHash('sha256').update(bytes).digest('hex'), peerId: 'desktop-mcp-runtime', peerPrincipal: 'owner' })
      const result = await authority.withVerifiedRequestOrigin(origin, async () => {
        const agent = ctx.agents.get(origin.sessionId), session = agent?.session
        const assertCurrent = async () => {
          if (controller.signal.aborted || !session || agent.id !== origin.sessionId || agent.session !== session || original(ctx.agents.get(agent.id)) !== original(agent)) throw fail('mcp_runtime_owner_unavailable')
          await authority.transactSceneMemory(origin, 'snapshot', origin.sceneId)
        }
        await assertCurrent()
        if (input.action !== 'list') {
          if (!SERVER.test(input.serverName ?? '') || typeof input.instanceId !== 'string') throw fail('invalid_arguments')
          return registry.control(agent, input.serverName, input.action, input.instanceId, assertCurrent)
        }
        const rows = registry.list(agent)
        const manager = ctx.get('mcpManager')
        const global = manager && typeof manager.list === 'function' ? manager.list().map(row => ({
          scope: 'global-manager', serverName: row.name, configured: row.configured === true,
          ...displayConnectionState(row.status), controls: 'native-settings',
        })) : []
        return { role: origin.roleId, groups: [...global, ...rows], configuration: 'saved Agent configuration is edited in existing role settings; runtime disable/enable is temporary' }
      })
      respond(200, { ok: true, result })
    } catch (error) {
      const code = typeof error?.code === 'string' && /^mcp_runtime_[a-z_]+$/.test(error.code) ? error.code : 'mcp_runtime_unavailable'
      respond(409, { ok: false, error_code: code })
    } finally { req.off?.('aborted', abort); res.off?.('close', disconnected) }
  }
}
