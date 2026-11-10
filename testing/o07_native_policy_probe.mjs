import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const shellRoot = process.env.TRADELOOM_WEB_AI_SHELL_ROOT
  ?? 'C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
const loadSdk = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
const root = await mkdtemp(join(tmpdir(), 'tl-o07-policy-'))
const resolvedRoot = resolve(root)
assert(isAbsolute(resolvedRoot))
const blockedPath = join(root, 'restricted-direct.txt')
const adapterPath = join(root, 'adapter-attempt.txt')
let ctx
let runtimeFiles
let capability
let completedProbe
let summary

function toolCallResponse(ToolCallId) {
  const id = ToolCallId('o07-policy-call')
  const args = JSON.stringify({ probe: true })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'o07_policy_probe', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'o07_policy_probe', arguments: args } },
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
  await writeFile(join(root, 'known.txt'), 'temporary policy probe input\n', 'utf8')
  const [cordis, llm, sessions, projections, systemPrompt, tools, agents, agentLoop, fsLocal, fsSandbox, fs, sandboxPolicy, workingDirectory, toolFs, scope] = await Promise.all([
    loadSdk('@deepseek-ai/cordis'), loadSdk('@deepseek-ai/dsh-llm'), loadSdk('@deepseek-ai/dsh-session'),
    loadSdk('@deepseek-ai/dsh-session-projection'), loadSdk('@deepseek-ai/dsh-system-prompt'),
    loadSdk('@deepseek-ai/dsh-tools'), loadSdk('@deepseek-ai/dsh-agent'), loadSdk('@deepseek-ai/dsh-agent-loop'),
    loadSdk('@deepseek-ai/dsh-fs-local'), loadSdk('@deepseek-ai/dsh-fs-sandbox'), loadSdk('@deepseek-ai/dsh-fs'),
    loadSdk('@deepseek-ai/dsh-sandbox-policy'), loadSdk('@deepseek-ai/dsh-working-directory'),
    loadSdk('@deepseek-ai/dsh-tool-fs'), loadSdk('@deepseek-ai/dsh-scope'),
  ])
  const { createWebAiRuntimeFiles } = await import(pathToFileURL(join(shellRoot, 'webai-runtime-files.js')).href)
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
    standardFsTools: toolFs,
  }, { enableFullRead: true, enableStandardWrite: true })
  // Preserve the production assembly order: scoped RuntimeFiles provider first,
  // then the original global SDK standard filesystem tools.
  await ctx.plugin(runtimeFiles.FileSystem, { cwd: root })
  await ctx.plugin(workingDirectory.default, { defaultDirectory: root })
  await ctx.plugin(toolFs, { read: true, readImage: false, write: true, edit: false })
  await ctx.plugin(agentLoop.default, { agents: [] })

  class ScriptAdapter extends llm.LlmAdapter {
    calls = 0
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() {
      this.calls += 1
      yield* this.calls === 1 ? toolCallResponse(llm.ToolCallId) : textResponse('policy probe tool run completed')
    }
  }
  const adapter = new ScriptAdapter()
  ctx.llm.registerAdapter(['o07-policy-script'], adapter)

  ctx.tools.register({
    name: 'o07_policy_probe',
    description: 'Test wrapper for checking whether the shared runtime-files adapter inherits an existing SDK restriction.',
    parameters: { probe: { type: 'boolean', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['globalWriteWasMounted', 'sdkRestriction', 'adapter'],
        properties: {
          globalWriteWasMounted: { type: 'boolean' },
          sdkRestriction: {
            type: 'object', additionalProperties: false,
            required: ['hiddenFromAgentView', 'directIsError', 'directErrorCode', 'directFileCreated'],
            properties: {
              hiddenFromAgentView: { type: 'boolean' }, directIsError: { type: 'boolean' },
              directErrorCode: { type: 'string' }, directFileCreated: { type: 'boolean' },
            },
          },
          adapter: {
            type: 'object', additionalProperties: false,
            required: ['ok', 'errorCode', 'fileCreated', 'fileContentMatches'],
            properties: {
              ok: { type: 'boolean' }, errorCode: { type: 'string' },
              fileCreated: { type: 'boolean' }, fileContentMatches: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      assert.equal(args.probe, true)
      const agent = exec.agent
      assert.equal(scope.scopeOf(agent.ctx), agent)
      const globalWriteBeforeRestriction = agent.ctx.tools.get('write', agent)
      assert(globalWriteBeforeRestriction, 'global standard write tool must exist before the restriction')

      const removeWrite = agent.ctx.tools.restrict({ deny: ['write'] })
      try {
        const writeVisibleAfterRestriction = agent.ctx.tools.get('write', agent)
        assert.equal(writeVisibleAfterRestriction, undefined, 'SDK restriction must hide the inherited global write tool')
        const direct = await agent.ctx.tools.execute({
          callId: 'o07-policy-direct-write',
          name: 'write',
          arguments: { file_path: blockedPath, content: 'direct restricted write must not happen\n' },
          agent,
          signal: exec.signal,
          parent: exec.token,
          rootCallId: exec.rootCallId,
        })
        const directCode = direct.error?.info?.code ?? direct.error?.code ?? null
        const directFileExists = await readFile(blockedPath, 'utf8').then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error))
        assert.equal(direct.isError, true, 'the direct standard write must be refused by the SDK restriction')
        assert.equal(directCode, 'UNKNOWN_TOOL', 'valid write arguments must fail because the inherited tool is hidden')
        assert.equal(directFileExists, false, 'the rejected direct call must not create its file')

        capability = await runtimeFiles.bind({
          exec,
          root,
          getRoot: () => root,
          isCurrent: () => true,
          // Empty only to isolate whether SDK ToolRuntime restriction naturally
          // reaches the scoped standard write installed by runtime-files.
          getDeniedTools: () => [],
        })
        const adapterWrite = await runtimeFiles.execute(capability, {
          op: 'write_new', path: 'adapter-attempt.txt', content: 'adapter write under SDK restriction\n', requestId: 'adapter-write',
        })
        const adapterContent = await readFile(adapterPath, 'utf8').then(value => value, error => error?.code === 'ENOENT' ? null : Promise.reject(error))
        completedProbe = {
          globalWriteWasMounted: true,
          sdkRestriction: { hiddenFromAgentView: true, directIsError: direct.isError, directErrorCode: directCode, directFileCreated: directFileExists },
          adapter: { ok: adapterWrite.ok, errorCode: adapterWrite.error?.code ?? '', fileCreated: adapterContent !== null, fileContentMatches: adapterContent === 'adapter write under SDK restriction\n' },
        }
        return completedProbe
      } finally {
        removeWrite()
      }
    },
  })

  const agent = await ctx.agentLoop.create(sessions.SessionId('o07-native-policy-probe'), { provider: 'o07-policy-script', model: 'local-script' })
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run the local SDK policy inheritance probe.' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  assert.equal(adapter.calls, 2, 'the deterministic adapter must complete one tool call and one final response')
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    && event.data.message.source.callId === llm.ToolCallId('o07-policy-call'))
  assert.equal(results.length, 1, 'AgentLoop must record exactly one result for the probe tool call')
  if (results[0].data.message.isError) console.error(JSON.stringify({ probeToolError: results[0].data.message.content }))
  assert.equal(results[0].data.message.isError, false, 'the probe wrapper itself must return a real successful ToolRunResult')
  assert.equal(results[0].data.message.role, 'tool')
  assert(completedProbe, 'all probe checks must complete inside the actual wrapper execute')
  const resultText = results[0].data.message.content?.find(item => item.type === 'text')?.text
  assert.equal(resultText, JSON.stringify(completedProbe), 'the SDK session receipt must carry the completed probe observations')
  assert.deepEqual(completedProbe.sdkRestriction, { hiddenFromAgentView: true, directIsError: true, directErrorCode: 'UNKNOWN_TOOL', directFileCreated: false })
  assert.equal(completedProbe.adapter.fileCreated, completedProbe.adapter.ok)
  assert.equal(completedProbe.adapter.fileContentMatches, completedProbe.adapter.ok)
  const adapterWriteBypassed = completedProbe.adapter.ok === true
  summary = {
    classification: adapterWriteBypassed ? 'FAIL_ADAPTER_BYPASSES_SDK_TOOL_RESTRICTION' : 'PASS_SDK_TOOL_RESTRICTION_INHERITED',
    sdkToolResult: { isError: results[0].data.message.isError, callId: 'o07-policy-call' },
    observation: completedProbe,
    boundary: 'Real rep4 compiled DSH AgentLoop/ToolRuntime/standard tool-fs + shared runtime-files; local script model and a unique temporary root. No Host/GUI/production preset or external model.',
  }
} finally {
  if (runtimeFiles) await runtimeFiles.dispose()
  if (ctx?.fiber && typeof ctx.fiber.dispose === 'function') await ctx.fiber.dispose()
  const tempRoot = resolve(tmpdir())
  if (!resolvedRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`) || !basename(resolvedRoot).startsWith('tl-o07-policy-')) {
    throw new Error('Refusing cleanup outside the uniquely created O07 policy-probe directory.')
  }
  await rm(resolvedRoot, { recursive: true, force: true })
}

console.log(JSON.stringify(summary))
if (summary.classification.startsWith('FAIL_')) process.exitCode = 2
