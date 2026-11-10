import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAgentConfigurationController, createAgentConfigurationHandler } from '../agent-configuration.js'
import { createAgentConfigurationSnapshotsHandler } from '../agent-configuration-snapshots.js'
import { ROLE_PRESETS } from '../roles.js'
import { HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

test('normal package exports and files include configuration snapshot modules', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.exports['./agent-configuration'], './agent-configuration.js')
  assert.equal(packageJson.exports['./agent-configuration-snapshots'], './agent-configuration-snapshots.js')
  assert.ok(packageJson.files.includes('agent-configuration.js'))
  assert.ok(packageJson.files.includes('agent-configuration-snapshots.js'))
  const [configuration, snapshots] = await Promise.all([
    import('@tradeloom/dsh-business-shell/agent-configuration'),
    import('@tradeloom/dsh-business-shell/agent-configuration-snapshots'),
  ])
  assert.equal(typeof configuration.createAgentConfigurationController, 'function')
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
  let onEdit
  const editor = {
    documentPath: patchPath,
    entries() { return entries },
    async edit(entry, change) {
      editCalls += 1
      const next = change(structuredClone(entry.options.config), { plugins: [] })
      await onEdit?.({ entry, next, editCalls })
      entry.options.config = structuredClone(next)
    },
  }
  const profile = { name: 'tradeloom', home, dir: profileDir, patchPath, startedBundles: ['@tradeloom/dsh-business-shell'] }
  const resolveResults = []
  const cleanupEffects = []
  const serviceOverrides = new Map()
  const presets = {
    async resolve(id) { return resolveResults.length ? resolveResults.shift() : { id } },
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
    FiberState: { ACTIVE: 'active' }, env: fixtureEnv, toolNames: ['search_web'], roleWorkspacePath,
    ...(defaultReadOnlyWorkspace ? {} : { roleWorkspacePathReadOnly }),
    snapshotHooks,
  }
  const configurationController = createAgentConfigurationController(ctx, dependencies)
  const configHandler = createAgentConfigurationHandler(ctx, { ...dependencies, configurationController })
  const snapshotHandler = createAgentConfigurationSnapshotsHandler(ctx, { ...dependencies, configurationController })
  return {
    home, ctx, entries, editor, presets, env, dependencies, configHandler, snapshotHandler,
    get editCalls() { return editCalls }, set onEdit(value) { onEdit = value },
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
  assert.equal(failed.body.error, 'configuration-apply-failed')
  assert.match(failed.body.backupSnapshotId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(currentFixture.entries[0].options.config, before)
  assert.equal(currentFixture.editCalls, 2, 'the original controlled update and compensation both use ConfigEditor')
  const listed = await callCurrent('GET', listUrl('center'))
  assert.equal(listed.body.snapshots.some(row => row.kind === 'pre-restore-backup'), true)
})

test('preview is handler-scoped and Host effect disposal clears it and closes the handler', async t => {
  currentFixture = await fixture(t)
  const captured = await capture('center')
  const preview = await callCurrent('POST', { action: 'preview', role: 'center', snapshotId: captured.body.snapshot.snapshotId })
  assert.equal(preview.status, 200)
  const replacementHandler = createAgentConfigurationSnapshotsHandler(currentFixture.ctx, currentFixture.dependencies)
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
