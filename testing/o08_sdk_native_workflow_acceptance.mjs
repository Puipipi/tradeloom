import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROLE_PRESETS } from '../packages/tradeloom-shell/roles.js'
import { createNativeWorkflowAccess, createWorkflowNativeUiHandler } from '../packages/tradeloom-shell/workflow-native-ui.js'
import { createWorkflowNativeService } from '../packages/tradeloom-shell/workflow-native-service.js'
import { registerWorkflowNativeTools } from '../packages/tradeloom-shell/workflow-native-tools.js'
import { createConfirmedWorkflowDefinition } from '../packages/tradeloom-shell/workflow-definition.js'
import { createWorkflowStore } from '../packages/tradeloom-shell/workflow-engine.js'
import { createPostgresWorkflowRunStore } from '../packages/tradeloom-shell/workflow-postgres.js'
import { createNativeWorkflowReadiness, NATIVE_WORKFLOW_READINESS } from '../packages/tradeloom-shell/workflow-native-readiness.js'
import * as nativeTaskAuthority from '../packages/tradeloom-shell/workflow-native-task-authority.js'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
const sdkFamily = process.env.TRADELOOM_O08_SDK_FAMILY ?? 'rep4'
const rep12ModulePaths = new Map([
  ['@deepseek-ai/cordis', 'vendor/cordis/lib/index.js'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm/lib/index.js'],
  ['@deepseek-ai/dsh-session', 'packages/core/session/lib/index.js'],
  ['@deepseek-ai/dsh-session-projection', 'packages/session/session-projection/lib/index.js'],
  ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt/lib/index.js'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools/lib/index.js'],
  ['@deepseek-ai/dsh-agent', 'packages/core/agent/lib/index.js'],
  ['@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop/lib/index.js'],
  ['@deepseek-ai/dsh-commands', 'packages/interaction/commands/lib/index.js'],
  ['@deepseek-ai/dsh-session-query', 'packages/session-query/session-query/lib/index.js'],
  ['@deepseek-ai/dsh-fs-local', 'packages/fs/fs-local/lib/index.js'],
  ['@deepseek-ai/dsh-working-directory', 'packages/session/working-directory/lib/index.js'],
  ['@deepseek-ai/dsh-subagent', 'packages/subagent/subagent/lib/index.js'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', 'packages/session/session-persistence-jsonl/lib/index.js'],
  ['@deepseek-ai/dsh-subagent-spawn-in-process', 'packages/subagent/subagent-spawn-in-process/lib/index.js'],
  ['@deepseek-ai/dsh-tool-subagent', 'packages/subagent/tool-subagent/lib/index.js'],
  ['@deepseek-ai/dsh-agent-preset-registry', 'packages/preset/agent-preset-registry/lib/index.js'],
  ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader/lib/index.js'],
  ['@deepseek-ai/dsh-tool-fs', 'packages/fs/tool-fs/lib/index.js'],
  ['@deepseek-ai/dsh-tool-present', 'packages/deliverables/tool-present/lib/index.js'],
  ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy/lib/index.js'],
  ['@deepseek-ai/dsh-typert-registry', 'packages/typert/registry/lib/index.js'],
  ['@deepseek-ai/dsh-api-workspace-files', 'packages/api/workspace-files/lib/index.js'],
  ['@deepseek-ai/dsh-user-questions', 'packages/interaction/user-questions/lib/index.js'],
])
assert(['rep4', 'rep12'].includes(sdkFamily), 'unsupported O08 SDK family')
const loadSdk = async name => {
  if (sdkFamily === 'rep12') {
    const modulePath = rep12ModulePaths.get(name)
    assert(modulePath, `no pinned rep12 module path for ${name}`)
    return import(pathToFileURL(join(dshRoot, modulePath)).href)
  }
  return import(pathToFileURL(requireFromDsh.resolve(name)).href)
}
let ctx
let service
let unregisterTools
let handler
let sessionQueryPlugin
let readiness
let readinessRecovery
let releaseReadinessRecovery
let readinessRecoveryResult
let submitReceipt
let pendingReadinessSubmit
const sdkToolReceipts = []
const nativeWorkflowToolStarts = []
let childStarts = []
let childEnds = []
let scriptCalls = 0
let scriptSawMixedInput = false
const scenario = process.env.TRADELOOM_O08_SCENARIO ?? 'success'
const allowedScenarios = new Set(['success', 'cancel', 'timeout', 'llm-error', 'deliverable', 'native-artifact', 'mixed-controls', 'mixed-review'])
const deliverableScenario = scenario === 'deliverable' || scenario === 'native-artifact'
const serviceTimeoutMs = Number(process.env.TRADELOOM_O08_SERVICE_TIMEOUT_MS ?? '15000')
let signalObserved = false
let streamErrorThrown = false
let signalStreamStartedResolve
const signalStreamStarted = new Promise(resolve => { signalStreamStartedResolve = resolve })
let childStartedResolve
const childStarted = new Promise(resolve => { childStartedResolve = resolve })
let childEndedResolve
const childEnded = new Promise(resolve => { childEndedResolve = resolve })
const reviewRequests = []
let summary
let phase = 'temp-isolation'

assert(allowedScenarios.has(scenario), 'unsupported O08 scenario')
assert(Number.isSafeInteger(serviceTimeoutMs) && serviceTimeoutMs >= 100 && serviceTimeoutMs <= 15_000,
  'O08 service timeout must be between 100 and 15000 ms')

function finalEvents(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallEvents(ToolCallId, id, name, args) {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: argumentsJson.length } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function loadArtifactCandidate(ownedRoot) {
  const afterSource = process.env.TRADELOOM_O08_ARTIFACT_CANDIDATE_AFTER
  assert(afterSource && isAbsolute(afterSource), 'absolute O08 artifact after candidate must be provided')
  const shellSource = resolve(process.cwd(), 'packages', 'tradeloom-shell')
  const overlayShell = join(ownedRoot, 'candidate-source-overlay', 'packages', 'tradeloom-shell')
  await mkdir(overlayShell, { recursive: true })
  for (const entry of await readdir(shellSource, { withFileTypes: true })) {
    if (!entry.isFile() || !(entry.name.endsWith('.js') || entry.name === 'package.json')) continue
    await copyFile(join(shellSource, entry.name), join(overlayShell, entry.name))
  }
  const candidateTarget = join(overlayShell, 'workflow-native-artifact-http.js')
  await writeFile(candidateTarget, await readFile(afterSource))
  const candidateModule = await import(pathToFileURL(candidateTarget).href + '?o08-service-identity-candidate')
  assert.equal(typeof candidateModule.createNativeArtifactHandler, 'function')
  return candidateModule
}

class FixtureRequest extends (await import('node:stream')).Readable {
  constructor(body) {
    super()
    this.method = 'POST'
    this.complete = true
    this.push(JSON.stringify(body))
    this.push(null)
  }
  _read() {}
}

class FixtureResponse extends (await import('node:events')).EventEmitter {
  statusCode = 200
  headers = new Map()
  body = ''
  writableEnded = false
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value) }
  end(body = '') { this.body = body; this.writableEnded = true }
}

function beginUi(body) {
  const req = new FixtureRequest(body)
  const res = new FixtureResponse()
  const response = handler(req, res).then(() => ({ status: res.statusCode, body: JSON.parse(res.body) }))
  return { req, res, response }
}

async function invokeUi(body) {
  return beginUi(body).response
}

function makeMemoryRunStore() {
  const rows = new Map()
  const copy = value => value === undefined ? undefined : structuredClone(value)
  return {
    async get(id) { return copy(rows.get(id)) ?? null },
    async list({ activeOnly = false } = {}) {
      return [...rows.values()].filter(row => !activeOnly || ['running', 'waiting'].includes(row.status)).map(({ id, status }) => ({ id, status }))
    },
    async save(snapshot, expectedRevision) {
      const prior = rows.get(snapshot.id)
      if ((prior?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('fixture CAS conflict'), { code: 'cas_conflict' })
      const saved = copy(snapshot)
      rows.set(saved.id, saved)
      return copy(saved)
    },
  }
}

function makePairedPostgresRunStore() {
  const host = '127.0.0.1'
  const port = Number(process.env.TRADELOOM_O08_DJANGO_PORT)
  const nativeBridgeKey = process.env.TRADELOOM_NATIVE_BRIDGE_KEY
  assert(Number.isInteger(port) && port >= 1 && port <= 65535, 'isolated Django loopback port must be provided')
  assert.match(nativeBridgeKey ?? '', /^[a-f0-9]{64}$/, 'test-only bridge key must be an in-memory synthetic key')
  const origin = `http://${host}:${port}`
  return createPostgresWorkflowRunStore({
    webServer: { protocol: 'http:', host, port, getOrigin: () => origin },
    pairedHost: { host, port }, port, nativeBridgeKey,
  })
}

async function readPersistedRunAfterRestart() {
  assert.equal(process.env.TRADELOOM_O08_RUNSTORE, 'postgres', 'readback requires the isolated PG adapter mode')
  const runId = process.env.TRADELOOM_O08_RUN_ID
  assert.match(runId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  const snapshot = await makePairedPostgresRunStore().get(runId)
  assert(snapshot, 'the original run must be readable after Django/PostgreSQL restart')
  assert.equal(snapshot.id, runId)
  assert.equal(snapshot.status, 'done')
  assert.equal(snapshot.parentAgentId, 'o08-center-session')
  assert.equal(snapshot.sessionId, 'o08-center-session')
  const node = snapshot.nodes['pure-ai']
  assert(node)
  assert.equal(node.status, 'done')
  assert.equal(node.attempt, 1, 'restart readback must not re-execute the node')
  assert(node.childId)
  assert(node.nativeRunId)
  const terminal = snapshot.events.filter(event => event.type === 'node-terminal' && event.nodeId === 'pure-ai')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].status, 'done')
  assert.equal(terminal[0].source, 'subagent/end')
  assert.equal(terminal[0].requestId, node.requestId)
  assert.equal(terminal[0].childId, node.childId)
  assert.equal(terminal[0].nativeRunId, node.nativeRunId)
  assert.equal(terminal[0].parentAgentId, snapshot.parentAgentId)
  assert.equal(terminal[0].sessionId, snapshot.sessionId)
  const expectedOutput = deliverableScenario
    ? [{ type: 'text', text: 'O08 catalog declared from the real child session.' }]
    : [{ type: 'text', text: 'O08 child completed.' }]
  assert.deepEqual(terminal[0].output, expectedOutput)
  console.log(JSON.stringify({ ok: true, phase: 'postgres-restart-readback', mode: 'readback-only', runId,
    status: snapshot.status, revision: snapshot.revision, nodeStatus: node.status, attempt: node.attempt,
    childId: node.childId, nativeRunId: node.nativeRunId, requestId: node.requestId,
    terminalSource: terminal[0].source, terminalCount: terminal.length, parentMatches: true,
    output: terminal[0].output }))
}

if (process.argv[2] === 'readback') {
  await readPersistedRunAfterRestart()
} else {
const tempRoot = await mkdtemp(join(tmpdir(), 'tl-o08-sdk-workflow-'))
const ownedRoot = resolve(tempRoot)
const dshHome = join(ownedRoot, 'dsh-home')
const settingsPath = join(ownedRoot, 'settings')
const sessionLogPath = join(ownedRoot, 'session-logs')
const workspacePath = join(ownedRoot, 'workspace')
const oldEnv = new Map(['DSH_HOME', 'TRADELOOM_DSH_APP_HOME', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]))
const marker = '.tradeloom-owned'

try {
  await mkdir(dshHome, { recursive: true })
  await mkdir(settingsPath, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await writeFile(join(dshHome, marker), 'tradeloom-dsh-apphome-v1\n', { flag: 'wx' })
  process.env.DSH_HOME = dshHome
  process.env.TRADELOOM_DSH_APP_HOME = dshHome
  process.env.HOME = ownedRoot
  process.env.USERPROFILE = ownedRoot

  phase = `load-single-${sdkFamily}-sdk-root`
  const [cordis, llm, sessions, projections, systemPrompt, tools, agents, agentLoop, commands,
    sessionQuery, fsLocal, workingDirectory, subagentService, sessionPersistenceJsonl, spawnProvider, toolSubagent, presetRegistry, loader,
    toolFs, toolPresent, sandboxPolicy, typertRegistry, workspaceFilesPackage] = await Promise.all([
    loadSdk('@deepseek-ai/cordis'), loadSdk('@deepseek-ai/dsh-llm'), loadSdk('@deepseek-ai/dsh-session'),
    loadSdk('@deepseek-ai/dsh-session-projection'), loadSdk('@deepseek-ai/dsh-system-prompt'),
    loadSdk('@deepseek-ai/dsh-tools'), loadSdk('@deepseek-ai/dsh-agent'), loadSdk('@deepseek-ai/dsh-agent-loop'),
    loadSdk('@deepseek-ai/dsh-commands'), loadSdk('@deepseek-ai/dsh-session-query'),
    loadSdk('@deepseek-ai/dsh-fs-local'), loadSdk('@deepseek-ai/dsh-working-directory'), loadSdk('@deepseek-ai/dsh-subagent'),
    loadSdk('@deepseek-ai/dsh-session-persistence-jsonl'),
    loadSdk('@deepseek-ai/dsh-subagent-spawn-in-process'),
    loadSdk('@deepseek-ai/dsh-tool-subagent'),
    loadSdk('@deepseek-ai/dsh-agent-preset-registry'),
    loadSdk('@deepseek-ai/cordis-plugin-loader'),
    loadSdk('@deepseek-ai/dsh-tool-fs'),
    loadSdk('@deepseek-ai/dsh-tool-present'),
    loadSdk('@deepseek-ai/dsh-sandbox-policy'),
    loadSdk('@deepseek-ai/dsh-typert-registry'),
    loadSdk('@deepseek-ai/dsh-api-workspace-files'),
  ])

  phase = 'mount-real-sdk-context'
  ctx = new cordis.Context()
  readiness = createNativeWorkflowReadiness()
  ctx.provide(NATIVE_WORKFLOW_READINESS, readiness)
  await ctx.plugin(llm.default)
  await ctx.plugin(sessions.default)
  await ctx.plugin(projections.default)
  await ctx.plugin(systemPrompt.default, { personaPrefix: '' })
  await ctx.plugin(tools.default)
  await ctx.plugin(agents.default)
  await ctx.plugin(commands.default)
  await ctx.plugin(loader.default)
  await ctx.plugin({ name: sessionPersistenceJsonl.name, Config: sessionPersistenceJsonl.Config, apply: sessionPersistenceJsonl.apply },
    { root: sessionLogPath, compression: 'none' })
  await ctx.plugin(fsLocal.default, { cwd: workspacePath })
  await ctx.plugin(workingDirectory.default, { defaultDirectory: workspacePath })
  sessionQueryPlugin = ctx.plugin(sessionQuery.default)
  await sessionQueryPlugin
  if (scenario === 'native-artifact') {
    await ctx.plugin(typertRegistry.default)
    await ctx.plugin(sandboxPolicy.default, { mode: 'workspace-write', workspaceRoot: workspacePath })
    await ctx.plugin(workspaceFilesPackage.default)
    assert(ctx.get('workspaceFiles'), 'the real SDK WorkspaceFiles service must be mounted')
  }
  if (scenario === 'mixed-review') {
    const userQuestions = await loadSdk('@deepseek-ai/dsh-user-questions')
    await ctx.plugin(userQuestions.default)
    assert(ctx.get('userQuestions'), 'the real rep12 UserQuestionService must be mounted')
  }
  // The registry only configures this host settings service to disable automatic
  // preset discovery; declarations below are explicit SDK preset registrations.
  ctx.provide('settings', { root: settingsPath, configure: () => () => {} })
  await ctx.plugin(presetRegistry.default, { default: ROLE_PRESETS.center })
  await ctx.plugin(agentLoop.default, { agents: [] })
  await ctx.plugin(subagentService.default, { maxActiveSubagents: 2 })
  assert(ctx.get('subagents'), 'real dsh-subagent service must be mounted')
  await ctx.plugin({ name: spawnProvider.name, inject: spawnProvider.inject, Config: spawnProvider.Config, apply: spawnProvider.apply }, { providerName: 'spawn' })
  assert(ctx.get('loader'), 'real Cordis Loader must be mounted')
  assert(ctx.subagents?.getProvider('spawn'), 'real in-process spawn provider must be registered')
  const presets = ctx.get('agentPresets')
  assert(presets && typeof presets.register === 'function', 'real AgentPresetRegistry service must be mounted')
  await presets.register({ id: ROLE_PRESETS.center, plugins: [] })
  await presets.register({ id: ROLE_PRESETS.product, plugins: [] })
  const presetRows = await presets.list()
  assert.deepEqual(presetRows.filter(row => row.broken).map(row => ({ id: row.id, broken: row.broken })), [],
    `SDK preset composition failed: ${JSON.stringify(presetRows.filter(row => row.broken).map(row => ({ id: row.id, broken: row.broken })))}`)
  await ctx.plugin({ name: toolSubagent.name, inject: toolSubagent.inject, Config: toolSubagent.Config, apply: toolSubagent.apply }, {
    provider: 'spawn', agentPreset: ROLE_PRESETS.product,
    allowedAgentPresets: [ROLE_PRESETS.product], maxDepth: 1,
  })
  if (deliverableScenario) {
    // Use the SDK's serial lifecycle seam so the actual child receives its
    // official tools before AgentLoop starts, without making them global.
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.agentPreset !== ROLE_PRESETS.product) return
      await agent.ctx.plugin(toolFs, { read: false, readImage: false, write: true, edit: false })
      await agent.ctx.plugin(toolPresent, { maxFiles: 1 })
    })
  }

  const parentId = 'o08-center-session'
  const workspaceId = 'o08-test-workspace'
  const workspaceRegistry = {
    archivedSessionIds: [],
    get(id) { return id === workspaceId ? { id, path: workspacePath, sessionIds: [parentId] } : undefined },
  }
  ctx.provide('workspaceRegistry', workspaceRegistry)
  ctx.provide('connection', { requestRejection: () => undefined })
  const roleState = {
    version: 1,
    roles: { center: { sessionId: parentId, workspaceId, workspacePath, agentPreset: ROLE_PRESETS.center } },
    roleBindingRevisions: { center: '1' },
  }
  const readState = async () => structuredClone(roleState)

  const workflow = ['mixed-controls', 'mixed-review'].includes(scenario) ? {
    version: 1, id: 'o08-live-smoke', title: 'O08 mixed control-node SDK smoke', source: 'manual', confirmed: true,
    nodes: [
      { id: 'local-input', kind: 'input', title: 'Local input', instruction: 'Exact SDK control-node input.' },
      { id: 'pure-ai', kind: 'agent', title: 'Pure AI', agent: 'product', instruction: 'Process the provided input and return exactly: O08 child completed.' },
      ...(scenario === 'mixed-review' ? [{ id: 'user-review', kind: 'review', title: 'Review result', instruction: 'Check the produced result.' }] : []),
      { id: 'local-output', kind: 'output', title: 'Local output', instruction: 'This instruction is not the output source.' },
    ],
    edges: scenario === 'mixed-review'
      ? [{ from: 'local-input', to: 'pure-ai' }, { from: 'pure-ai', to: 'user-review' }, { from: 'user-review', to: 'local-output' }]
      : [{ from: 'local-input', to: 'pure-ai' }, { from: 'pure-ai', to: 'local-output' }],
  } : {
    version: 1, id: 'o08-live-smoke', title: 'O08 live SDK child smoke', source: 'manual', confirmed: true,
    nodes: [{ id: 'pure-ai', kind: 'agent', title: 'Pure AI', agent: 'product', instruction: 'Return exactly: O08 child completed.' }],
    edges: [],
  }
  const definitionStore = createWorkflowStore(join(ownedRoot, 'workflow-definitions'))
  const savedDefinition = await definitionStore.save(workflow)
  const confirmed = createConfirmedWorkflowDefinition(savedDefinition)
  const runStore = process.env.TRADELOOM_O08_RUNSTORE === 'postgres'
    ? makePairedPostgresRunStore() : makeMemoryRunStore()
  phase = 'install-native-authority-and-service'
  await ctx.plugin(nativeTaskAuthority)
  service = createWorkflowNativeService({
    ctx, readState, definitionStore, runStore,
    taskAuthority: ctx.nativeTaskAuthority, timeoutMs: serviceTimeoutMs,
  })
  let releaseBarrier
  const recoveryBarrier = new Promise(resolve => { releaseBarrier = resolve })
  releaseReadinessRecovery = releaseBarrier
  readinessRecovery = readiness.startRecovery(async signal => {
    if (scenario === 'mixed-review') await recoveryBarrier
    if (signal.aborted) return
    readinessRecoveryResult = await service.recover()
    return readinessRecoveryResult
  })
  if (scenario !== 'mixed-review') {
    releaseReadinessRecovery()
    await readinessRecovery
  }
  unregisterTools = registerWorkflowNativeTools(ctx, service, { preset: ROLE_PRESETS.center })
  ctx.on('tools/execute', async (exec, next) => {
    if (typeof exec.name === 'string' && exec.name.startsWith('tradeloom_wf_native_')) nativeWorkflowToolStarts.push(exec.name)
    const result = await next()
    if (exec.name === 'tradeloom_wf_native_submit' || exec.name === 'subagent'
      || deliverableScenario && ['write', 'present'].includes(exec.name)) {
      sdkToolReceipts.push({ name: exec.name, callId: exec.callId, isError: result?.isError === true,
        errorCode: result?.error?.code ?? result?.error?.info?.code ?? null, errorName: result?.error?.name ?? null,
        errorReason: typeof result?.error?.message === 'string' ? result.error.message.slice(0, 220) : null,
        agentId: exec.agent?.session?.id ?? null,
        value: exec.name === 'tradeloom_wf_native_submit'
          ? (typeof result?.value?.data === 'string' ? JSON.parse(result.value.data) : null)
          : result?.value?.kind === 'activation' ? { kind: result.value.kind, subagentId: result.value.subagentId }
            : exec.name === 'present' && result?.value ? structuredClone(result.value) : null })
    }
    return result
  }, { global: true })
  handler = createWorkflowNativeUiHandler(ctx, { readState, resolveProfileNamespace: async () => dshHome })

  class ScriptAdapter extends llm.LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream(options = {}) {
      scriptCalls++
      if (['mixed-controls', 'mixed-review'].includes(scenario)) {
        try { scriptSawMixedInput ||= JSON.stringify(options).includes('Exact SDK control-node input.') } catch {}
      }
      if (scenario === 'cancel' || scenario === 'timeout') {
        signalStreamStartedResolve()
        const signal = options.signal
        await new Promise(resolve => {
          const onAbort = () => { signalObserved = true; resolve() }
          if (signal?.aborted) onAbort()
          else if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
          else throw new Error('script adapter received no AbortSignal')
        })
        return
      }
      if (scenario === 'llm-error') {
        streamErrorThrown = true
        signalStreamStartedResolve()
        throw Object.assign(new Error('O08_TEST_LLM_FAILURE'), { code: 'O08_TEST_LLM_FAILURE' })
      }
      if (deliverableScenario) {
        if (scriptCalls === 1) {
          yield* toolCallEvents(llm.ToolCallId, 'o08-write-catalog', 'write', {
            file_path: 'catalog.md', content: '# O08 Producer Catalog\n\nProduced by the real SDK write tool.\n',
          })
          return
        }
        if (scriptCalls === 2) {
          yield* toolCallEvents(llm.ToolCallId, 'o08-present-catalog', 'present', {
            files: [{ path: 'catalog.md', description: 'O08 producer-chain catalog' }],
          })
          return
        }
        yield* finalEvents('O08 catalog declared from the real child session.')
        return
      }
      yield* finalEvents('O08 child completed.')
    }
  }
  ctx.llm.registerAdapter(['o08-local-script'], new ScriptAdapter())

  phase = 'create-live-parent-session'
  const parent = await ctx.agentLoop.create(sessions.SessionId(parentId),
    { provider: 'o08-local-script', model: 'deterministic-local-script' },
    { cwd: workspacePath, agentPreset: ROLE_PRESETS.center })
  assert.equal(ctx.agents.get(parentId), parent)
  assert.equal(parent.session.header.agentPreset, ROLE_PRESETS.center)
  if (scenario === 'mixed-review') {
    ctx.on('user-questions/request', async request => {
      reviewRequests.push(request)
      assert.equal(request.agent, parent, 'the actual SDK question must be scoped to the live root Agent')
      assert.equal(request.questions.length, 1)
      const question = request.questions[0]
      assert.deepEqual(question.options.map(option => option.label), ['批准', '拒绝'])
      assert.equal(question.intent, undefined, 'review does not use model intent as authorization')
      assert.match(question.detail, /Check the produced result/)
      assert.match(question.detail, /O08 child completed\./)
      const waitingRun = await runStore.get(submitReceipt.runId)
      assert.equal(waitingRun.nodes['user-review'].status, 'waiting', 'review request must be persisted before answer')
      assert.equal(waitingRun.nodes['user-review'].reviewState.request.questionId, question.id)
      return { answers: [{ id: question.id, selected: ['批准'] }] }
    })
  }
  const actualSubagentTool = ctx.tools.get('subagent', parent)
  assert(actualSubagentTool, 'real official subagent tool must be visible to the center Agent')
  assert.deepEqual(actualSubagentTool.parameters?.properties?.agent_preset?.enum, [ROLE_PRESETS.product],
    `unexpected official subagent preset schema: ${JSON.stringify(actualSubagentTool.parameters?.properties?.agent_preset ?? null)}`)
  if (deliverableScenario) {
    assert.equal(ctx.tools.get('write', parent), undefined,
      'filesystem tools must be scoped to the product child preset, not exposed on the center')
  }
  parent.ctx.on('subagent/start', info => { childStarts.push({ ...info }); childStartedResolve(info) })
  parent.ctx.on('subagent/end', info => { childEnds.push({ ...info }); childEndedResolve(info) })

  phase = 'ui-prepare'
  let preparedResponse
  let submitted
  if (scenario === 'mixed-review') {
    phase = 'readiness-pending-submit'
    pendingReadinessSubmit = beginUi({ action: 'submit', workflowId: workflow.id,
      operationId: 'o08-sdk-readiness-submit', expectedDefinitionRevision: confirmed.definitionRevision,
      expectedBindingRevision: '1', confirm: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(readiness.state, 'pending')
    assert.equal(pendingReadinessSubmit.res.writableEnded, false,
      'native submit must remain behind startup recovery while the gate is pending')
    assert.deepEqual(await runStore.list(), [], 'pending recovery must not commit a workflow run')
    assert.deepEqual(nativeWorkflowToolStarts, [], 'pending recovery must not start a native workflow tool')
    assert.deepEqual(childStarts, [], 'pending recovery must not dispatch an SDK child')
    assert.equal(scriptCalls, 0, 'pending recovery must not invoke the local model adapter')

    phase = 'readiness-complete-real-memory-journal-recovery'
    releaseReadinessRecovery()
    await readinessRecovery
    assert.equal(readiness.state, 'ready')
    assert.deepEqual(readinessRecoveryResult, { recovered: [], unmanaged: [] },
      'startup producer must call the real service recovery over the isolated memory journal')
    submitted = await pendingReadinessSubmit.response
    assert.equal(submitted.status, 202)
    assert.equal(submitted.body.ok, true)
    submitReceipt = submitted.body.submission

    phase = 'ui-prepare-after-readiness'
    preparedResponse = await invokeUi({ action: 'prepare', workflowId: workflow.id })
  } else {
    preparedResponse = await invokeUi({ action: 'prepare', workflowId: workflow.id })
  }
  assert.equal(preparedResponse.status, 200, `prepare failed with code ${preparedResponse.body.error_code ?? 'unknown'}`)
  assert.equal(preparedResponse.body.ok, true)
  const prepared = preparedResponse.body.prepared
  assert.equal(prepared.definitionRevision, confirmed.definitionRevision)
  assert.equal(prepared.bindingRevision, '1')
  assert.equal(prepared.executionMode, 'native_dsh')
  assert.equal(prepared.graph.nodeCount, ['mixed-controls', 'mixed-review'].includes(scenario) ? workflow.nodes.length : 1)
  if (['mixed-controls', 'mixed-review'].includes(scenario)) {
    assert.deepEqual(prepared.graph.roleIds, ['product'])
    assert.deepEqual(prepared.graph.nodes.map(node => node.kind ?? 'agent'), workflow.nodes.map(node => node.kind))
  }

  phase = 'ui-submit-real-command-and-agent-toolrun'
  if (!submitted) {
    submitted = await invokeUi({ action: 'submit', workflowId: workflow.id,
      operationId: 'o08-sdk-child-submit', expectedDefinitionRevision: prepared.definitionRevision,
      expectedBindingRevision: prepared.bindingRevision, confirm: true })
    assert.equal(submitted.status, 202)
    assert.equal(submitted.body.ok, true)
    submitReceipt = submitted.body.submission
  }
  assert.equal(submitReceipt.accepted, true)
  assert.equal(submitReceipt.settled, false, 'UI submit only acknowledges scheduling')

  if (['cancel', 'timeout', 'llm-error'].includes(scenario)) {
    phase = 'wait-fault-child-and-real-sdk-stream'
    await within(Promise.all([childStarted, signalStreamStarted]), 8_000, 'real child/stream start')
    let cancelResponse
    if (scenario === 'cancel') {
      phase = 'cancel-through-original-ui-endpoint'
      cancelResponse = await invokeUi({ action: 'cancel', runId: submitReceipt.runId, operationId: 'o08-fault-cancel' })
      assert.equal(cancelResponse.status, 200)
      assert.equal(cancelResponse.body.ok, true)
      assert.equal(cancelResponse.body.cancellation.abortRequested, true)
      assert.equal(cancelResponse.body.cancellation.intentPersisted, true)
      assert.equal(cancelResponse.body.cancellation.settled, false)
    }

    phase = 'wait-fault-real-sdk-child-terminal'
    const drain = await within(service.drain(), 18_000, 'fault workflow drain')
    assert.equal(drain.length, 1)
    assert.equal(drain[0].error, null)
    await within(childEnded, 5_000, 'real SDK child terminal event')
    const run = await runStore.get(submitReceipt.runId)
    assert(run)
    const node = run.nodes['pure-ai']
    assert(node)
    assert.equal(run.parentAgentId, parent.id)
    assert.equal(run.sessionId, parent.session.id)
    assert.equal(node.attempt, 1)
    assert.notEqual(run.status, 'done')
    assert.notEqual(node.status, 'done')
    assert.notDeepEqual(node.output, [{ type: 'text', text: 'O08 child completed.' }])
    assert.deepEqual(node.artifacts, [])
    assert.equal(run.events.filter(event => event.type === 'attempt-started' && event.nodeId === 'pure-ai').length, 1)
    assert.equal(run.events.filter(event => event.type === 'node-terminal' && event.nodeId === 'pure-ai').length, 0)
    const outcomeEvents = run.events.filter(event => ['node-interrupted', 'node-error', 'attempt-unknown',
      'tool-error-unverified', 'attempt-error'].includes(event.type) && event.nodeId === 'pure-ai')
    assert.equal(outcomeEvents.length, 1)
    assert.equal(childStarts.length, 1)
    assert.equal(childEnds.length, 1)
    assert.equal(childStarts[0].id, childEnds[0].id)
    assert.equal(childStarts[0].runId, childEnds[0].runId)
    assert.equal(childStarts[0].local, true)
    assert.equal(ctx.agents.get(childEnds[0].id), undefined, 'the SDK child must leave the active-agent registry')
    const childSessionRecord = await ctx.sessionQuery.readSession(childEnds[0].id)
    assert.equal(childSessionRecord.session.parentSession, parent.id)
    assert.equal(childSessionRecord.session.id, childEnds[0].id)
    if (scenario === 'cancel' || scenario === 'timeout') {
      assert.equal(signalObserved, true, 'the real child LLM stream must observe SDK cancellation')
      assert.equal(childEnds[0].stopReason, 'aborted')
      if (scenario === 'cancel') {
        assert.equal(outcomeEvents[0].type, 'node-interrupted')
        assert.equal(outcomeEvents[0].source, 'subagent/end')
        assert.equal(outcomeEvents[0].childId, childEnds[0].id)
        assert.equal(outcomeEvents[0].nativeRunId, childEnds[0].runId)
      } else {
        assert.equal(outcomeEvents[0].type, 'attempt-unknown')
        assert.equal(outcomeEvents[0].errorCategory, 'SUBAGENT_TERMINAL_TIMEOUT')
      }
    } else {
      assert.equal(scenario, 'llm-error')
      assert.equal(streamErrorThrown, true)
      assert.equal(childEnds[0].stopReason, 'error')
      assert.equal(outcomeEvents[0].type, 'node-error')
      assert.equal(outcomeEvents[0].source, 'subagent/end')
      assert.equal(outcomeEvents[0].errorCategory, 'error')
    }
    const submitToolReceipt = sdkToolReceipts.filter(receipt => receipt.name === 'tradeloom_wf_native_submit')
    assert.equal(submitToolReceipt.length, 1)
    assert.equal(submitToolReceipt[0].isError, false)
    assert.equal(submitToolReceipt[0].value.runId, run.id)
    summary = {
      ok: true, phase: 'fault-observed', scenario,
      serviceTimeoutMs,
      cancellation: cancelResponse?.body.cancellation ?? null,
      sdk: { childStarts: childStarts.length, childEnds: childEnds.length, childStopReason: childEnds[0].stopReason,
        scriptCalls, signalObserved, streamErrorThrown, activeChildCleared: ctx.agents.get(childEnds[0].id) === undefined },
      run: { runId: run.id, status: run.status, nodeStatus: node.status, attempt: node.attempt,
        outcomeType: outcomeEvents[0].type, terminalNodeSuccesses: 0, artifacts: node.artifacts.length,
        parentMatches: run.parentAgentId === parent.id && run.sessionId === parent.session.id,
        persistedTimeoutOutcome: scenario === 'timeout' ? outcomeEvents[0].errorCategory : null },
    }
  } else if (deliverableScenario) {
    phase = 'wait-real-sdk-child-and-declared-deliverable'
    const drain = await within(service.drain(), 18_000, 'deliverable workflow drain')
    assert.equal(drain.length, 1)
    assert.equal(drain[0].error, null)
    const run = await runStore.get(submitReceipt.runId)
    assert(run)
    const node = run.nodes['pure-ai']
    assert(node)
    const deliverableDebug = JSON.stringify({ run: run.status, node: node.status, error: node.error,
      childStopReason: childEnds[0]?.stopReason, toolReceipts: sdkToolReceipts.map(({ name, isError, errorCode, errorReason, callId, agentId, value }) => ({ name, isError, errorCode, errorReason, callId, agentId, value })) })
    assert.equal(run.status, 'done', deliverableDebug)
    assert.equal(node.status, 'done', deliverableDebug)
    assert.equal(node.attempt, 1)
    assert.equal(run.parentAgentId, parent.id)
    assert.equal(run.sessionId, parent.session.id)
    assert.equal(childStarts.length, 1)
    assert.equal(childEnds.length, 1)
    assert.equal(childStarts[0].id, childEnds[0].id)
    assert.equal(childStarts[0].runId, childEnds[0].runId)
    assert.equal(childEnds[0].stopReason, 'completed')
    assert.equal(ctx.agents.get(childEnds[0].id), undefined)

    const writeReceipts = sdkToolReceipts.filter(receipt => receipt.name === 'write')
    const presentReceipts = sdkToolReceipts.filter(receipt => receipt.name === 'present')
    assert.equal(writeReceipts.length, 1)
    assert.equal(writeReceipts[0].isError, false)
    assert.equal(writeReceipts[0].agentId, childStarts[0].id)
    assert.equal(presentReceipts.length, 1)
    assert.equal(presentReceipts[0].isError, false)
    assert.equal(presentReceipts[0].agentId, childStarts[0].id)
    assert.equal(presentReceipts[0].value?.turn, 1)
    assert.deepEqual(presentReceipts[0].value?.files, [{
      path: presentReceipts[0].value.files[0].path,
      description: 'O08 producer-chain catalog',
    }])

    const childSession = await ctx.sessionQuery.readSession(childStarts[0].id)
    assert.equal(childSession.session.id, childStarts[0].id)
    assert.equal(childSession.session.parentSession, parent.id)
    assert.equal(resolve(childSession.session.cwd), resolve(workspacePath))
    const presentedEvents = childSession.events.filter(event => event.type === 'deliverables/presented')
    assert.equal(presentedEvents.length, 1)
    const presented = presentedEvents[0]
    assert(Number.isSafeInteger(presented.seq) && presented.seq >= 0)
    assert.equal(presented.data.callId, presentReceipts[0].callId)
    assert.equal(presented.data.turn, presentReceipts[0].value.turn)
    assert.equal(presented.data.files.length, 1)
    assert.equal(presented.data.files[0].description, 'O08 producer-chain catalog')
    assert.equal(resolve(childSession.session.cwd, presented.data.files[0].path), resolve(workspacePath, 'catalog.md'))
    const sourceEvent = await ctx.sessionQuery.readEvent({ sessionId: childSession.session.id, seq: presented.seq, before: 0, after: 0 })
    assert.equal(sourceEvent.session.id, childSession.session.id)
    assert.equal(sourceEvent.target.seq, presented.seq)
    assert.equal(sourceEvent.target.type, 'deliverables/presented')
    assert.deepEqual(sourceEvent.target.data, presented.data)
    const content = await readFile(resolve(workspacePath, 'catalog.md'), 'utf8')
    assert.equal(content, '# O08 Producer Catalog\n\nProduced by the real SDK write tool.\n')

    assert.equal(node.artifactSource, 'deliverables/presented')
    assert.equal(node.artifactEvidence.range.childSessionId, childSession.session.id)
    assert.equal(node.artifactEvidence.range.nativeRunId, childStarts[0].runId)
    assert.equal(node.artifactEvidence.range.startInclusive <= presented.seq, true)
    assert.equal(node.artifactEvidence.range.endExclusive > presented.seq, true)
    assert.equal(node.artifactEvidence.declarations.length, 1)
    const declaration = node.artifactEvidence.declarations[0]
    assert.deepEqual(declaration, { sourceSessionSeq: presented.seq, fileIndex: 0,
      presentCallId: presented.data.callId, sourceTurn: presented.data.turn,
      path: presented.data.files[0].path, description: presented.data.files[0].description })
    assert.deepEqual(node.artifacts, [declaration])
    assert.equal(Object.hasOwn(declaration, 'sha256'), false, 'this producer-only acceptance must not create content hashes')

    const readback = await invokeUi({ action: 'get', runId: run.id })
    assert.equal(readback.status, 200)
    assert.equal(readback.body.run.status, 'done')
    const projectedNode = readback.body.run.nodes[0]
    assert.equal(projectedNode.artifactState, 'declared')
    assert.deepEqual(projectedNode.artifactEvidence, node.artifactEvidence)
    let nativeArtifact = null
    if (scenario === 'native-artifact') {
      phase = 'native-artifact-real-handler-backend-and-workspace-files'
      const djangoPort = Number(process.env.TRADELOOM_O08_DJANGO_PORT)
      const djangoOrigin = `http://127.0.0.1:${djangoPort}`
      assert(Number.isInteger(djangoPort) && djangoPort > 0 && djangoPort <= 65535)
      assert.match(process.env.TRADELOOM_NATIVE_BRIDGE_KEY ?? '', /^[a-f0-9]{64}$/)
      const sdkWorkspaceFiles = ctx.get('workspaceFiles')
      const artifactScope = { sessionId: childSession.session.id, workspaceRoot: childSession.session.cwd }
      const sdkFileStat = await sdkWorkspaceFiles.stat(artifactScope, presented.data.files[0].path)
      const sdkFileBytes = await sdkWorkspaceFiles.readBytes(artifactScope, presented.data.files[0].path, {})
      assert.equal(sdkFileStat.bytes, sdkFileBytes.data.length)
      assert.equal(sdkFileBytes.eof, true)
      assert.equal(Buffer.from(sdkFileBytes.data).toString('utf8'), content)
      ctx.provide('webServer', { protocol: 'http:', host: '127.0.0.1', port: djangoPort, getOrigin: () => djangoOrigin })
      ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => workspacePath }) })
      const serviceIdentity = name => {
        const first = ctx.get(name), second = ctx.get(name), marker = Symbol.for('cordis.original')
        const firstOriginal = first?.[marker], secondOriginal = second?.[marker]
        return { same: first === second, hasOriginal: firstOriginal !== undefined && secondOriginal !== undefined,
          originalSame: firstOriginal !== undefined && firstOriginal === secondOriginal }
      }
      const diagnosticRead = await ctx.get('sessionQuery').readEvent({
        sessionId: childSession.session.id, seq: presented.seq, before: 0, after: 0,
      })
      const identityDiagnostics = {
        sessionQuerySame: serviceIdentity('sessionQuery').same,
        sessionQueryHasOriginal: serviceIdentity('sessionQuery').hasOriginal,
        sessionQueryOriginalSame: serviceIdentity('sessionQuery').originalSame,
        filesystemSame: serviceIdentity('fs').same,
        filesystemHasOriginal: serviceIdentity('fs').hasOriginal,
        filesystemOriginalSame: serviceIdentity('fs').originalSame,
        workspaceFilesSame: serviceIdentity('workspaceFiles').same,
        workspaceFilesHasOriginal: serviceIdentity('workspaceFiles').hasOriginal,
        workspaceFilesOriginalSame: serviceIdentity('workspaceFiles').originalSame,
        directoryPickerSame: serviceIdentity('directoryPicker').same,
        readEventSuccessful: diagnosticRead?.target?.type === 'deliverables/presented',
      }
      const identityDiagnosticText = Object.entries(identityDiagnostics).map(([key, value]) => `${key}=${value}`).join(',')
      const authorizationInputs = []
      const candidateModule = await loadArtifactCandidate(ownedRoot)
      const artifactHandler = candidateModule.createNativeArtifactHandler(ctx, {
        access: createNativeWorkflowAccess(ctx, { readState }),
        authorizeImport: async input => { authorizationInputs.push(structuredClone(input)); return 'allowed-once' },
      })
      const artifactServer = createServer((req, res) => { void artifactHandler.handle(req, res) })
      try {
        const artifactOrigin = await new Promise((resolve, reject) => {
          artifactServer.once('error', reject)
          artifactServer.listen(0, '127.0.0.1', () => {
            artifactServer.off('error', reject)
            const address = artifactServer.address()
            if (!address || typeof address === 'string') return reject(new Error('artifact-listener-address-invalid'))
            resolve(`http://127.0.0.1:${address.port}`)
          })
        })
        const emptyListResponse = await fetch(new URL(`${candidateModule.NATIVE_ARTIFACT_COLLECTION}?runId=${run.id}&offset=0`, artifactOrigin))
        const emptyList = await emptyListResponse.json()
        assert.equal(emptyListResponse.status, 200, `handlerReason=${emptyList.reason ?? 'none'}`)
        assert.equal(emptyList.ok, true)
        assert.equal(emptyList.items.length, 0)
        const input = { runId: run.id, nodeId: 'pure-ai', attempt: 1, sourceSessionSeq: presented.seq, fileIndex: 0 }
        async function rejectDuringServiceChange(change) {
          const currentQuery = ctx.get('sessionQuery')
          const provider = currentQuery?.[Symbol.for('cordis.original')]
          assert(provider && typeof provider.readEvent === 'function', 'real sessionQuery provider must expose Cordis original identity')
          const originalReadEvent = provider.readEvent
          let releaseRead
          let startedRead
          const readStarted = new Promise(resolve => { startedRead = resolve })
          const readGate = new Promise(resolve => { releaseRead = resolve })
          provider.readEvent = async function (...args) {
            const result = await originalReadEvent.apply(this, args)
            startedRead()
            await readGate
            return result
          }
          let requestPromise
          try {
            requestPromise = fetch(new URL(candidateModule.NATIVE_ARTIFACT_COLLECTION, artifactOrigin), {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
            })
            await within(readStarted, 5000, 'real sessionQuery readEvent seam')
            await sessionQueryPlugin.dispose()
            sessionQueryPlugin = null
            if (change === 'replace') {
              sessionQueryPlugin = ctx.plugin(sessionQuery.default)
              await sessionQueryPlugin
              assert.notEqual(ctx.get('sessionQuery')?.[Symbol.for('cordis.original')], provider,
                'rebind must expose a distinct official SDK provider')
            }
            releaseRead()
            const response = await within(requestPromise, 5000, `handler ${change} response`)
            const body = await response.json()
            assert.equal(response.status, 503, `service ${change} must reject the in-flight import`)
            assert.equal(body.ok, false)
            assert.equal(authorizationInputs.length, 1, `service ${change} must reject before a second import authorization`)
            if (!sessionQueryPlugin) {
              sessionQueryPlugin = ctx.plugin(sessionQuery.default)
              await sessionQueryPlugin
            }
            const after = await fetch(new URL(`${candidateModule.NATIVE_ARTIFACT_COLLECTION}?runId=${run.id}&offset=0`, artifactOrigin))
            const afterBody = await after.json()
            assert.equal(after.status, 200)
            assert.equal(afterBody.items.length, 1, `service ${change} must not register another artifact`)
            return { status: response.status, itemCount: afterBody.items.length }
          } finally {
            releaseRead()
            provider.readEvent = originalReadEvent
            if (requestPromise) await requestPromise.catch(() => {})
            if (!sessionQueryPlugin) {
              sessionQueryPlugin = ctx.plugin(sessionQuery.default)
              await sessionQueryPlugin
            }
          }
        }
        const registered = await fetch(new URL(candidateModule.NATIVE_ARTIFACT_COLLECTION, artifactOrigin), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
        })
        const registration = await registered.json()
        assert.equal(registered.status, 200, `handlerReason=${registration.reason ?? 'none'};authorized=${authorizationInputs.length};${identityDiagnosticText}`)
        assert.equal(registration.ok, true)
        const version = registration.version
        assert.equal(version.runId, run.id)
        assert.equal(version.nodeId, 'pure-ai')
        assert.equal(version.attempt, 1)
        assert.equal(version.name, 'catalog.md')
        assert.equal(version.mimeType, 'text/plain; charset=utf-8')
        assert.equal(version.source.sessionId, childSession.session.id)
        assert.equal(version.source.seq, presented.seq)
        assert.equal(version.source.index, 0)
        assert.equal(version.source.callId, presented.data.callId)
        assert.equal(version.source.turn, presented.data.turn)
        assert.equal(version.availability, 'ready')
        assert.equal(version.previewSupported, null, 'the registration response does not claim preview support')
        assert.equal(authorizationInputs.length, 1)
        assert.equal(authorizationInputs[0].runId, run.id)
        assert.equal(authorizationInputs[0].childSessionId, childSession.session.id)
        assert.equal(authorizationInputs[0].parentAgentId, parent.id)
        assert.equal(authorizationInputs[0].parentSessionId, parent.session.id)
        assert.equal(resolve(authorizationInputs[0].root), resolve(workspacePath))
        assert.equal(resolve(authorizationInputs[0].file), resolve(workspacePath, 'catalog.md'))

        const revokedProvider = await rejectDuringServiceChange('revoke')
        const replacedProvider = await rejectDuringServiceChange('replace')

        const listedResponse = await fetch(new URL(`${candidateModule.NATIVE_ARTIFACT_COLLECTION}?runId=${run.id}&offset=0`, artifactOrigin))
        assert.equal(listedResponse.status, 200)
        const listed = await listedResponse.json()
        assert.equal(listed.ok, true)
        assert.equal(listed.items.length, 1)
        assert.equal(listed.items[0].previewSupported, true, 'the real list endpoint validates preview support')
        const listedVersion = listed.items[0]
        for (const key of ['id', 'runId', 'nodeId', 'attempt', 'name', 'mimeType', 'byteSize', 'sha256', 'source', 'availability']) {
          assert.deepEqual(listedVersion[key], version[key], `registered and listed artifact ${key} must agree`)
        }
        const expectedBytes = await readFile(resolve(workspacePath, 'catalog.md'))
        const expectedDigest = createHash('sha256').update(expectedBytes).digest('hex')
        assert.equal(version.byteSize, expectedBytes.length)
        assert.equal(version.sha256, expectedDigest)

        const storedPath = resolve(process.env.TRADELOOM_ARTIFACT_ROOT, 'native', version.id, 'content')
        const storedBytes = await readFile(storedPath)
        assert.deepEqual(storedBytes, expectedBytes)
        const downloaded = await fetch(new URL(listedVersion.downloadUrl, artifactOrigin))
        assert.equal(downloaded.status, 200)
        assert.equal(downloaded.headers.get('content-disposition'), 'attachment')
        const downloadBytes = Buffer.from(await downloaded.arrayBuffer())
        assert.deepEqual(downloadBytes, expectedBytes)
        const previewed = await fetch(new URL(listedVersion.previewUrl, artifactOrigin))
        assert.equal(previewed.status, 200)
        assert.equal(previewed.headers.get('content-type'), 'text/plain')
        assert.equal(previewed.headers.get('content-disposition'), 'inline')
        const previewBytes = Buffer.from(await previewed.arrayBuffer())
        assert.deepEqual(previewBytes, expectedBytes)
        nativeArtifact = { registerStatus: registered.status, listStatus: listedResponse.status,
          downloadStatus: downloaded.status, previewStatus: previewed.status, sourceSessionId: version.source.sessionId,
          sourceSeq: version.source.seq, fileIndex: version.source.index, callId: version.source.callId,
          turn: version.source.turn, name: version.name, byteSize: version.byteSize, sha256: version.sha256,
          workspaceFilesService: 'installed rep4 @deepseek-ai/dsh-api-workspace-files WorkspaceFiles',
          candidateOverlay: 'temporary top-level shell .js files and package.json; only the artifact handler is replaced by after candidate',
          providerLifecycle: { revoked: revokedProvider, replaced: replacedProvider },
          bytesMatch: storedBytes.equals(expectedBytes) && downloadBytes.equals(expectedBytes) && previewBytes.equals(expectedBytes) }
      } finally {
        artifactHandler.dispose()
        await new Promise((resolve, reject) => artifactServer.close(error => error ? reject(error) : resolve()))
      }
    }
    summary = {
      ok: true, phase: scenario === 'native-artifact' ? 'complete' : 'real-sdk-deliverable-declared',
      sdk: { childStarts: childStarts.length, childEnds: childEnds.length, stopReason: childEnds[0].stopReason,
        toolCalls: [{ name: 'write', callId: writeReceipts[0].callId, isError: writeReceipts[0].isError },
          { name: 'present', callId: presentReceipts[0].callId, isError: presentReceipts[0].isError }],
        scriptModelCalls: scriptCalls, childParentMatches: childSession.session.parentSession === parent.id },
      run: { runId: run.id, status: run.status, revision: run.revision, nodeStatus: node.status, artifactState: projectedNode.artifactState,
        attempt: node.attempt, childId: node.childId, nativeRunId: node.nativeRunId, requestId: node.requestId,
        sourceSeq: presented.seq, presentCallId: presented.data.callId, fileIndex: declaration.fileIndex,
        declaredPath: declaration.path, fileContentsMatch: content === '# O08 Producer Catalog\n\nProduced by the real SDK write tool.\n',
        output: node.output,
        artifactsCount: node.artifacts.length, artifactUpload: nativeArtifact ? 'registered-through-original-native-artifact-handler-and-Django' : 'not attempted',
        hashesComputed: nativeArtifact !== null },
      nativeArtifact,
      boundary: nativeArtifact
        ? '真实 rep4 SDK AgentLoop/ToolRuntime/official tool-fs write + tool-present event、Session query/filesystem/WorkspaceFiles、原 native artifact handler 与 Django/PostgreSQL registration/list/download/preview。一次性目录选择、authorizeImport、connection admission、Host webServer pairing 与工作流 role/workspace/settings 为测试 fixture；无真实 GUI picker、Host bootstrap、Electron、外部模型或用户 profile。'
        : '真实 rep4 SDK AgentLoop/ToolRuntime/official tool-fs write + tool-present producer event, real child Session/query, and original workflow executor/journal/UI projection. Deterministic local ScriptAdapter and existing test role/workspace/connection/settings fixtures; no native artifact registration/upload or hashes. No PG, GUI, Host bootstrap, real web session, or external model.',
    }
  } else if (scenario === 'mixed-controls') {
    phase = 'wait-mixed-control-nodes-and-real-sdk-child'
    const drain = await within(service.drain(), 18_000, 'mixed-control workflow drain')
    assert.equal(drain.length, 1)
    assert.equal(drain[0].error, null)
    const run = await runStore.get(submitReceipt.runId)
    assert(run)
    const input = run.nodes['local-input']
    const node = run.nodes['pure-ai']
    const output = run.nodes['local-output']
    assert.equal(run.status, 'done')
    assert.equal(input.status, 'done'); assert.equal(input.output, 'Exact SDK control-node input.')
    assert.equal(output.status, 'done'); assert.equal(output.output, 'O08 child completed.')
    for (const local of [input, output]) {
      assert.equal(local.attempt, 0)
      assert.equal(local.attemptState, 'local')
      for (const key of ['requestId', 'toolCallId', 'childId', 'nativeRunId']) assert.equal(local[key], null)
      assert.equal(local.artifactSource, 'unknown'); assert.deepEqual(local.artifacts, [])
    }
    assert.equal(node.status, 'done'); assert.equal(node.attempt, 1)
    assert(node.childId); assert(node.nativeRunId); assert(node.toolCallId); assert(node.requestId)
    assert.equal(run.parentAgentId, parent.id); assert.equal(run.sessionId, parent.session.id)
    assert.equal(childStarts.length, 1); assert.equal(childEnds.length, 1)
    assert.equal(childStarts[0].id, node.childId); assert.equal(childEnds[0].id, node.childId)
    assert.equal(childStarts[0].runId, node.nativeRunId); assert.equal(childEnds[0].runId, node.nativeRunId)
    assert.equal(childEnds[0].stopReason, 'completed')
    assert.equal(ctx.agents.get(childEnds[0].id), undefined)
    const childSession = await ctx.sessionQuery.readSession(node.childId)
    assert.equal(childSession.session.parentSession, parent.id)
    const localEvents = run.events.filter(event => event.source === 'workflow/local' && event.type === 'local-node-terminal')
    assert.deepEqual(localEvents.map(event => [event.nodeId, event.attempt, event.requestId, event.childId]), [
      ['local-input', 0, null, null], ['local-output', 0, null, null],
    ])
    const nativeReceipts = sdkToolReceipts.filter(receipt => ['tradeloom_wf_native_submit', 'subagent'].includes(receipt.name))
    assert.equal(nativeReceipts.length, 2)
    assert.deepEqual(nativeReceipts.map(receipt => receipt.name), ['tradeloom_wf_native_submit', 'subagent'])
    assert.equal(nativeReceipts.every(receipt => receipt.isError === false), true)
    assert.equal(nativeReceipts[1].value.subagentId, node.childId)
    assert(scriptCalls >= 1, 'the local ScriptAdapter must service the real SDK child')
    assert.equal(scriptSawMixedInput, true, 'the actual SDK child LLM request must contain the verified local input')
    const readback = await invokeUi({ action: 'get', runId: run.id })
    assert.equal(readback.status, 200)
    assert.deepEqual(readback.body.run.nodes.map(item => item.kind), ['input', undefined, 'output'])
    assert.equal(readback.body.run.nodes[0].terminalReceipt.source, 'workflow/local')
    assert.equal(readback.body.run.nodes[1].terminalReceipt.source, 'subagent/end')
    assert.equal(readback.body.run.nodes[2].terminalReceipt.source, 'workflow/local')
    assert.equal(readback.body.run.succeeded, true)
    summary = {
      ok: true, phase: 'mixed-controls-complete', scenario,
      ui: { prepared: preparedResponse.status, submit: submitted.status, get: readback.status, nodeCount: prepared.graph.nodeCount, roleIds: prepared.graph.roleIds },
      sdk: { runtime: `installed ${sdkFamily} SDK modules`, childStarts: childStarts.length, childEnds: childEnds.length,
        childStopReason: childEnds[0].stopReason, scriptModelCalls: scriptCalls,
        submitToolReceipt: nativeReceipts[0].isError === false, subagentToolReceipt: nativeReceipts[1].isError === false },
      run: { runId: run.id, status: run.status, localInputStatus: input.status, localInputAttempt: input.attempt,
        agentStatus: node.status, agentAttempt: node.attempt, outputStatus: output.status, outputAttempt: output.attempt,
        localSources: localEvents.map(event => event.source), agentSource: run.events.find(event => event.type === 'node-terminal' && event.nodeId === 'pure-ai').source,
        childId: node.childId, nativeRunId: node.nativeRunId, parentMatches: run.parentAgentId === parent.id && run.sessionId === parent.session.id,
        artifactSources: [input.artifactSource, node.artifactSource, output.artifactSource] },
      boundary: `真实${sdkFamily} SDK Context/Commands/AgentLoop/ToolRuntime/Session/AgentPresetRegistry/Subagent manager/in-process spawn/tool-subagent/JSONL child persistence 与原 native UI/service/journal；connection admission、workspaceRegistry 和中心 role state 为测试 fixture；LLM 为本地确定性 ScriptAdapter。非生产 Host/GUI/外部模型证明。`,
    }
  } else if (scenario === 'mixed-review') {
    phase = 'wait-rep12-sdk-review-and-child'
    const drain = await within(service.drain(), 18_000, 'mixed-review workflow drain')
    assert.equal(drain.length, 1)
    assert.equal(drain[0].error, null)
    const run = await runStore.get(submitReceipt.runId)
    assert.equal(run.status, 'done')
    const input = run.nodes['local-input']
    const node = run.nodes['pure-ai']
    const review = run.nodes['user-review']
    const output = run.nodes['local-output']
    assert.equal(input.status, 'done')
    assert.equal(input.output, 'Exact SDK control-node input.')
    assert.equal(node.status, 'done')
    assert.equal(node.attempt, 1)
    assert.equal(node.output[0]?.text, 'O08 child completed.')
    assert.equal(review.status, 'done')
    assert.equal(review.reviewState.status, 'approved')
    assert.equal(review.attempt, 0)
    assert.equal(review.output, 'O08 child completed.')
    for (const key of ['requestId', 'toolCallId', 'childId', 'nativeRunId']) assert.equal(review[key], null)
    assert.deepEqual(review.artifacts, [])
    assert.equal(review.artifactSource, 'unknown')
    assert.equal(output.status, 'done')
    assert.equal(output.output, 'O08 child completed.')
    assert.equal(reviewRequests.length, 1)
    assert.equal(reviewRequests[0].questions[0].id, review.reviewState.receipt.questionId)
    assert.equal(reviewRequests[0].agent, parent)
    assert.equal(childStarts.length, 1)
    assert.equal(childEnds.length, 1)
    assert.equal(childStarts[0].id, node.childId)
    assert.equal(childEnds[0].id, node.childId)
    assert.equal(childEnds[0].stopReason, 'completed')
    assert.equal(run.events.filter(event => event.type === 'attempt-started').length, 1)
    assert.equal(run.events.filter(event => event.type === 'review-node-waiting').length, 1)
    assert.equal(run.events.filter(event => event.type === 'review-node-terminal').length, 1)
    const readback = await invokeUi({ action: 'get', runId: run.id })
    assert.equal(readback.status, 200)
    assert.deepEqual(readback.body.run.nodes.map(item => item.kind), ['input', undefined, 'review', 'output'])
    assert.equal(readback.body.run.nodes[2].terminalReceipt.source, 'dsh-user-questions')
    assert.equal(readback.body.run.nodes[2].reviewStatus, 'approved')
    assert.equal(readback.body.run.nodes[2].attempt, 0)
    assert.equal(readback.body.run.nodes[3].terminalReceipt.source, 'workflow/local')
    assert.equal(readback.body.run.succeeded, true)
    summary = {
      ok: true, phase: 'rep12-mixed-review-complete', scenario,
      ui: { prepared: preparedResponse.status, submit: submitted.status, get: readback.status,
        nodeCount: prepared.graph.nodeCount, roleIds: prepared.graph.roleIds },
      sdk: { runtime: 'installed rep12 SDK modules', userQuestionService: 'real UserQuestionService.ask + scoped request waterfall',
        questionRequests: reviewRequests.length, answerer: 'deterministic fixture answerer, not a human UI response',
        childStarts: childStarts.length, childEnds: childEnds.length, childStopReason: childEnds[0].stopReason,
        scriptModelCalls: scriptCalls, nativeAgentAttempts: run.events.filter(event => event.type === 'attempt-started').length },
      run: { runId: run.id, status: run.status, localInputAttempt: input.attempt, agentAttempt: node.attempt,
        reviewStatus: review.reviewState.status, reviewAttempt: review.attempt, reviewQuestionId: review.reviewState.receipt.questionId,
        outputStatus: output.status, output: output.output, artifactSources: [input.artifactSource, node.artifactSource, review.artifactSource, output.artifactSource],
        parentMatches: run.parentAgentId === parent.id && run.sessionId === parent.session.id },
      startupRecovery: {
        state: readiness.state,
        recovered: readinessRecoveryResult.recovered.length,
        unmanaged: readinessRecoveryResult.unmanaged.length,
        pendingSubmitBlocked: true,
        runCountBeforeReady: 0,
        nativeToolStartsBeforeReady: 0,
        childStartsBeforeReady: 0,
        scriptCallsBeforeReady: 0,
        source: 'real createNativeWorkflowReadiness + service.recover() over the scenario in-memory run journal',
      },
      boundary: '真实rep12 Context/Commands/AgentLoop/ToolRuntime/Session/AgentPresetRegistry/Subagent manager/in-process child与UserQuestionService.ask/scoped request waterfall；ScriptAdapter与answerer为本地确定性fixture，readState/workspace/connection admission仍为fixture。未调用真人UI、生产Host、GUI或外部模型。',
    }
  } else {
  phase = 'wait-real-sdk-child-terminal'
  let drainTimer
  const drain = await Promise.race([
    service.drain(),
    new Promise((_, reject) => { drainTimer = setTimeout(() => reject(new Error('O08 workflow drain exceeded 18000 ms')), 18_000) }),
  ]).finally(() => clearTimeout(drainTimer))
  assert.equal(drain.length, 1)
  assert.equal(drain[0].error, null)
  const run = await runStore.get(submitReceipt.runId)
  assert(run, 'real native journal must persist the run')
  const node = run.nodes['pure-ai']
  const expectedOutput = [{ type: 'text', text: 'O08 child completed.' }]
  assert.equal(run.status, 'done')
  assert.equal(node.status, 'done')
  assert.deepEqual(node.output, expectedOutput)
  assert(node.childId)
  assert(node.nativeRunId)
  assert.equal(run.parentAgentId, parent.id)
  assert.equal(run.sessionId, parent.session.id)
  const terminalEvent = run.events.find(event => event.type === 'node-terminal' && event.nodeId === 'pure-ai')
  assert(terminalEvent, 'journal must contain a persisted terminal event')
  assert.equal(node.requestId, terminalEvent.requestId)
  assert.equal(terminalEvent.status, 'done')
  assert.equal(terminalEvent.source, 'subagent/end')
  assert.equal(terminalEvent.childId, node.childId)
  assert.equal(terminalEvent.nativeRunId, node.nativeRunId)
  assert.equal(terminalEvent.parentAgentId, parent.id)
  assert.equal(terminalEvent.sessionId, parent.session.id)
  assert.deepEqual(terminalEvent.output, expectedOutput)
  const submitToolReceipt = sdkToolReceipts.filter(receipt => receipt.name === 'tradeloom_wf_native_submit')
  assert.equal(submitToolReceipt.length, 1)
  assert.equal(submitToolReceipt[0].isError, false)
  assert.equal(submitToolReceipt[0].value.runId, run.id)
  const subagentToolReceipt = sdkToolReceipts.filter(receipt => receipt.name === 'subagent')
  assert.equal(subagentToolReceipt.length, 1)
  assert.equal(subagentToolReceipt[0].isError, false)
  assert.equal(subagentToolReceipt[0].value.kind, 'activation')
  assert.equal(subagentToolReceipt[0].value.subagentId, node.childId)
  assert.equal(childStarts.length, 1)
  assert.equal(childEnds.length, 1)
  assert.equal(childStarts[0].id, node.childId)
  assert.equal(childEnds[0].id, node.childId)
  assert.equal(childStarts[0].runId, node.nativeRunId)
  assert.equal(childEnds[0].runId, node.nativeRunId)
  assert.equal(childStarts[0].local, true)
  assert.equal(childEnds[0].stopReason, 'completed')
  const childSessionRecord = await ctx.sessionQuery.readSession(node.childId)
  assert.equal(childSessionRecord.session.id, node.childId)
  assert.equal(childSessionRecord.session.parentSession, parent.id,
    'the SDK-persisted child Session header must record its actual parent')
  assert(scriptCalls >= 1, 'the actual SDK child must call the deterministic local LLM adapter')
  assert(run.revision >= 4, 'journal must persist run creation, queueing, attempt start, and terminal result')

  phase = 'verify-ui-readback-and-actual-submit-tool-receipt'
  const readback = await invokeUi({ action: 'get', runId: submitReceipt.runId })
  assert.equal(readback.status, 200)
  assert.equal(readback.body.run.status, 'done')
  assert.equal(readback.body.run.nodes[0].status, 'done')
  summary = {
    ok: true,
    phase: 'complete',
    ui: { prepared: preparedResponse.status, submit: submitted.status, get: readback.status, acceptedThenSettled: true },
    sdk: { runtime: `installed ${sdkFamily} SDK modules`, childStarts: childStarts.length, childEnds: childEnds.length,
      childLocal: childStarts[0].local, stopReason: childEnds[0].stopReason, scriptModelCalls: scriptCalls,
      workflowToolReceipt: submitToolReceipt[0].isError === false,
      subagentToolReceipt: subagentToolReceipt[0].isError === false && subagentToolReceipt[0].value.subagentId === node.childId },
    run: { runId: run.id, status: run.status, revision: run.revision, nodeStatus: node.status,
      attempt: node.attempt, childId: node.childId, nativeRunId: node.nativeRunId, requestId: node.requestId,
      terminalSource: terminalEvent.source,
      parentMatches: run.parentAgentId === parent.id && run.sessionId === parent.session.id,
      childIdMatchesLifecycle: node.childId === childStarts[0].id && node.childId === childEnds[0].id,
      output: node.output },
    store: process.env.TRADELOOM_O08_RUNSTORE === 'postgres'
      ? 'original workflow-postgres adapter through real loopback Django/PostgreSQL HTTP'
      : 'in-memory paired runStore fixture',
    definition: 'original workflow-engine file store scoped to this temporary root; no canvas workflow-definition HTTP API exists in this repo',
    settings: 'in-memory no-op service fixture; its declared settings path is inside the same temporary root; no user settings/profile loaded',
    startupRecovery: readiness ? {
      state: readiness.state,
      result: readinessRecoveryResult,
      pendingSubmitBlocked: scenario === 'mixed-review',
      nativeToolStartsWhilePending: scenario === 'mixed-review' ? 0 : null,
      childStartsWhilePending: scenario === 'mixed-review' ? 0 : null,
      recoverySource: 'actual createNativeWorkflowReadiness producer calling service.recover() against this runner\'s in-memory journal',
    } : null,
      boundary: `真实 ${sdkFamily} Context/Commands/AgentLoop/ToolRuntime/Session/AgentPresetRegistry/Subagent manager/in-process spawn/tool-subagent/JSONL child persistence 与原 native UI/service/authority/executor；readState、workspaceRegistry、connection admission 为测试 fixture；LLM 为本地确定性脚本。是否使用真实 PG runStore 由隔离验收编排器明确选择。未调用外部模型、GUI、真实 Host bootstrap 或生产 workspace/profile。`,
  }
  }
} finally {
  const cleanupErrors = []
  try { readiness?.close() } catch (error) { cleanupErrors.push(error) }
  try { releaseReadinessRecovery?.() } catch (error) { cleanupErrors.push(error) }
  try { await readinessRecovery } catch (error) { cleanupErrors.push(error) }
  try { unregisterTools?.() } catch (error) { cleanupErrors.push(error) }
  try { await service?.dispose?.() } catch (error) { cleanupErrors.push(error) }
  try { if (ctx?.fiber?.dispose) await ctx.fiber.dispose() } catch (error) { cleanupErrors.push(error) }
  for (const [key, value] of oldEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const tempBase = resolve(tmpdir())
  if (!ownedRoot.startsWith(`${tempBase}${process.platform === 'win32' ? '\\' : '/'}`)
    || !basename(ownedRoot).startsWith('tl-o08-sdk-workflow-')) throw new Error('Refusing cleanup outside the unique O08 temp root')
  try { await rm(ownedRoot, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
  try { await assert.rejects(stat(ownedRoot), error => error.code === 'ENOENT') } catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'O08 owned-resource cleanup failed')
}

console.log(JSON.stringify(summary))
}
