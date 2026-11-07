import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createAgentConfigurationResources } from '../agent-configuration.js'
import { createAgentConfigurationSnapshotsHandler } from '../agent-configuration-snapshots.js'
import { ROLE_PRESETS } from '../roles.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

const ownedRoot = process.env.TRADELOOM_AGENT_CONFIGURATION_TEST_ROOT
if (!ownedRoot) throw new Error('TRADELOOM_AGENT_CONFIGURATION_TEST_ROOT must be an explicit workspace-owned path')
await mkdir(ownedRoot, { recursive: true })

async function runtime() {
  const base = process.env.TRADELOOM_DSH_PINNED_SOURCE
  if (!base) throw new Error('TRADELOOM_DSH_PINNED_SOURCE must point to the pinned rep12 runtime')
  const importDsh = relative => import(pathToFileURL(resolve(base, relative)).href)
  const [
    { boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Include },
    llm, sessions, projections, skills, systemPrompt, tools, agents, agentLoop, fsLocal, workingDirectory,
    { default: AgentPresetRegistry },
  ] = await Promise.all([
    importDsh('packages/boot/app-boot/lib/index.js'),
    importDsh('packages/boot/config-editor/lib/index.js'),
    importDsh('vendor/include/lib/index.js'),
    importDsh('packages/llm/llm/lib/index.js'),
    importDsh('packages/core/session/lib/index.js'),
    importDsh('packages/session/session-projection/lib/index.js'),
    importDsh('packages/skill/skill/lib/index.js'),
    importDsh('packages/core/system-prompt/lib/index.js'),
    importDsh('packages/core/tools/lib/index.js'),
    importDsh('packages/core/agent/lib/index.js'),
    importDsh('packages/core/agent-loop/lib/index.js'),
    importDsh('packages/fs/fs-local/lib/index.js'),
    importDsh('packages/session/working-directory/lib/index.js'),
    importDsh('packages/preset/agent-preset-registry/lib/index.js'),
  ])
  return { base, importDsh, boot, initProfile, readProfilePatches, ConfigEditor, Include,
    llm, sessions, projections, skills, systemPrompt, tools, agents, agentLoop, fsLocal, workingDirectory, AgentPresetRegistry }
}

async function ownedRuntimeProfile(t, rt, { realPreset = false } = {}) {
  const home = await mkdtemp(join(ownedRoot, 'rep12-config-snapshot-'))
  const root = await realpath(ownedRoot)
  assert.equal(dirname(await realpath(home)), root)
  let context
  const savedRuntimeEnv = new Map()
  if (realPreset) {
    for (const key of ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR', 'HOME', 'USERPROFILE']) savedRuntimeEnv.set(key, process.env[key])
    process.env.DSH_HOME = home
    process.env.DSH_AGENTS_HOME = home
    process.env.DSH_BUNDLED_SKILL_DIR = join(home, 'bundled-skills')
    process.env.HOME = home
    process.env.USERPROFILE = home
    await mkdir(process.env.DSH_BUNDLED_SKILL_DIR, { recursive: true })
  }
  t.after(async () => {
    if (context) await context.fiber.dispose()
    for (const [key, value] of savedRuntimeEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const current = await realpath(home).catch(() => undefined)
    if (current && dirname(current) === root) await rm(current, { recursive: true, force: true })
  })
  const profileDir = join(home, 'profiles', 'tradeloom')
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  rt.initProfile(profileDir, ['test-bundle'])
  const bundle = join(profileDir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'isolated-agent-configuration-snapshot-test' }) + '\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  let presetPackage
  if (realPreset) {
    presetPackage = join(rt.base, 'packages', 'preset', 'agent-preset')
  } else {
    presetPackage = await mkdtemp(join(ownedRoot, 'rep12-preset-package-'))
    assert.equal(dirname(await realpath(presetPackage)), root)
    t.after(async () => {
      const current = await realpath(presetPackage).catch(() => undefined)
      if (current && dirname(current) === root) await rm(current, { recursive: true, force: true })
    })
    const schemaUrl = pathToFileURL(join(rt.base, 'vendor', 'schemastery', 'lib', 'index.mjs')).href
    await writeFile(join(presetPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-preset', type: 'module', main: 'index.js' }))
    await writeFile(join(presetPackage, 'index.js'), `import schema from ${JSON.stringify(schemaUrl)}\nexport default { Config: schema.object({ id: schema.string().required(), name: schema.string(), description: schema.string(), order: schema.number(), plugins: schema.array(schema.any()).required() }), apply(ctx, config) { ctx.provide('preset-config', config) } }\n`)
  }
  const targetPreset = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-agent-preset')
  await mkdir(dirname(targetPreset), { recursive: true })
  await symlink(presetPackage, targetPreset, 'junction')
  if (realPreset) {
    const targetShell = join(profileDir, 'node_modules', '@tradeloom', 'dsh-business-shell')
    await mkdir(dirname(targetShell), { recursive: true })
    const shellFixture = await mkdtemp(join(ownedRoot, 'rep12-shell-source-'))
    assert.equal(dirname(await realpath(shellFixture)), root)
    t.after(async () => {
      const current = await realpath(shellFixture).catch(() => undefined)
      if (current && dirname(current) === root) await rm(current, { recursive: true, force: true })
    })
    await copyFile(fileURLToPath(new URL('../tool-policy.js', import.meta.url)), join(shellFixture, 'tool-policy.js'))
    await writeFile(join(shellFixture, 'package.json'), JSON.stringify({ name: '@tradeloom/dsh-business-shell', type: 'module', exports: {
      './tool-policy': './tool-policy.js',
    } }))
    const scopeTarget = join(shellFixture, 'node_modules', '@deepseek-ai', 'dsh-scope')
    await mkdir(dirname(scopeTarget), { recursive: true })
    await symlink(join(rt.base, 'packages', 'core', 'scope'), scopeTarget, 'junction')
    const currentToolPolicy = await readFile(resolve(process.cwd(), 'packages', 'tradeloom-shell', 'tool-policy.js'))
    const fixtureToolPolicy = await readFile(join(shellFixture, 'tool-policy.js'))
    assert.equal(createHash('sha256').update(fixtureToolPolicy).digest('hex'), createHash('sha256').update(currentToolPolicy).digest('hex'),
      'owned plugin fixture must contain the exact current tool-policy source bytes')
    await symlink(shellFixture, targetShell, 'junction')
    const skillTarget = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem')
    await mkdir(dirname(skillTarget), { recursive: true })
    await symlink(join(rt.base, 'packages', 'skill', 'skill-filesystem'), skillTarget, 'junction')
  }
  const managedPlugins = realPreset ? [
    { id: 'tradeloom-skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      providerName: 'tradeloom-center-skills', includeDefaultRoots: false, customSkillDirs: [],
    } },
    { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
  ] : [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep' } },
    { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: ['search_web'] } },
  ]
  const rows = [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'center-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: ROLE_PRESETS.center, plugins: managedPlugins } },
  ]
  await writeFile(join(bundle, 'cordis.patch.yml'), `${JSON.stringify([{ insert: rows }], null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  const profile = { name: 'tradeloom', startedBundles: ['test-bundle', '@tradeloom/dsh-business-shell'], dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [] }
  context = await rt.boot('dsh', join(profileDir, 'cordis.yml'), rt.readProfilePatches('dsh', profile), async owner => {
    owner.provide('profileContext', profile)
    owner.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    Object.assign(owner.loader.builtins, { include: rt.Include, editor: rt.ConfigEditor })
    if (realPreset) {
      await owner.plugin(rt.llm.default)
      await owner.plugin(rt.sessions.default)
      await owner.plugin(rt.projections.default)
      await owner.plugin(rt.skills.default)
      await owner.plugin(rt.systemPrompt.default, { personaPrefix: '' })
      await owner.plugin(rt.tools.default)
      await owner.plugin(rt.agents.default)
      await owner.plugin(rt.fsLocal.default, { cwd: home })
      await owner.plugin(rt.workingDirectory.default, { defaultDirectory: home })
      await owner.plugin(rt.agentLoop.default, { agents: [] })
      owner.provide('settings', { root: home, configure: () => () => {} })
      await owner.plugin(rt.AgentPresetRegistry, { default: ROLE_PRESETS.center })
    }
  })
  return { home, profile, ctx: context, presetPackage }
}

function req(method, url, value) {
  const chunks = value === undefined ? [] : [Buffer.from(JSON.stringify(value))]
  const request = Readable.from(chunks)
  request.method = method
  request.url = url
  return request
}

import { Readable } from 'node:stream'

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
}

async function invoke(handler, method, url, value) {
  const res = response()
  await handler(req(method, url, value), res)
  return { status: res.statusCode, value: res.body ? JSON.parse(res.body) : undefined }
}

test('real rep12 ConfigEditor snapshot restores managed config on disk for future agents only', async t => {
  const rt = await runtime()
  const setup = await ownedRuntimeProfile(t, rt)
  const env = { SNAPSHOT_RUNTIME_TOKEN: 'synthetic-runtime-secret' }
  const apiCtx = {
    connection: { requestRejection: () => undefined },
    agents: setup.ctx.agents,
    tools: { schemas: () => [{ name: 'search_web' }] },
    effect: setup.ctx.effect.bind(setup.ctx),
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id } } }
      return setup.ctx.get(name)
    },
  }
  const dependencies = {
    resolveOwnedHome: async () => setup.home, env, toolNames: ['search_web'],
    async roleWorkspacePath(role) { const path = join(setup.home, 'tradeloom-workspaces', role); await mkdir(path, { recursive: true }); return path },
    roleWorkspacePathReadOnly(role) { return join(setup.home, 'tradeloom-workspaces', role) },
  }
  const resources = createAgentConfigurationResources(apiCtx, dependencies)
  const configHandler = resources.configurationHandler
  const snapshotHandler = createAgentConfigurationSnapshotsHandler(apiCtx, { ...dependencies, snapshotOperations: resources.snapshotOperations })
  const before = await invoke(configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  assert.equal(before.status, 200, JSON.stringify(before.value))
  const editor = setup.ctx.get('configEditor')
  assert.ok(editor, 'official rep12 ConfigEditor is loaded')
  const presetEntry = editor.entries().find(entry => entry.options.id === 'center-preset')
  assert.ok(presetEntry)
  const originalUnmanaged = structuredClone(presetEntry.options.config.plugins[0])
  const captured = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', { action: 'capture', role: 'center' })
  assert.equal(captured.status, 201, JSON.stringify(captured.value))
  const updated = await invoke(configHandler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.value.revision, mcpServers: [], skill: before.value.skill, deniedTools: [],
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.value))
  assert.deepEqual(editor.entries().find(entry => entry.options.id === 'center-preset').options.config.plugins[0], originalUnmanaged)
  const preview = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'preview', role: 'center', snapshotId: captured.value.snapshot.snapshotId,
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.value))
  assert.equal(preview.value.applicable, true)
  const restored = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'restore', role: 'center', previewId: preview.value.previewId,
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.value))
  assert.equal(restored.value.appliedForNewAgents, true)
  assert.equal(restored.value.currentSessionUnchanged, true)
  const after = await invoke(configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  assert.deepEqual(after.value.deniedTools, ['search_web'])
  assert.equal(after.value.revision, restored.value.revision)
  assert.notEqual(after.value.revision, captured.value.snapshot.sourceRevision)
  assert.deepEqual(setup.ctx.get('preset-config').plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools, ['search_web'],
    'the real Loader-applied preset reflects the restored managed config')
  const text = await readFile(setup.profile.patchPath, 'utf8')
  assert.match(text, /search_web/)
  assert.equal(text.includes(env.SNAPSHOT_RUNTIME_TOKEN), false)
  const pending = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'preview', role: 'center', snapshotId: captured.value.snapshot.snapshotId,
  })
  assert.equal(pending.status, 200)
  await setup.ctx.fiber.dispose()
  const disposed = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'restore', role: 'center', previewId: pending.value.previewId,
  })
  assert.equal(disposed.status, 503)
  assert.equal(disposed.value.error, 'snapshot-handler-closed')
})

test('real rep12 preset registry and new Agents enforce restored tool policy without touching the existing session', async t => {
  const rt = await runtime()
  const setup = await ownedRuntimeProfile(t, rt, { realPreset: true })
  const ctx = setup.ctx
  let modelRequests = 0
  let probeCalls = 0
  class NoRequestAdapter extends rt.llm.LlmAdapter {
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() { modelRequests += 1; throw new Error('model request must not start in this test') }
  }
  ctx.llm.registerAdapter(['snapshot-no-call'], new NoRequestAdapter())
  const unregisterProbe = ctx.tools.register({
    name: 'snapshot_probe', description: 'owned deterministic test probe', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { probeCalls += 1; return 'probe executed' },
  })
  t.after(() => unregisterProbe())
  const registry = ctx.get('agentPresets')
  assert.ok(registry, 'the rep12 AgentPresetRegistry is mounted')
  const resolved = await registry.resolve(ROLE_PRESETS.center)
  assert.equal(resolved.id, ROLE_PRESETS.center)
  assert.equal(resolved.broken, undefined)

  const apiCtx = {
    connection: { requestRejection: () => undefined },
    agents: ctx.agents,
    tools: { schemas: () => ctx.tools.schemas() },
    effect: ctx.effect.bind(ctx),
    get(name) { return ctx.get(name) },
  }
  const env = {}
  const dependencies = {
    resolveOwnedHome: async () => setup.home,
    env,
    toolNames: ['snapshot_probe'],
    async roleWorkspacePath(role) { const path = join(setup.home, 'tradeloom-workspaces', role); await mkdir(path, { recursive: true }); return path },
    roleWorkspacePathReadOnly(role) { return join(setup.home, 'tradeloom-workspaces', role) },
  }
  const resources = createAgentConfigurationResources(apiCtx, dependencies)
  const configHandler = resources.configurationHandler
  const snapshotHandler = createAgentConfigurationSnapshotsHandler(apiCtx, { ...dependencies, snapshotOperations: resources.snapshotOperations })
  const before = await invoke(configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  assert.equal(before.status, 200, JSON.stringify(before.value))
  const presetEntries = ctx.get('configEditor').entries().filter(entry => entry.options.config?.id === ROLE_PRESETS.center)
  const presetDiagnostics = presetEntries.map(entry => {
    const skillConfig = entry.options.config.plugins.find(row => row.id === 'tradeloom-skill-filesystem')?.config
    return { id: entry.options.id, name: entry.options.name, skillRowPresent: Boolean(skillConfig),
      skillConfigKeys: skillConfig && typeof skillConfig === 'object' ? Object.keys(skillConfig).sort() : [],
      includeDefaultRoots: skillConfig?.includeDefaultRoots === false ? false : skillConfig?.includeDefaultRoots === true ? true : null,
      customSkillDirsCount: Array.isArray(skillConfig?.customSkillDirs) ? skillConfig.customSkillDirs.length : null }
  })
  const allRows = presetEntries[0]?.options.config.plugins ?? []
  console.log(JSON.stringify({ phase: 'real-preset-owned-skill-config', editable: before.value.editable,
    projectedIncludeDefaultRoots: before.value.skill.includeDefaultRoots, presetEntries: presetDiagnostics,
    pluginRows: allRows.map(row => ({ id: row.id, name: row.name, keys: Object.keys(row).sort(),
      configKeys: row.config && typeof row.config === 'object' ? Object.keys(row.config).sort() : [],
      providerMatchesRole: row.id === 'tradeloom-skill-filesystem' && row.config.providerName === 'tradeloom-center-skills',
      deniedToolsArray: row.id === 'tradeloom-tool-policy' && Array.isArray(row.config.deniedTools) })) }))
  assert.deepEqual(before.value.deniedTools, [])
  assert.deepEqual(before.value.skill, { includeDefaultRoots: false, customSkillDirs: [] })
  const captured = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', { action: 'capture', role: 'center' })
  assert.equal(captured.status, 201, JSON.stringify(captured.value))

  const workspace = join(setup.home, 'rep12-agent-workspace')
  await mkdir(workspace, { recursive: true })
  const createAgent = async label => {
    const agent = await ctx.agentLoop.create(rt.sessions.SessionId(`n03-config-${label}`),
      { provider: 'snapshot-no-call', model: 'no-call-model' }, { cwd: workspace, agentPreset: ROLE_PRESETS.center })
    await registry.mount(agent.ctx, ROLE_PRESETS.center)
    return agent
  }
  const existingAgent = await createAgent('existing')
  const existingId = existingAgent.session.id
  const existingSession = existingAgent.session
  const existingMessages = []
  existingAgent.ctx.on('session/event', (session, event) => {
    if (session.id === existingId && (event.type === 'user/message' || event.type === 'assistant/message')) existingMessages.push(event.type)
  })
  assert.strictEqual(ctx.agents.get(existingId), existingAgent)

  const denied = await invoke(configHandler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.value.revision, mcpServers: [], skill: before.value.skill, deniedTools: ['snapshot_probe'],
  })
  assert.equal(denied.status, 200, JSON.stringify(denied.value))
  const deniedAgent = await createAgent('denied')
  assert.strictEqual(ctx.tools.get('snapshot_probe', deniedAgent)?.name, 'snapshot_probe')
  assert.ok(ctx.tools.schemas(deniedAgent).some(schema => schema.name === 'snapshot_probe'),
    'rep12 guard controls execution; it does not remove schemas/get results')
  const deniedResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: rt.llm.ToolCallId('snapshot-policy-denied'), name: 'snapshot_probe', arguments: {}, agent: deniedAgent })
  assert.equal(deniedResult.isError, true)
  assert.deepEqual(deniedResult.content, [{ type: 'text', text: 'Error: This tool is disabled for this TradeLoom assistant.' }],
    'the actual rep12 tools/pre-execute guard returns the managed policy denial')
  assert.equal(probeCalls, 0, 'the actual rep12 preset guard blocks the probe before its body')

  const preview = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'preview', role: 'center', snapshotId: captured.value.snapshot.snapshotId,
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.value))
  assert.equal(preview.value.applicable, true)
  const restored = await invoke(snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'restore', role: 'center', previewId: preview.value.previewId,
  })
  assert.equal(restored.status, 200, JSON.stringify(restored.value))
  assert.equal(restored.value.appliedForNewAgents, true)
  assert.deepEqual((await registry.resolve(ROLE_PRESETS.center)).broken, undefined)

  const newAgent = await createAgent('restored')
  assert.strictEqual(ctx.tools.get('snapshot_probe', newAgent)?.name, 'snapshot_probe')
  assert.ok(ctx.tools.schemas(newAgent).some(schema => schema.name === 'snapshot_probe'))
  const allowedResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: rt.llm.ToolCallId('snapshot-policy-restored'), name: 'snapshot_probe', arguments: {}, agent: newAgent })
  assert.equal(allowedResult.isError, false)
  assert.equal(probeCalls, 1, 'a new real Agent receives restored policy and executes the local probe once')
  assert.equal(modelRequests, 0, 'no Agent turn or model request was started')
  assert.strictEqual(ctx.agents.get(existingId), existingAgent)
  assert.strictEqual(existingAgent.session, existingSession)
  assert.deepEqual(existingMessages, [], 'the pre-existing Agent session received no replacement or new messages')
})
