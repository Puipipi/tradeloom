import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createScenesHandler, createSessionHandler } from '../host.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE } from '../state.js'

const fixtureRoot = join(tmpdir(), 'tradeloom-binding-revision-tests')
await mkdir(fixtureRoot, { recursive: true })

async function ownedFixture(t) {
  const home = await mkdtemp(join(fixtureRoot, 'owned-home-'))
  await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  const env = { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home }
  return { home, env, store: await createStateStore({ env }) }
}

function binding(sessionId, workspaceId = 'workspace-center') {
  return {
    sessionId,
    workspaceId,
    workspacePath: 'C:\\owned\\center',
    agentPreset: 'tradeloom-center',
  }
}

function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  return req
}

function response() {
  return { statusCode: 0, setHeader() {}, end(body = '') { this.body = body } }
}

test('legacy role revisions are stable across reads/reopened stores and migrate on the next write', async t => {
  const { env, store } = await ownedFixture(t)
  await store.transact(state => { state.roles.center = binding('legacy-center') })

  const legacy = JSON.parse(await readFile(store.paths.statePath, 'utf8'))
  delete legacy.roleBindingRevisions
  await writeFile(store.paths.statePath, `${JSON.stringify(legacy)}\n`, 'utf8')

  const reopened = await createStateStore({ env })
  assert.equal((await reopened.read()).roleBindingRevisions.center, '1')
  assert.equal(Object.hasOwn(JSON.parse(await readFile(reopened.paths.statePath, 'utf8')), 'roleBindingRevisions'), false,
    'a read-only legacy migration does not write the state file')
  assert.equal((await (await createStateStore({ env })).read()).roleBindingRevisions.center, '1',
    'reopening the store derives the same legacy seed')

  await reopened.transact(state => { state.userProfile = { displayName: 'fixture', notes: 'fixture' } })
  const saved = await reopened.read()
  assert.equal(saved.roleBindingRevisions.center, '1')
  assert.equal(JSON.parse(await readFile(reopened.paths.statePath, 'utf8')).roleBindingRevisions.center, '1',
    'the first ordinary write persists the deterministic seed')
})

test('only committed binding tuple changes advance decimal counters; fake counters and unrelated state writes are ignored', async t => {
  const { env, store } = await ownedFixture(t)
  await store.transact(state => { state.roles.center = binding('session-A') })
  assert.equal((await store.read()).roleBindingRevisions.center, '1')

  await store.transact(state => {
    state.roles.center = { ...binding('session-A'), bindingRevision: '999999' }
    state.roleBindingRevisions.center = '999999'
  })
  assert.equal((await store.read()).roleBindingRevisions.center, '1', 'a same tuple and forged counter do not advance state')
  assert.equal((await store.read()).roles.center.bindingRevision, undefined, 'role-object counters are discarded')

  await store.transact(state => { state.roles.center = binding('session-B') })
  assert.equal((await store.read()).roleBindingRevisions.center, '2')

  await store.transact(state => {
    state.userProfile = { displayName: 'fixture', notes: 'profile update' }
    state.sceneWorkbench = { version: 1, layouts: {} }
    state.dockLayouts = { version: 2, scenes: {} }
    state.roleBindingRevisions.center = '0'
  })
  assert.equal((await store.read()).roleBindingRevisions.center, '2', 'profile and layout writes cannot change the counter')

  await store.transact(state => {
    delete state.roles.center
    state.roleBindingRevisions.center = '0'
    delete state.roleBindingRevisions
  })
  assert.equal((await store.read()).roleBindingRevisions.center, '3', 'deleting a binding advances and preserves its tombstone')

  await store.transact(state => {
    state.roles.center = binding('session-A')
    state.roleBindingRevisions = { center: '1' }
  })
  const reopened = await createStateStore({ env })
  assert.equal((await reopened.read()).roleBindingRevisions.center, '4',
    'rebinding an earlier tuple cannot ABA to its prior revision or forge a reset')
})

test('Host scene metadata and session-create response expose the committed server revision', async t => {
  const fixture = await ownedFixture(t)
  await fixture.store.transact(state => { state.roles.center = binding('center-A') })
  await fixture.store.transact(state => { state.roles.center = binding('center-B') })

  const sceneHandler = createScenesHandler({
    connection: { requestRejection: () => undefined },
    webServer: { getOrigin: () => 'http://127.0.0.1:3088' },
    workspaceRegistry: { archivedSessionIds: [] },
  }, { createStateStore: () => createStateStore({ env: fixture.env }) })
  const sceneResponse = response()
  await sceneHandler(request('GET', { sessionBindings: { center: 'client-session' }, bindingRevision: '999' }), sceneResponse)
  const scene = JSON.parse(sceneResponse.body)
  assert.deepEqual(scene.sessionBindings, { center: 'center-B' }, 'the compatible role-to-session map comes from Host state')
  assert.equal(scene.sessionBindingMetadata.center.bindingRevision, '2', 'metadata ignores a client-supplied counter')

  const workspaces = []
  const sessionStore = fixture.store
  let agent
  const persistence = { identity: Symbol('offline-persistence'), async flush() {}, async stat() { return { header: agent.session.header } } }
  const createHandler = createSessionHandler({
    connection: { requestRejection: () => undefined },
    get: () => persistence,
    agents: { get: id => agent?.id === id ? agent : undefined },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => workspaces,
      get: id => workspaces.find(row => row.id === id),
      async create(path) {
        const workspace = { id: 'fixture-workspace', path }
        workspaces.push(workspace)
        return workspace
      },
    },
    sessionController: { async create(input) {
      const workspace = workspaces.find(row => row.id === input.workspaceId)
      workspace.sessionIds = [input.sessionId]
      agent = { id: input.sessionId, session: { id: input.sessionId, header: { id: input.sessionId, cwd: workspace.path, agentPreset: input.agentPreset } }, ctx: { get: () => persistence } }
      return { sessionId: input.sessionId, agentPreset: input.agentPreset }
    } },
  }, {
    resolveOwnedHome: async () => fixture.home,
    roleWorkspacePath: async () => 'C:\\owned\\center',
    createStateStore: async () => ({
      transact: callback => sessionStore.transact(callback),
      async read() { throw new Error('session route must return the transaction revision without re-reading') },
    }),
  })
  const createResponse = response()
  await createHandler(request('POST', { role: 'product' }), createResponse)
  const created = JSON.parse(createResponse.body)
  assert.equal(createResponse.statusCode, 200)
  assert.equal(created.binding.bindingRevision, '1')
  assert.equal((await sessionStore.read()).roleBindingRevisions.product, created.binding.bindingRevision)
})
