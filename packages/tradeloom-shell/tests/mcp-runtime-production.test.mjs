import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { executeNativeTool } from '../workflow-native-command-attribution.js'

async function fixture(t, options = {}) {
  assert.ok(process.env.TL_SEVEN_SDK_RUNTIME && process.env.TL_SEVEN_TEST_ROOT, 'explicit desktop runtime/private test root required; no dependency fallback')
  const runtime = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  assert.match(runtime('./package.json').version, /^0\.2\.2-rc\.[23]$/)
  let resolving = false
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (!resolving && (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@modelcontextprotocol/'))) {
      resolving = true; try { return { url: pathToFileURL(runtime.resolve(specifier)).href, shortCircuit: true } } finally { resolving = false }
    }
    return next(specifier, context)
  } })
  t.after(() => hooks.deregister())
  const { Context } = runtime('@deepseek-ai/cordis'), { SessionStore } = runtime('@deepseek-ai/dsh-session')
  const { SessionProjectionRegistry } = runtime('@deepseek-ai/dsh-session-projection'), { AgentRegistry } = runtime('@deepseek-ai/dsh-agent')
  const { AgentLoop } = runtime('@deepseek-ai/dsh-agent-loop'), { ToolsService } = runtime('@deepseek-ai/dsh-tools')
  const { SystemPrompt } = runtime('@deepseek-ai/dsh-system-prompt')
  const module = await import('../mcp-runtime.js')
  const ctx = new Context()
  if (options.credentials) ctx.provide('credentials', options.credentials)
  ctx.provide('llm', { async prepareCall() { throw Error('No model request permitted in this controlled test') } })
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService)
  await ctx.plugin(runtime('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const registry = module.createMcpRuntimeRegistry(ctx); ctx.provide('mcpRuntime', registry)
  const first = await ctx.agentLoop.create('mcp-one', {}, { agentPreset: 'tradeloom-center' })
  const second = await ctx.agentLoop.create('mcp-two', {}, { agentPreset: 'tradeloom-product' })
  await mkdir(process.env.TL_SEVEN_TEST_ROOT, { recursive: true })
  const root = await mkdtemp(join(process.env.TL_SEVEN_TEST_ROOT, 'actual-mcp-'))
  const peer = fileURLToPath(new URL('./fixtures/mcp-owned-echo.mjs', import.meta.url))
  const config = (name, owner) => ({ transport: 'stdio', serverName: name, command: process.execPath, args: [peer, join(root, `${owner}.json`)], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: root,
    toolCallTimeoutMs: 3000, startupTimeoutMs: 5000, closeTimeoutMs: 5000, expandTemplates: false, failOnStartupError: true, maxInstructionBytes: 32768,
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1000, maxAttempts: 1 }, ...options.config })
  const one = first.ctx.plugin(module, config('synthetic', 'one')); await one
  const two = second.ctx.plugin(module, config('synthetic', 'two')); await two
  t.after(async () => { registry.close(); await ctx.fiber.dispose() })
  return { ctx, registry, first, second, one, two, root }
}

async function peerState(root, name, predicate) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { const value = JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')); if (predicate(value)) return value } catch (error) { if (!['ENOENT'].includes(error.code)) throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('controlled MCP peer did not acknowledge the expected protocol phase')
}

test('desktop SDK client connects, exposes owned tools, cancels and joins before replacement', async t => {
  const f = await fixture(t)
  const list = f.registry.list(f.first)
  assert.equal(list.length, 1); assert.equal(list[0].connected, true)
  assert.deepEqual(list[0].visibleTools.sort(), ['mcp__synthetic__echo', 'mcp__synthetic__wait'])
  const output = await executeNativeTool(f.ctx.tools, { name: 'mcp__synthetic__echo', arguments: { text: 'synthetic-only' }, callId: 'synthetic-echo', agent: f.first, signal: new AbortController().signal })
  assert.equal(output.isError, false)
  assert.ok(JSON.stringify(output).includes('synthetic-only'))
  const abort = new AbortController()
  const waiting = executeNativeTool(f.ctx.tools, { name: 'mcp__synthetic__wait', arguments: {}, callId: 'synthetic-wait', agent: f.first, signal: abort.signal })
  const admitted = await peerState(f.root, 'one', state => state.waiting.length === 1)
  abort.abort()
  const cancelled = await waiting
  assert.equal(cancelled.isError, true)
  await peerState(f.root, 'one', state => state.cancelled.includes(admitted.waiting[0]))
  const old = list[0].instanceId
  await f.registry.control(f.first, 'synthetic', 'restart', old, async () => {})
  const current = f.registry.list(f.first)[0]
  assert.notEqual(current.instanceId, old); assert.equal(current.connected, true)
  assert.throws(() => process.kill(admitted.pid, 0), 'replacement awaits the actual former stdio child')
  await assert.rejects(f.registry.control(f.first, 'synthetic', 'disable', old, async () => {}), { code: 'mcp_runtime_instance_changed' })
  await f.registry.control(f.first, 'synthetic', 'disable', current.instanceId, async () => {})
  assert.equal(f.registry.list(f.first)[0].phase, 'closed')
  assert.equal(f.registry.list(f.first)[0].enabled, false)
  assert.equal(f.ctx.tools.get('mcp__synthetic__echo', f.first), undefined)
  assert.ok(f.ctx.tools.get('mcp__synthetic__echo', f.second), 'another opaque Agent remains live')
  await f.registry.control(f.first, 'synthetic', 'enable', f.registry.list(f.first)[0].instanceId, async () => {})
  assert.equal(f.registry.list(f.first)[0].connected, true)
  const child = JSON.parse(await readFile(join(f.root, 'one.json'), 'utf8'))
  await f.one.dispose()
  assert.deepEqual(f.registry.list(f.first), [])
  assert.throws(() => process.kill(child.pid, 0), 'official client disposal joined its controlled stdio child')
})

test('desktop SDK missing credential is visible waiting-credentials, never connecting', async t => {
  const f = await fixture(t, { credentials: { async resolve() { return undefined } }, config: {
    expandTemplates: true, failOnStartupError: false, env: { ELECTRON_RUN_AS_NODE: '1', SYNTHETIC_MCP_SECRET: '${credential:synthetic_missing}' },
  } })
  const state = f.registry.list(f.first)[0]
  assert.equal(state.phase, 'waiting-credentials'); assert.equal(state.connected, false)
  assert.equal(state.statusLabel, '等待凭据，请在原生设置配置'); assert.equal(state.canRestart, false)
})

test('desktop SDK failed startup reports failed/reconnect-disabled without a false connecting fallback', async t => {
  const f = await fixture(t, { config: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-owned-echo.mjs', import.meta.url)), 'unused', 'fail-startup'], failOnStartupError: false } })
  const state = f.registry.list(f.first)[0]
  assert.equal(state.phase, 'failed'); assert.equal(state.reason, 'reconnect-disabled')
  assert.equal(state.connected, false); assert.equal(state.statusLabel, '连接失败')
})

test('revoked control never remounts an old scope', async t => {
  const f = await fixture(t), before = f.registry.list(f.first)[0]
  await assert.rejects(f.registry.control(f.first, 'synthetic', 'restart', before.instanceId, async () => { throw Object.assign(Error(), { code: 'operation_revoked' }) }), { code: 'operation_revoked' })
  assert.equal(f.registry.list(f.first)[0].instanceId, before.instanceId)
})
