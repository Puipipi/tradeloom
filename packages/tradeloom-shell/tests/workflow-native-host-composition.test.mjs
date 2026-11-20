import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { executeNativeTool } from '../workflow-native-command-attribution.js'

test('actual rc2 Agent compositions share one Host recovery owner across parallel centers and rotation', async t => {
  assert.ok(process.env.TL_SEVEN_SDK_RUNTIME, 'explicit pinned rc2 runtime required')
  const require = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  assert.equal(require('./package.json').version, '0.2.2-rc.2')
  let resolving = false
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (!resolving && specifier.startsWith('@deepseek-ai/')) {
      resolving = true; try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } } finally { resolving = false }
    }
    return next(specifier, context)
  } }); t.after(() => hooks.deregister())
  const { Context } = require('@deepseek-ai/cordis')
  const { SessionStore } = require('@deepseek-ai/dsh-session'), { SessionProjectionRegistry } = require('@deepseek-ai/dsh-session-projection')
  const { AgentRegistry } = require('@deepseek-ai/dsh-agent'), { AgentLoop } = require('@deepseek-ai/dsh-agent-loop')
  const { ToolsService } = require('@deepseek-ai/dsh-tools'), { SystemPrompt } = require('@deepseek-ai/dsh-system-prompt')
  const module = await import('../workflow-native-tools.js')
  const { createNativeWorkflowReadiness } = await import('../workflow-native-readiness.js')
  const { createWorkflowNativeService } = await import('../workflow-native-service.js')
  const { ROLE_PRESETS } = await import('../roles.js')
  const ctx = new Context(), gate = createNativeWorkflowReadiness()
  ctx.provide('llm', { prepareCall() { throw Error('no model execution in this composition test') } })
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService); await ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native')); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const workspace = { id: 'controlled-workspace', path: 'controlled-workspace', sessionIds: [] }
  ctx.provide('webServer', { host: '127.0.0.1', port: 3088 }); ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: id => id === workspace.id ? workspace : undefined })
  ctx.provide('sessionQuery', { async observeSession(id) { return { header: { id, cwd: workspace.path }, projections: { values: { agentPreset: ROLE_PRESETS.center } }, [Symbol.dispose]() {} } } })
  ctx.provide('subagents', {}); ctx.provide('nativeTaskAuthority', {})
  ctx.provide('nativeWorkflowReadiness', gate)
  let finishRecovery, recoveries = 0, services = 0
  const runStore = { async get() { return null }, async list() { return [] }, async save() { throw Error('not dispatched') },
    async getOwnershipNamespace() { return { namespaceId: 'controlled', recoveryCursor: 'start' } },
    recoverExpired() { recoveries++; return new Promise(resolve => { finishRecovery = () => resolve({ complete: true }) }) },
    getOwnershipState() {}, createOwned() {}, saveOwned() {}, renewOwned() {}, releaseOwned() {}, claimResumed() {},
  }
  let state = { roles: {}, roleBindingRevisions: {} }
  const owner = module.createWorkflowNativeHostComposition(ctx, {}, { createPostgresWorkflowRunStore: () => runStore,
    resolveOwnedHome: async () => 'controlled-no-filesystem-read', createStateStore: () => ({ read: async () => state }),
    createWorkflowNativeService: options => { services++; return createWorkflowNativeService(options) } })
  ctx.provide('nativeWorkflowRuntime', owner)
  t.after(async () => { await owner.dispose(); gate.close(); await ctx.fiber.dispose() })
  const first = await ctx.agentLoop.create('center-one', {}, { agentPreset: ROLE_PRESETS.center })
  const second = await ctx.agentLoop.create('center-two', {}, { agentPreset: ROLE_PRESETS.center })
  workspace.sessionIds.push(first.session.id, second.session.id)
  const activate = (agent, revision) => { state = { roles: { center: { sessionId: agent.session.id, workspaceId: workspace.id, workspacePath: workspace.path, agentPreset: ROLE_PRESETS.center } }, roleBindingRevisions: { center: revision } } }
  activate(first, 1)
  const one = first.ctx.plugin(module, { preset: ROLE_PRESETS.center }); await one
  const service = owner.currentService
  const two = second.ctx.plugin(module, { preset: ROLE_PRESETS.center }); await two
  assert.equal(services, 1); assert.equal(owner.currentService, service)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(gate.state, 'pending'); assert.equal(recoveries, 1)
  let ready = false; const waiting = gate.wait().then(() => { ready = true })
  await Promise.resolve(); assert.equal(ready, false)
  finishRecovery(); await waiting
  assert.ok(ctx.tools.get('tradeloom_wf_native_list', first)); assert.ok(ctx.tools.get('tradeloom_wf_native_list', second))
  const execute = agent => executeNativeTool(ctx.tools, { name: 'tradeloom_wf_native_list', arguments: {}, callId: `controlled-${agent.id}-${state.roleBindingRevisions.center}`, agent, signal: new AbortController().signal })
  assert.equal((await execute(first)).value.ok, true)
  assert.equal((await execute(second)).value.error_code, 'center_binding_mismatch')
  activate(second, 2)
  assert.equal((await execute(first)).value.error_code, 'center_binding_mismatch')
  assert.equal((await execute(second)).value.ok, true)
  await one.dispose()
  assert.equal(gate.state, 'ready'); assert.ok(ctx.tools.get('tradeloom_wf_native_list', second))
  const replacement = first.ctx.plugin(module, { preset: ROLE_PRESETS.center }); await replacement
  assert.equal(owner.currentService, service); assert.equal(recoveries, 1)
  await two.dispose(); assert.equal(gate.state, 'ready'); assert.ok(ctx.tools.get('tradeloom_wf_native_list', first))
  await replacement.dispose(); assert.equal(gate.state, 'ready')
})
