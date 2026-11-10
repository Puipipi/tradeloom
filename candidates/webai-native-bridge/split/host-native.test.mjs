import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createNativeWebAiAuthorization, NATIVE_WEB_AI_TOOLS, mountOptionalWebAiHost } from './host-native.mjs'
import { WEB_AI_NATIVE_HEADER, WEB_AI_NATIVE_PATH } from './wire.mjs'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
const sdk = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
const nativeKey = 'synthetic-o07-native-bridge-key'

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'tl-o07-native-host-'))
  const [cordis, llm, sessions, projections, systemPrompt, tools, agents, agentLoop,
    fsSandbox, sandboxPolicy, workingDirectory, scope] = await Promise.all([
    sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-llm'), sdk('@deepseek-ai/dsh-session'),
    sdk('@deepseek-ai/dsh-session-projection'), sdk('@deepseek-ai/dsh-system-prompt'),
    sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-agent'), sdk('@deepseek-ai/dsh-agent-loop'),
    sdk('@deepseek-ai/dsh-fs-sandbox'), sdk('@deepseek-ai/dsh-sandbox-policy'),
    sdk('@deepseek-ai/dsh-working-directory'), sdk('@deepseek-ai/dsh-scope'),
  ])
  const ctx = new cordis.Context()
  const routes = []
  ctx.provide('connection', {
    fetch: {
      register(definition) {
        routes.push(definition)
        return () => { const index = routes.indexOf(definition); if (index >= 0) routes.splice(index, 1) }
      },
    },
  })
  await ctx.plugin(llm.default)
  await ctx.plugin(sessions.default)
  await ctx.plugin(projections.default)
  await ctx.plugin(systemPrompt.default, { personaPrefix: '' })
  await ctx.plugin(tools.default)
  await ctx.plugin(agents.default)
  await ctx.plugin(sandboxPolicy.default, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(fsSandbox.default, { cwd: root })
  await ctx.plugin(workingDirectory.default, { defaultDirectory: root })
  await ctx.plugin(agentLoop.default, { agents: [] })
  const dispose = async component => {
    await component?.dispose?.()
    await ctx.fiber.dispose()
    const tempRoot = resolve(tmpdir())
    const safeRoot = resolve(root)
    if (!safeRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)
      || !safeRoot.split(/[\\/]/).at(-1).startsWith('tl-o07-native-host-')) {
      throw new Error('Refusing cleanup outside the unique native Host test directory.')
    }
    await rm(safeRoot, { recursive: true, force: true })
  }
  t.after(async () => dispose())
  return { ctx, root, routes, modules: { llm, sessions, tools, scope } }
}

function toolCallResponse(ToolCallId, id, name, args) {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('missing native key or target policy installs neither route nor tools', async t => {
  const { ctx, routes } = await harness(t)
  const loadRuntimeSdk = async () => {
    const [tools, scope] = await Promise.all([sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-scope')])
    return { ToolRuntime: tools.default, scopeOf: scope.scopeOf }
  }
  const noKey = mountOptionalWebAiHost(ctx, { getNativeBridgeKey: () => undefined, loadRuntimeSdk, authorizeTarget: () => true })
  assert.deepEqual(await noKey.ready, { available: false, reason: 'NATIVE_BRIDGE_KEY_UNAVAILABLE' })
  assert.equal(routes.length, 0)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.list), undefined)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.ask), undefined)
  await noKey.dispose()

  const noPolicy = mountOptionalWebAiHost(ctx, { getNativeBridgeKey: () => nativeKey, loadRuntimeSdk })
  assert.deepEqual(await noPolicy.ready, { available: false, reason: 'TARGET_AUTHORIZATION_UNAVAILABLE' })
  assert.equal(routes.length, 0)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.list), undefined)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.ask), undefined)
  await noPolicy.dispose()
})

test('missing deferred Host dependencies stay pending without throwing or registering feature tools', async t => {
  const { Context } = await sdk('@deepseek-ai/cordis')
  const ctx = new Context()
  const component = mountOptionalWebAiHost(ctx, {
    getNativeBridgeKey: () => nativeKey,
    loadRuntimeSdk: async () => { throw new Error('must not load before Host dependencies exist') },
    authorizeTarget: () => true,
  })
  assert.deepEqual(component.status, { available: false, reason: 'HOST_DEPENDENCIES_PENDING' })
  assert.equal(ctx.tools, undefined)
  await component.dispose()
  await ctx.fiber.dispose()
})

test('only the exact live SDK exec can authorize, and the binding expires when that ToolRun settles', async t => {
  const { ctx, modules } = await harness(t)
  const target = { targetId: 'identity-target', generation: 1, providerId: 'deepseek', windowId: 'identity-window', conversationId: 'identity-conversation', available: true }
  let expectedAgent
  const authorization = createNativeWebAiAuthorization(ctx, {
    ToolRuntime: modules.tools.default,
    scopeOf: modules.scope.scopeOf,
    getTarget: id => id === target.targetId ? target : undefined,
    listTargets: () => [target],
    authorizeTarget: ({ action, caller }) => action === 'ask' && caller.agent === expectedAgent,
  })
  assert.equal(authorization.available, true)
  let savedExec
  let savedBinding
  let deniedClones
  ctx.tools.register({
    name: NATIVE_WEB_AI_TOOLS.ask,
    description: 'Real ToolRuntime identity probe.',
    parameters: { targetId: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['result'], properties: { result: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      savedExec = exec
      const fakeExecs = [
        { ...exec },
        { ...exec, agent: { id: exec.agent.id, session: exec.agent.session, ctx: exec.agent.ctx } },
        { ...exec, agent: { id: exec.agent.id, session: { id: exec.agent.session.id }, ctx: exec.agent.ctx } },
        { ...exec, agent: { id: exec.agent.id, session: exec.agent.session, ctx: { get: name => name === 'fs' ? {} : exec.agent.ctx.get(name) } } },
      ]
      deniedClones = []
      for (const fakeExec of fakeExecs) {
        try { await authorization.authorizeNativeToolRun({ exec: fakeExec, targetId: args.targetId }); deniedClones.push(false) }
        catch (error) { deniedClones.push(error.code === 'NATIVE_EXEC_UNAVAILABLE') }
      }
      savedBinding = await authorization.authorizeNativeToolRun({ exec, targetId: args.targetId })
      assert.equal(savedBinding.isCurrent(), true)
      return { result: 'authorized exact live exec' }
    },
  })

  class ScriptAdapter extends modules.llm.LlmAdapter {
    calls = 0
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() {
      this.calls++
      yield* this.calls === 1
        ? toolCallResponse(modules.llm.ToolCallId, 'identity-tool-call', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'identity-target' })
        : textResponse('identity probe complete')
    }
  }
  const adapter = new ScriptAdapter()
  ctx.llm.registerAdapter(['identity-script'], adapter)
  const agent = await ctx.agentLoop.create(modules.sessions.SessionId('identity-agent'), { provider: 'identity-script', model: 'local-script' })
  expectedAgent = agent
  agent.followup(modules.llm.createUserMessage({ content: [{ type: 'text', text: 'run identity probe' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.source.callId === modules.llm.ToolCallId('identity-tool-call'))
  assert(result)
  assert.equal(result.data.message.isError, false)
  assert.deepEqual(deniedClones, [true, true, true, true], 'callId or copied agent/session/fs fields cannot replace the exact live exec')
  assert.equal(savedBinding.isCurrent(), false, 'a native binding expires after its ToolRun settles')
  await assert.rejects(authorization.authorizeNativeToolRun({ exec: savedExec, targetId: 'identity-target' }), error => error.code === 'NATIVE_EXEC_UNAVAILABLE')
  authorization.dispose()
})

test('real SDK native exec lists only authorized targets, rechecks ask policy, and keeps withFiles unavailable', async t => {
  const { ctx, root, routes, modules } = await harness(t)
  let testAgent
  const workspaceEntity = { id: 'native-workspace-A', path: root, sessionIds: [] }
  ctx.provide('workspaceRegistry', { list: () => [workspaceEntity] })
  let askDecisions = 0
  const component = mountOptionalWebAiHost(ctx, {
    getNativeBridgeKey: () => nativeKey,
    loadRuntimeSdk: async () => ({ ToolRuntime: modules.tools.default, scopeOf: modules.scope.scopeOf }),
    authorizeTarget: async ({ action, caller, target }) => {
      if (caller.agent !== testAgent) return false
      if (action === 'list') {
        assert.deepEqual(caller.workspaceMembership, {
          workspaceId: 'native-workspace-A', path: root, includesSession: true,
        }, 'WorkspaceRegistry entities expose id, path, and sessionIds')
        if (!['policy-test-target', 'workspace-race'].includes(target.targetId)) return false
        // A same-value target upsert creates a new DTO object but keeps the
        // stable target identity and must remain authorized.
        component.transport.targets.set(target.targetId, { ...target })
        return true
      }
      if (action === 'ask' && target.targetId === 'policy-test-target') return ++askDecisions >= 2
      if (action === 'ask' && target.targetId === 'target-race') {
        component.transport.targets.set(target.targetId, { ...target, generation: target.generation + 1 })
        return true
      }
      if (action === 'ask' && target.targetId === 'cwd-race') {
        await caller.workingDirectory.set(caller.agent, join(root, 'nested'), caller.exec.signal)
        return true
      }
      if (action === 'ask' && target.targetId === 'workspace-race') {
        workspaceEntity.id = 'native-workspace-B'
        return true
      }
      return false
    },
  })
  assert.deepEqual(await component.ready, { available: true, reason: undefined })
  assert.equal(routes.length, 1)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.list)?.name, NATIVE_WEB_AI_TOOLS.list)
  assert.equal(ctx.tools.get(NATIVE_WEB_AI_TOOLS.ask)?.name, NATIVE_WEB_AI_TOOLS.ask)
  component.transport.targets.set('policy-test-target', {
    targetId: 'policy-test-target', generation: 7, providerId: 'deepseek', windowId: 'real-target-object-id',
    conversationId: 'test-conversation', available: true,
  })
  await mkdir(join(root, 'nested'))
  component.transport.targets.set('target-race', {
    targetId: 'target-race', generation: 2, providerId: 'deepseek', windowId: 'target-race-window',
    conversationId: 'race-conversation', available: true,
  })
  component.transport.targets.set('cwd-race', {
    targetId: 'cwd-race', generation: 3, providerId: 'deepseek', windowId: 'cwd-race-window',
    conversationId: 'cwd-conversation', available: true,
  })
  component.transport.targets.set('workspace-race', {
    targetId: 'workspace-race', generation: 4, providerId: 'deepseek', windowId: 'workspace-race-window',
    conversationId: 'workspace-conversation', available: true,
  })

  class ScriptAdapter extends modules.llm.LlmAdapter {
    calls = 0
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() {
      this.calls++
      if (this.calls === 1) yield* toolCallResponse(modules.llm.ToolCallId, 'native-list', NATIVE_WEB_AI_TOOLS.list, {})
      else if (this.calls === 2) yield* toolCallResponse(modules.llm.ToolCallId, 'native-ask-denied', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'policy-test-target', prompt: 'deny this ask' })
      else if (this.calls === 3) yield* toolCallResponse(modules.llm.ToolCallId, 'native-ask-target-race', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'target-race', prompt: 'target changes while policy waits' })
      else if (this.calls === 4) yield* toolCallResponse(modules.llm.ToolCallId, 'native-ask-cwd-race', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'cwd-race', prompt: 'working directory changes while policy waits' })
      else if (this.calls === 5) yield* toolCallResponse(modules.llm.ToolCallId, 'native-ask-workspace-race', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'workspace-race', prompt: 'workspace membership changes while policy waits' })
      else if (this.calls === 6) yield* toolCallResponse(modules.llm.ToolCallId, 'native-ask-files', NATIVE_WEB_AI_TOOLS.ask, { targetId: 'policy-test-target', prompt: 'withFiles is disabled', withFiles: true })
      else yield* textResponse('script complete')
    }
  }
  const adapter = new ScriptAdapter()
  ctx.llm.registerAdapter(['native-host-script'], adapter)
  testAgent = await ctx.agentLoop.create(modules.sessions.SessionId('native-host-auth-test'), { provider: 'native-host-script', model: 'local-script' })
  workspaceEntity.sessionIds.push(String(testAgent.session.id))
  testAgent.followup(modules.llm.createUserMessage({ content: [{ type: 'text', text: 'exercise native Host authorization' }], source: { kind: 'user' } }))
  await testAgent.whenIdle()

  assert.equal(adapter.calls, 7)
  const events = testAgent.session.snapshotEvents()
  const toolResult = id => events.find(event => event.type === 'tool/result' && event.data.message.source.callId === modules.llm.ToolCallId(id))
  const listed = toolResult('native-list')
  assert(listed)
  if (listed.data.message.isError) console.error(JSON.stringify({ listError: listed.data.message.content }))
  assert.equal(listed.data.message.isError, false)
  const listedText = listed.data.message.content.find(item => item.type === 'text')?.text ?? ''
  assert.match(listedText, /policy-test-target/)

  const deniedAsk = toolResult('native-ask-denied')
  assert(deniedAsk)
  assert.equal(deniedAsk.data.message.isError, true)
  assert.match(deniedAsk.data.message.content.map(item => item.text ?? '').join('\n'), /TARGET_AUTHORIZATION_DENIED/)

  const targetRace = toolResult('native-ask-target-race')
  assert(targetRace)
  assert.equal(targetRace.data.message.isError, true)
  assert.match(targetRace.data.message.content.map(item => item.text ?? '').join('\n'), /TARGET_CHANGED/)

  const cwdRace = toolResult('native-ask-cwd-race')
  assert(cwdRace)
  assert.equal(cwdRace.data.message.isError, true)
  assert.match(cwdRace.data.message.content.map(item => item.text ?? '').join('\n'), /NATIVE_SESSION_CHANGED/)

  const workspaceRace = toolResult('native-ask-workspace-race')
  assert(workspaceRace)
  assert.equal(workspaceRace.data.message.isError, true)
  assert.match(workspaceRace.data.message.content.map(item => item.text ?? '').join('\n'), /NATIVE_SESSION_CHANGED/)

  const filesAsk = toolResult('native-ask-files')
  assert(filesAsk)
  assert.equal(filesAsk.data.message.isError, true)
  assert.match(filesAsk.data.message.content.map(item => item.text ?? '').join('\n'), /FILES_POLICY_UNAVAILABLE/)
  assert.equal(askDecisions, 1, 'withFiles is rejected before target policy or Host job creation')
  assert.equal(component.transport.jobs.size, 0)
  const response = await component.transport.handleRequest(new Request(`http://host${WEB_AI_NATIVE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', [WEB_AI_NATIVE_HEADER]: nativeKey },
    body: JSON.stringify({ type: 'next', hostInstanceId: component.transport.hostInstanceId, timeoutMs: 0 }),
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).command, null, 'withFiles rejection must enqueue no ask/cancel/release command')
})
