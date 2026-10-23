import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAgentConfigurationHandler } from '../agent-configuration.js'
import { apply as applyHost } from '../host.js'
import { ROLE_PRESETS } from '../roles.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'
import { createScopedToolPolicy } from '../tool-policy.js'

const auditRoot = fileURLToPath(new URL('../../../../workspace/testing/agent-capability-configuration-20261023/', import.meta.url))
await mkdir(auditRoot, { recursive: true })

async function fixture(t, { rejected, initialConfig, env = {} } = {}) {
  const home = await mkdtemp(join(auditRoot, 'api-'))
  const resolvedRoot = await realpath(auditRoot)
  const resolvedHome = await realpath(home)
  assert.equal(dirname(resolvedHome), resolvedRoot, 'fixture must stay directly inside the designated test root')
  t.after(async () => {
    const now = await realpath(home).catch(() => undefined)
    if (now && dirname(now) === resolvedRoot) await rm(now, { recursive: true, force: true })
  })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const profileDir = join(home, 'profiles', 'tradeloom')
  await mkdir(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entry = {
    options: { id: 'tradeloom-center-preset', name: '@deepseek-ai/dsh-agent-preset', config: structuredClone(initialConfig ?? {
      id: ROLE_PRESETS.center,
      name: '中心',
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep this plugin' } },
        { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
      ],
    }) },
    fiber: { state: 'active' },
  }
  const editor = {
    documentPath: patchPath,
    entries() { return [entry] },
    async edit(selected, change) {
      assert.strictEqual(selected, entry)
      const next = change(structuredClone(entry.options.config), { plugins: [] })
      entry.options.config = structuredClone(next)
    },
  }
  const profile = {
    name: 'tradeloom', home, dir: profileDir, patchPath,
    startedBundles: ['@tradeloom/dsh-business-shell'],
  }
  const presetRegistry = {
    async resolve(id) { return { id } },
    async compositionInventory() { return [{ id: ROLE_PRESETS.center }] },
  }
  const ctx = {
    connection: { requestRejection() { return rejected } },
    tools: { schemas() { return [{ name: 'mcp__inventory__lookup' }, { name: 'search_web' }] } },
    agents: { get() { return undefined } },
    get(name) { return name === 'configEditor' ? editor : name === 'profileContext' ? profile : name === 'agentPresets' ? presetRegistry : undefined },
  }
  const handler = createAgentConfigurationHandler(ctx, {
    resolveOwnedHome: async () => home,
    FiberState: { ACTIVE: 'active' },
    env,
    toolNames: ['mcp__inventory__lookup', 'search_web'],
    async roleWorkspacePath(role) {
      const path = join(home, 'tradeloom-workspaces', role)
      await mkdir(path, { recursive: true })
      return path
    },
  })
  return { home, ctx, entry, editor, handler, profile }
}

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

function response() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value = '') { this.body = value },
  }
}

async function call(handler, method = 'GET', url = '/tradeloom/agent-configuration?role=center', body) {
  const res = response()
  await handler(request(method, url, body), res)
  return { res, body: res.body ? JSON.parse(res.body) : undefined }
}

test('host exposes the protected role configuration resource', () => {
  const routes = []
  const ctx = {
    tools: {},
    agents: { get() { return undefined } },
    connection: { requestRejection() { return undefined } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    workspaceRegistry: {},
    sessionController: {},
    on() {},
    effect(register) { this.cleanup = register() },
  }

  applyHost(ctx)
  assert.ok(routes.some(route => route.kind === 'exact' && route.path === '/tradeloom/agent-configuration'),
    'Host must expose the role configuration API on its protected same-origin router')
  ctx.cleanup()
})

test('configuration API checks same-origin rejection and strict role query before profile access', async t => {
  const setup = await fixture(t, { rejected: 403 })
  const denied = await call(setup.handler)
  assert.equal(denied.res.statusCode, 403)
  assert.equal(denied.res.body, '')

  setup.ctx.connection.requestRejection = () => undefined
  for (const url of [
    '/tradeloom/agent-configuration?role=center&role=product',
    '/tradeloom/agent-configuration?role=product&extra=1',
    '/tradeloom/agent-configuration?role=unknown',
  ]) {
    const result = await call(setup.handler, 'GET', url)
    assert.equal(result.res.statusCode, 400)
  }
})

test('GET projects owned configuration and only returns secret references, never evaluated values', async t => {
  const env = { NARRATIVE_TOKEN: 'synthetic-value-that-must-not-leak' }
  const setup = await fixture(t, { env, initialConfig: {
    id: ROLE_PRESETS.center,
    name: '中心',
    description: 'preserve this field',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep this plugin' } },
      { id: 'tradeloom-mcp-inventory', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'streamable-http', serverName: 'inventory', url: 'https://example.invalid/mcp',
        headers: { Authorization: { __jsExpr: '"Bearer " + process.env["NARRATIVE_TOKEN"]' } },
        toolCallTimeoutMs: 10000, failOnStartupError: false,
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: ['search_web'] } },
    ],
  } })
  const result = await call(setup.handler)
  assert.equal(result.res.statusCode, 200, JSON.stringify(result.body))
  assert.equal(result.body.editable, true)
  assert.equal(result.body.mcpServers[0].headers.Authorization.envName, 'NARRATIVE_TOKEN')
  assert.equal(result.body.mcpServers[0].headers.Authorization.scheme, 'bearer')
  assert.equal(result.body.mcpServers[0].headers.Authorization.present, true)
  assert.deepEqual(result.body.deniedTools, ['search_web'])
  assert.equal(JSON.stringify(result.body).includes(env.NARRATIVE_TOKEN), false)
  assert.equal(result.body.skill.includeDefaultRoots, true)
})

test('PUT uses managed-subtree revision, converts only env references, and preserves unmanaged rows and preset fields', async t => {
  const env = { INVENTORY_TOKEN: 'test-secret' }
  const setup = await fixture(t, { env, initialConfig: {
    id: ROLE_PRESETS.center,
    name: '中心',
    description: 'keep the description',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep this plugin' } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
    ],
  } })
  const initial = await call(setup.handler)
  const workspace = join(setup.home, 'tradeloom-workspaces', 'center')
  await mkdir(join(workspace, 'skills'), { recursive: true })
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: initial.body.revision,
    mcpServers: [{
      id: 'tradeloom-mcp-inventory', transport: 'streamable-http', serverName: 'inventory',
      url: 'https://example.invalid/mcp', headers: { Authorization: { envName: 'INVENTORY_TOKEN', scheme: 'bearer' } },
      toolCallTimeoutMs: 10000, failOnStartupError: false,
    }],
    skill: { includeDefaultRoots: true, customSkillDirs: ['skills'] },
    deniedTools: ['search_web'],
  })
  assert.equal(result.res.statusCode, 200)
  assert.equal(result.body.appliedForNewAgents, true)
  assert.equal(result.body.currentSessionUnchanged, true)
  assert.equal(JSON.stringify(result.body).includes(env.INVENTORY_TOKEN), false)
  assert.equal(setup.entry.options.config.description, 'keep the description')
  assert.deepEqual(setup.entry.options.config.plugins[0], {
    id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep this plugin' },
  })
  const saved = setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-mcp-inventory')
  assert.deepEqual(saved.config.headers.Authorization, { __jsExpr: '"Bearer " + process.env["INVENTORY_TOKEN"]' })
  assert.equal(setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-skill-filesystem').config.providerName, 'tradeloom-center-skills')
})

test('nested Skill roots round-trip through Windows paths and remain writable', async t => {
  const setup = await fixture(t)
  const initial = await call(setup.handler)
  const workspace = join(setup.home, 'tradeloom-workspaces', 'center')
  await mkdir(join(workspace, 'skills', 'nested'), { recursive: true })
  const write = async revision => call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: revision,
    mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: ['skills/nested'] },
    deniedTools: [],
  })
  const saved = await write(initial.body.revision)
  assert.equal(saved.res.statusCode, 200)
  const read = await call(setup.handler)
  assert.deepEqual(read.body.skill.customSkillDirs, ['skills/nested'])
  const roundTrip = await write(read.body.revision)
  assert.equal(roundTrip.res.statusCode, 200)
})

test('unknown managed fields and unsafe command expressions are hidden and make the whole configuration read-only', async t => {
  const sentinel = 'do-not-project-this-expression'
  const setup = await fixture(t, { initialConfig: {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'tradeloom-mcp-legacy', name: '@deepseek-ai/dsh-mcp-client', enabled: false, config: {
        transport: 'stdio', serverName: 'legacy', command: { __jsExpr: sentinel }, args: [], cwd: '',
        env: {}, toolCallTimeoutMs: 1000, failOnStartupError: false,
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
    ],
  } })
  const read = await call(setup.handler)
  assert.equal(read.res.statusCode, 200)
  assert.equal(read.body.editable, false)
  assert.equal(JSON.stringify(read.body).includes(sentinel), false)
  assert.deepEqual(read.body.mcpServers, [{ id: 'tradeloom-mcp-legacy', configured: true, editable: false }])
  const rejected = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: read.body.revision, mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(rejected.res.statusCode, 409)
})

test('unknown Skill and policy fields are not projected or overwritten', async t => {
  const hiddenSkill = 'private-skill-config-field'
  const hiddenPolicy = 'private-policy-config-field'
  const setup = await fixture(t, { initialConfig: {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'tradeloom-skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', enabled: false, config: {
        providerName: 'tradeloom-center-skills', includeDefaultRoots: true, customSkillDirs: [], customField: hiddenSkill,
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: {
        deniedTools: ['search_web'], extra: hiddenPolicy,
      } },
    ],
  } })
  const read = await call(setup.handler)
  assert.equal(read.res.statusCode, 200)
  assert.equal(read.body.editable, false)
  assert.equal(JSON.stringify(read.body).includes(hiddenSkill), false)
  assert.equal(JSON.stringify(read.body).includes(hiddenPolicy), false)
  assert.deepEqual(read.body.deniedTools, [])
  const put = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: read.body.revision, mcpServers: [], skill: read.body.skill, deniedTools: [],
  })
  assert.equal(put.res.statusCode, 409)
  assert.equal(setup.entry.options.config.plugins[0].config.customField, hiddenSkill)
})

test('PUT rejects duplicate names against unmanaged MCP rows without exposing their values', async t => {
  const setup = await fixture(t, { initialConfig: {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
      { id: 'external-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'stdio', serverName: 'same-name', command: 'external-command-secret', args: [], cwd: '', env: {},
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
    ],
  } })
  const read = await call(setup.handler)
  assert.equal(read.body.editable, true)
  assert.equal(JSON.stringify(read.body).includes('external-command-secret'), false)
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: read.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-new', transport: 'stdio', serverName: 'same-name', command: 'mcp', args: [], cwd: '', env: {}, toolCallTimeoutMs: 1000, failOnStartupError: false }],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 409)
  assert.equal(setup.entry.options.config.plugins.some(row => row.id === 'tradeloom-mcp-new'), false)
})

test('locked callback detects a concurrent unmanaged MCP name collision and preserves it', async t => {
  const setup = await fixture(t)
  const initial = await call(setup.handler)
  setup.editor.edit = async (entry, change) => {
    const latest = structuredClone(entry.options.config)
    latest.plugins.push({ id: 'external-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
      transport: 'stdio', serverName: 'raced-name', command: 'private-external-command', args: [], cwd: '', env: {},
    } })
    entry.options.config = latest
    entry.options.config = change(latest, { plugins: [] })
  }
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: initial.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-raced', transport: 'stdio', serverName: 'raced-name', command: 'mcp', args: [], cwd: '', env: {}, toolCallTimeoutMs: 1000, failOnStartupError: false }],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 409)
  assert.equal(JSON.stringify(result.body).includes('private-external-command'), false)
  assert.equal(setup.entry.options.config.plugins.some(row => row.id === 'external-mcp'), true)
  assert.equal(setup.entry.options.config.plugins.some(row => row.id === 'tradeloom-mcp-raced'), false)
})

test('preset lookup rejects duplicate, inactive, and disabled roots', async t => {
  for (const mode of ['duplicate', 'inactive', 'disabled', 'options-disabled']) {
    const setup = await fixture(t)
    if (mode === 'duplicate') setup.editor.entries = () => [setup.entry, structuredClone(setup.entry)]
    else if (mode === 'inactive') setup.entry.fiber.state = 'inactive'
    else if (mode === 'disabled') setup.entry.disabled = true
    else setup.entry.options.enabled = false
    const result = await call(setup.handler)
    assert.equal(result.res.statusCode, 503, mode)
    assert.equal(result.body.error, 'configuration-unavailable', mode)
  }
})

test('production FiberState const enum is matched without a runtime enum export', async t => {
  const setup = await fixture(t)
  setup.entry.fiber.state = 2
  setup.handler = createAgentConfigurationHandler(setup.ctx, {
    resolveOwnedHome: async () => setup.home,
    async roleWorkspacePath(role) {
      const path = join(setup.home, 'tradeloom-workspaces', role)
      await mkdir(path, { recursive: true })
      return path
    },
  })
  const result = await call(setup.handler)
  assert.equal(result.res.statusCode, 200)
})

test('locked callback rejects concurrent managed edits and preserves concurrent unmanaged edits', async t => {
  const setup = await fixture(t)
  const initial = await call(setup.handler)
  const body = {
    expectedRevision: initial.body.revision, mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  }
  const originalEdit = setup.editor.edit.bind(setup.editor)
  setup.editor.edit = async (entry, change) => {
    const latest = structuredClone(entry.options.config)
    latest.description = 'concurrent unmanaged update'
    latest.plugins.find(row => row.id === 'persona').config.prefix = 'concurrent persona update'
    entry.options.config = change(latest, { plugins: [] })
  }
  const saved = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', body)
  assert.equal(saved.res.statusCode, 200)
  assert.equal(setup.entry.options.config.description, 'concurrent unmanaged update')
  assert.equal(setup.entry.options.config.plugins[0].config.prefix, 'concurrent persona update')

  const refreshed = await call(setup.handler)
  setup.editor.edit = async (entry, change) => {
    const latest = structuredClone(entry.options.config)
    latest.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = ['search_web']
    entry.options.config = latest
    entry.options.config = change(latest, { plugins: [] })
  }
  const raced = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...body, expectedRevision: refreshed.body.revision,
  })
  assert.equal(raced.res.statusCode, 409)
  assert.deepEqual(setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools, ['search_web'])
  setup.editor.edit = originalEdit
})

test('PUT rejects absent env references, escaped Skill paths, and duplicate server names without writing', async t => {
  const setup = await fixture(t)
  const initial = await call(setup.handler)
  const base = {
    expectedRevision: initial.body.revision, mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  }
  const missingEnv = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...base,
    mcpServers: [{ id: 'tradeloom-mcp-one', transport: 'stdio', serverName: 'one', command: 'mcp', args: [], cwd: '', env: { TOKEN: { envName: 'MISSING', scheme: 'raw' } }, toolCallTimeoutMs: 1000, failOnStartupError: false }],
  })
  assert.equal(missingEnv.res.statusCode, 400)
  const escape = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...base, skill: { includeDefaultRoots: true, customSkillDirs: ['../outside'] },
  })
  assert.equal(escape.res.statusCode, 400)
  const duplicateName = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...base,
    mcpServers: ['one', 'one'].map((serverName, index) => ({ id: `tradeloom-mcp-${index}`, transport: 'stdio', serverName, command: 'mcp', args: [], cwd: '', env: {}, toolCallTimeoutMs: 1000, failOnStartupError: false })),
  })
  assert.equal(duplicateName.res.statusCode, 400)
  assert.equal(setup.entry.options.config.plugins.length, 2)
})

test('PUT rolls back managed rows when the official preset registry reports a failed child activation', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        return { id, ...(resolveReads === 2 ? { broken: 'synthetic startup failure' } : {}) }
      } }
        : undefined
  const saved = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{
      id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true,
    }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(saved.res.statusCode, 503)
  assert.equal(saved.body.error, 'configuration-apply-failed')
  assert.deepEqual(setup.entry.options.config.plugins, [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep this plugin' } },
    { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
  ])
  assert.equal(resolveReads, 3, 'the handler checks existing, written and restored preset states through resolve')
})

test('PUT reports a distinct restore failure when a broken definition cannot be restored', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  const originalEdit = setup.editor.edit
  let edits = 0
  setup.editor.edit = async (...args) => {
    edits += 1
    if (edits === 2) throw new Error('synthetic restore write failure')
    return originalEdit(...args)
  }
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        return { id, ...(edits === 1 ? { broken: 'synthetic startup failure' } : {}) }
      } }
        : undefined
  const saved = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{
      id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true,
    }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(saved.res.statusCode, 503)
  assert.equal(saved.body.error, 'configuration-restore-failed')
  assert.equal(edits, 2, 'restore is attempted once and is not silently retried')
})

test('GET remains readable when official preset resolution is unavailable but PUT refuses to claim application', async t => {
  const setup = await fixture(t)
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async compositionInventory() { return [{ id: ROLE_PRESETS.center }] } }
        : undefined
  const before = await call(setup.handler)
  assert.equal(before.res.statusCode, 200)
  const saved = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision, mcpServers: [], skill: before.body.skill, deniedTools: [],
  })
  assert.equal(saved.res.statusCode, 503)
  assert.equal(saved.body.error, 'configuration-unavailable')
  assert.equal(setup.entry.options.config.plugins.length, 2, 'no configuration write occurs without the official resolver')
})

test('same-role saves serialize across validation and application, while another role can save independently', async t => {
  const setup = await fixture(t)
  const center = await call(setup.handler)
  const productEntry = {
    options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: ROLE_PRESETS.product, plugins: [
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
    ] } },
    fiber: { state: 'active' },
  }
  const originalEntries = setup.editor.entries
  const originalEdit = setup.editor.edit
  setup.editor.entries = () => [...originalEntries(), productEntry]
  let releaseCenter
  let centerEntered
  const entered = new Promise(resolve => { centerEntered = resolve })
  const centerGate = new Promise(resolve => { releaseCenter = resolve })
  setup.editor.edit = async (entry, callback) => {
    if (entry === setup.entry && !centerEntered.called) {
      centerEntered.called = true
      centerEntered()
      await centerGate
    }
    if (entry === productEntry) {
      productEntry.options.config = structuredClone(callback(structuredClone(productEntry.options.config), { plugins: [] }))
      return
    }
    return originalEdit(entry, callback)
  }
  const centerBody = { expectedRevision: center.body.revision, mcpServers: [], skill: center.body.skill, deniedTools: [] }
  const centerFirst = call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', centerBody)
  await entered
  const centerSecond = call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', centerBody)
  const productBody = {
    expectedRevision: '', mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  }
  const productGet = await call(setup.handler, 'GET', '/tradeloom/agent-configuration?role=product')
  productBody.expectedRevision = productGet.body.revision
  let productResult
  try {
    productResult = await Promise.race([
      call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=product', productBody),
      new Promise((_, reject) => setTimeout(() => reject(new Error('product role write was blocked by center role')), 500)),
    ])
  } finally { releaseCenter() }
  assert.equal(productResult.res.statusCode, 200)
  assert.equal((await centerFirst).res.statusCode, 200)
  assert.equal((await centerSecond).res.statusCode, 409, 'the queued stale write cannot apply over the first save')
})

test('a managed edit during preset resolution is reported as a conflict and is never overwritten', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        if (resolveReads === 2) {
          const policy = setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-tool-policy')
          policy.config.deniedTools = ['external-concurrent-edit']
        }
        return { id }
      } }
        : undefined
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision, mcpServers: [], skill: before.body.skill, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 409)
  assert.equal(result.body.error, 'revision-conflict')
  assert.deepEqual(setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools,
    ['external-concurrent-edit'], 'the concurrent managed edit survives without a compensating overwrite')
})

test('compensating restore preserves unrelated preset rows that change while activation is checked', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        if (resolveReads === 2) setup.entry.options.config.plugins.push({ id: 'external-plugin', name: '@other/plugin', config: { retained: true } })
        return { id, ...(resolveReads === 2 ? { broken: 'synthetic startup failure' } : {}) }
      } }
        : undefined
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 503)
  assert.equal(result.body.error, 'configuration-apply-failed')
  assert.equal((await call(setup.handler)).body.revision, before.body.revision)
  assert.deepEqual(setup.entry.options.config.plugins.find(row => row.id === 'external-plugin'),
    { id: 'external-plugin', name: '@other/plugin', config: { retained: true } })
})

test('a previously broken preset restores its prior managed configuration without claiming health', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        return { id, ...(resolveReads <= 3 ? { broken: 'pre-existing or synthetic activation failure' } : {}) }
      } }
        : undefined
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 503)
  assert.equal(result.body.error, 'configuration-apply-failed')
  assert.equal((await call(setup.handler)).body.revision, before.body.revision,
    'the previous broken preset configuration is restored by revision without claiming it became healthy')
  assert.equal(resolveReads, 3)
})

test('restore health is verified when a previously healthy preset is restored', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        return { id, ...(resolveReads >= 2 ? { broken: 'persistent synthetic activation failure' } : {}) }
      } }
        : undefined
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 503)
  assert.equal(result.body.error, 'configuration-restore-failed', 'restored data that still fails resolve is reported distinctly')
  assert.equal((await call(setup.handler)).body.revision, before.body.revision)
})

test('restore reports a concurrent post-write managed change as conflict rather than restore failure', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  const originalEdit = setup.editor.edit
  let edits = 0
  setup.editor.edit = async (entry, callback) => {
    edits += 1
    await originalEdit(entry, callback)
    if (edits === 2) {
      setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = ['external-during-restore']
    }
  }
  let resolveReads = 0
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { async resolve(id) {
        resolveReads += 1
        return { id, ...(resolveReads === 2 ? { broken: 'synthetic startup failure' } : {}) }
      } }
        : undefined
  const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: before.body.revision,
    mcpServers: [{ id: 'tradeloom-mcp-failing', transport: 'streamable-http', serverName: 'failing',
      url: 'http://127.0.0.1:9/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true }],
    skill: before.body.skill, deniedTools: [],
  })
  assert.equal(result.res.statusCode, 409)
  assert.equal(result.body.error, 'revision-conflict')
  assert.deepEqual(setup.entry.options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools,
    ['external-during-restore'])
})

test('invalid request envelopes return 400 before revision comparison or any ConfigEditor write', async t => {
  const setup = await fixture(t)
  const before = await call(setup.handler)
  let editCalls = 0
  const originalEdit = setup.editor.edit
  setup.editor.edit = async (...args) => { editCalls += 1; return originalEdit(...args) }
  for (const body of [null, [], { expectedRevision: 7 }, { expectedRevision: 'wrong', mcpServers: [], skill: {}, deniedTools: [] }]) {
    const result = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', body)
    assert.equal(result.res.statusCode, 400)
    assert.equal(result.body.error, 'invalid-configuration')
  }
  assert.equal(editCalls, 0)
  assert.equal((await call(setup.handler)).body.revision, before.body.revision)
})

test('denied tools from an older generation can be retained or removed but not added when unseen', async t => {
  const setup = await fixture(t, { initialConfig: {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: ['mcp__offline__tool'] } },
    ],
  } })
  setup.handler = createAgentConfigurationHandler(setup.ctx, {
    resolveOwnedHome: async () => setup.home,
    FiberState: { ACTIVE: 'active' },
    env: {},
    async roleWorkspacePath(role) {
      const path = join(setup.home, 'tradeloom-workspaces', role)
      await mkdir(path, { recursive: true })
      return path
    },
    async createStateStore() { return { async read() { return { roles: { center: { sessionId: 'live-session', agentPreset: ROLE_PRESETS.center } } } } } },
  })
  let composed = 'wrong'
  setup.ctx.get = name => name === 'configEditor' ? setup.editor
    : name === 'profileContext' ? setup.profile
      : name === 'agentPresets' ? { composedPreset: async context => context === setup.live.ctx ? composed : 'wrong',
        async resolve(id) { return { id } } }
        : undefined
  setup.live = { session: { id: 'live-session', header: { agentPreset: ROLE_PRESETS.center } }, ctx: {} }
  setup.ctx.agents.get = () => setup.live
  setup.ctx.tools.schemas = agent => agent === setup.live ? [{ name: 'search_web' }] : []
  const current = await call(setup.handler)
  const mismatched = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: current.body.revision, mcpServers: [], skill: current.body.skill,
    deniedTools: ['search_web'],
  })
  assert.equal(mismatched.res.statusCode, 400)
  composed = ROLE_PRESETS.center
  const retained = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: current.body.revision, mcpServers: [], skill: current.body.skill,
    deniedTools: ['mcp__offline__tool', 'search_web'],
  })
  assert.equal(retained.res.statusCode, 200)
  const refreshed = await call(setup.handler)
  const removed = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: refreshed.body.revision, mcpServers: [], skill: refreshed.body.skill,
    deniedTools: [],
  })
  assert.equal(removed.res.statusCode, 200)
  const after = await call(setup.handler)
  const invented = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: after.body.revision, mcpServers: [], skill: after.body.skill,
    deniedTools: ['mcp__offline__tool'],
  })
  assert.equal(invented.res.statusCode, 400)
})

test('PUT rejects stale revisions, raw secrets, arbitrary JS, URL credentials, extra keys, and unknown tools without editing', async t => {
  const setup = await fixture(t, { env: { TOKEN: 'secret' } })
  const initial = await call(setup.handler)
  const base = {
    expectedRevision: initial.body.revision,
    mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] },
    deniedTools: [],
  }
  const stale = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', { ...base, expectedRevision: '0'.repeat(64) })
  assert.equal(stale.res.statusCode, 409)
  const rawSecret = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...base, mcpServers: [{ id: 'tradeloom-mcp-test', transport: 'stdio', serverName: 'test', command: 'mcp', args: [], cwd: '', toolCallTimeoutMs: 1000, failOnStartupError: false, env: { TOKEN: { envName: 'TOKEN', scheme: 'raw', extra: true } } }],
  })
  assert.equal(rawSecret.res.statusCode, 400)
  const extra = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', { ...base, actor: 'system' })
  assert.equal(extra.res.statusCode, 400)
  for (const envName of [['TOKEN'], { name: 'TOKEN' }]) {
    const invalidEnvName = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
      ...base, mcpServers: [{ id: 'tradeloom-mcp-test', transport: 'stdio', serverName: 'test', command: 'mcp', args: [], cwd: '',
        toolCallTimeoutMs: 1000, failOnStartupError: false, env: { TOKEN: { envName, scheme: 'raw' } } }],
    })
    assert.equal(invalidEnvName.res.statusCode, 400, 'environment reference names must be primitive strings')
  }
  const unknown = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', { ...base, deniedTools: ['not_a_real_tool'] })
  assert.equal(unknown.res.statusCode, 400)
  const credentials = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    ...base, mcpServers: [{ id: 'tradeloom-mcp-test', transport: 'streamable-http', serverName: 'test', url: 'https://user:pass@example.invalid/mcp', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: false }],
  })
  assert.equal(credentials.res.statusCode, 400)
  assert.equal(setup.entry.options.config.plugins.length, 2)
})

test('unknown managed expressions make the whole managed config read-only and ConfigEditor absence never falls back to files', async t => {
  const setup = await fixture(t, { initialConfig: {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'tradeloom-mcp-legacy', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'stdio', serverName: 'legacy', command: 'mcp', args: [], cwd: '',
        env: { TOKEN: 'unknown evaluated value' }, toolCallTimeoutMs: 1000, failOnStartupError: false,
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
    ],
  } })
  const read = await call(setup.handler)
  assert.equal(read.res.statusCode, 200)
  assert.equal(read.body.editable, false)
  assert.equal(JSON.stringify(read.body).includes('unknown evaluated value'), false)
  const blocked = await call(setup.handler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: read.body.revision, mcpServers: [],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  assert.equal(blocked.res.statusCode, 409)

  const unavailable = await fixture(t)
  unavailable.ctx.get = name => name === 'profileContext' ? unavailable.ctx.profile : undefined
  const result = await call(unavailable.handler)
  assert.equal(result.res.statusCode, 503)
  assert.equal(result.body.error, 'configuration-unavailable')
})

test('tool policy refuses global scope and denies only names in its preset scope', async () => {
  const globalCtx = { tools: { guard() { throw new Error('global guard must not be registered') } } }
  assert.throws(() => createScopedToolPolicy(globalCtx, { deniedTools: ['search_web'] }, () => undefined), /preset scope/)

  let registered
  const scopedCtx = { tools: { guard(handler) { registered = handler; return () => {} } } }
  createScopedToolPolicy(scopedCtx, { deniedTools: ['search_web'] }, () => 'tradeloom-center')
  assert.equal(registered({ name: 'search_web' }), 'This tool is disabled for this TradeLoom assistant.')
  assert.equal(registered({ name: 'mcp__inventory__lookup' }), undefined)
})

test('default role presets register the scoped policy plugin without a global guard', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal((patch.match(/name: '@tradeloom\/dsh-business-shell\/tool-policy'/g) ?? []).length, 6)
  assert.doesNotMatch(patch, /id: tradeloom-tool-policy[\s\S]{0,120}deniedTools:\s*\n\s+-/)
})
