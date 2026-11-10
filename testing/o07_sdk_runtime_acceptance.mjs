import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const shellRoot = process.env.TRADELOOM_WEB_AI_SHELL_ROOT
  ?? 'C:/Users/23825/Desktop/ICT/tradeloom/packages/tradeloom-shell'
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))

async function sdk(packageName) {
  return import(pathToFileURL(requireFromDsh.resolve(packageName)).href)
}

function toolCallResponse(ToolCallId, id, name, args) {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsJson } },
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

const root = await mkdtemp(join(tmpdir(), 'tl-o07-sdk-'))
const resolvedRoot = resolve(root)
assert(isAbsolute(resolvedRoot))
const outside = `${resolvedRoot}-outside.txt`
let ctx
let runtimeFiles
let capability
let resultSummary
let completedChecks
const negativeControl = process.env.TRADELOOM_O07_NEGATIVE === '1'
const expectedChecks = ['read', 'write_new', 'overwrite-denied', 'traversal-denied', 'policy-denied']

try {
  await writeFile(join(root, 'known.txt'), 'O07 native SDK fixture\n', 'utf8')
  await writeFile(join(root, 'existing.txt'), 'preserve these exact bytes\r\n', 'utf8')
  await mkdir(join(root, 'nested'))
  await writeFile(outside, 'outside sentinel\n', 'utf8')

  const [cordis, llm, sessions, projections, systemPrompt, tools, agents, agentLoop, scope, fsLocal, fsSandbox, fs, sandboxPolicy, workingDirectory, toolFs] = await Promise.all([
    sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-llm'), sdk('@deepseek-ai/dsh-session'),
    sdk('@deepseek-ai/dsh-session-projection'), sdk('@deepseek-ai/dsh-system-prompt'),
    sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-agent'), sdk('@deepseek-ai/dsh-agent-loop'),
    sdk('@deepseek-ai/dsh-scope'), sdk('@deepseek-ai/dsh-fs-local'), sdk('@deepseek-ai/dsh-fs-sandbox'),
    sdk('@deepseek-ai/dsh-fs'), sdk('@deepseek-ai/dsh-sandbox-policy'),
    sdk('@deepseek-ai/dsh-working-directory'), sdk('@deepseek-ai/dsh-tool-fs'),
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
  await ctx.plugin(runtimeFiles.FileSystem, { cwd: root })
  await ctx.plugin(workingDirectory.default, { defaultDirectory: root })
  await ctx.plugin(agentLoop.default, { agents: [] })

  class ScriptAdapter extends llm.LlmAdapter {
    calls = 0
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model })
    }
    async *stream() {
      this.calls += 1
      yield* this.calls === 1
        ? toolCallResponse(llm.ToolCallId, 'o07-call-1', 'o07_sdk_runtime_probe', { task: 'exercise' })
        : textResponse('O07 scripted tool turn completed.')
    }
  }
  const adapter = new ScriptAdapter()
  ctx.llm.registerAdapter(['o07-script'], adapter)

  const deniedNames = []
  ctx.tools.register({
    name: 'o07_sdk_runtime_probe',
    description: 'Test-only wrapper that routes a real ToolRuntime execution into the shared O07 runtime-files adapter.',
    parameters: { task: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['checks'], properties: { checks: { type: 'array', items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.checks.join(', ') }],
    },
    async execute(args, exec) {
      if (negativeControl) throw new Error('O07 negative-control intentional tool failure')
      assert.equal(args.task, 'exercise')
      capability = await runtimeFiles.bind({
        exec,
        root,
        getRoot: () => root,
        isCurrent: () => true,
        getDeniedTools: () => deniedNames,
      })
      const checks = []
      const readKnown = await runtimeFiles.execute(capability, { op: 'read', path: 'known.txt', requestId: 'read-known' })
      assert.deepEqual(readKnown, { ok: true, content: 'O07 native SDK fixture\n' })
      checks.push('read')

      const writeNew = await runtimeFiles.execute(capability, { op: 'write_new', path: 'created.txt', content: 'created by real SDK tool-fs\n', requestId: 'write-new' })
      assert.deepEqual(writeNew, { ok: true, created: true })
      assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'created by real SDK tool-fs\n')
      checks.push('write_new')

      const beforeExisting = await readFile(join(root, 'existing.txt'))
      const overwrite = await runtimeFiles.execute(capability, { op: 'write_new', path: 'existing.txt', content: 'must not replace', requestId: 'write-existing' })
      assert.equal(overwrite.ok, false)
      assert.equal(overwrite.error.code, 'ALREADY_EXISTS')
      assert.deepEqual(await readFile(join(root, 'existing.txt')), beforeExisting)
      checks.push('overwrite-denied')

      const traversal = await runtimeFiles.execute(capability, { op: 'write_new', path: `../${basename(root)}-outside.txt`, content: 'must not escape', requestId: 'write-traversal' })
      assert.equal(traversal.ok, false)
      assert.equal(traversal.error.code, 'INVALID_REQUEST')
      assert.equal(await readFile(outside, 'utf8'), 'outside sentinel\n')
      checks.push('traversal-denied')

      deniedNames.push('read')
      const deniedRead = await runtimeFiles.execute(capability, { op: 'read', path: 'known.txt', requestId: 'read-denied' })
      assert.equal(deniedRead.ok, false)
      assert.equal(typeof deniedRead.error.code, 'string')
      assert.notEqual(deniedRead.content, 'O07 native SDK fixture\n')
      deniedNames.splice(0)
      checks.push('policy-denied')
      completedChecks = checks
      return { checks }
    },
  })

  const { createUserMessage } = llm
  const agent = await ctx.agentLoop.create(sessions.SessionId('o07-runtime-acceptance'), { provider: 'o07-script', model: 'local-script' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the local O07 acceptance tool.' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  assert.equal(adapter.calls, 2, 'one scripted tool request followed by one scripted final response')
  assert.equal(scope.scopeOf(agent.ctx), agent, 'the actual agent context is scoped to this SDK agent')
  const toolResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    && event.data.message.source.callId === llm.ToolCallId('o07-call-1'))
  assert.equal(toolResults.length, 1, 'the AgentLoop must record exactly one result for the scripted native tool call')
  if (toolResults[0].data.message.isError) {
    const failure = toolResults[0].data.error
    console.error(JSON.stringify({ toolFailure: { dataKeys: Object.keys(toolResults[0].data), name: failure?.name, code: failure?.code, message: failure?.message, result: toolResults[0].data.message.content } }))
  }
  assert.equal(toolResults[0].data.message.isError, false, 'the real ToolRunResult must be successful')
  assert.equal(toolResults[0].data.message.role, 'tool')
  assert.deepEqual(completedChecks, expectedChecks, 'every filesystem assertion must complete inside the real execute callback')
  assert.deepEqual(toolResults[0].data.message.content, [{ type: 'text', text: expectedChecks.join(', ') }], 'the successful result must carry the completed checks receipt')
  assert.deepEqual(await readFile(join(root, 'existing.txt')), Buffer.from('preserve these exact bytes\r\n'))

  const afterLifecycle = await runtimeFiles.execute(capability, { op: 'read', path: 'known.txt', requestId: 'after-lifecycle' })
  assert.deepEqual(afterLifecycle, { ok: false, error: { code: 'INVALID_GRANT' } })
  assert.equal(runtimeFiles.revoke(capability), false, 'native ToolRuntime completion auto-revoked the grant')
  resultSummary = {
    result: 'passed',
    checks: ['real-agent-toolcall', 'real-live-exec-bind', ...completedChecks, 'lifecycle-revoke'],
    runtime: 'rep4 installed compiled DSH SDK; shared webai-runtime-files.js; deterministic local script adapter',
    boundary: 'No Host installation, GUI, provider DOM, external model, real web page, or production preset validation.',
  }
} finally {
  if (runtimeFiles) await runtimeFiles.dispose()
  if (ctx?.fiber && typeof ctx.fiber.dispose === 'function') await ctx.fiber.dispose()
  const tempRoot = resolve(tmpdir())
  if (!resolvedRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`) || !resolvedRoot.includes('tl-o07-sdk-')) {
    throw new Error('Refusing cleanup outside the uniquely created O07 temporary directory.')
  }
  await rm(resolvedRoot, { recursive: true, force: true })
  await rm(outside, { force: true })
}

console.log(JSON.stringify(resultSummary))
