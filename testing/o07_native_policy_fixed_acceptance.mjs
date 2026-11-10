import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const candidateRoot = resolve('recovery-20261029/o07-write-restriction-candidate-20261030/after/packages/tradeloom-shell')
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
const loadSdk = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
const { createWebAiRuntimeFiles } = await import(pathToFileURL(join(candidateRoot, 'webai-runtime-files.js')).href)
const root = await mkdtemp(join(tmpdir(), 'tl-o07-policy-fixed-'))
const resolvedRoot = resolve(root)
const blockedPath = join(root, 'restricted-adapter.txt')
const createdPath = join(root, 'visible-global-write.txt')
const directAllowedPath = join(root, 'visible-direct-write.txt')
let ctx
let runtimeFiles
let completedChecks
let summary
let probeStage = 'setup'
let standardWriteApplyCount = 0

function toolCallResponse(ToolCallId) {
  const id = ToolCallId('o07-fixed-policy-call')
  const args = JSON.stringify({ probe: true })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'o07_policy_fixed_probe', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'o07_policy_fixed_probe', arguments: args } },
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

try {
  assert(isAbsolute(resolvedRoot))
  const [cordis, llm, sessions, projections, systemPrompt, tools, agents, agentLoop, fsLocal, fsSandbox, fs,
    sandboxPolicy, workingDirectory, toolFs, scope] = await Promise.all([
    loadSdk('@deepseek-ai/cordis'), loadSdk('@deepseek-ai/dsh-llm'), loadSdk('@deepseek-ai/dsh-session'),
    loadSdk('@deepseek-ai/dsh-session-projection'), loadSdk('@deepseek-ai/dsh-system-prompt'),
    loadSdk('@deepseek-ai/dsh-tools'), loadSdk('@deepseek-ai/dsh-agent'), loadSdk('@deepseek-ai/dsh-agent-loop'),
    loadSdk('@deepseek-ai/dsh-fs-local'), loadSdk('@deepseek-ai/dsh-fs-sandbox'), loadSdk('@deepseek-ai/dsh-fs'),
    loadSdk('@deepseek-ai/dsh-sandbox-policy'), loadSdk('@deepseek-ai/dsh-working-directory'),
    loadSdk('@deepseek-ai/dsh-tool-fs'), loadSdk('@deepseek-ai/dsh-scope'),
  ])
  ctx = new cordis.Context()
  await ctx.plugin(llm.default)
  await ctx.plugin(sessions.default)
  await ctx.plugin(projections.default)
  await ctx.plugin(systemPrompt.default, { personaPrefix: '' })
  await ctx.plugin(tools.default)
  await ctx.plugin(agents.default)
  await ctx.plugin(sandboxPolicy.default, { mode: 'workspace-write', workspaceRoot: root })

  runtimeFiles = createWebAiRuntimeFiles(ctx, {
    ToolRuntime: tools.default,
    LocalFileSystem: fsLocal.default,
    SandboxedFileSystem: fsSandbox.default,
    FsError: fs.FsError,
    scopeOf: scope.scopeOf,
    standardFsTools: {
      ...toolFs,
      apply(...args) {
        standardWriteApplyCount += 1
        return Reflect.apply(toolFs.apply, toolFs, args)
      },
    },
  }, { enableFullRead: false, enableStandardWrite: true })
  await ctx.plugin(runtimeFiles.FileSystem, { cwd: root })
  await ctx.plugin(workingDirectory.default, { defaultDirectory: root })
  await ctx.plugin(toolFs, { read: true, readImage: false, write: true, edit: false })
  await ctx.plugin(agentLoop.default, { agents: [] })

  class ScriptAdapter extends llm.LlmAdapter {
    calls = 0
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() {
      this.calls += 1
      yield* this.calls === 1
        ? toolCallResponse(llm.ToolCallId)
        : textResponse('fixed SDK restriction acceptance completed')
    }
  }
  const adapter = new ScriptAdapter()
  ctx.llm.registerAdapter(['o07-policy-fixed-script'], adapter)

  ctx.tools.register({
    name: 'o07_policy_fixed_probe',
    description: 'Runs the isolated real SDK restriction and visible global write acceptance.',
    parameters: { probe: { type: 'boolean', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['checks'], properties: { checks: { type: 'array', items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      probeStage = 'validate-agent'
      assert.equal(args.probe, true)
      const agent = exec.agent
      assert.equal(scope.scopeOf(agent.ctx), agent)
      const globalWrite = agent.ctx.tools.get('write', agent)
      assert(globalWrite, 'SDK global write must be present before restriction')

      const removeWrite = agent.ctx.tools.restrict({ deny: ['write'] })
      try {
        probeStage = 'verify-direct-restriction'
        assert.equal(agent.ctx.tools.get('write', agent), undefined, 'SDK restrict must hide inherited global write')
        const direct = await agent.ctx.tools.execute({
          callId: 'o07-fixed-restricted-direct', name: 'write',
          arguments: { file_path: blockedPath, content: 'must remain absent\n' }, agent,
          signal: exec.signal, parent: exec.token, rootCallId: exec.rootCallId,
        })
        assert.equal(direct.isError, true)
        assert.equal(direct.error?.info?.code ?? direct.error?.code, 'UNKNOWN_TOOL')
        await assert.rejects(stat(blockedPath), error => error.code === 'ENOENT')
        const bindError = await runtimeFiles.bind({ exec, root, getRoot: () => root, isCurrent: () => true, getDeniedTools: () => [] })
          .then(() => null, error => error)
        assert(bindError, 'candidate must fail closed when the inherited write is hidden')
        probeStage = `bind-denied:${bindError.name}:${bindError.info?.code ?? bindError.code ?? 'NO_CODE'}`
        assert.equal(bindError.info?.code ?? bindError.code, 'UNKNOWN_TOOL')
        await assert.rejects(stat(blockedPath), error => error.code === 'ENOENT')
      } finally {
        removeWrite()
      }

      const visibleWrite = agent.ctx.tools.get('write', agent)
      probeStage = 'visible-write-bind'
      assert(visibleWrite, 'global write must return when SDK restriction is removed')
      const capability = await runtimeFiles.bind({ exec, root, getRoot: () => root, isCurrent: () => true, getDeniedTools: () => [] })
      try {
        probeStage = 'visible-write-identity'
        const afterBindWrite = agent.ctx.tools.get('write', agent)
        assert(afterBindWrite, 'existing visible global write must remain available')
        probeStage = 'visible-direct-global-write'
        const directAllowed = await agent.ctx.tools.execute({
          callId: 'o07-fixed-visible-direct-write', name: 'write',
          arguments: { file_path: directAllowedPath, content: 'direct global write remains available\n' },
          agent, signal: exec.signal, parent: exec.token, rootCallId: exec.rootCallId,
        })
        assert.equal(directAllowed.isError, false, 'candidate must not block ordinary SDK global write calls')
        assert.equal(await readFile(directAllowedPath, 'utf8'), 'direct global write remains available\n')
        probeStage = 'visible-write-create'
        const created = await runtimeFiles.execute(capability, {
          op: 'write_new', path: 'visible-global-write.txt', content: 'permitted global write\n', requestId: 'visible-write-1',
        })
        probeStage = 'visible-write-create-result'
        assert.deepEqual(created, { ok: true, created: true })
        probeStage = 'visible-write-content'
        const createdContent = await readFile(createdPath, 'utf8').then(value => value, () => null)
        probeStage = `visible-write-content:exists=${createdContent !== null}`
        const expectedContent = 'permitted global write\n'
        assert.equal(createdContent, expectedContent)
        assert.equal(standardWriteApplyCount, 0, 'candidate must not install a scoped standard write shadow')
        probeStage = 'visible-write-overwrite'
        const overwrite = await runtimeFiles.execute(capability, {
          op: 'write_new', path: 'visible-global-write.txt', content: 'must not overwrite\n', requestId: 'visible-write-2',
        })
        probeStage = 'visible-write-overwrite-result'
        assert.deepEqual(overwrite, { ok: false, error: { code: 'ALREADY_EXISTS' } })
        probeStage = 'visible-write-preserve'
        assert.equal(await readFile(createdPath, 'utf8'), 'permitted global write\n')
      } finally {
        runtimeFiles.revoke(capability)
      }
      completedChecks = ['restricted direct write denied', 'adapter failed closed with hidden global write', 'no restricted target created', 'ordinary visible global write still works during binding', 'adapter reused visible global write without a scoped shadow', 'write_new succeeded', 'overwrite denied and original bytes preserved']
      return { checks: completedChecks }
    },
  })

  const agent = await ctx.agentLoop.create(sessions.SessionId('o07-native-policy-fixed'), { provider: 'o07-policy-fixed-script', model: 'local-script' })
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run the isolated local SDK policy acceptance.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(adapter.calls, 2)
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    && event.data.message.source.callId === llm.ToolCallId('o07-fixed-policy-call'))
  assert.equal(results.length, 1)
  if (results[0].data.message.isError) {
    const errorCode = results[0].data.message.error?.info?.code ?? results[0].data.message.error?.code ?? 'UNKNOWN'
    throw new Error(`Outer probe tool failed with safe code ${errorCode}; stage=${probeStage}; completedChecks=${completedChecks?.length ?? 0}`)
  }
  assert.equal(results[0].data.message.isError, false, 'outer SDK ToolRunResult must confirm the probe completed')
  assert.equal(results[0].data.message.role, 'tool')
  const resultText = results[0].data.message.content?.find(item => item.type === 'text')?.text
  assert.deepEqual(completedChecks, [
    'restricted direct write denied', 'adapter failed closed with hidden global write', 'no restricted target created',
    'ordinary visible global write still works during binding', 'adapter reused visible global write without a scoped shadow',
    'write_new succeeded', 'overwrite denied and original bytes preserved',
  ])
  assert.equal(resultText, JSON.stringify({ checks: completedChecks }), 'outer receipt must contain all completed checks')
  summary = {
    classification: 'PASS_CANDIDATE_FAILS_CLOSED_ON_SDK_RESTRICTED_WRITE',
    sdkToolResult: { isError: false, callId: 'o07-fixed-policy-call' },
    checks: completedChecks,
    boundary: '真实 rep4 SDK AgentLoop/ToolRuntime/standard tool-fs/沙箱文件系统与候选 runtime-files；确定性本地脚本 LLM、测试策略输入和唯一临时目录。未验证 Host 挂载、生产 preset/guard、GUI、真实网页或外部模型。',
  }
} finally {
  if (runtimeFiles) await runtimeFiles.dispose()
  if (ctx?.fiber && typeof ctx.fiber.dispose === 'function') await ctx.fiber.dispose()
  const tempRoot = resolve(tmpdir())
  if (!resolvedRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)
    || !basename(resolvedRoot).startsWith('tl-o07-policy-fixed-')) throw new Error('Refusing cleanup outside this acceptance temp directory.')
  await rm(resolvedRoot, { recursive: true, force: true })
  await assert.rejects(stat(resolvedRoot), error => error.code === 'ENOENT')
}

console.log(JSON.stringify(summary))
