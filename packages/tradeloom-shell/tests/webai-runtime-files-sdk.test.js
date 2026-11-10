import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createWebAiRuntimeFiles, WEB_AI_RUNTIME_LIST_TOOL } from '../webai-runtime-files.js'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT
const ownedRoot = process.env.TRADELOOM_WEB_AI_TEST_ROOT

async function sdkModule(relativePath) {
  return import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

async function packageModule(packagePath, name) {
  const require = createRequire(pathToFileURL(join(sdkRoot, packagePath, '__webai_runtime_test__.cjs')))
  return import(pathToFileURL(require.resolve(name)).href)
}

async function createRuntime(t, { enableFullRead = false } = {}) {
  if (!ownedRoot) throw new Error('TRADELOOM_WEB_AI_TEST_ROOT must be an explicit workspace-owned directory')
  const root = await mkdtemp(join(ownedRoot, 'runtime-files-'))
  await mkdir(root, { recursive: true })
  const [{ Context }, fsLocal, fsSandbox, fsTypes, scope, testkit, llm, toolFs] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/fs/fs-local/lib/index.js'),
    sdkModule('packages/fs/fs-sandbox/lib/index.js'),
    sdkModule('packages/fs/fs/lib/index.js'),
    packageModule('packages/core/tools', '@deepseek-ai/dsh-scope'),
    packageModule('packages/test-support/agent-loop-testkit', '@deepseek-ai/dsh-agent-loop-testkit'),
    packageModule('packages/llm/llm', '@deepseek-ai/dsh-llm'),
    sdkModule('packages/fs/tool-fs/lib/index.js'),
  ])
  const ctx = new Context()
  await testkit.mountAgentLoopTestDependencies(ctx)
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access' }) })
  const dependencies = {
    ToolRuntime: (await sdkModule('packages/core/tools/lib/index.js')).ToolRuntime,
    LocalFileSystem: fsLocal.LocalFileSystem,
    SandboxedFileSystem: fsSandbox.SandboxedFileSystem,
    FsError: fsTypes.FsError,
    scopeOf: scope.scopeOf,
    standardFsTools: toolFs,
  }
  const bridge = createWebAiRuntimeFiles(ctx, dependencies, { enableFullRead, enableStandardWrite: true })
  const { FileSystem } = bridge
  await ctx.plugin(FileSystem, { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
  let nestedWriteResult
  const nestedResults = []
  let currentBinding = true
  let lastCapability
  const executeTool = ctx.tools.execute.bind(ctx.tools)
  ctx.tools.execute = async exec => {
    const result = await executeTool(exec)
    if (exec.name === 'write') nestedWriteResult = {
      isError: result.isError, value: result.value,
      errorCode: result.error?.code ?? result.error?.info?.code ?? null,
      content: result.content,
    }
    if (exec.callId?.startsWith('webai-files:')) nestedResults.push({ name: exec.name, isError: result.isError, content: result.content })
    return result
  }

  ctx.provide('workingDirectory', { defaultDirectory: root, get: () => root, ensure: () => Promise.resolve(root) })
  await ctx.plugin(toolFs, { read: false, readImage: false, write: true, edit: false })

  const harness = await testkit.mountAgentLoopTestHarness(ctx)
  class NoRequestAdapter extends llm.LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() { throw new Error('This test must not start a model request') }
  }
  ctx.llm.registerAdapter(['webai-local'], new NoRequestAdapter())
  const agent = await harness.create('webai-runtime-files-test', { provider: 'webai-local', model: 'local-only' })

  // A trusted outer ToolRuntime execution owns the one-shot grant and performs
  // the nested list/read/write call before that execution settles.
  ctx.tools.register({
    name: 'webai_test_operation', description: 'Owned WebAI integration probe.',
    parameters: {
      request: { type: 'object', required: ['op', 'path', 'requestId'], properties: {
        op: { type: 'string' }, path: { type: 'string' }, requestId: { type: 'string' }, content: { type: 'string' },
      } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const capability = await bridge.bind({
        exec,
        root,
        getRoot: () => root,
        isCurrent: () => currentBinding && ctx.agents.get(agent.id) === agent && agent.session === exec.agent.session,
        getDeniedTools: () => deniedTools,
      })
      lastCapability = capability
      return bridge.execute(capability, args.request)
    },
  })

  let deniedTools = []
  t.after(async () => {
    await bridge.dispose()
    await ctx.fiber.dispose()
  })
  const callRaw = request => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: llm.ToolCallId(`webai-runtime-${Math.random().toString(16).slice(2)}`),
      name: 'webai_test_operation', arguments: { request }, agent,
    })
  const call = async request => {
    const result = await callRaw(request)
    assert.equal(result.isError, false, JSON.stringify(result.content))
    return result.value
  }
  return {
    root, ctx, agent, bridge, call, callRaw,
    setDeniedTools: value => { deniedTools = value },
    setCurrentBinding: value => { currentBinding = value },
    get lastCapability() { return lastCapability },
    nestedResults,
    get nestedWriteResult() { return nestedWriteResult },
  }
}

test('rep12 ToolRuntime 与 LocalFileSystem 执行运行时目录grant，默认禁读、显式开读、只新建不覆盖', {
  skip: sdkRoot && ownedRoot ? false : '需要固定 rep12 SDK 与本工作区 owned 测试根',
}, async t => {
  const f = await createRuntime(t)
  await writeFile(join(f.root, 'existing.txt'), 'original')
  const defaultRead = await f.call({ op: 'read', path: 'existing.txt', requestId: 'default-read' })
  assert.deepEqual(defaultRead, { ok: false, error: { code: 'TOOL_UNAVAILABLE' } })

  const listing = await f.call({ op: 'list', path: '.', requestId: 'list' })
  assert.equal(listing.ok, true)
  assert.ok(listing.entries.some(entry => entry.name === 'existing.txt'))
  assert.deepEqual(await f.bridge.execute(f.lastCapability, { op: 'list', path: '.', requestId: 'stale-exec' }),
    { ok: false, error: { code: 'INVALID_GRANT' } }, 'grant is invalid after the parent ToolRuntime execution settles')
  const created = await f.call({ op: 'write_new', path: 'new.txt', content: 'new content', requestId: 'create' })
  assert.equal(created.ok, true, `nested ${JSON.stringify(f.nestedWriteResult)}; result ${JSON.stringify(created)}`)
  assert.deepEqual(created, { ok: true, created: true })
  const overwrite = await f.call({ op: 'write_new', path: 'existing.txt', content: 'replacement', requestId: 'overwrite' })
  assert.deepEqual(overwrite, { ok: false, error: { code: 'ALREADY_EXISTS' } })
  assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original')
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new content')

  f.setDeniedTools([WEB_AI_RUNTIME_LIST_TOOL])
  const denied = await f.call({ op: 'list', path: '.', requestId: 'denied-list' })
  assert.equal(denied.error.code, 'TOOL_FAILED')
  assert.ok(f.nestedResults.some(result => result.name === WEB_AI_RUNTIME_LIST_TOOL
    && result.isError && result.content.some(part => part.text?.includes('This file operation is unavailable for this caller.'))),
  'the SDK ToolRuntime denied the nested list because the current grant policy disallows it')
  f.setCurrentBinding(false)
  const staleBinding = await f.callRaw({ op: 'list', path: '.', requestId: 'stale-binding' })
  assert.equal(staleBinding.isError, true)
  assert.equal(f.nestedResults.filter(result => result.name === WEB_AI_RUNTIME_LIST_TOOL).length, 2,
    'stale binding is rejected before dispatching the nested filesystem operation')
})

test('rep12 ToolRuntime full read remains opt-in and reads only through the bound grant', {
  skip: sdkRoot && ownedRoot ? false : '需要固定 rep12 SDK 与本工作区 owned 测试根',
}, async t => {
  const f = await createRuntime(t, { enableFullRead: true })
  await writeFile(join(f.root, 'read.txt'), 'owned text')
  const read = await f.call({ op: 'read', path: 'read.txt', requestId: 'read-enabled' })
  assert.deepEqual(read, { ok: true, content: 'owned text' })

  f.setDeniedTools(['read', 'tradeloom_webai_read_file'])
  const denied = await f.call({ op: 'read', path: 'read.txt', requestId: 'read-denied' })
  assert.equal(denied.error.code, 'TOOL_FAILED')
  assert.ok(f.nestedResults.some(result => result.name === 'tradeloom_webai_read_file'
    && result.isError && result.content.some(part => part.text?.includes('This file operation is unavailable for this caller.'))),
  'the SDK ToolRuntime denied the nested read because the current grant policy disallows it')
})
