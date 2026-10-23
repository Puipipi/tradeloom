import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import { createAgentConfigurationHandler } from '../agent-configuration.js'
import { createNewSessionHandler } from '../host.js'
import { ROLE_PRESETS } from '../roles.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

const evidenceRoot = fileURLToPath(new URL('../../../../workspace/testing/agent-capability-configuration-20261023/', import.meta.url))

async function runtime(t) {
  const base = process.env.TRADELOOM_DSH_PINNED_SOURCE
  if (!base) { t.skip('requires pinned compiled DSH runtime') ; return undefined }
  const importDsh = relative => import(pathToFileURL(resolve(base, relative)).href)
  const [{ boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Include }] = await Promise.all([
    importDsh('packages/boot/app-boot/lib/index.js'),
    importDsh('packages/boot/config-editor/lib/index.js'),
    importDsh('vendor/include/lib/index.js'),
  ])
  return { base, importDsh, boot, initProfile, readProfilePatches, ConfigEditor, Include }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function ownedProfile(t, rt, { rows, builtins, links = [], prepareHost }) {
  const home = await mkdtemp(join(evidenceRoot, 'runtime-profile-'))
  const audit = await realpath(evidenceRoot)
  const safeHome = await realpath(home)
  assert.equal(dirname(safeHome), audit, 'runtime profile is created directly beneath the isolated test root')
  let ctx
  t.after(async () => {
    if (ctx) await ctx.fiber.dispose()
    const current = await realpath(home).catch(() => undefined)
    if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
  })
  const profileDir = join(home, 'profiles', 'tradeloom')
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  rt.initProfile(profileDir, ['test-bundle'])
  const bundle = join(profileDir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  for (const link of links) {
    const target = join(profileDir, 'node_modules', ...link.name.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await symlink(link.path, target, 'junction')
  }
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'isolated-agent-config-test' }) + '\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), `${JSON.stringify([{ insert: rows }], null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'tradeloom', startedBundles: ['test-bundle', '@tradeloom/dsh-business-shell'], dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx = await rt.boot('dsh', join(profileDir, 'cordis.yml'), rt.readProfilePatches('dsh', profile), async owner => {
    owner.provide('profileContext', profile)
    owner.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    Object.assign(owner.loader.builtins, { include: rt.Include, editor: rt.ConfigEditor, ...builtins })
    await prepareHost?.(owner, { home, profile })
  })
  return { home, profile, ctx }
}

test('official Loader and ConfigEditor edit the isolated profile patch and reconcile runtime state', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const schema = await rt.importDsh('vendor/schemastery/lib/index.mjs').then(module => module.default)
  let applied
  const Probe = {
    Config: schema.object({ value: schema.string().required(), retained: schema.string().required() }),
    apply(_ctx, config) { applied = structuredClone(config) },
  }
  const { profile, ctx } = await ownedProfile(t, rt, {
    rows: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'probe', name: 'cordis:probe', config: { value: 'before', retained: 'keep' } },
    ],
    builtins: { probe: Probe },
  })
  const editor = ctx.get('configEditor')
  assert.ok(editor, 'the real ConfigEditor plugin is active in the booted Loader')
  const entry = editor.entries().find(candidate => candidate.options.id === 'probe')
  assert.ok(entry, 'the probe entry is owned by the isolated profile include tree')
  assert.equal(applied.value, 'before')
  await editor.edit(entry, current => ({ ...current, value: 'after' }))
  assert.deepEqual(applied, { value: 'after', retained: 'keep' }, 'ConfigEditor reconciles the live Loader plugin')
  const currentEntry = editor.entries().find(candidate => candidate.options.id === 'probe')
  assert.equal(currentEntry.options.config.value, 'after')
  assert.equal(currentEntry.options.config.retained, 'keep')
  const text = await readFile(profile.patchPath, 'utf8')
  assert.match(text, /value:\s*after/)
  assert.match(text, /retained:\s*keep/)
})

test('compiled DSH MCP client executes real synthetic stdio and Streamable HTTP ping tools', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const [{ Context }, { default: ToolRuntime }, { default: SystemPrompt }, mcpClient] = await Promise.all([
    rt.importDsh('vendor/cordis/lib/index.js'),
    rt.importDsh('packages/core/tools/lib/index.js'),
    rt.importDsh('packages/core/system-prompt/lib/index.js'),
    rt.importDsh('packages/mcp/mcp-client/lib/index.js'),
  ])
  const clientRequire = createRequire(join(rt.base, 'packages', 'mcp', 'mcp-client', 'package.json'))
  const { createMcpHandler, McpServer } = clientRequire('@modelcontextprotocol/server')
  const { toNodeHandler } = clientRequire('@modelcontextprotocol/node')
  const { z } = clientRequire('zod')
  const httpCalls = []
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'tradeloom-runtime-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('ping', { description: 'synthetic no-op ping', inputSchema: z.object({}) }, async () => {
      httpCalls.push('ping')
      return { content: [{ type: 'text', text: 'pong-http' }] }
    })
    return server
  })
  const serveHttp = toNodeHandler(handler)
  const httpServer = createServer((request, response) => { void serveHttp(request, response) })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const address = httpServer.address()
  assert.ok(address && typeof address === 'object')
  const httpCtx = new Context()
  await httpCtx.plugin(SystemPrompt, { personaPrefix: '' })
  await httpCtx.plugin(ToolRuntime)
  t.after(async () => { await httpCtx.fiber.dispose() })
  t.after(async () => {
    await handler.close()
    if (httpServer.listening) await new Promise(resolveClose => httpServer.close(resolveClose))
  })
  await httpCtx.plugin(mcpClient, {
    transport: 'streamable-http', serverName: 'synthetic_http', url: `http://127.0.0.1:${address.port}/mcp`,
    headers: {}, toolCallTimeoutMs: 5000, failOnStartupError: true, reconnect: { enabled: false },
  })
  const httpResult = await httpCtx.get('tools').execute({
    callId: 'runtime-http-ping', signal: new AbortController().signal,
    name: 'mcp__synthetic_http__ping', arguments: {},
  })
  assert.equal(httpResult.content[0]?.text, 'pong-http')
  assert.deepEqual(httpCalls, ['ping'], 'the real DSH client called the loopback MCP server exactly once')

  const fixtureDir = await mkdtemp(join(evidenceRoot, 'runtime-stdio-'))
  const audit = await realpath(evidenceRoot)
  assert.equal(dirname(await realpath(fixtureDir)), audit)
  const stdioServerPath = join(fixtureDir, 'stdio-mcp-server.cjs')
  const serverModule = clientRequire.resolve('@modelcontextprotocol/server')
  const stdioModule = clientRequire.resolve('@modelcontextprotocol/server/stdio')
  const zodModule = clientRequire.resolve('zod')
  await writeFile(stdioServerPath, `
const { McpServer } = require(${JSON.stringify(serverModule)})
const { StdioServerTransport } = require(${JSON.stringify(stdioModule)})
const { z } = require(${JSON.stringify(zodModule)})
const server = new McpServer({ name: 'tradeloom-runtime-stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.registerTool('ping', { description: 'synthetic no-op ping', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong-stdio' }] }))
void server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1 })
`)
  const stdioCtx = new Context()
  await stdioCtx.plugin(SystemPrompt, { personaPrefix: '' })
  await stdioCtx.plugin(ToolRuntime)
  t.after(async () => { await stdioCtx.fiber.dispose() })
  t.after(async () => {
    const current = await realpath(fixtureDir).catch(() => undefined)
    if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
  })
  await withTimeout(stdioCtx.plugin(mcpClient, {
    transport: 'stdio', serverName: 'synthetic_stdio', command: process.execPath,
    args: [stdioServerPath], env: {}, cwd: fixtureDir, toolCallTimeoutMs: 5000,
    failOnStartupError: true, reconnect: { enabled: false },
  }), 10000, 'synthetic stdio startup')
  const stdioResult = await stdioCtx.get('tools').execute({
    callId: 'runtime-stdio-ping', signal: new AbortController().signal,
    name: 'mcp__synthetic_stdio__ping', arguments: {},
  })
  assert.equal(stdioResult.content[0]?.text, 'pong-stdio')
})

test('real AgentLoop Agents inherit preset-scoped guards and keep the prior generation alive', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const [{ Context }, { default: Loader }, { default: Group }, { default: AgentPresetRegistry }, testkit, { default: SkillRegistry }, skillFilesystem, { scopeOf }, { createScopedToolPolicy }] = await Promise.all([
    rt.importDsh('vendor/cordis/lib/index.js'),
    rt.importDsh('vendor/loader/lib/index.js'),
    rt.importDsh('vendor/group/lib/index.js'),
    rt.importDsh('packages/preset/agent-preset-registry/lib/index.js'),
    rt.importDsh('packages/test-support/agent-loop-testkit/lib/index.js'),
    rt.importDsh('packages/skill/skill/lib/index.js'),
    rt.importDsh('packages/skill/skill-filesystem/lib/index.js'),
    rt.importDsh('packages/core/scope/lib/index.js'),
    import('../tool-policy.js'),
  ])
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SkillRegistry)
  const skillRoot = await mkdtemp(join(evidenceRoot, 'runtime-agent-skills-'))
  const audit = await realpath(evidenceRoot)
  assert.equal(dirname(await realpath(skillRoot)), audit)
  t.after(async () => {
    const current = await realpath(skillRoot).catch(() => undefined)
    if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
  })
  const oldSkillDir = join(skillRoot, 'old')
  const newSkillDir = join(skillRoot, 'new')
  await mkdir(join(oldSkillDir, 'old-skill'), { recursive: true })
  await mkdir(join(newSkillDir, 'new-skill'), { recursive: true })
  await writeFile(join(oldSkillDir, 'old-skill', 'SKILL.md'), '---\nname: old-skill\ndescription: synthetic old generation skill\n---\nold')
  await writeFile(join(newSkillDir, 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: synthetic new generation skill\n---\nnew')
  ctx.loader.builtins['tradeloom-policy'] = {
    inject: ['tools'],
    apply(owner, config) { return createScopedToolPolicy(owner, config, scopeOf) },
  }
  ctx.loader.builtins['skill-filesystem'] = skillFilesystem
  await ctx.plugin(AgentPresetRegistry, { default: 'task3-old' })
  const loop = await testkit.mountAgentLoopTestHarness(ctx)
  let bodyCalls = 0
  ctx.tools.register({
    name: 'synthetic-protected', description: 'synthetic tool used to verify preset scope',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { bodyCalls += 1; return Promise.resolve('ran') },
  })
  const presets = ctx.get('agentPresets')
  const skillsRow = (root, role) => ({ id: 'skills', name: 'cordis:skill-filesystem', config: {
    providerName: `task3-${role}-skills`, includeDefaultRoots: false, customSkillDirs: [root], watch: false,
  } })
  await presets.register({ id: 'task3-old', plugins: [
    { id: 'policy', name: 'cordis:tradeloom-policy', config: { deniedTools: ['synthetic-protected'] } },
    skillsRow(oldSkillDir, 'old'),
  ] })
  await presets.register({ id: 'task3-new', plugins: [
    { id: 'policy', name: 'cordis:tradeloom-policy', config: { deniedTools: [] } },
    skillsRow(newSkillDir, 'new'),
  ] })
  const oldHandle = await ctx.agents.create({ sessionId: 'task3-old-agent', setup: async agentCtx => { await presets.mount(agentCtx, 'task3-old') } })
  const newHandle = await ctx.agents.create({ sessionId: 'task3-new-agent', setup: async agentCtx => { await presets.mount(agentCtx, 'task3-new') } })
  t.after(async () => { await oldHandle.dispose(); await newHandle.dispose() })
  const oldAgent = oldHandle.agent
  const newAgent = newHandle.agent
  const run = agent => ctx.tools.execute({
    callId: `call-${agent.id}`, signal: new AbortController().signal,
    name: 'synthetic-protected', arguments: {}, agent,
  })
  const denied = await run(oldAgent)
  assert.equal(denied?.isError, true, 'the old Agent receives the scoped policy denial')
  assert.equal(bodyCalls, 0, 'the old Agent is denied before tool execution')
  const allowed = await run(newAgent)
  assert.equal(allowed?.value, 'ran', 'the other real Agent generation remains unaffected')
  assert.equal(bodyCalls, 1)
  assert.equal(presets.composedPreset(oldAgent.ctx), 'task3-old')
  assert.equal(presets.composedPreset(newAgent.ctx), 'task3-new')
  const skillRegistry = ctx.get('skills')
  const oldSkills = await skillRegistry.snapshot({ cwd: skillRoot, scope: oldAgent })
  const newSkills = await skillRegistry.snapshot({ cwd: skillRoot, scope: newAgent })
  assert.deepEqual(oldSkills.skills.map(skill => skill.name), ['old-skill'])
  assert.deepEqual(newSkills.skills.map(skill => skill.name), ['new-skill'])
})

test('configuration API round-trips a canonical env reference through the real ConfigEditor', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const env = { TASK3_RUNTIME_TOKEN: 'synthetic-secret-value' }
  const presetPackage = await mkdtemp(join(evidenceRoot, 'runtime-preset-probe-'))
  const audit = await realpath(evidenceRoot)
  assert.equal(dirname(await realpath(presetPackage)), audit)
  t.after(async () => {
    const current = await realpath(presetPackage).catch(() => undefined)
    if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
  })
  const schemaUrl = pathToFileURL(join(rt.base, 'vendor', 'schemastery', 'lib', 'index.mjs')).href
  await writeFile(join(presetPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-preset', type: 'module', main: 'index.js' }))
  await writeFile(join(presetPackage, 'index.js'), `import schema from ${JSON.stringify(schemaUrl)}\nexport default { Config: schema.object({ id: schema.string().required(), name: schema.string(), description: schema.string(), order: schema.number(), plugins: schema.array(schema.any()).required() }), apply(ctx, config) { ctx.provide('preset-config', config) } }\n`)
  const setup = await ownedProfile(t, rt, {
    rows: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'center-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: ROLE_PRESETS.center, plugins: [] } },
    ],
    links: [
      { name: '@deepseek-ai/dsh-agent-preset', path: presetPackage },
    ],
  })
  const apiCtx = {
    connection: { requestRejection: () => undefined },
    agents: setup.ctx.agents,
    tools: { schemas: () => [] },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id } } }
      return setup.ctx.get(name)
    },
  }
  const editor = setup.ctx.get('configEditor')
  const handler = createAgentConfigurationHandler(apiCtx, {
    resolveOwnedHome: async () => setup.home, env,
    async roleWorkspacePath(role) {
      const path = join(setup.home, 'tradeloom-workspaces', role)
      await mkdir(path, { recursive: true })
      return path
    },
  })
  const invoke = async (method, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = '/tradeloom/agent-configuration?role=center'
    const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
    await handler(req, res)
    return { status: res.statusCode, value: res.body ? JSON.parse(res.body) : undefined }
  }
  const before = await invoke('GET')
  assert.equal(before.status, 200)
  const saved = await invoke('PUT', {
    expectedRevision: before.value.revision,
    mcpServers: [{
      id: 'tradeloom-mcp-runtime', transport: 'streamable-http', serverName: 'runtime',
      toolCallTimeoutMs: 5000, failOnStartupError: true, url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: { envName: 'TASK3_RUNTIME_TOKEN', scheme: 'bearer' } },
    }],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.value))
  assert.equal(saved.value.appliedForNewAgents, true)
  const updatedEntry = editor.entries().find(entry => entry.options.id === 'center-preset')
  assert.ok(updatedEntry)
  assert.equal(updatedEntry.options.config.plugins.find(row => row.id === 'tradeloom-mcp-runtime').config.headers.Authorization.__jsExpr,
    '"Bearer " + process.env["TASK3_RUNTIME_TOKEN"]')
  const after = await invoke('GET')
  assert.equal(after.status, 200)
  assert.equal(after.value.mcpServers[0].headers.Authorization.envName, 'TASK3_RUNTIME_TOKEN')
  assert.equal(after.value.mcpServers[0].headers.Authorization.scheme, 'bearer')
  assert.equal(after.value.mcpServers[0].headers.Authorization.present, true)
  assert.equal(JSON.stringify(after.value).includes(env.TASK3_RUNTIME_TOKEN), false)
})

test('ConfigEditor updates a real preset for new Agents while the old Agent keeps its generation', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const [{ default: Group }, testkit] = await Promise.all([
    rt.importDsh('vendor/group/lib/index.js'),
    rt.importDsh('packages/test-support/agent-loop-testkit/lib/index.js'),
  ])
  const policyPackage = await mkdtemp(join(evidenceRoot, 'runtime-policy-package-'))
  const audit = await realpath(evidenceRoot)
  assert.equal(dirname(await realpath(policyPackage)), audit)
  t.after(async () => {
    const current = await realpath(policyPackage).catch(() => undefined)
    if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
  })
  const policyUrl = pathToFileURL(fileURLToPath(new URL('../tool-policy.js', import.meta.url))).href
  const scopeUrl = pathToFileURL(join(rt.base, 'packages', 'core', 'scope', 'lib', 'index.js')).href
  await writeFile(join(policyPackage, 'package.json'), JSON.stringify({
    name: '@tradeloom/dsh-business-shell', type: 'module',
    exports: { './tool-policy': './tool-policy.js' },
  }))
  await writeFile(join(policyPackage, 'tool-policy.js'), `import { createScopedToolPolicy } from ${JSON.stringify(policyUrl)}\nimport { scopeOf } from ${JSON.stringify(scopeUrl)}\nexport const name='@tradeloom/dsh-business-shell/tool-policy'; export const inject=['tools']; export function apply(ctx,config){ return createScopedToolPolicy(ctx,config,scopeOf) }\n`)
  const { default: SkillRegistry } = await rt.importDsh('packages/skill/skill/lib/index.js')
  const { profile, ctx } = await ownedProfile(t, rt, {
    rows: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: ROLE_PRESETS.center } },
      { id: 'center-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: ROLE_PRESETS.center, plugins: [
        { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: ['synthetic-protected'] } },
      ] } },
    ],
    links: [
      { name: '@deepseek-ai/dsh-agent-preset-registry', path: join(rt.base, 'packages', 'preset', 'agent-preset-registry') },
      { name: '@deepseek-ai/dsh-agent-preset', path: join(rt.base, 'packages', 'preset', 'agent-preset') },
      { name: '@deepseek-ai/dsh-skill-filesystem', path: join(rt.base, 'packages', 'skill', 'skill-filesystem') },
      { name: '@tradeloom/dsh-business-shell', path: policyPackage },
    ],
    prepareHost: async (owner, { home }) => {
      owner.loader.builtins.group = Group
      await owner.plugin(SkillRegistry)
      await testkit.mountAgentLoopTestDependencies(owner)
      await testkit.mountAgentLoopTestHarness(owner)
    },
  })
  let bodyCalls = 0
  ctx.tools.register({
    name: 'synthetic-protected', description: 'synthetic tool for real preset generation test',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { bodyCalls += 1; return Promise.resolve('ran') },
  })
  const presets = ctx.get('agentPresets')
  const oldHandle = await ctx.agents.create({ sessionId: 'task3-generation-old', setup: async agentCtx => { await presets.mount(agentCtx, ROLE_PRESETS.center) } })
  t.after(async () => { await oldHandle.dispose() })
  const run = agent => ctx.tools.execute({
    callId: `generation-${agent.id}`, signal: new AbortController().signal,
    name: 'synthetic-protected', arguments: {}, agent,
  })
  assert.equal((await run(oldHandle.agent))?.isError, true)
  assert.equal(bodyCalls, 0)
  const apiCtx = { connection: { requestRejection: () => undefined }, agents: ctx.agents, tools: ctx.tools, get: ctx.get.bind(ctx) }
  const handler = createAgentConfigurationHandler(apiCtx, {
    resolveOwnedHome: async () => profile.home, toolNames: ['synthetic-protected'], env: {},
    async roleWorkspacePath(role) {
      const path = join(profile.home, 'tradeloom-workspaces', role)
      await mkdir(path, { recursive: true })
      return path
    },
  })
  const invoke = async (method, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method; req.url = '/tradeloom/agent-configuration?role=center'
    const res = { statusCode: 200, body: '', setHeader() {}, end(value = '') { this.body = value } }
    await handler(req, res)
    return { status: res.statusCode, value: res.body ? JSON.parse(res.body) : undefined }
  }
  const before = await invoke('GET')
  assert.equal(before.status, 200)
  const saved = await invoke('PUT', {
    expectedRevision: before.value.revision, mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.value))
  assert.equal(saved.value.appliedForNewAgents, true)
  assert.equal((await run(oldHandle.agent))?.isError, true, 'the already-running Agent retains the prior policy generation')
  assert.equal(bodyCalls, 0)
  const newHandle = await ctx.agents.create({ sessionId: 'task3-generation-new', setup: async agentCtx => { await presets.mount(agentCtx, ROLE_PRESETS.center) } })
  t.after(async () => { await newHandle.dispose() })
  assert.equal((await run(newHandle.agent))?.value, 'ran', 'a new real Agent receives the updated configuration')
  assert.equal(bodyCalls, 1)
})

test('new-session route creates through official SessionController and replays its persisted binding', async t => {
  const rt = await runtime(t)
  if (!rt) return
  const [{ default: Group }, { default: SessionController }, { default: SessionQueryEngine }, { default: WorkspaceRegistry }, { default: Storage }, { JsonStorageBackend }, { DomainFacility }, testkit] = await Promise.all([
    rt.importDsh('vendor/group/lib/index.js'),
    rt.importDsh('packages/api/session-controller/lib/index.js'),
    rt.importDsh('packages/session-query/session-query/lib/index.js'),
    rt.importDsh('packages/workspace/workspace/lib/index.js'),
    rt.importDsh('packages/storage/storage/lib/index.js'),
    rt.importDsh('packages/storage/storage-json/lib/index.js'),
    rt.importDsh('packages/storage/storage-domain/lib/index.js'),
    rt.importDsh('packages/test-support/agent-loop-testkit/lib/index.js'),
  ])
  const audit = await realpath(evidenceRoot)
  const { home, profile, ctx } = await ownedProfile(t, rt, {
    rows: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: ROLE_PRESETS.center } },
      { id: 'center-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: ROLE_PRESETS.center, plugins: [] } },
    ],
    links: [
      { name: '@deepseek-ai/dsh-agent-preset-registry', path: join(rt.base, 'packages', 'preset', 'agent-preset-registry') },
      { name: '@deepseek-ai/dsh-agent-preset', path: join(rt.base, 'packages', 'preset', 'agent-preset') },
    ],
    prepareHost: async (owner, { home }) => {
      owner.loader.builtins.group = Group
      await testkit.mountAgentLoopTestDependencies(owner, { workingDirectory: true })
      await testkit.mountAgentLoopTestHarness(owner)
      const backend = new JsonStorageBackend(join(home, 'runtime-storage'))
      await owner.plugin(Storage)
      owner.storage.backend.register('task3-json', backend)
      owner.effect(() => async () => backend.close(), 'task3-storage-close')
      const facility = new DomainFacility(owner, { backend: 'task3-json', routes: {} })
      owner.storage.mount('domain', facility)
      owner.provide('storageDomain', facility)
      const persistedSessions = new Map()
      owner.provide('sessionPersistence', {
        async list() { return [...persistedSessions.values()].map(record => ({ header: record.header, revision: `runtime-${record.header.id}` })) },
        async create(header) {
          const record = { header: structuredClone(header), events: [] }
          persistedSessions.set(header.id, record)
          return {
            async append(events) { record.events.push(...structuredClone(events)) },
            async close() {},
          }
        },
        async open(sessionId) {
          const record = persistedSessions.get(sessionId)
          if (!record) return undefined
          return { header: record.header, events: [...record.events], revision: `runtime-${sessionId}`, async close() {} }
        },
        async stat(sessionId) { return persistedSessions.has(sessionId) ? { header: persistedSessions.get(sessionId).header, revision: `runtime-${sessionId}` } : undefined },
      })
      await owner.plugin(WorkspaceRegistry)
      await owner.plugin(SessionQueryEngine)
      owner.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'synthetic' }), saveSelection: async () => {} })
      owner.provide('attachments', { imageLimits: {
        maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024,
        maxImageDimension: 32, maxImageBytes: 1024, mediaTypes: ['image/png'],
      } })
      owner.provide('fileUploads', { registerAgentResolver: () => () => {} })
      owner.provide('remoteAccess', { allows: () => true })
      owner.provide('fileReferences', { list: async () => [] })
      owner.provide('connection', { fetch: { register: () => () => {} } })
      owner.provide('typert', {
        resources: { register() {} },
        lookups: { configure() {} },
        contexts: { configureHost() {} },
      })
      await owner.plugin(SessionController, { nativeOpen: false })
    },
  })
  const workspacePath = join(home, 'tradeloom-workspaces', 'center')
  await mkdir(workspacePath, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(workspacePath, 'synthetic center workspace')
  const previous = await ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: ROLE_PRESETS.center, sessionId: 'task3-old-bound-session' })
  const oldBefore = await ctx.sessionQuery.observeSession(previous.sessionId)
  const oldHeader = structuredClone(oldBefore.header)
  const oldEventCount = oldBefore.events.length
  oldBefore[Symbol.dispose]()
  const state = { roles: { center: { workspaceId: workspace.id, workspacePath, sessionId: previous.sessionId, agentPreset: ROLE_PRESETS.center } } }
  const store = {
    async read() { return structuredClone(state) },
    async transact(operation) { return await operation(state) },
  }
  const handler = createNewSessionHandler({
    connection: { requestRejection: () => undefined },
    workspaceRegistry: ctx.workspaceRegistry,
    sessionController: ctx.sessionController,
    sessionQuery: ctx.sessionQuery,
    logger: { error() {} },
  }, {
    createStateStore: async () => store,
    resolveOwnedHome: async () => home,
    roleWorkspacePath: async () => workspacePath,
  })
  const operationId = '76c4028f-8f91-4f70-9c4e-9c6d3cb2026c'
  const input = { role: 'center', expectedSessionId: previous.sessionId, operationId }
  const send = async () => {
    const req = Readable.from([Buffer.from(JSON.stringify(input))])
    req.method = 'POST'; req.url = '/tradeloom/session/new'
    const res = { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
    await handler(req, res)
    return { status: res.statusCode, value: JSON.parse(res.body) }
  }
  const created = await send()
  assert.equal(created.status, 201, JSON.stringify(created.value))
  assert.equal(created.value.sessionId, `session-${operationId}`)
  const replay = await send()
  assert.equal(replay.status, 200)
  assert.equal(replay.value.replayed, true)
  assert.equal(replay.value.sessionId, created.value.sessionId)
  assert.equal(state.roles.center.sessionId, created.value.sessionId)
  assert.equal(ctx.workspaceRegistry.get(workspace.id).sessionIds.includes(created.value.sessionId), true)
  assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(created.value.sessionId), false)
  const oldAfter = await ctx.sessionQuery.observeSession(previous.sessionId)
  assert.deepEqual(oldAfter.header, oldHeader, 'the previous native session header is preserved')
  assert.equal(oldAfter.events.length, oldEventCount, 'the previous session history is untouched')
  oldAfter[Symbol.dispose]()
  const newObservation = await ctx.sessionQuery.observeSession(created.value.sessionId)
  assert.equal(newObservation.header.id, created.value.sessionId)
  assert.equal(newObservation.header.cwd, workspacePath)
  assert.equal(newObservation.projections.values.agentPreset, ROLE_PRESETS.center)
  const boundary = newObservation.projections.values.turnBoundary
  assert.ok(boundary === undefined || boundary.openTurnStartSeq === null && boundary.lastTurn === 0,
    'the official Session projection satisfies the blank-session predicate')
  newObservation[Symbol.dispose]()
})

test('isolated product profile boot applies configuration to a new disk-backed session generation', async t => {
  const base = process.env.TRADELOOM_DSH_PINNED_SOURCE
  if (!base) { t.skip('requires pinned compiled DSH runtime'); return }
  const runRoot = await mkdtemp(join(evidenceRoot, 'profile-boot-task3-'))
  const evidencePath = join(evidenceRoot, `profile-boot-task3-capture-${randomUUID()}`)
  await mkdir(evidencePath, { recursive: false })
  const audit = await realpath(evidenceRoot)
  assert.equal(dirname(await realpath(runRoot)), audit)
  assert.equal(dirname(await realpath(evidencePath)), audit)
  let preserveRunRoot = false
  t.after(async () => {
    if (!preserveRunRoot) {
      const current = await realpath(runRoot).catch(() => undefined)
      if (current && dirname(current) === audit) await rm(current, { recursive: true, force: true })
    }
  })

  const dshHome = join(runRoot, 'dsh-home')
  const nodeDir = dirname(process.execPath)
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const childEnv = {
    PATH: [nodeDir, systemRoot && join(systemRoot, 'System32')].filter(Boolean).join(';'),
    ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
    ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
    ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    TASK3_PROFILE_RUN_ROOT: runRoot,
    TASK3_REPO_ROOT: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    TRADELOOM_DSH_PINNED_SOURCE: base,
    DSH_HOME: dshHome,
    TRADELOOM_DSH_APP_HOME: dshHome,
    TASK3_PROFILE_MCP_TOKEN: `synthetic-${randomUUID()}`,
    TASK3_LOCAL_MODEL_KEY: `synthetic-${randomUUID()}`,
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/profile-runtime-task3.mjs', import.meta.url))], {
    cwd: runRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  let code
  let signal
  const childExit = once(child, 'exit')
  try { [code, signal] = await withTimeout(childExit, 120000, 'isolated product profile boot') }
  catch (error) {
    preserveRunRoot = true
    child.kill()
    await childExit
    throw error
  }
  const syntheticToken = childEnv.TASK3_PROFILE_MCP_TOKEN
  const redactOutput = text => text.split(syntheticToken).join('[synthetic-secret-redacted]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[generated-token-redacted]')
  const stdoutText = redactOutput(Buffer.concat(stdout).toString('utf8'))
  const stderrText = redactOutput(Buffer.concat(stderr).toString('utf8'))
  await writeFile(join(evidencePath, 'stdout.txt'), stdoutText, 'utf8')
  await writeFile(join(evidencePath, 'stderr.txt'), stderrText, 'utf8')
  await writeFile(join(evidencePath, 'exit.json'), `${JSON.stringify({ code, signal })}\n`, 'utf8')
  const resultLine = stdoutText.trim().split(/\r?\n/).at(-1)
  let result
  try { result = JSON.parse(resultLine ?? '') } catch { result = undefined }
  preserveRunRoot = code !== 0 || result?.ok !== true
  assert.equal(code, 0, `the isolated product profile child exits successfully; private capture: ${evidencePath}`)
  assert.equal(result?.ok, true, `the full profile chain reports its allowlisted assertions; private capture: ${evidencePath}`)
  assert.equal(result.profileBoot, true)
  assert.equal(result.officialConfigEditor, true)
  assert.equal(result.officialSessionController, true)
  assert.equal(result.officialSessionQuery, true)
  assert.equal(result.officialWorkspaceRegistry, true)
  assert.equal(result.productToolPolicy, true)
  assert.equal(result.mcpAuthorizationEnvReferenceRoundTrip, true)
  assert.equal(result.mcpPingCalls, 4)
  assert.equal(result.mcpAuthorizationObserved, true)
  assert.equal(result.configEditorStartupFailureRollback, true)
  assert.equal(result.recoveryGenerationAfterRollback, true)
  assert.equal(result.newSessionReplay, true)
  assert.equal(result.oldSessionHistoryPreserved, true)
  assert.equal(result.oldGenerationAllowedAfterSave, true)
  assert.equal(result.newGenerationDenied, true)
  assert.equal(result.diskStateBindingPersisted, true)
  assert.equal(result.oldSessionDiskArtifact, true)
  assert.equal(result.newSessionDiskArtifact, true)
})
