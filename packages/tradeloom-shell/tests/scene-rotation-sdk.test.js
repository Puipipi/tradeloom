import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { HOME_MARKER, HOME_MARKER_VALUE, createStateStore } from '../state.js'
import { createSceneMemoryStore } from '../scene-memory.js'
import { createSceneRotationController, createSdkSceneRotationAdapter } from '../scene-rotation.js'

const sdkRoot = process.env.TRADELOOM_REP12_SDK_ROOT

async function sdkModule(relativePath) {
  return await import(pathToFileURL(join(sdkRoot, relativePath)).href)
}

async function packageModule(packagePath, name) {
  const require = createRequire(pathToFileURL(join(sdkRoot, packagePath, '__scene_rotation_test__.cjs')))
  return await import(pathToFileURL(require.resolve(name)).href)
}

function provideControllerFixtures(ctx) {
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
    resources: { register: () => () => {} },
  })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    saveSelection: async () => {},
  })
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: [] },
    admitPromptContent: async content => [...content],
  })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {}, resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }), retirePrompt: () => {},
  })
}

test('rep12 Context, SessionController, WorkspaceRegistry and JSONL persistence execute a real empty-session rotation', {
  skip: sdkRoot ? false : 'set TRADELOOM_REP12_SDK_ROOT to run the pinned rep12 SDK integration',
}, async t => {
  assert.ok(sdkRoot)
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-scene-rotation-sdk-'))
  const appHome = join(root, 'app-home')
  const workspacePath = join(root, 'workspace')
  const sessionRoot = join(root, 'sessions')
  await mkdir(appHome, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await writeFile(join(appHome, HOME_MARKER), HOME_MARKER_VALUE)
  const stateStore = await createStateStore({ env: { DSH_HOME: appHome, TRADELOOM_DSH_APP_HOME: appHome } })

  const [{ Context }, controllerModule, storageModule,
    storageSqliteModule, domainModule, workspaceModule, jsonlModule, querySqliteModule, remoteAccessModule,
    agentLoopTestkit] = await Promise.all([
    sdkModule('vendor/cordis/lib/index.js'),
    sdkModule('packages/api/session-controller/lib/index.js'),
    packageModule('packages/workspace/workspace', '@deepseek-ai/dsh-storage'),
    sdkModule('packages/storage/storage-sqlite/lib/index.js'),
    packageModule('packages/workspace/workspace', '@deepseek-ai/dsh-storage-domain'),
    sdkModule('packages/workspace/workspace/lib/index.js'),
    sdkModule('packages/session/session-persistence-jsonl/lib/index.js'),
    sdkModule('packages/session-query/session-query-sqlite/lib/index.js'),
    packageModule('packages/api/session-controller', '@deepseek-ai/dsh-api-remote-access'),
    packageModule('packages/test-support/agent-loop-testkit', '@deepseek-ai/dsh-agent-loop-testkit'),
  ])
  const ctx = new Context()
  let rotation
  let workspaceStorage
  try {
    await ctx.plugin(storageModule.default)
    workspaceStorage = new storageSqliteModule.SqliteStorageBackend({ path: join(root, 'workspace-store.sqlite'), journalMode: 'wal' })
    ctx.storage.backend.register('sqlite', workspaceStorage)
    const domain = new domainModule.DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', domain)
    ctx.provide('storageDomain', domain)
    await jsonlModule.apply(ctx, { root: sessionRoot, compression: 'none' })
    await ctx.plugin(querySqliteModule.SqliteSessionQueryEngine, { path: join(root, 'session-query.sqlite') })
    await ctx.plugin(workspaceModule.default)
    await agentLoopTestkit.mountAgentLoopTestDependencies(ctx)
    await agentLoopTestkit.mountAgentLoopTestHarness(ctx)
    provideControllerFixtures(ctx)
    new remoteAccessModule.default(ctx)
    const sessionController = new controllerModule.SessionController(ctx, { nativeOpen: false })

    const oldId = 'session-o04-old'
    const oldCreated = await sessionController.create({ sessionId: oldId, cwd: workspacePath })
    assert.equal(oldCreated.sessionId, oldId)
    const oldLive = ctx.sessions.get(oldId)
    assert.ok(oldLive)
    await ctx.sessions.flush(oldLive)
    await ctx.sessionPersistence.flush()
    const workspace = await ctx.workspaceRegistry.create(workspacePath, 'O04 isolated workspace')
    if (!workspace.sessionIds.includes(oldId)) await workspace.attachSession(oldId)

    const memory = createSceneMemoryStore(stateStore, {
      sceneIds: ['scene-sdk'],
      verifySession: async ({ sessionId }) => (await ctx.sessionPersistence.stat(sessionId)) !== undefined,
    })
    await memory.configureScene({ sceneId: 'scene-sdk', expectedRevision: 0, responsibility: 'isolated SDK test', assetRefs: [], primarySkill: null })
    await memory.bindSession({ sceneId: 'scene-sdk', sessionId: oldId, expectedSessionId: null })
    await memory.updateHandoff({ sessionId: oldId, operationId: 'sdk-handoff-1', expectedRevision: 0, text: 'Continue from persisted handoff.' })
    const adapter = createSdkSceneRotationAdapter(ctx)
    rotation = createSceneRotationController({ sceneMemory: memory, adapter })

    const preview = await rotation.preview('scene-sdk', { archiveOld: true })
    assert.equal(preview.workspaceId, workspace.id)
    assert.equal(preview.handoff.text, 'Continue from persisted handoff.')
    const completed = await rotation.execute(preview.previewId)
    assert.equal(completed.phase, 'complete')
    assert.equal(completed.oldSessionId, oldId)
    assert.equal(completed.createdSessionId, preview.plannedSessionId)
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, [oldId])
    assert.ok(ctx.workspaceRegistry.get(workspace.id).sessionIds.includes(preview.plannedSessionId))
    assert.equal(await ctx.sessionPersistence.stat(preview.plannedSessionId) !== undefined, true)
    const observation = await ctx.sessionQuery.observeSession(preview.plannedSessionId)
    try {
      assert.equal(observation.header.id, preview.plannedSessionId)
      assert.equal(observation.events.some(event => event.type === 'user/message' || event.type === 'turn/start'), false)
    } finally { observation[Symbol.dispose]?.() }
    const inherited = await memory.readForSession(preview.plannedSessionId)
    assert.equal(inherited.handoff.sourceSessionId, oldId)
    assert.equal(inherited.handoff.revision, 1)
    assert.equal(inherited.handoff.text, 'Continue from persisted handoff.')
    const graph = await memory.readGraphForSession(preview.plannedSessionId, { kinds: ['handoff'] })
    assert.equal(graph.target.sessionId, preview.plannedSessionId)
    assert.equal(graph.target.sceneId, 'scene-sdk')
    assert.equal(graph.nodes[0].source.sourceSessionId, oldId)
    const resolvedGraphTarget = await memory.resolveGraphTarget(preview.plannedSessionId, {
      nodeId: graph.nodes[0].id,
      expectedTarget: graph.target,
    })
    assert.equal(resolvedGraphTarget.target.sessionId, preview.plannedSessionId)
    assert.equal(resolvedGraphTarget.referenceSessionId, oldId)
    const presetSessionId = 'session-o04-preset-event'
    await sessionController.create({ sessionId: presetSessionId, cwd: workspacePath })
    const presetSession = ctx.sessions.get(presetSessionId)
    assert.ok(presetSession)
    presetSession.append('agent-preset/selected', { agentPreset: 'rep12-preset-event-fixture' })
    await ctx.sessions.flush(presetSession)
    await ctx.sessionPersistence.flush()
    assert.equal((await adapter.inspectSession(presetSessionId)).agentPreset, 'rep12-preset-event-fixture')
  } finally {
    try { await rotation?.dispose() } finally {
      try { await workspaceStorage?.close() } finally {
        try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  }
})
