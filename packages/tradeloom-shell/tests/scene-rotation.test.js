import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createSurfaceOwner } from '../../../apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/surface-owner.mjs'
import { getRoleBindingRevision, HOME_MARKER, HOME_MARKER_VALUE, ROLE_IDS } from '../state.js'
import { ROLE_PRESETS } from '../roles.js'
import { createSceneMemoryStore } from '../scene-memory-store.js'
import { createAgentConfigurationResources, createManagedConfigurationSequenceTracker } from '../agent-configuration.js'
import { createSceneRotationHandlers } from '../scene-rotation.js'
import { createNewSessionHandler } from '../host.js'

const clone = value => JSON.parse(JSON.stringify(value))

async function createPrivateTestHome(t, prefix) {
  const configuredRoot = process.env.O04_SCENE_ROTATION_TEST_ROOT
  if (configuredRoot !== undefined) assert.equal(isAbsolute(configuredRoot), true)
  const root = await realpath(configuredRoot === undefined ? tmpdir() : configuredRoot)
  assert.equal(isAbsolute(root), true)
  const home = await mkdtemp(join(root, prefix))
  const resolvedHome = await realpath(home)
  assert.equal(dirname(resolvedHome), root)
  assert.notEqual(resolve(resolvedHome), root)
  t.after(async () => {
    const current = await realpath(home).catch(() => undefined)
    if (current && dirname(current) === root && resolve(current) === resolvedHome && resolve(current) !== root) {
      await rm(current, { recursive: true, force: true })
    }
  })
  return { root, home, resolvedHome }
}

function createStateStore(initialState) {
  let state = clone(initialState)
  return {
    paths: { statePath: 'isolated-scene-rotation-state.json' },
    async read() { return clone(state) },
    async writeImmutableBackup() { throw new Error('unexpected legacy backup') },
    async verifyImmutableBackup() { throw new Error('unexpected legacy backup') },
    async transact(mutator, options = {}) {
      const previousBytes = Buffer.from(JSON.stringify(state), 'utf8')
      const draft = clone(state)
      const result = await mutator(draft)
      if (options.beforeRename) await options.beforeRename({ previousBytes })
      if (options.beforeCommitAttempt) await options.beforeCommitAttempt()
      options.validateCommit?.()
      if (!options.readOnly) state = draft
      return result
    },
  }
}

function makeSceneMemoryFixture() {
  const roleId = ROLE_IDS[0]
  const activeUntil = Date.now() + 60_000
  const operationId = 'o04-write-revision-test'
  const hostEpoch = 'o04-host-epoch-test'
  const state = {
    roles: {
      [roleId]: {
        sessionId: 'session-before-rotation',
        workspaceId: 'workspace-test',
        workspacePath: 'isolated-workspace',
        agentPreset: `tradeloom-${roleId}`,
      },
    },
    sceneMemoryMigration: { version: 1 },
    sceneMemories: {
      'scene-test': {
        value: { retained: true },
        lineage: { operationId: 'older-operation' },
        unrelated: { keep: 'this field' },
      },
    },
    sceneMemoryOperations: {
      [operationId]: { status: 'active', hostEpoch, expiresAt: activeUntil },
    },
  }
  const origin = {
    scope: 'role',
    sceneId: 'scene-test',
    panelId: 'panel-test',
    roleId,
    sessionId: state.roles[roleId].sessionId,
    workspaceId: state.roles[roleId].workspaceId,
    workspacePath: state.roles[roleId].workspacePath,
    agentPreset: state.roles[roleId].agentPreset,
    bindingRevision: getRoleBindingRevision(state, roleId),
    operationId,
    hostEpoch,
    activeUntil,
  }
  const stateStore = createStateStore(state)
  const store = createSceneMemoryStore({
    stateStore,
    isSessionLive: () => true,
    isSessionDurable: async () => true,
    isOperationActive: () => true,
  })
  return { stateStore, store, origin }
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

async function call(handler, method, url, body) {
  const res = response()
  await handler(request(method, url, body), res)
  return { res, body: res.body ? JSON.parse(res.body) : undefined }
}

function makeRotationServiceFixture({ createSession, withManagedConfigurationLock } = {}) {
  const roleId = ROLE_IDS[0]
  let state = {
    roles: { [roleId]: {
      sessionId: 'session-old', workspaceId: 'workspace-old', workspacePath: 'workspace-path-new', agentPreset: ROLE_PRESETS[roleId],
    } },
    roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, role === roleId ? '4' : '0'])),
    sceneMemories: { 'scene-test': { value: { keep: true }, writeRevision: 2 } },
  }
  const stateStore = {
    async read() { return clone(state) },
    queue: Promise.resolve(),
    transact(mutator, options = {}) {
      const run = this.queue.then(async () => {
      const draft = clone(state)
      const result = await mutator(draft)
      options.validateCommit?.()
      if (!options.readOnly) state = draft
      return result
      })
      this.queue = run.catch(() => {})
      return run
    },
  }
  const businessPaths = ['/home', '/products', '/agent-center', '/artifacts', '/runs']
  const scenes = {
    version: 1, grid: { cols: 4, rows: 4 },
    scenes: [{
      id: 'scene-test', label: 'Test', roleId, defaultBusinessRoute: '/home',
      panels: [
        { id: 'panel-test', title: 'Chat', type: 'native-chat', col: 1, row: 1, w: 1, h: 1 },
        ...businessPaths.map((path, index) => ({ id: `business-${index}`, title: `Business ${index}`, type: 'business-iframe', path, col: 1, row: 1, w: 1, h: 1 })),
      ],
    }],
    businessRoutes: Object.fromEntries(businessPaths.map((path, index) => [path, { sceneId: 'scene-test', panelId: `business-${index}` }])),
  }
  const workspaces = new Map([['workspace-old', { id: 'workspace-old', path: 'workspace-path-new', sessionIds: ['session-old'] }]])
  let createCalls = 0
  const ctx = {
    connection: { requestRejection: () => undefined },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [...workspaces.values()],
      get: id => workspaces.get(id),
      async create(path) { const workspace = { id: 'workspace-new', path, sessionIds: [] }; workspaces.set(workspace.id, workspace); return workspace },
      async archiveSession(sessionId, options) {
        assert.equal(options.stopActivity, false)
        if (!this.archivedSessionIds.includes(sessionId)) this.archivedSessionIds.push(sessionId)
      },
    },
    sessionController: {
      async create(input) {
        createCalls += 1
        if (createSession) return await createSession(input, workspaces)
        workspaces.get(input.workspaceId).sessionIds.push(input.sessionId)
        return { sessionId: input.sessionId, agentPreset: input.agentPreset }
      },
    },
  }
  const handlers = createSceneRotationHandlers(ctx, {
    createStateStore: async () => stateStore,
    roleWorkspacePath: async () => 'workspace-path-new',
    readScenes: async () => JSON.stringify(scenes),
    readManagedConfigurationIdentity: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    readManagedConfigurationIdentityUnderLock: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    withManagedConfigurationLock: withManagedConfigurationLock ?? (async (_role, callback) => await callback()),
    getHostEpoch: () => 'host-epoch-test',
    ensureDurableRoleSession: async (_ctx, sessionId) => () => [...workspaces.values()].some(workspace => workspace.sessionIds.includes(sessionId)),
    reconcileCreatedSession: async () => false,
  })
  return { roleId, stateStore, workspaces, ctx, scenes, handlers, get createCalls() { return createCalls } }
}

test('each successful scene-memory write increments the shared scene write revision once', async () => {
  const { stateStore, store, origin } = makeSceneMemoryFixture()

  await store.write(origin, 'scene-test', { retained: true })
  let state = await stateStore.read()
  assert.equal(state.sceneMemories['scene-test'].writeRevision, 1)
  assert.deepEqual(state.sceneMemories['scene-test'].unrelated, { keep: 'this field' })

  await store.write(origin, 'scene-test', { retained: true })
  state = await stateStore.read()
  assert.equal(state.sceneMemories['scene-test'].writeRevision, 2)
})

test('cross-role revision reads wait for the active global configuration mutation', async () => {
  let state = {}
  const digests = { roleA: 'before-A', roleB: 'stable-B' }
  const stateStore = {
    async read() { return clone(state) },
    async transact(mutator) {
      const draft = clone(state)
      const result = await mutator(draft)
      state = draft
      return result
    },
  }
  const tracker = createManagedConfigurationSequenceTracker({}, {
    createStateStore: async () => stateStore,
    resolveManagedConfigurationHome: async () => 'same-owned-home',
    readManagedConfigurationDigest: async role => digests[role],
  })

  let announceWriter
  const writerStarted = new Promise(resolve => { announceWriter = resolve })
  let releaseWriter
  const writerGate = new Promise(resolve => { releaseWriter = resolve })
  const writer = tracker.withLock('roleA', async () => {
    const token = await tracker.begin({ role: 'roleA', beforeDigest: 'before-A', intendedDigest: 'after-A' })
    announceWriter()
    await writerGate
    digests.roleA = 'after-A'
    await tracker.finish(token)
  })
  await writerStarted

  let readSettled = false
  const crossRoleRead = tracker.readIdentity('roleB').then(value => {
    readSettled = true
    return value
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(readSettled, false, 'a role-B preview must not reconcile role-A while its write is active')

  releaseWriter()
  await writer
  const identity = await crossRoleRead
  assert.equal(identity.managedConfigurationSequence, 1)
  assert.equal(identity.roleManagedConfigDigest, 'stable-B')
})

test('an unknown config mutation is reread before a new authorized write consumes its sequence', async () => {
  let state = {
    managedConfigurationMutationSequence: 7,
    managedConfigurationMutation: {
      sequence: 7,
      role: 'roleA',
      beforeDigest: 'before-A',
      intendedDigest: 'intended-A',
      status: 'unknown',
      writeStarted: true,
    },
  }
  const digests = { roleA: 'third-A', roleB: 'before-B' }
  const readRoles = []
  const stateStore = {
    async read() { return clone(state) },
    async transact(mutator) {
      const draft = clone(state)
      const result = await mutator(draft)
      state = draft
      return result
    },
  }
  const tracker = createManagedConfigurationSequenceTracker({}, {
    createStateStore: async () => stateStore,
    resolveManagedConfigurationHome: async () => 'same-owned-home',
    readManagedConfigurationDigest: async role => { readRoles.push(role); return digests[role] },
  })

  await assert.rejects(tracker.readIdentity('roleB'), error => error.code === 'managed-configuration-outcome-unknown')
  await tracker.withLock('roleB', async () => {
    const token = await tracker.begin({ role: 'roleB', beforeDigest: 'before-B', intendedDigest: 'after-B' })
    assert.equal(readRoles.includes('roleA'), true, 'recovery must reread the unresolved role from its trusted provider')
    assert.equal(state.managedConfigurationMutation.recoveredUnknownSequence, 7)
    digests.roleB = 'after-B'
    await tracker.finish(token)
  })
  const identity = await tracker.readIdentity('roleA')
  assert.equal(identity.managedConfigurationSequence, 8)
  assert.equal(identity.roleManagedConfigDigest, 'third-A')
})

test('trusted identity rejects invalid managed rows while preserving unrelated plugin shapes', async t => {
  const { root, home, resolvedHome } = await createPrivateTestHome(t, 'config-identity-')
  const profileDir = join(home, 'profiles', 'tradeloom')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)

  const entry = {
    options: {
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id: ROLE_PRESETS.center, plugins: { malformed: true } },
    },
    fiber: { state: 2 },
  }
  const profile = {
    name: 'tradeloom', home, dir: profileDir, patchPath,
    startedBundles: ['@tradeloom/dsh-business-shell'],
  }
  const ctx = {
    get(name) {
      if (name === 'configEditor') return { documentPath: patchPath, entries: () => [entry], edit: async () => {} }
      if (name === 'profileContext') return profile
      return undefined
    },
  }
  const tracker = createManagedConfigurationSequenceTracker(ctx, {
    createStateStore: async () => createStateStore({}),
    resolveOwnedHome: async () => home,
    resolveManagedConfigurationHome: async () => home,
  })

  await assert.rejects(tracker.readIdentity(ROLE_IDS[0]), error => {
    assert.equal(error.code, 'managed-configuration-schema-invalid')
    assert.equal(error.status, 503)
    return true
  })

  entry.options.config = {
    id: ROLE_PRESETS.center,
    plugins: [
      { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
      'unrelated legacy plugin row',
    ],
  }
  const identity = await tracker.readIdentity(ROLE_IDS[0])
  assert.equal(identity.managedConfigurationSequence, 0)
  assert.match(identity.roleManagedConfigDigest, /^[a-f0-9]{64}$/)
})

test('a real configuration PUT holds the global identity lock until its editor write is read back', async t => {
  const { root, home, resolvedHome } = await createPrivateTestHome(t, 'config-put-lock-')

  const profileDir = join(home, 'profiles', 'tradeloom')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const roles = [ROLE_IDS[0], ROLE_IDS[1]]
  const entries = new Map(roles.map(role => [role, {
    options: { name: '@deepseek-ai/dsh-agent-preset', config: {
      id: ROLE_PRESETS[role], plugins: [
        { id: 'tradeloom-tool-policy', name: '@tradeloom/dsh-business-shell/tool-policy', config: { deniedTools: [] } },
      ],
    } },
    fiber: { state: 2 },
  }]))
  let editStarted
  const started = new Promise(resolveStarted => { editStarted = resolveStarted })
  let releaseEdit
  const editGate = new Promise(resolveEdit => { releaseEdit = resolveEdit })
  let snapshotEditStarted
  const snapshotStarted = new Promise(resolveStarted => { snapshotEditStarted = resolveStarted })
  let releaseSnapshotEdit
  const snapshotEditGate = new Promise(resolveEdit => { releaseSnapshotEdit = resolveEdit })
  let holdFirstEdit = true
  let holdSnapshotEdit = true
  const editor = {
    documentPath: patchPath,
    entries: () => [...entries.values()],
    async edit(selected, change) {
      if (selected === entries.get(roles[0]) && holdFirstEdit) {
        holdFirstEdit = false
        editStarted()
        await editGate
      } else if (selected === entries.get(roles[0]) && holdSnapshotEdit) {
        holdSnapshotEdit = false
        snapshotEditStarted()
        await snapshotEditGate
      }
      selected.options.config = structuredClone(change(structuredClone(selected.options.config), { plugins: [] }))
    },
  }
  const profile = {
    name: 'tradeloom', home, dir: profileDir, patchPath,
    startedBundles: ['@tradeloom/dsh-business-shell'],
  }
  let state = {}
  const stateStore = {
    async read() { return clone(state) },
    async transact(mutator, options = {}) {
      const draft = clone(state)
      const result = await mutator(draft)
      options.validateCommit?.()
      if (!options.readOnly) state = draft
      return result
    },
  }
  const ctx = {
    connection: { requestRejection: () => undefined },
    get(name) {
      if (name === 'configEditor') return editor
      if (name === 'profileContext') return profile
      if (name === 'agentPresets') return { resolve: async id => ({ id }) }
      return undefined
    },
  }
  const resources = createAgentConfigurationResources(ctx, {
    createStateStore: async () => stateStore,
    resolveOwnedHome: async () => home,
    resolveManagedConfigurationHome: async () => home,
    FiberState: { ACTIVE: 2 },
    toolNames: ['search_web'],
    roleWorkspacePathReadOnly: async role => {
      const workspace = join(home, 'tradeloom-workspaces', role)
      await mkdir(workspace, { recursive: true })
      return workspace
    },
  })
  const initial = await call(resources.configurationHandler, 'GET', `/tradeloom/agent-configuration?role=${roles[0]}`)
  assert.equal(initial.res.statusCode, 200)
  const put = call(resources.configurationHandler, 'PUT', `/tradeloom/agent-configuration?role=${roles[0]}`, {
    expectedRevision: initial.body.revision,
    mcpServers: [], skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: ['search_web'],
  })
  await started

  let readerSettled = false
  const crossRoleRead = resources.readManagedConfigurationIdentity(roles[1]).then(value => {
    readerSettled = true
    return value
  })
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  assert.equal(readerSettled, false, 'an actual PUT pending in configEditor.edit must block a cross-role identity read')

  releaseEdit()
  const result = await put
  assert.equal(result.res.statusCode, 200)
  const identity = await crossRoleRead
  assert.equal(identity.managedConfigurationSequence, 1)
  assert.match(identity.roleManagedConfigDigest, /^[a-f0-9]{64}$/)

  let snapshotReaderSettled = false
  const snapshotUpdate = resources.snapshotOperations.withRole(roles[0], async operations => {
    const current = await operations.read()
    const input = { expectedRevision:current.revision, mcpServers:[],
      skill:{ includeDefaultRoots:true, customSkillDirs:[] }, deniedTools:[] }
    const preview = await operations.preview(input)
    assert.equal(preview.current.revision, current.revision)
    return await operations.update(input)
  })
  await snapshotStarted
  const snapshotCrossRoleRead = resources.readManagedConfigurationIdentity(roles[1]).then(value => {
    snapshotReaderSettled = true
    return value
  })
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  assert.equal(snapshotReaderSettled, false, 'an actual snapshot mutation must hold the global identity lock through editor write/readback')
  releaseSnapshotEdit()
  const snapshotResult = await snapshotUpdate
  assert.match(snapshotResult.revision, /^[a-f0-9]{64}$/)
  const snapshotIdentity = await snapshotCrossRoleRead
  assert.equal(snapshotIdentity.managedConfigurationSequence, 2)
  assert.match(snapshotIdentity.roleManagedConfigDigest, /^[a-f0-9]{64}$/)
})

test('the legacy new-session route and scene rotation share one per-role claim', async t => {
  async function makeSharedFixture() {
    let signalCreateStarted
    const createStarted = new Promise(resolveStarted => { signalCreateStarted = resolveStarted })
    let releaseCreate
    const createGate = new Promise(resolveCreate => { releaseCreate = resolveCreate })
    const agents = new Map()
    let fixture
    fixture = makeRotationServiceFixture({ createSession: async (input, workspaces) => {
      signalCreateStarted(input)
      await createGate
      const workspace = workspaces.get(input.workspaceId)
      workspace.sessionIds.push(input.sessionId)
      const persistence = fixture.ctx.get('sessionPersistence')
      const agent = { id: input.sessionId, session: { id: input.sessionId, seq: 0 }, ctx: { get: () => persistence } }
      agents.set(input.sessionId, agent)
      return { sessionId: input.sessionId, agentPreset: input.agentPreset }
    } })
    const persistence = {
      identity: {},
      async flush() {},
      async stat(sessionId) {
        const workspace = [...fixture.workspaces.values()].find(item => item.sessionIds.includes(sessionId))
        if (!workspace) throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { header: { id: sessionId, cwd: workspace.path, agentPreset: ROLE_PRESETS[fixture.roleId] } }
      },
    }
    fixture.ctx.connection = { requestRejection: () => undefined }
    fixture.ctx.logger = { error() {} }
    fixture.ctx.agents = { get: id => agents.get(id) }
    fixture.ctx.get = name => name === 'sessionPersistence' ? persistence : undefined
    fixture.ctx.sessionQuery = {
      async observeSession(sessionId) {
        const workspace = [...fixture.workspaces.values()].find(item => item.sessionIds.includes(sessionId))
        if (!workspace) throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return {
          header: { id: sessionId, cwd: workspace.path }, cursor: -1,
          projections: { values: { agentPreset: ROLE_PRESETS[fixture.roleId] } }, events: [],
        }
      },
    }
    const newSession = createNewSessionHandler(fixture.ctx, {
      createStateStore: async () => fixture.stateStore,
      resolveOwnedHome: async () => 'isolated-o04-home',
      roleWorkspacePath: async () => 'workspace-path-new',
    })
    return { fixture, newSession, createStarted, releaseCreate }
  }

  const rotationFirst = await makeSharedFixture()
  t.after(() => rotationFirst.fixture.handlers.dispose())
  const rotationPreview = await call(rotationFirst.fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test',
  })
  const rotationConfirm = call(rotationFirst.fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', {
    previewToken: rotationPreview.body.previewToken,
  })
  await rotationFirst.createStarted
  const blockedLegacyCreate = await call(rotationFirst.newSession, 'POST', '/tradeloom/session/new', {
    role: rotationFirst.fixture.roleId,
    expectedSessionId: 'session-old',
    operationId: '00000000-0000-4000-8000-000000000001',
  })
  assert.equal(blockedLegacyCreate.res.statusCode, 409)
  assert.equal(blockedLegacyCreate.body.error, 'session-create-in-progress')
  assert.equal(rotationFirst.fixture.createCalls, 1)
  rotationFirst.releaseCreate()
  assert.equal((await rotationConfirm).res.statusCode, 200)

  const legacyFirst = await makeSharedFixture()
  t.after(() => legacyFirst.fixture.handlers.dispose())
  const legacyCreate = call(legacyFirst.newSession, 'POST', '/tradeloom/session/new', {
    role: legacyFirst.fixture.roleId,
    expectedSessionId: 'session-old',
    operationId: '00000000-0000-4000-8000-000000000002',
  })
  await legacyFirst.createStarted
  const blockedRotationPreview = await call(legacyFirst.fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test',
  })
  assert.equal(typeof blockedRotationPreview.body.previewToken, 'string')
  const blockedRotation = await call(legacyFirst.fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', {
    previewToken: blockedRotationPreview.body.previewToken,
  })
  assert.equal(blockedRotation.res.statusCode, 409)
  assert.equal(blockedRotation.body.error, 'rotation-in-progress')
  assert.equal(legacyFirst.fixture.createCalls, 1)
  legacyFirst.releaseCreate()
  const legacyResult = await legacyCreate
  assert.equal(legacyResult.res.statusCode, 201)
  assert.equal(legacyFirst.fixture.createCalls, 1)
})

test('archive-pending rotation is rediscovered by its current role binding after handler restart', async t => {
  const fixture = makeRotationServiceFixture()
  let archiveCalls = 0
  fixture.ctx.workspaceRegistry.archiveSession = async (sessionId, options) => {
    assert.equal(sessionId, 'session-old')
    assert.deepEqual(options, { stopActivity: false })
    archiveCalls += 1
    if (archiveCalls === 1) throw new Error('simulated archive interruption')
    fixture.ctx.workspaceRegistry.archivedSessionIds.push(sessionId)
  }
  t.after(() => fixture.handlers.dispose())
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test', archiveOld: true,
  })
  const confirmed = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', {
    previewToken: preview.body.previewToken,
  })
  assert.equal(confirmed.res.statusCode, 200)
  assert.equal(confirmed.body.status, 'archive_pending')
  const persisted = await fixture.stateStore.read()
  assert.equal(persisted.pendingSceneRotationByRole?.[fixture.roleId], undefined,
    'a bound archive retry must not occupy the role new-session claim')

  await fixture.handlers.dispose()
  const restartedHandlers = createSceneRotationHandlers(fixture.ctx, {
    createStateStore: async () => fixture.stateStore,
    roleWorkspacePath: async () => 'workspace-path-new',
    readScenes: async () => JSON.stringify(fixture.scenes),
    readManagedConfigurationIdentity: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    readManagedConfigurationIdentityUnderLock: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    withManagedConfigurationLock: async (_role, callback) => await callback(),
    getHostEpoch: () => 'host-epoch-test',
    ensureDurableRoleSession: async (_ctx, sessionId) => () => [...fixture.workspaces.values()].some(workspace => workspace.sessionIds.includes(sessionId)),
    reconcileCreatedSession: async () => false,
  })
  t.after(() => restartedHandlers.dispose())
  const discovered = await call(restartedHandlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test',
  })
  assert.deepEqual(discovered.body.pendingOperation, {
    operationId: confirmed.body.operationId, sceneId: 'scene-test', panelId: 'panel-test',
    roleId: fixture.roleId, status: 'archive_pending', sessionId: confirmed.body.sessionId,
  })
  const resumed = await call(restartedHandlers.resume, 'POST', '/tradeloom/scene-rotation/resume', {
    operationId: confirmed.body.operationId,
  })
  assert.equal(resumed.res.statusCode, 200)
  assert.equal(resumed.body.status, 'completed')
  assert.equal(resumed.body.sessionId, confirmed.body.sessionId)
  assert.equal(fixture.createCalls, 1)
  assert.equal(archiveCalls, 2)
  assert.deepEqual(fixture.ctx.workspaceRegistry.archivedSessionIds, ['session-old'])
})

test('bound archive rotation is recoverable after restart before the first archive call', async t => {
  const fixture = makeRotationServiceFixture()
  const archiveSession = async (sessionId, options) => {
    assert.equal(sessionId, 'session-old')
    assert.deepEqual(options, { stopActivity: false })
    fixture.ctx.workspaceRegistry.archivedSessionIds.push(sessionId)
  }
  fixture.ctx.workspaceRegistry.archiveSession = undefined
  t.after(() => fixture.handlers.dispose())
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test', archiveOld: true,
  })
  const interrupted = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', {
    previewToken: preview.body.previewToken,
  })
  assert.equal(interrupted.res.statusCode, 503)
  assert.equal(interrupted.body.error, 'rotation-archive-unavailable')
  const persisted = await fixture.stateStore.read()
  assert.equal(persisted.sceneRotationOperations[preview.body.operationId].status, 'bound')
  assert.equal(persisted.pendingSceneRotationByRole?.[fixture.roleId], undefined)

  fixture.ctx.workspaceRegistry.archiveSession = archiveSession
  await fixture.handlers.dispose()
  const restartedHandlers = createSceneRotationHandlers(fixture.ctx, {
    createStateStore: async () => fixture.stateStore,
    roleWorkspacePath: async () => 'workspace-path-new',
    readScenes: async () => JSON.stringify(fixture.scenes),
    readManagedConfigurationIdentity: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    readManagedConfigurationIdentityUnderLock: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    withManagedConfigurationLock: async (_role, callback) => await callback(),
    getHostEpoch: () => 'host-epoch-test',
    ensureDurableRoleSession: async (_ctx, sessionId) => () => [...fixture.workspaces.values()].some(workspace => workspace.sessionIds.includes(sessionId)),
    reconcileCreatedSession: async () => false,
  })
  t.after(() => restartedHandlers.dispose())
  const rediscovered = await call(restartedHandlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test',
  })
  assert.equal(rediscovered.body.pendingOperation.operationId, preview.body.operationId)
  assert.equal(rediscovered.body.pendingOperation.status, 'bound')
  const resumed = await call(restartedHandlers.resume, 'POST', '/tradeloom/scene-rotation/resume', {
    operationId: preview.body.operationId,
  })
  assert.equal(resumed.res.statusCode, 200)
  assert.equal(resumed.body.status, 'completed')
  assert.equal(fixture.createCalls, 1)
  assert.deepEqual(fixture.ctx.workspaceRegistry.archivedSessionIds, ['session-old'])
})

test('preview confirmation creates one durable session and binds only the captured role', async () => {
  const roleId = ROLE_IDS[0]
  const initialState = {
    roles: { [roleId]: {
      sessionId: 'session-old', workspaceId: 'workspace-old', workspacePath: 'workspace-path-new', agentPreset: ROLE_PRESETS[roleId],
    } },
    roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, role === roleId ? '4' : '0'])),
    sceneMemories: { 'scene-test': { value: { keep: true }, writeRevision: 2 } },
  }
  let state = clone(initialState)
  const stateStore = {
    async read() { return clone(state) },
    async transact(mutator, options = {}) {
      const draft = clone(state)
      const result = await mutator(draft)
      options.validateCommit?.()
      if (!options.readOnly) state = draft
      return result
    },
  }
  const businessPaths = ['/home', '/products', '/agent-center', '/artifacts', '/runs']
  const scenes = {
    version: 1, grid: { cols: 4, rows: 4 },
    scenes: [{
      id: 'scene-test', label: 'Test', roleId, defaultBusinessRoute: '/home',
      panels: [
        { id: 'panel-test', title: 'Chat', type: 'native-chat', col: 1, row: 1, w: 1, h: 1 },
        ...businessPaths.map((path, index) => ({
          id: `business-${index}`, title: `Business ${index}`, type: 'business-iframe', path,
          col: 1, row: 1, w: 1, h: 1,
        })),
      ],
    }],
    businessRoutes: Object.fromEntries(businessPaths.map((path, index) => [path, { sceneId: 'scene-test', panelId: `business-${index}` }])),
  }
  const workspaces = new Map([['workspace-old', { id: 'workspace-old', path: 'workspace-path-new', sessionIds: ['session-old'] }]])
  let createCalls = 0
  const ctx = {
    connection: { requestRejection: () => undefined },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [...workspaces.values()],
      get: id => workspaces.get(id),
      async create(path) {
        const workspace = { id: 'workspace-new', path, sessionIds: [] }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
    },
    sessionController: {
      async create({ workspaceId, sessionId, agentPreset }) {
        createCalls += 1
        workspaces.get(workspaceId).sessionIds.push(sessionId)
        return { sessionId, agentPreset }
      },
    },
  }
  const handlers = createSceneRotationHandlers(ctx, {
    createStateStore: async () => stateStore,
    roleWorkspacePath: async () => 'workspace-path-new',
    readScenes: async () => JSON.stringify(scenes),
    readManagedConfigurationIdentity: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    readManagedConfigurationIdentityUnderLock: async () => ({ managedConfigurationSequence: 3, roleManagedConfigDigest: 'a'.repeat(64) }),
    withManagedConfigurationLock: async (_role, callback) => await callback(),
    getHostEpoch: () => 'host-epoch-test',
    ensureDurableRoleSession: async (_ctx, sessionId) => () => [...workspaces.values()].some(workspace => workspace.sessionIds.includes(sessionId)),
    reconcileCreatedSession: async () => false,
  })
  const preview = await call(handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', {
    sceneId: 'scene-test', panelId: 'panel-test',
  })
  assert.equal(preview.res.statusCode, 200)
  const confirmBody = { previewToken: preview.body.previewToken }
  const [confirmed, concurrentConfirm] = await Promise.all([
    call(handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', confirmBody),
    call(handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', confirmBody),
  ])
  assert.equal(confirmed.res.statusCode, 200, JSON.stringify(confirmed.body))
  assert.equal(concurrentConfirm.res.statusCode, 200)
  assert.equal(concurrentConfirm.body.operationId, confirmed.body.operationId)
  assert.equal(createCalls, 1)
  assert.equal((await stateStore.read()).roles[roleId].sessionId, confirmed.body.sessionId)
  const replayed = await call(handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', {
    previewToken: preview.body.previewToken,
  })
  assert.equal(replayed.res.statusCode, 200)
  assert.equal(replayed.body.replayed, true)
  assert.equal(replayed.body.sessionId, confirmed.body.sessionId)
  const status = await call(handlers.status, 'POST', '/tradeloom/scene-rotation/status', {
    operationId: preview.body.operationId,
  })
  assert.equal(status.body.status, 'completed')
  assert.equal(createCalls, 1)
  handlers.dispose()
})

test('cancelling a fresh preview makes no journal, binding, or SDK change', async () => {
  const fixture = makeRotationServiceFixture()
  const before = await fixture.stateStore.read()
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  assert.equal(preview.res.statusCode, 200)
  const cancelled = await call(fixture.handlers.cancel, 'POST', '/tradeloom/scene-rotation/cancel', { previewToken:preview.body.previewToken })
  assert.equal(cancelled.res.statusCode, 200)
  assert.equal(cancelled.body.cancelled, true)
  assert.deepEqual(await fixture.stateStore.read(), before)
  assert.equal(fixture.createCalls, 0)
  const confirm = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  assert.equal(confirm.res.statusCode, 409)
  assert.equal(fixture.createCalls, 0)
  await fixture.handlers.dispose()
})

test('abandon during a held create releases only its pointer and prevents the late callback from binding', async () => {
  let createStarted
  const started = new Promise(resolve => { createStarted = resolve })
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const fixture = makeRotationServiceFixture({ createSession: async (input, workspaces) => {
    createStarted()
    await createGate
    workspaces.get(input.workspaceId).sessionIds.push(input.sessionId)
    return { sessionId:input.sessionId, agentPreset:input.agentPreset }
  } })
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  const confirming = call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  await started
  const abandoned = await call(fixture.handlers.abandon, 'POST', '/tradeloom/scene-rotation/abandon', { operationId:preview.body.operationId })
  assert.equal(abandoned.res.statusCode, 200)
  assert.equal(abandoned.body.abandoned, true)
  assert.equal(abandoned.body.pendingReleased, true)
  assert.equal(abandoned.body.externalEffectStatus, 'unknown-or-created')
  releaseCreate()
  const lateResult = await confirming
  assert.equal(lateResult.res.statusCode, 409)
  const state = await fixture.stateStore.read()
  assert.equal(state.roles[fixture.roleId].sessionId, 'session-old')
  assert.equal(state.pendingSceneRotationByRole?.[fixture.roleId], undefined)
  assert.equal(state.sceneRotationOperations[preview.body.operationId].status, 'abandoned')
  assert.equal(fixture.createCalls, 1)
  assert.ok([...fixture.workspaces.values()].some(workspace => workspace.sessionIds.includes(abandoned.body.sessionId)))
  await fixture.handlers.dispose()
})

test('abandon releases its own pending pointer after an unrelated binding change without touching that binding', async () => {
  let createStarted
  const started = new Promise(resolve => { createStarted = resolve })
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const fixture = makeRotationServiceFixture({ createSession: async () => { createStarted(); await createGate; throw new Error('create response unavailable') } })
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  const confirming = call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  await started
  await fixture.stateStore.transact(state => {
    state.roles[fixture.roleId] = { ...state.roles[fixture.roleId], sessionId:'session-owned-by-other-operation' }
  })
  let abandoned
  try {
    abandoned = await call(fixture.handlers.abandon, 'POST', '/tradeloom/scene-rotation/abandon', { operationId:preview.body.operationId })
  } finally {
    releaseCreate()
  }
  await confirming
  assert.equal(abandoned.res.statusCode, 200)
  assert.equal(abandoned.body.abandoned, true)
  assert.equal(abandoned.body.pendingReleased, true)
  assert.equal(abandoned.body.bindingChanged, true)
  const state = await fixture.stateStore.read()
  assert.equal(state.roles[fixture.roleId].sessionId, 'session-owned-by-other-operation', 'abandon does not restore or overwrite the third-party binding')
  assert.equal(state.pendingSceneRotationByRole?.[fixture.roleId], undefined, 'only this operation’s pointer is released')
  assert.equal(state.sceneRotationOperations[preview.body.operationId].status, 'abandoned')
  assert.equal(fixture.createCalls, 1)
  await fixture.handlers.dispose()
})

test('abandon never releases another operation pointer after a binding change', async () => {
  let createStarted
  const started = new Promise(resolve => { createStarted = resolve })
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const fixture = makeRotationServiceFixture({ createSession: async () => { createStarted(); await createGate; throw new Error('create response unavailable') } })
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  const confirming = call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  await started
  await fixture.stateStore.transact(state => {
    state.roles[fixture.roleId] = { ...state.roles[fixture.roleId], sessionId:'session-owned-by-other-operation' }
    state.pendingSceneRotationByRole[fixture.roleId] = 'another-operation'
  })
  let abandoned
  try {
    abandoned = await call(fixture.handlers.abandon, 'POST', '/tradeloom/scene-rotation/abandon', { operationId:preview.body.operationId })
  } finally {
    releaseCreate()
  }
  await confirming
  assert.equal(abandoned.res.statusCode, 409)
  assert.equal(abandoned.body.error, 'rotation-binding-changed')
  const state = await fixture.stateStore.read()
  assert.equal(state.roles[fixture.roleId].sessionId, 'session-owned-by-other-operation')
  assert.equal(state.pendingSceneRotationByRole?.[fixture.roleId], 'another-operation')
  assert.equal(state.sceneRotationOperations[preview.body.operationId].status, 'creating')
  assert.equal(fixture.createCalls, 1)
  await fixture.handlers.dispose()
})

test('a lost create response remains unknown and resume never issues a second create', async () => {
  const fixture = makeRotationServiceFixture({ createSession: async (input, workspaces) => {
    workspaces.get(input.workspaceId).sessionIds.push(input.sessionId)
    throw new Error('simulated lost response after the SDK created the exact session')
  } })
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  const confirm = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  assert.equal(confirm.res.statusCode, 503)
  assert.equal(confirm.body.error, 'rotation-outcome-unknown')
  const resume = await call(fixture.handlers.resume, 'POST', '/tradeloom/scene-rotation/resume', { operationId:preview.body.operationId })
  assert.equal(resume.res.statusCode, 409)
  assert.equal(resume.body.error, 'rotation-outcome-unknown')
  assert.equal(fixture.createCalls, 1)
  const state = await fixture.stateStore.read()
  assert.equal(state.sceneRotationOperations[preview.body.operationId].status, 'creating')
  assert.equal(state.roles[fixture.roleId].sessionId, 'session-old')
  await fixture.handlers.dispose()
})

test('two independently previewed rotations for the same role permit only one SDK create', async () => {
  const fixture = makeRotationServiceFixture()
  const [firstPreview, secondPreview] = await Promise.all([
    call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' }),
    call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' }),
  ])
  assert.equal(firstPreview.res.statusCode, 200)
  assert.equal(secondPreview.res.statusCode, 200)
  assert.notEqual(firstPreview.body.operationId, secondPreview.body.operationId)
  const results = await Promise.all([
    call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:firstPreview.body.previewToken }),
    call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:secondPreview.body.previewToken }),
  ])
  assert.equal(results.filter(result => result.res.statusCode === 200).length, 1)
  assert.equal(results.filter(result => result.res.statusCode === 409 && result.body.error === 'rotation-in-progress').length, 1)
  assert.equal(fixture.createCalls, 1)
  const state = await fixture.stateStore.read()
  assert.equal(state.pendingSceneRotationByRole?.[fixture.roleId], undefined)
  assert.equal(state.roles[fixture.roleId].sessionId, results.find(result => result.res.statusCode === 200).body.sessionId)
  await fixture.handlers.dispose()
})

test('a role change after preview rejects before creating a session', async () => {
  const fixture = makeRotationServiceFixture()
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  fixture.scenes.scenes[0].panels[0].roleId = ROLE_IDS[1]
  const confirmed = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  assert.equal(confirmed.res.statusCode, 409)
  assert.equal(confirmed.body.error, 'rotation-stale-target')
  assert.equal(fixture.createCalls, 0)
  assert.equal((await fixture.stateStore.read()).roles[fixture.roleId].sessionId, 'session-old')
  await fixture.handlers.dispose()
})

test('dispose waits for an in-flight create and prevents its late binding write', async () => {
  let createStarted
  const started = new Promise(resolve => { createStarted = resolve })
  let releaseCreate
  const createGate = new Promise(resolve => { releaseCreate = resolve })
  const fixture = makeRotationServiceFixture({ createSession: async (input, workspaces) => {
    createStarted()
    await createGate
    workspaces.get(input.workspaceId).sessionIds.push(input.sessionId)
    return { sessionId:input.sessionId, agentPreset:input.agentPreset }
  } })
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test' })
  const confirming = call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  await started
  let disposed = false
  const disposing = fixture.handlers.dispose().then(() => { disposed = true })
  await new Promise(resolveTick => setTimeout(resolveTick, 0))
  assert.equal(disposed, false)
  releaseCreate()
  const confirmed = await confirming
  await disposing
  assert.equal(disposed, true)
  assert.equal(confirmed.res.statusCode, 503)
  assert.equal((await fixture.stateStore.read()).roles[fixture.roleId].sessionId, 'session-old')
  assert.equal(fixture.createCalls, 1)
})

test('archive retry does not stop the old session and bound abandon preserves the new binding', async () => {
  const fixture = makeRotationServiceFixture()
  let archiveCalls = 0
  fixture.ctx.workspaceRegistry.archiveSession = async (sessionId, options) => {
    archiveCalls += 1
    assert.equal(sessionId, 'session-old')
    assert.equal(options.stopActivity, false)
    if (archiveCalls === 1) throw new Error('simulated archive failure')
    fixture.ctx.workspaceRegistry.archivedSessionIds.push(sessionId)
  }
  const preview = await call(fixture.handlers.preview, 'POST', '/tradeloom/scene-rotation/preview', { sceneId:'scene-test', panelId:'panel-test', archiveOld:true })
  const confirmed = await call(fixture.handlers.confirm, 'POST', '/tradeloom/scene-rotation/confirm', { previewToken:preview.body.previewToken })
  assert.equal(confirmed.res.statusCode, 200)
  assert.equal(confirmed.body.status, 'archive_pending')
  const newSessionId = confirmed.body.sessionId
  const resumed = await call(fixture.handlers.resume, 'POST', '/tradeloom/scene-rotation/resume', { operationId:preview.body.operationId })
  assert.equal(resumed.res.statusCode, 200)
  assert.equal(resumed.body.status, 'completed')
  assert.equal(archiveCalls, 2)
  const abandoned = await call(fixture.handlers.abandon, 'POST', '/tradeloom/scene-rotation/abandon', { operationId:preview.body.operationId })
  assert.equal(abandoned.res.statusCode, 200)
  assert.equal(abandoned.body.alreadyBound, true)
  assert.equal((await fixture.stateStore.read()).roles[fixture.roleId].sessionId, newSessionId)
  await fixture.handlers.dispose()
})

test('rotation surface refresh rechecks its captured owner after every await and preserves real popout ownership', async () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const sourcePath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs')
  const source = await readFile(sourcePath, 'utf8')
  const start = source.indexOf('      const refreshRoleRotationSurfaces = async (result, assertCapturedOwner) => {')
  const end = source.indexOf('\n      const runRotationRequest =', start)
  assert.ok(start >= 0 && end > start, 'the production refresh helper is present')
  const helperSource = source.slice(start, end).trim()
  const sceneId = 'scene-center', panelId = 'panel-popout', roleId = 'center'
  const id = JSON.stringify([sceneId, panelId])
  const filesPanelId = 'panel-files', otherPanelId = 'panel-other-role'
  const filesId = JSON.stringify([sceneId, filesPanelId]), otherId = JSON.stringify([sceneId, otherPanelId])
  const makeFixture = ({ getConfig, resolveBinding }) => {
    const mainWindow = { frame: { url: 'dsh-app://app/source-shell/main.html' } }
    const registry = createSurfaceOwner(mainWindow)
    const webContents = { mainFrame: { url: 'dsh-app://app/source-shell/renderer/scene-entry.html' }, isDestroyed: () => false }
    const view = { frame: webContents.mainFrame, webContents }
    const wrapper = { frame: webContents.mainFrame, destroy() {} }
    const partition = 'persist:o04-private-fixture'
    const item = { sceneId, panelId, roleId, sessionId: 'session-old', bindingRevision: 'rev-old', wrapper,
      surface: 'chat', view, status: 'document-loaded', loaded: true }
    registry.attach({ sceneId, panelId, sessionId: item.sessionId, view: wrapper, partition, surface: 'chat' })
    const filesWebContents = { mainFrame: { url: 'dsh-app://app/source-shell/renderer/scene-entry.html' }, isDestroyed: () => false }
    const filesView = { frame: filesWebContents.mainFrame, webContents: filesWebContents }
    const filesWrapper = { frame: filesWebContents.mainFrame, destroy() {} }
    const filesItem = { sceneId, panelId: filesPanelId, roleId, sessionId: 'session-old', bindingRevision: 'rev-old',
      wrapper: filesWrapper, surface: 'files', view: filesView, status: 'document-loaded', loaded: true }
    registry.attach({ sceneId, panelId: filesPanelId, sessionId: filesItem.sessionId, view: filesWrapper, partition, surface: 'files' })
    const otherWebContents = { mainFrame: { url: 'dsh-app://app/source-shell/renderer/scene-entry.html' }, isDestroyed: () => false }
    const otherView = { frame: otherWebContents.mainFrame, webContents: otherWebContents }
    const otherWrapper = { frame: otherWebContents.mainFrame, destroy() {} }
    const otherItem = { sceneId, panelId: otherPanelId, roleId: 'trader', sessionId: 'session-trader', bindingRevision: 'rev-trader',
      wrapper: otherWrapper, surface: 'chat', view: otherView, status: 'document-loaded', loaded: true }
    registry.attach({ sceneId, panelId: otherPanelId, sessionId: otherItem.sessionId, view: otherWrapper, partition, surface: 'chat' })
    const popout = { id: 91, webContents: { mainFrame: { url: 'about:blank' }, isDestroyed: () => false, send() {} },
      getContentBounds: () => ({ x: 17, y: 23, width: 640, height: 480 }), isDestroyed: () => false }
    const wrap = window => ({ id: window.id, get frame() { return window.webContents.mainFrame },
      get bounds() { return window.getContentBounds() }, window })
    registry.rehome(sceneId, panelId, wrap(popout))
    const views = new Map([[id, item], [filesId, filesItem], [otherId, otherItem]])
    const rolePopouts = new Map([[id, popout]])
    const panels = [{ id: panelId, type: 'native-chat', roleId }, { id: filesPanelId, type: 'native-workspace', roleId },
      { id: otherPanelId, type: 'native-chat', roleId: 'trader' }]
    let config = { scenes: [{ id: sceneId, panels }], sessionBindings: { [roleId]: 'session-old', trader: 'session-trader' } }
    const context = { getConfig, resolveBinding, config, registry, views, rolePopouts, ownedPartition: partition,
      key: (scene, panel) => JSON.stringify([scene, panel]), wrap,
      orderedScenes: order => order.map(scene => config.scenes.find(candidate => candidate.id === scene)).filter(Boolean),
      notifyGuest() {}, emit() {} }
    const refresh = runInNewContext(`(() => { ${helperSource}; return refreshRoleRotationSurfaces })()`, context, { filename: sourcePath })
    return { refresh, context, item, filesItem, otherItem, registry, popout }
  }
  const result = { status: 'bound', roleId, sessionId: 'session-new' }

  for (const stage of ['getConfig', 'resolveBinding']) {
    let valid = true
    let release
    const held = new Promise(resolvePromise => { release = resolvePromise })
    const f = makeFixture({
      getConfig: async () => { if (stage === 'getConfig') await held; return { scenes: [{ id: sceneId, panels: [
        { id: panelId, type: 'native-chat', roleId }, { id: filesPanelId, type: 'native-workspace', roleId }, { id: otherPanelId, type: 'native-chat', roleId: 'trader' },
      ] }, { id: 'scene-other', panels: [] }], sessionBindings: { [roleId]: 'session-new', trader: 'session-trader' } } },
      resolveBinding: async ({ panelId: targetPanel }) => { if (stage === 'resolveBinding') await held; return { sceneId, panelId: targetPanel, bindingStatus: 'bound', sessionId: 'session-new', bindingRevision: 'rev-new' } },
    })
    const beforeSeats = [f.registry.get(sceneId, panelId), f.registry.get(sceneId, filesPanelId), f.registry.get(sceneId, otherPanelId)]
    const beforeItemSessions = [f.item.sessionId, f.filesItem.sessionId, f.otherItem.sessionId]
    const pending = f.refresh(result, () => { if (!valid) throw new Error('scene rotation owner changed') })
    await new Promise(resolvePromise => setImmediate(resolvePromise))
    valid = false
    release()
    await assert.rejects(pending, /scene rotation owner changed/)
    assert.equal(f.registry.get(sceneId, panelId), beforeSeats[0], `${stage}: chat registry seat is unchanged`)
    assert.equal(f.registry.get(sceneId, filesPanelId), beforeSeats[1], `${stage}: files registry seat is unchanged`)
    assert.equal(f.registry.get(sceneId, otherPanelId), beforeSeats[2], `${stage}: other role registry seat is unchanged`)
    assert.deepEqual([f.item.sessionId, f.filesItem.sessionId, f.otherItem.sessionId], beforeItemSessions, `${stage}: no surface session is changed`)
    assert.equal(f.registry.get(sceneId, panelId).sessionId, 'session-old')
    f.registry.destroy()
  }

  const f = makeFixture({
    getConfig: async () => ({ scenes: [{ id: sceneId, panels: [
      { id: panelId, type: 'native-chat', roleId }, { id: filesPanelId, type: 'native-workspace', roleId }, { id: otherPanelId, type: 'native-chat', roleId: 'trader' },
    ] }], sessionBindings: { [roleId]: 'session-new', trader: 'session-trader' } }),
    resolveBinding: async ({ panelId: targetPanel }) => ({ sceneId, panelId: targetPanel, bindingStatus: 'bound', sessionId: 'session-new', bindingRevision: 'rev-new' }),
  })
  const originalBounds = f.popout.getContentBounds()
  await f.refresh(result, () => {})
  const refreshedSeat = f.registry.get(sceneId, panelId)
  assert.equal(refreshedSeat.sessionId, 'session-new')
  assert.equal(refreshedSeat.rehomed, true)
  assert.equal(refreshedSeat.window.window, f.popout, 'the same real BrowserWindow remains the owned popout')
  assert.deepEqual(f.popout.getContentBounds(), originalBounds, 'refresh does not change popout placement')
  assert.equal(f.context.views.get(id).sessionId, 'session-new')
  assert.equal(f.registry.get(sceneId, filesPanelId).sessionId, 'session-new', 'all open surfaces for the selected role receive the new session')
  assert.equal(f.registry.get(sceneId, filesPanelId).rehomed, false, 'the docked same-role surface stays docked')
  assert.equal(f.registry.get(sceneId, otherPanelId).sessionId, 'session-trader', 'an unrelated role is unchanged')
  f.registry.destroy()
})

test('SourceMode business bridge pins the clicked role target and accepts its new session after host confirm', async () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const bridgePath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui/business-bridge.js')
  const source = await readFile(bridgePath, 'utf8')
  const start = source.indexOf('  function openSceneRotation(panel) {')
  const end = source.indexOf('\n  function panelMenuCapabilities(', start)
  const predicateStart = source.indexOf('  function isCurrentRole(record) {')
  const predicateEnd = source.indexOf('\n  function nativePaneVisible(', predicateStart)
  assert.ok(start >= 0 && end > start && predicateStart >= 0 && predicateEnd > predicateStart, 'the production business bridge predicate and entry are present')
  const role = { panel: {}, content: { isConnected: true }, created: true, uiSceneId: 'ui-scene', revision: 3,
    target: { sceneId: 'scene-center', panelId: 'panel-chat', roleId: 'center' } }
  const state = { roleRecord: role, sceneRevision: 3, sceneId: 'ui-scene', tearingDown: false,
    config: { raw: { sessionBindings: { center: 'session-before' } } } }
  const requests = []
  const statusUpdates = []
  const app = {
    sceneRotation: {
      async preview(request) { requests.push(['preview', request]); return { previewToken: 'preview-token', operationId: 'operation-1', archiveOld: false } },
      async confirm(request) { requests.push(['confirm', request]); return { operationId: 'operation-1', roleId: 'center', sessionId: 'session-after', status: 'bound' } },
      async status(request) { requests.push(['status', request]); return { status: 'bound', sessionId: 'session-after' } },
      async resume(request) { requests.push(['resume', request]); return { ...request } },
      async cancel(request) { requests.push(['cancel', request]); return { cancelled: false, operationId: 'operation-1', status: 'creating' } },
      async abandon(request) { requests.push(['abandon', request]); return { ...request } },
    },
    async sourceConfig() { return { raw: { sessionBindings: { center: 'session-after' } } } },
    harnessSurface: { async status(sceneId, panelId) { requests.push(['surface-status', { sceneId, panelId }]); return { status: 'loaded' } } },
  }
  const bridgeFunctions = runInNewContext(`(() => { ${source.slice(predicateStart, predicateEnd)}; ${source.slice(start, end)}; return { isCurrentRole, openSceneRotation } })()`, {
    state, app, validateConfig: value => value,
    onRoleStatus: value => statusUpdates.push(value),
  }, { filename: bridgePath })
  assert.equal(bridgeFunctions.isCurrentRole(role), true)
  const flow = bridgeFunctions.openSceneRotation(role.panel)
  assert.equal(flow.target.sceneId, 'scene-center')
  assert.equal(flow.target.panelId, 'panel-chat')
  assert.equal(flow.target.roleId, 'center')
  assert.equal(flow.target.sessionId, 'session-before')
  await flow.preview({ sceneId: 'renderer-forgery', panelId: 'renderer-forgery', archiveOld: true, roleId: 'trader', sessionId: 'wrong' })
  assert.equal(requests[0][0], 'preview')
  assert.deepEqual({ ...requests[0][1] }, { sceneId: 'scene-center', panelId: 'panel-chat', archiveOld: true })
  const confirmed = await flow.confirm({ previewToken: 'preview-token', operationId: 'ignored' })
  assert.equal(confirmed.sessionId, 'session-after')
  assert.equal(state.config.raw.sessionBindings.center, 'session-after')
  assert.equal(requests[1][0], 'confirm')
  assert.deepEqual({ ...requests[1][1] }, { previewToken: 'preview-token' })
  assert.equal(requests[2][0], 'surface-status')
  assert.deepEqual({ ...requests[2][1] }, { sceneId: 'scene-center', panelId: 'panel-chat' })
  assert.equal(statusUpdates.length, 1)
  assert.deepEqual({ ...statusUpdates[0] }, { status: 'loaded', sceneId: 'scene-center', panelId: 'panel-chat' })

  let releasePreview
  let previewStarted
  const previewGate = new Promise(resolvePromise => { releasePreview = resolvePromise })
  const started = new Promise(resolvePromise => { previewStarted = resolvePromise })
  app.sceneRotation.preview = async request => { requests.push(['delayed-preview', request]); previewStarted(); await previewGate; return { previewToken: 'stale-token', operationId: 'stale-op' } }
  const pendingFlow = bridgeFunctions.openSceneRotation(role.panel)
  const pendingPreview = pendingFlow.preview({ archiveOld: false })
  await started
  state.sceneRevision++
  state.sceneId = 'different-ui-scene'
  state.roleRecord = { ...role, uiSceneId: 'different-ui-scene', revision: state.sceneRevision }
  releasePreview()
  const stale = await pendingPreview
  assert.equal(stale.staleTarget, true, 'the actual producer predicate rejects the original flow after role record/scene switch')
  assert.equal(requests.at(-1)[0], 'delayed-preview')
  assert.deepEqual({ ...requests.at(-1)[1] }, { sceneId: 'scene-center', panelId: 'panel-chat', archiveOld: false }, 'the pending request remains pinned to its original target')
})

test('SourceMode preload invokes the six narrow routes and the controller accepts only registered main or solo source frames', async () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const preloadPath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-preload.cjs')
  const preloadSource = await readFile(preloadPath, 'utf8')
  const exposed = {}
  const invoked = []
  const ipcRenderer = { invoke: async (channel, request) => { invoked.push({ channel, request }); return { ok: true } } }
  runInNewContext(preloadSource, { require: name => { assert.equal(name, 'electron'); return {
    contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value } }, ipcRenderer,
  } } }, { filename: preloadPath })
  const request = { operationId: 'op-fixed' }
  for (const operation of ['preview', 'confirm', 'status', 'resume', 'cancel', 'abandon']) await exposed.app.sceneRotation[operation](request)
  assert.deepEqual(invoked.map(item => item.channel), [
    'source-shell:sceneRotationPreview', 'source-shell:sceneRotationConfirm', 'source-shell:sceneRotationStatus',
    'source-shell:sceneRotationResume', 'source-shell:sceneRotationCancel', 'source-shell:sceneRotationAbandon',
  ])
  assert.ok(invoked.every(item => item.request === request), 'preload forwards only the supplied DTO to its matching fixed channel')

  const controllerPath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs')
  const controllerSource = await readFile(controllerPath, 'utf8')
  const ownerStart = controllerSource.indexOf('  const assertWindow = event => {')
  const ownerEnd = controllerSource.indexOf('\n  const scene =', ownerStart)
  const rotationStart = controllerSource.indexOf('      const rotationOwner = event => {')
  const rotationEnd = controllerSource.indexOf('\n      const refreshRoleRotationSurfaces =', rotationStart)
  assert.ok(ownerStart >= 0 && ownerEnd > ownerStart && rotationStart >= 0 && rotationEnd > rotationStart)
  const mainUrl = 'dsh-app://app/source-shell/renderer/source-entry.html'
  const makeWindow = url => ({ webContents: { mainFrame: { url } }, isDestroyed: () => false })
  const main = makeWindow(mainUrl)
  const soloScene = 'scene-solo'
  const solo = makeWindow(`${mainUrl}?solo=1&scene=${encodeURIComponent(soloScene)}`)
  const roleGuest = makeWindow(mainUrl)
  const context = { windows: new Map([['main', main], [soloScene, solo]]), accountPopout: undefined,
    rolePopouts: new Map([['role-guest', roleGuest]]), SOURCE_URL: mainUrl,
    ACCOUNT_URL: 'dsh-app://app/source-shell/renderer/account-window.html', Error }
  const helpers = controllerSource.slice(ownerStart, ownerEnd)
  const rotation = controllerSource.slice(rotationStart, rotationEnd).trim()
  const owners = runInNewContext(`(() => { ${helpers}; ${rotation}; return { assertWindow, assertThemeWindow, rotationOwner } })()`, context,
    { filename: controllerPath })
  const mainEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const soloEvent = { sender: solo.webContents, senderFrame: solo.webContents.mainFrame }
  assert.equal(owners.rotationOwner(mainEvent).id, 'main')
  assert.equal(owners.rotationOwner(soloEvent).id, soloScene)
  assert.throws(() => owners.rotationOwner({ sender: main.webContents, senderFrame: { url: mainUrl } }), /rejected sender|owner rejected/)
  assert.throws(() => owners.rotationOwner({ sender: roleGuest.webContents, senderFrame: roleGuest.webContents.mainFrame }), /rejected sender|wrong source theme owner/)
  const foreignSoloFrame = { url: solo.webContents.mainFrame.url }
  assert.throws(() => owners.rotationOwner({ sender: solo.webContents, senderFrame: foreignSoloFrame }), /rejected sender|owner rejected/)
})

test('SourceMode More menu opens the real rotation flow and preserves a consumed operation when cancel reports false', async () => {
  const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const bridgePath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui/business-bridge.js')
  const panelPath = join(repo, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui/panel-interactions.js')
  const [bridgeSource, panelSource] = await Promise.all([readFile(bridgePath, 'utf8'), readFile(panelPath, 'utf8')])
  const isCurrentStart = bridgeSource.indexOf('  function isCurrentRole(record) {')
  const isCurrentEnd = bridgeSource.indexOf('\n  function nativePaneVisible(', isCurrentStart)
  const bridgeStart = bridgeSource.indexOf('  function openSceneRotation(panel) {')
  const bridgeEnd = bridgeSource.indexOf('\n  function panelMenuCapabilities(', bridgeStart)
  assert.ok(isCurrentStart >= 0 && isCurrentEnd > isCurrentStart && bridgeStart >= 0 && bridgeEnd > bridgeStart)
  const role = { panel: undefined, content: { isConnected: true }, created: true, uiSceneId: 'ui-scene', revision: 2,
    target: { sceneId: 'scene-center', panelId: 'panel-chat', roleId: 'center' } }
  const state = { roleRecord: role, sceneRevision: 2, sceneId: 'ui-scene', tearingDown: false,
    config: { raw: { sessionBindings: { center: 'session-old' } } } }
  const calls = []
  const app = { sceneRotation: {
    async preview(request) { calls.push(['preview', request]); return { previewToken: 'token-consumed', operationId: 'operation-consumed', impactMessage: 'fixed impact' } },
    async cancel(request) { calls.push(['cancel', request]); return { cancelled: false, operationId: 'operation-consumed', status: 'creating' } },
    async status(request) { calls.push(['status', request]); return { operationId: request.operationId, status: 'creating' } },
    async resume(request) { calls.push(['resume', request]); return { operationId: request.operationId, status: 'creating' } },
    async abandon(request) { calls.push(['abandon', request]); return { operationId: request.operationId, status: 'abandoned' } },
  } }
  const openSceneRotation = runInNewContext(`(() => { ${bridgeSource.slice(isCurrentStart, isCurrentEnd)}; ${bridgeSource.slice(bridgeStart, bridgeEnd)}; return openSceneRotation })()`, {
    state, app, validateConfig: value => value, onRoleStatus() {},
  }, { filename: bridgePath })

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.classList = { add() {} }; this.isConnected = true; this.offsetHeight = 40; this.offsetWidth = 160 }
    setAttribute(name, value) { this.attributes[name] = value }
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback) }
    append(...children) { for (const child of children) { if (child && typeof child === 'object') child.parentNode = this; this.children.push(child) } }
    replaceChildren(...children) { this.children = []; this.append(...children) }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.isConnected = false }
    querySelectorAll(selector) { const found = []; const visit = node => { if (node?.tagName === 'button' && selector === 'button') found.push(node); for (const child of node?.children ?? []) visit(child) }; visit(this); return found }
    querySelector(selector) { return this.querySelectorAll(selector)[0] }
    getBoundingClientRect() { return { bottom: 24, right: 80 } }
    focus() {}
    showModal() { this.open = true }
    close() { this.open = false; for (const callback of this.listeners.close ?? []) callback({}) }
    async click() { for (const callback of this.listeners.click ?? []) await callback({ target: this, preventDefault() {} }) }
  }
  const document = {
    body: new FakeElement('body'),
    createElement: tagName => new FakeElement(tagName),
    createTextNode: textContent => ({ textContent }),
    addEventListener() {}, removeEventListener() {},
  }
  const actionsStart = panelSource.indexOf('  const ACTIONS = [')
  const actionsEnd = panelSource.indexOf('\n  const states =', actionsStart)
  const uiStart = panelSource.indexOf('  function openSceneRotationDialog(flow) {')
  const uiEnd = panelSource.indexOf('\n  function setFullscreenButton(', uiStart)
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart && uiStart >= 0 && uiEnd > uiStart)
  const uiFunctions = runInNewContext(`(() => { ${panelSource.slice(actionsStart, actionsEnd)}; let menu; let toastTimer; function announce() {}; ${panelSource.slice(uiStart, uiEnd)}; return openMenu })()`, {
    document, window: { innerHeight: 900, innerWidth: 1200, businessBridge: {
      panelMenuCapabilities: () => ({ nativeConversation: true }), openSceneRotation,
    } }, getComputedStyle: () => ({ display: 'block' }),
  }, { filename: panelPath })
  const panel = { querySelector() { return null } }
  role.panel = panel
  const menuButton = new FakeElement('button')
  uiFunctions(menuButton, panel)
  const menu = document.body.children[0]
  const rotationItem = menu.querySelectorAll('button').find(item => item.textContent === '轮换此角色会话')
  assert.ok(rotationItem, 'the actual More menu renders the rotation action for a native role panel')
  await rotationItem.click()
  const dialog = document.body.children.find(element => element.tagName === 'dialog')
  assert.ok(dialog?.open, 'the menu action opens the actual rotation dialog function')
  assert.match(dialog.children[1].textContent, /scene-center \/ panel-chat \/ center \/ session-old/)
  const actions = dialog.children[5]
  await actions.querySelectorAll('button').find(item => item.textContent === '查看影响预览').click()
  assert.equal(calls[0][0], 'preview')
  assert.deepEqual({ ...calls[0][1] }, { sceneId: 'scene-center', panelId: 'panel-chat', archiveOld: false })
  await actions.querySelectorAll('button').find(item => item.textContent === '取消预览').click()
  assert.equal(calls[1][0], 'cancel')
  assert.deepEqual({ ...calls[1][1] }, { previewToken: 'token-consumed' })
  assert.match(dialog.children[3].textContent, /预览已被消费.*operation-consumed.*creating/)
  assert.doesNotMatch(dialog.children[3].textContent, /没有创建或更改会话/)
  assert.deepEqual(actions.querySelectorAll('button').map(item => item.textContent), ['读取操作状态', '恢复原操作', '放弃本地操作', '关闭'])
})
