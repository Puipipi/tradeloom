import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAgentConfigurationResources } from '../agent-configuration.js'
import { createAgentConfigurationSnapshotsHandler } from '../agent-configuration-snapshots.js'
import { ROLE_PRESETS } from '../roles.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

test('package files include snapshot modules without adding a public snapshot subpath', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.exports['./agent-configuration-snapshots'], undefined,
    'Host uses a relative import; the internal snapshots handler is not a public package subpath')
  assert.equal(packageJson.exports['./agent-configuration'], undefined,
    'the internal snapshot operations controller must not be a public package subpath')
  assert.ok(packageJson.files.includes('agent-configuration.js'))
  assert.ok(packageJson.files.includes('agent-configuration-snapshots.js'))
  const [configuration, snapshots] = await Promise.all([
    import('../agent-configuration.js'),
    import('../agent-configuration-snapshots.js'),
  ])
  assert.equal(typeof configuration.createAgentConfigurationResources, 'function')
  assert.equal(typeof configuration.createAgentConfigurationHandler, 'function')
  assert.equal(typeof snapshots.createAgentConfigurationSnapshotsHandler, 'function')
})

const fixtureRoot = process.env.TRADELOOM_AGENT_CONFIGURATION_TEST_ROOT
  ?? join(tmpdir(), 'tradeloom-agent-configuration-snapshot-test')
await mkdir(fixtureRoot, { recursive: true })

function initialConfig(role, { unsupported = false } = {}) {
  return {
    id: ROLE_PRESETS[role], name: role,
    description: 'unmanaged preset description',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep unmanaged row' } },
      { id: 'tradeloom-mcp-inventory', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'streamable-http', serverName: 'inventory', url: 'https://inventory.example.invalid/mcp?tenant=synthetic',
        headers: { Authorization: { __jsExpr: '"Bearer " + process.env["INVENTORY_TOKEN"]' } },
        toolCallTimeoutMs: 5000, failOnStartupError: false,
      } },
      { id: 'tradeloom-skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
        providerName: `tradeloom-${role}-skills`, includeDefaultRoots: false, customSkillDirs: [],
      } },
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: {
        deniedTools: ['search_web'], ...(unsupported ? { unknown: 'hidden' } : {}),
      } },
    ],
  }
}

async function fixture(t, { rejected, unsupported = false, roles = ['center'], env = { INVENTORY_TOKEN: 'snapshot-test-secret' }, snapshotHooks, defaultReadOnlyWorkspace = false } = {}) {
  const home = await mkdtemp(join(fixtureRoot, 'owned-home-'))
  const root = await realpath(fixtureRoot)
  const owned = await realpath(home)
  assert.equal(dirname(owned), root)
  t.after(async () => {
    const current = await realpath(home).catch(() => undefined)
    if (current && dirname(current) === root) await rm(current, { recursive: true, force: true })
  })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const profileDir = join(home, 'profiles', 'tradeloom')
  await mkdir(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entries = roles.map(role => ({
    options: { id: `${role}-preset-entry`, name: '@deepseek-ai/dsh-agent-preset', config: initialConfig(role, { unsupported }) },
    fiber: { state: 'active' },
  }))
  let editCalls = 0
  let beforeEdit
  let onEdit
  let afterEdit
  const editor = {
    documentPath: patchPath,
    entries() { return entries },
    async edit(entry, change) {
      editCalls += 1
      await beforeEdit?.({ entry, editCalls })
      const next = change(structuredClone(entry.options.config), { plugins: [] })
      await onEdit?.({ entry, next, editCalls })
      entry.options.config = structuredClone(next)
      await afterEdit?.({ entry, next, editCalls })
    },
  }
  const profile = { name: 'tradeloom', home, dir: profileDir, patchPath, startedBundles: ['@tradeloom/dsh-business-shell'] }
  const resolveResults = []
  let resolveCalls = 0
  let onResolve
  const cleanupEffects = []
  const serviceOverrides = new Map()
  const presets = {
    async resolve(id) {
      resolveCalls += 1
      await onResolve?.({ id, resolveCalls })
      return resolveResults.length ? resolveResults.shift() : { id }
    },
  }
  const ctx = {
    connection: { requestRejection() { return rejected } },
    tools: { schemas() { return [{ name: 'search_web' }] } },
    agents: { get() { return undefined } },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') cleanupEffects.push(dispose); return dispose },
    get(name) { return serviceOverrides.has(name) ? serviceOverrides.get(name) : name === 'configEditor' ? editor : name === 'profileContext' ? profile : name === 'agentPresets' ? presets : undefined },
  }
  async function roleWorkspacePath(role) {
    const path = join(home, 'tradeloom-workspaces', role)
    await mkdir(path, { recursive: true })
    return path
  }
  async function roleWorkspacePathReadOnly(role) {
    return join(home, 'tradeloom-workspaces', role)
  }
  const fixtureEnv = defaultReadOnlyWorkspace
    ? { ...env, DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
    : env
  const dependencies = {
    resolveOwnedHome: async () => home,
    createStateStore: () => createStateStore({ env: { ...fixtureEnv, DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home } }),
    FiberState: { ACTIVE: 'active' }, env: fixtureEnv, toolNames: ['search_web'], roleWorkspacePath,
    ...(defaultReadOnlyWorkspace ? {} : { roleWorkspacePathReadOnly }),
    snapshotHooks,
  }
  const resources = createAgentConfigurationResources(ctx, dependencies)
  const configHandler = resources.configurationHandler
  const snapshotHandler = createAgentConfigurationSnapshotsHandler(ctx, { ...dependencies, snapshotOperations: resources.snapshotOperations })
  return {
    home, ctx, entries, editor, presets, env, dependencies, configHandler, snapshotHandler,
    get editCalls() { return editCalls }, set beforeEdit(value) { beforeEdit = value }, set onEdit(value) { onEdit = value }, set afterEdit(value) { afterEdit = value },
    set onResolve(value) { onResolve = value },
    queueResolve(...results) { resolveResults.push(...results) },
    replaceService(name, value) { serviceOverrides.set(name, value) },
    disposeEffects() { for (const dispose of cleanupEffects.splice(0)) dispose() },
  }
}

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value }, end(value = '') { this.body = value } }
}

async function call(handler, method, url, body) {
  const res = response()
  await handler(request(method, url, body), res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, raw: res.body }
}

const listUrl = role => `/tradeloom/agent-configuration/snapshots?role=${role}`
const capture = role => callCurrent('POST', { action: 'capture', role })
let currentFixture
function callCurrent(method, bodyOrUrl, maybeBody) {
  return typeof bodyOrUrl === 'string'
    ? call(currentFixture.snapshotHandler, method, bodyOrUrl, maybeBody)
    : call(currentFixture.snapshotHandler, method, '/tradeloom/agent-configuration/snapshots', bodyOrUrl)
}

test('snapshot handler preserves same-origin rejection before configuration/profile access', async t => {
  currentFixture = await fixture(t, { rejected: 403 })
  let entryReads = 0
  currentFixture.editor.entries = () => { entryReads += 1; return [] }
  const deniedList = await call(currentFixture.snapshotHandler, 'GET', listUrl('center'))
  const deniedCapture = await call(currentFixture.snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', { action: 'capture', role: 'center' })
  assert.equal(deniedList.status, 403)
  assert.equal(deniedCapture.status, 403)
  assert.equal(deniedList.raw, '')
  assert.equal(deniedCapture.raw, '')
  assert.equal(entryReads, 0)
})

test('capture/list/export persist only a fixed managed projection and dynamic secret references', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const snapshotId = captured.body.snapshot.snapshotId
  assert.match(snapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(captured.body.snapshot.kind, 'capture')
  assert.deepEqual(captured.body.snapshot.scope, ['mcpServers', 'skill', 'deniedTools'])
  const path = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', `${snapshotId}.json`)
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes('snapshot-test-secret'), false)
  const stored = JSON.parse(text)
  assert.deepEqual(stored.projection.mcpServers[0].headers.Authorization, { envName: 'INVENTORY_TOKEN', scheme: 'bearer' })
  assert.equal(Object.hasOwn(stored.projection.mcpServers[0].headers.Authorization, 'present'), false)
  const exported = await callCurrent('GET', `${listUrl('center')}&snapshotId=${snapshotId}`)
  assert.equal(exported.status, 200)
  assert.equal(exported.body.snapshot.checksum, captured.body.snapshot.checksum)
  assert.equal(JSON.stringify(exported.body).includes('snapshot-test-secret'), false)
  const listed = await callCurrent('GET', listUrl('center'))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.snapshots.length, 1)
  assert.equal(listed.body.snapshots[0].snapshotId, snapshotId)
  assert.equal(listed.body.snapshots[0].sourceRevision, captured.body.snapshot.sourceRevision)
})

test('list isolates a corrupt row while still returning valid snapshot metadata', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const badId = randomUUID()
  const directory = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')
  await writeFile(join(directory, `${badId}.json`), '{')
  const listed = await callCurrent('GET', listUrl('center'))
  assert.equal(listed.status, 200)
  assert.equal(listed.body.snapshots.length, 2)
  assert.ok(listed.body.snapshots.some(row => row.snapshotId === captured.body.snapshot.snapshotId && row.checksum))
  assert.deepEqual(listed.body.snapshots.find(row => row.snapshotId === badId), {
    snapshotId: badId, status: 'invalid', errorCode: 'snapshot-invalid',
  })
})

test('preview and cancel do not edit configuration or write another snapshot', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const beforeConfig = structuredClone(currentFixture.entries[0].options.config)
  const beforeFiles = await readdir(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center'))
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.applicable, true)
  assert.equal(preview.body.noOp, true)
  assert.equal(currentFixture.editCalls, 0)
  assert.deepEqual(currentFixture.entries[0].options.config, beforeConfig)
  assert.deepEqual(await readdir(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')), beforeFiles)
  const cancelled = await callCurrent('POST', { action: 'cancel', role: 'center', previewId: preview.body.previewId })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.cancelled, true)
  const rejected = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(rejected.status, 404)
  assert.equal(currentFixture.editCalls, 0)
})

test('preview and cancel use the default workspace resolver without creating a missing role directory', async t => {
  currentFixture = await fixture(t, { defaultReadOnlyWorkspace: true })
  const captured = await capture('center')
  assert.equal(captured.status, 201, JSON.stringify(captured.body))
  const workspaceParent = join(currentFixture.home, 'tradeloom-workspaces')
  await assert.rejects(lstat(workspaceParent), { code: 'ENOENT' })
  const snapshotDirectoryPath = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')
  const snapshotFiles = await readdir(snapshotDirectoryPath)
  const configurationBefore = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.applicable, true)
  assert.equal(currentFixture.editCalls, 0)
  const cancelled = await callCurrent('POST', { action: 'cancel', role: 'center', previewId: preview.body.previewId })
  assert.equal(cancelled.status, 200)
  await assert.rejects(lstat(workspaceParent), { code: 'ENOENT' })
  assert.deepEqual(await readdir(snapshotDirectoryPath), snapshotFiles)
  assert.deepEqual(currentFixture.entries[0].options.config, configurationBefore)
  assert.equal(currentFixture.editCalls, 0)
})

test('prototype-named snapshot actions remain typed invalid requests', async t => {
  currentFixture = await fixture(t)
  for (const action of ['constructor', 'toString']) {
    const result = await callCurrent('POST', { action, role: 'center' })
    assert.equal(result.status, 400)
    assert.deepEqual(result.body, { error: 'invalid-request' })
  }
  assert.equal(currentFixture.editCalls, 0)
})

test('restore backs up the current projection before applying through ConfigEditor and verifies readback', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const configRead = await call(currentFixture.configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  const safeInput = configRead.body.mcpServers.map(server => {
    const next = { ...server }
    delete next.present
    for (const key of ['env', 'headers']) {
      if (next[key]) next[key] = Object.fromEntries(Object.entries(next[key]).map(([name, ref]) => [name, { envName: ref.envName, scheme: ref.scheme }]))
    }
    return next
  })
  const changed = await call(currentFixture.configHandler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: configRead.body.revision, mcpServers: safeInput,
    skill: configRead.body.skill, deniedTools: [],
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.body.applicable, true)
  assert.equal(preview.body.noOp, false)
  currentFixture.onEdit = async ({ editCalls }) => {
    if (editCalls !== 2) return
    const files = await readdir(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center'))
    const backups = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', file), 'utf8'))))
    assert.equal(backups.some(record => record.kind === 'pre-restore-backup'), true,
      'verified current-state backup must exist before ConfigEditor edit begins')
  }
  const restored = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.status, 'restored')
  assert.equal(restored.body.appliedForNewAgents, true)
  assert.equal(restored.body.currentSessionUnchanged, true)
  assert.ok(restored.body.backupSnapshotId)
  const after = await call(currentFixture.configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  assert.equal(after.status, 200)
  assert.deepEqual(after.body.deniedTools, ['search_web'])
  assert.equal(after.body.revision, captured.body.snapshot.sourceRevision)
  assert.deepEqual(currentFixture.entries[0].options.config.plugins[0], {
    id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'keep unmanaged row' },
  })
  const files = await readdir(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center'))
  const backup = JSON.parse(await readFile(join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', `${restored.body.backupSnapshotId}.json`), 'utf8'))
  assert.equal(backup.kind, 'pre-restore-backup')
  assert.equal(backup.sourceSnapshotId, captured.body.snapshot.snapshotId)
  assert.deepEqual(backup.projection.deniedTools, [])
})

test('identical target is a no-op and does not write a backup or call ConfigEditor', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const result = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(result.status, 200)
  assert.equal(result.body.status, 'no-op')
  assert.equal(result.body.backupSnapshotId, null)
  assert.equal(currentFixture.editCalls, 0)
  const list = await callCurrent('GET', listUrl('center'))
  assert.equal(list.body.snapshots.filter(row => row.kind === 'pre-restore-backup').length, 0)
})

test('stale current configuration, cross-role use, unsupported source, and checksum corruption are rejected', async t => {
  currentFixture = await fixture(t, { roles: ['center', 'product'] })
  const captured = await capture('center')
  const crossRole = await callCurrent('POST', { action: 'preview', role: 'product', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(crossRole.status, 409)

  const current = await call(currentFixture.configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = ['search_web', 'synthetic_new']
  const editsBefore = currentFixture.editCalls
  const stale = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error, 'snapshot-restore-stale')
  assert.equal(currentFixture.editCalls, editsBefore)
  assert.notEqual(current.body.revision, (await call(currentFixture.configHandler, 'GET', '/tradeloom/agent-configuration?role=center')).body.revision)

  const unsupported = await fixture(t, { unsupported: true })
  currentFixture = unsupported
  const refused = await capture('center')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'unsupported-managed-config')

  currentFixture = await fixture(t)
  const valid = await capture('center')
  const path = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', `${valid.body.snapshot.snapshotId}.json`)
  const corrupt = JSON.parse(await readFile(path, 'utf8'))
  corrupt.projection.deniedTools = []
  await writeFile(path, JSON.stringify(corrupt))
  const invalid = await callCurrent('GET', `${listUrl('center')}&snapshotId=${valid.body.snapshot.snapshotId}`)
  assert.equal(invalid.status, 409)
  assert.equal(invalid.body.error, 'snapshot-checksum-mismatch')
})

test('recomputed checksum does not authorize fields outside the managed DTO', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const path = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', `${captured.body.snapshot.snapshotId}.json`)
  const altered = JSON.parse(await readFile(path, 'utf8'))
  altered.projection.mcpServers[0].credential = 'synthetic-literal-secret'
  const { checksum, ...payload } = altered
  altered.checksum = createHash('sha256').update(canonical(payload)).digest('hex')
  await writeFile(path, JSON.stringify(altered))
  const exported = await callCurrent('GET', `${listUrl('center')}&snapshotId=${captured.body.snapshot.snapshotId}`)
  assert.equal(exported.status, 409)
  assert.equal(exported.body.error, 'snapshot-invalid')
  assert.equal(JSON.stringify(exported.body).includes('synthetic-literal-secret'), false)
})

test('missing secret references make preview non-applicable without trying ConfigEditor', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  delete currentFixture.env.INVENTORY_TOKEN
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.applicable, false)
  assert.deepEqual(preview.body.reasons, ['invalid-configuration'])
  const restore = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(restore.status, 409)
  assert.equal(restore.body.error, 'snapshot-not-applicable')
  assert.equal(currentFixture.editCalls, 0)
})

test('preview rejects unmanaged MCP name collisions without attempting ConfigEditor writes', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const collision = { id: 'external-inventory', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'inventory',
  } }
  currentFixture.entries[0].options.config.plugins.push(collision)
  const beforeConfig = structuredClone(currentFixture.entries[0].options.config)
  const directory = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')
  const beforeFiles = await readdir(directory)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.applicable, false)
  assert.deepEqual(preview.body.reasons, ['server-name-conflict'])
  assert.equal(currentFixture.editCalls, 0)
  assert.deepEqual(currentFixture.entries[0].options.config, beforeConfig)
  assert.deepEqual(await readdir(directory), beforeFiles)
})

test('preview reports preset registry unavailability before any profile or snapshot write', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const beforeConfig = structuredClone(currentFixture.entries[0].options.config)
  const directory = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')
  const beforeFiles = await readdir(directory)
  currentFixture.presets.resolve = async () => { throw new Error('synthetic unavailable') }
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.applicable, false)
  assert.deepEqual(preview.body.reasons, ['configuration-unavailable'])
  assert.equal(currentFixture.editCalls, 0)
  assert.deepEqual(currentFixture.entries[0].options.config, beforeConfig)
  assert.deepEqual(await readdir(directory), beforeFiles)
})

test('backup write failure leaves the configuration unchanged and does not call ConfigEditor', async t => {
  currentFixture = await fixture(t, { snapshotHooks: { rename(_from, _to, kind) {
    if (kind === 'pre-restore-backup') throw Object.assign(new Error('injected backup failure'), { code: 'EIO' })
    return rename(_from, _to)
  } } })
  const captured = await capture('center')
  const before = structuredClone(currentFixture.entries[0].options.config)
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const currentBefore = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const editsBefore = currentFixture.editCalls
  const result = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'snapshot-backup-write-failed')
  assert.equal(currentFixture.editCalls, editsBefore)
  assert.deepEqual(currentFixture.entries[0].options.config, currentBefore)
  assert.notDeepEqual(currentBefore, before)
})

test('failed preset activation uses existing ConfigEditor compensation and retains verified backup', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.queueResolve({ id: ROLE_PRESETS.center }, { id: ROLE_PRESETS.center, broken: true }, { id: ROLE_PRESETS.center })
  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-failed')
  assert.equal(failed.body.restoreStatus, 'restored')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  assert.equal(currentFixture.editCalls, 2, 'the original controlled update and compensation both use ConfigEditor')
  const listed = await callCurrent('GET', listUrl('center'))
  assert.equal(listed.body.snapshots.some(row => row.kind === 'pre-restore-backup'), true)
})

test('compensation does not report restored when a previously healthy preset remains unhealthy', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.queueResolve(
    { id: ROLE_PRESETS.center },
    { id: ROLE_PRESETS.center, broken: true },
    { id: ROLE_PRESETS.center, broken: true },
  )

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(failed.body.restoreStatus, 'unknown')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before,
    'managed config was written back, but unhealthy preset state prevents full restored status')
})

test('same-provider post-write readback failure compensates and verifies the previous managed projection', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const policy = currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy')
  policy.config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  let reads = 0
  currentFixture.afterEdit = async ({ editCalls }) => {
    if (editCalls !== 1) return
    const entries = currentFixture.editor.entries.bind(currentFixture.editor)
    currentFixture.editor.entries = () => {
      reads += 1
      if (reads === 5) throw new Error('synthetic post-write readback failure')
      return entries()
    }
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-failed')
  assert.equal(failed.body.restoreStatus, 'restored')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  assert.equal(currentFixture.editCalls, 2, 'rollback uses the same ConfigEditor after provider identity remains stable')
})

test('snapshot restore verifies and compensates when ConfigEditor applies then rejects', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.afterEdit = ({ editCalls }) => {
    if (editCalls === 1) throw new Error('synthetic rejection after ConfigEditor applied target')
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-failed')
  assert.equal(failed.body.restoreStatus, 'restored')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  assert.equal(currentFixture.editCalls, 2, 'confirmed target commit is compensated through the same ConfigEditor')
})

test('snapshot restore classifies a ConfigEditor callback CAS rejection as conflict without compensation', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.beforeEdit = ({ editCalls }) => {
    if (editCalls === 1) currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = ['concurrent-owner-edit']
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error, 'snapshot-restore-conflict')
  assert.equal(failed.body.restoreStatus, 'conflict')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools, ['concurrent-owner-edit'])
  assert.equal(currentFixture.editCalls, 1, 'CAS rejection before callback commit must not trigger rollback')
})

test('snapshot restore does not read or compensate through a replaced provider after edit rejection', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const oldEditor = currentFixture.editor
  const oldEntries = oldEditor.entries.bind(oldEditor)
  let replaced = false
  let oldReadsAfterReplacement = 0
  oldEditor.entries = () => {
    if (replaced) oldReadsAfterReplacement += 1
    return oldEntries()
  }
  currentFixture.afterEdit = ({ editCalls }) => {
    if (editCalls !== 1) return
    currentFixture.replaceService('configEditor', { ...oldEditor })
    replaced = true
    throw new Error('synthetic rejection after provider replacement')
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(failed.body.restoreStatus, 'unknown')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 1, 'uncertain commit after provider replacement must not trigger stale-editor compensation')
  assert.equal(oldReadsAfterReplacement, 0)
})

test('snapshot restore rechecks provider and preimage after rejecting edit health resolution', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const oldEditor = currentFixture.editor
  const oldEntries = oldEditor.entries.bind(oldEditor)
  let replaced = false
  let oldReadsAfterReplacement = 0
  oldEditor.entries = () => {
    if (replaced) oldReadsAfterReplacement += 1
    return oldEntries()
  }
  currentFixture.onEdit = ({ editCalls }) => {
    if (editCalls === 1) throw new Error('synthetic rejection before editor commit')
  }
  currentFixture.onResolve = ({ resolveCalls }) => {
    if (resolveCalls === 3) {
      currentFixture.replaceService('configEditor', { ...oldEditor })
      replaced = true
    }
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(failed.body.restoreStatus, 'unknown')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 1, 'confirmed preimage is not sufficient after its provider is replaced during health resolution')
  assert.equal(oldReadsAfterReplacement, 0)
})

test('same-provider compensation conflict preserves a newer managed edit', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  let reads = 0
  currentFixture.afterEdit = async ({ editCalls }) => {
    if (editCalls !== 1) return
    const entries = currentFixture.editor.entries.bind(currentFixture.editor)
    currentFixture.editor.entries = () => {
      reads += 1
      if (reads === 5) throw new Error('synthetic post-write readback failure')
      return entries()
    }
  }
  currentFixture.beforeEdit = async ({ editCalls }) => {
    if (editCalls === 2) {
      currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = ['concurrent-owner-edit']
    }
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 409)
  assert.equal(failed.body.error, 'snapshot-restore-conflict')
  assert.equal(failed.body.restoreStatus, 'conflict')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools, ['concurrent-owner-edit'])
})

test('same-provider compensation failure reports unknown with backup reference and does not claim unchanged config', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  let reads = 0
  currentFixture.afterEdit = async ({ editCalls }) => {
    if (editCalls !== 1) return
    const entries = currentFixture.editor.entries.bind(currentFixture.editor)
    currentFixture.editor.entries = () => {
      reads += 1
      if (reads === 5 || reads >= 7) throw new Error('synthetic unreadable provider state')
      return entries()
    }
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(failed.body.restoreStatus, 'unknown')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 1, 'failed readback prevents a second unverified write')
  assert.notDeepEqual(currentFixture.entries[0].options.config, before, 'unknown result must not claim that config stayed unchanged')
})

test('provider replacement during compensation resolve is detected before another old-editor read', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.queueResolve(
    { id: ROLE_PRESETS.center },
    { id: ROLE_PRESETS.center, broken: true },
    { id: ROLE_PRESETS.center },
  )
  const oldEditor = currentFixture.editor
  const oldEntries = oldEditor.entries.bind(oldEditor)
  let replaced = false
  let oldReadsAfterReplacement = 0
  oldEditor.entries = () => {
    if (replaced) oldReadsAfterReplacement += 1
    return oldEntries()
  }
  currentFixture.onResolve = ({ resolveCalls }) => {
    if (resolveCalls === 4) {
      currentFixture.replaceService('configEditor', { ...oldEditor })
      replaced = true
    }
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(failed.body.restoreStatus, 'unknown')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 2, 'the failed apply and compensation each use ConfigEditor once')
  assert.equal(oldReadsAfterReplacement, 0, 'provider replacement after compensation resolve blocks old-editor readback')
})

test('snapshot callback failure after update is compensated under the same role lock', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.onEdit = ({ editCalls }) => {
    if (editCalls === 1) currentFixture.disposeEffects()
  }

  const failed = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.error, 'snapshot-restore-failed')
  assert.equal(failed.body.restoreStatus, 'restored')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  assert.equal(currentFixture.editCalls, 2, 'callback failure after the write triggers one guarded compensation')
})

test('same-role concurrent restores serialize and the second stale preview cannot write', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const firstPreview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const secondPreview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const results = await Promise.all([
    callCurrent('POST', { action: 'restore', role: 'center', previewId: firstPreview.body.previewId }),
    callCurrent('POST', { action: 'restore', role: 'center', previewId: secondPreview.body.previewId }),
  ])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  const conflict = results.find(result => result.status === 409)
  assert.equal(conflict.body.error, 'snapshot-restore-stale')
  assert.equal(currentFixture.editCalls, 1, 'the shared role lock admits only the first prepared restore')
})

test('configuration PUT and snapshot restore share the same deferred role lock', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  const current = await call(currentFixture.configHandler, 'GET', '/tradeloom/agent-configuration?role=center')
  const inputServers = current.body.mcpServers.map(server => {
    const next = { ...server }
    delete next.present
    for (const key of ['env', 'headers']) {
      if (next[key]) next[key] = Object.fromEntries(Object.entries(next[key]).map(([name, ref]) => [name, { envName: ref.envName, scheme: ref.scheme }]))
    }
    return next
  })
  let releasePut
  let enteredPut
  const putEntered = new Promise(resolve => { enteredPut = resolve })
  const putMayFinish = new Promise(resolve => { releasePut = resolve })
  currentFixture.beforeEdit = async ({ editCalls }) => {
    if (editCalls === 1) {
      enteredPut()
      await putMayFinish
    }
  }
  const putPromise = call(currentFixture.configHandler, 'PUT', '/tradeloom/agent-configuration?role=center', {
    expectedRevision: current.body.revision, mcpServers: inputServers,
    skill: current.body.skill, deniedTools: ['search_web'],
  })
  await putEntered
  const backupDirectory = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center')
  const restorePromise = callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  await new Promise(resolve => setImmediate(resolve))
  const heldFiles = await readdir(backupDirectory)
  assert.equal(currentFixture.editCalls, 1, 'snapshot restore cannot enter ConfigEditor while PUT holds the role lock')
  assert.equal(heldFiles.some(file => file !== `${captured.body.snapshot.snapshotId}.json`), false,
    'snapshot restore cannot create its backup while PUT holds the role lock')

  releasePut()
  const [putResult, restoreResult] = await Promise.all([putPromise, restorePromise])
  assert.equal(putResult.status, 200, JSON.stringify(putResult.body))
  assert.equal(restoreResult.status, 409)
  assert.equal(restoreResult.body.error, 'snapshot-restore-stale')
  assert.equal(currentFixture.editCalls, 1, 'the stale snapshot does not overwrite the completed PUT')
})

test('preview is handler-scoped and Host effect disposal clears it and closes the handler', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  const replacementResources = createAgentConfigurationResources(currentFixture.ctx, currentFixture.dependencies)
  const replacementHandler = createAgentConfigurationSnapshotsHandler(currentFixture.ctx, { ...currentFixture.dependencies, snapshotOperations: replacementResources.snapshotOperations })
  const crossHandler = await call(replacementHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'restore', role: 'center', previewId: preview.body.previewId,
  })
  assert.equal(crossHandler.status, 404)
  const edits = currentFixture.editCalls
  currentFixture.disposeEffects()
  const closed = await call(currentFixture.snapshotHandler, 'POST', '/tradeloom/agent-configuration/snapshots', {
    action: 'restore', role: 'center', previewId: preview.body.previewId,
  })
  assert.equal(closed.status, 503)
  assert.equal(closed.body.error, 'snapshot-handler-closed')
  assert.equal(currentFixture.editCalls, edits)
})

test('provider replacement after preview is stale and provider replacement during backup preserves backup id without editing', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  currentFixture.replaceService('configEditor', { ...currentFixture.editor })
  const stale = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error, 'snapshot-restore-stale')
  assert.equal(currentFixture.editCalls, 0)

  currentFixture = await fixture(t, { snapshotHooks: { async afterSnapshotWrite({ kind }) {
    if (kind === 'pre-restore-backup') currentFixture.replaceService('configEditor', { ...currentFixture.editor })
  } } })
  const source = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const active = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: source.body.snapshot.snapshotId })
  const rejected = await callCurrent('POST', { action: 'restore', role: 'center', previewId: active.body.previewId })
  assert.equal(rejected.status, 503)
  assert.equal(rejected.body.error, 'configuration-unavailable')
  assert.match(rejected.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 0)
})

test('provider replacement during ConfigEditor edit stops snapshot readback and compensation through the old provider', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.body.applicable, true)

  const oldEditor = currentFixture.editor
  const oldEntries = oldEditor.entries.bind(oldEditor)
  let providerReplaced = false
  let oldProviderReadsAfterReplacement = 0
  oldEditor.entries = () => {
    if (providerReplaced) oldProviderReadsAfterReplacement += 1
    return oldEntries()
  }
  currentFixture.onEdit = async ({ editCalls }) => {
    if (editCalls !== 1) return
    currentFixture.replaceService('configEditor', { ...oldEditor })
    providerReplaced = true
  }

  const result = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'snapshot-restore-outcome-unknown')
  assert.equal(result.body.restoreStatus, 'unknown')
  assert.match(result.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, 1, 'provider replacement must not trigger a compensating edit through the old editor')
  assert.equal(oldProviderReadsAfterReplacement, 0, 'provider replacement must be detected before old-editor readback')
})

test('a same-provider ConfigEditor edit may replace the active entry and fiber without invalidating the snapshot owner', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools = []
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.body.applicable, true)
  currentFixture.onEdit = async ({ entry, next }) => {
    const index = currentFixture.entries.indexOf(entry)
    assert.notEqual(index, -1)
    currentFixture.entries[index] = {
      ...entry,
      fiber: { state: 'active' },
      options: { ...entry.options, config: structuredClone(next) },
    }
  }

  const restored = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(restored.body.status, 'restored')
  assert.equal(currentFixture.editCalls, 1)
  assert.deepEqual(currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy').config.deniedTools, ['search_web'])
})

test('Host disposal during verified backup stops restore before ConfigEditor edit and returns backup id', async t => {
  currentFixture = await fixture(t, { snapshotHooks: { async afterSnapshotWrite({ kind }) {
    if (kind === 'pre-restore-backup') currentFixture.disposeEffects()
  } } })
  const source = await capture('center')
  const policy = currentFixture.entries[0].options.config.plugins.find(row => row.id === 'tradeloom-tool-policy')
  policy.config.deniedTools = []
  const before = structuredClone(currentFixture.entries[0].options.config)
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: source.body.snapshot.snapshotId })
  assert.equal(preview.body.applicable, true)
  const editsBefore = currentFixture.editCalls
  const result = await callCurrent('POST', { action: 'restore', role: 'center', previewId: preview.body.previewId })
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'snapshot-handler-closed')
  assert.match(result.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.equal(currentFixture.editCalls, editsBefore)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  const backupPath = join(currentFixture.home, 'tradeloom-agent-configuration-snapshots', 'center', `${result.body.backupSnapshotId}.json`)
  const backup = JSON.parse(await readFile(backupPath, 'utf8'))
  assert.equal(backup.kind, 'pre-restore-backup')
})
