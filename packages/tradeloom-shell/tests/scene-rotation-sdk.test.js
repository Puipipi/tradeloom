import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE, replaceRoleBinding, roleWorkspacePath } from '../state.js'
import { ROLE_IDS, ROLE_PRESETS } from '../roles.js'
import { createAgentConfigurationResources } from '../agent-configuration.js'
import { createSceneRotationHandlers } from '../scene-rotation.js'
import { apply as applyHost, inject as hostInject, createRotationSessionReconciler } from '../host.js'

const sdkModules = process.env.O04_SDK_NODE_MODULES
const sdkTestSkip = !sdkModules && !process.env.O04_PRIVATE_TEST_ROOT
  ? 'requires the isolated R76 SDK and private test root environment'
  : false
const sdk = relative => import(pathToFileURL(join(sdkModules, ...relative.split('/'))).href)
const copy = value => JSON.parse(JSON.stringify(value))

function request(body, url = '/tradeloom/scene-rotation') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  return req
}

function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value }, end(value = '') { this.body = value } }
}

async function invoke(handler, body) {
  const res = response()
  await handler(request(body), res)
  return { status: res.statusCode, value: res.body ? JSON.parse(res.body) : undefined }
}

function createMemoryKvBackend() {
  const units = new Map()
  return {
    kv: {
      async open(descriptor) {
        const name = descriptor.name
        let unit = units.get(name)
        if (!unit) {
          const tables = Object.fromEntries((descriptor.tables ?? []).map(key => [key, {}]))
          let global = null
          unit = {
            async loadAll() { return { tables: copy(tables), global: global === null ? null : copy(global) } },
            async setGlobal(value) { global = copy(value) },
            async putRecord(table, key, value) { tables[table][key] = copy(value) },
            async deleteRecord(table, key) { delete tables[table][key] },
            async close() {},
          }
          units.set(name, unit)
        }
        return unit
      },
    },
  }
}

test('real SDK creates and rotates an empty preset session with exact JSONL and WorkspaceRegistry identity', { skip: sdkTestSkip }, async t => {
  assert.ok(sdkModules && /^[A-Za-z]:\\/.test(sdkModules), 'O04_SDK_NODE_MODULES must point to the private R76-pinned execution root')
  const privateRoot = resolve(process.env.O04_PRIVATE_TEST_ROOT ?? '')
  assert.ok(privateRoot.length > 3 && privateRoot !== resolve(process.cwd()), 'private test root is required')
  await mkdir(privateRoot, { recursive: true })
  const runRoot = join(privateRoot, `sdk-empty-session-${randomUUID()}`)
  assert.ok(resolve(runRoot).startsWith(privateRoot + sep), 'test output must remain inside its private marker')
  await mkdir(runRoot)
  const appHome = join(runRoot, 'app-home')
  const sessionRoot = join(runRoot, 'sessions')
  const role = ROLE_IDS[0]
  const presetId = ROLE_PRESETS[role]
  const sessionId = `session-o04-${randomUUID()}`
  let context
  t.after(async () => {
    await context?.dispose?.()
    await rm(runRoot, { recursive: true, force: true })
  })

  await mkdir(appHome, { recursive: true })
  await writeFile(join(appHome, HOME_MARKER), HOME_MARKER_VALUE, { flag: 'wx' })
  await mkdir(sessionRoot, { recursive: true })
  process.env.DSH_HOME = appHome
  process.env.TRADELOOM_DSH_APP_HOME = appHome

  const [cordis, session, projection, agent, systemPrompt, agentLoop, tools, apiSession, workspace, sessionQuery, jsonl, storage, storageDomain, presetRegistry, loader, appBoot] = await Promise.all([
    sdk('@deepseek-ai/cordis/lib/index.js'),
    sdk('@deepseek-ai/dsh-session/lib/index.js'),
    sdk('@deepseek-ai/dsh-session-projection/lib/index.js'),
    sdk('@deepseek-ai/dsh-agent/lib/index.js'),
    sdk('@deepseek-ai/dsh-system-prompt/lib/index.js'),
    sdk('@deepseek-ai/dsh-agent-loop/lib/index.js'),
    sdk('@deepseek-ai/dsh-tools/lib/index.js'),
    sdk('@deepseek-ai/dsh-api-session-controller/lib/index.js'),
    sdk('@deepseek-ai/dsh-workspace/lib/index.js'),
    sdk('@deepseek-ai/dsh-session-query/lib/index.js'),
    sdk('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'),
    sdk('@deepseek-ai/dsh-storage/lib/index.js'),
    sdk('@deepseek-ai/dsh-storage-domain/lib/index.js'),
    sdk('@deepseek-ai/dsh-agent-preset-registry/lib/index.js'),
    sdk('@deepseek-ai/cordis-plugin-loader/lib/index.js'),
    sdk('@deepseek-ai/dsh-app-boot/lib/index.js'),
  ])
  const { Context } = cordis
  context = new Context()
  let modelCalls = 0
  const lookupTable = new Map()
  const registry = {
    lookups: { register(name, value) { lookupTable.set(name, value) }, configure(name, value) { lookupTable.set(`resolve:${name}`, value) } },
    contexts: { configureHost() {} },
    resources: { register() {} },
  }
  context.provide('typert', registry)
  context.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'o04-inert', model: 'no-call' }), saveSelection: async () => {} })
  context.provide('attachments', { imageLimits: {
    maxImageBytes: 1024 * 1024,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 4 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 8192,
    mediaTypes: ['image/png'],
  } })
  context.provide('fileUploads', { registerAgentResolver() { return () => {} } })
  context.provide('fs', await import('node:fs/promises'))
  context.provide('llm', { async *stream() { modelCalls += 1; throw new Error('unexpected model call in empty-session test') } })
  context.provide('remoteAccess', {})
  context.provide('connection', { requestRejection: () => undefined, fetch: { register: () => () => {} } })

  await context.plugin(storage.Storage)
  await context.plugin(loader.Loader)
  context.storage.backend.register('o04-workspace-memory', createMemoryKvBackend())
  context.provide(storage.storageBackendServiceKey('o04-workspace-memory'), {})
  await context.plugin({ name: storageDomain.name, inject: storageDomain.inject, apply: storageDomain.apply }, { backend: 'o04-workspace-memory' })
  await jsonl.apply(context, { root: sessionRoot })
  await context.plugin(session.SessionStore)
  await context.plugin(projection.SessionProjectionRegistry)
  await context.plugin(presetRegistry.AgentPresetRegistry, { default: presetId })
  const profileDir = join(appHome, 'profiles', 'desktop')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  await mkdir(profileDir, { recursive: true })
  await writeFile(profilePatchPath, [
    '- id: config-editor',
    "  name: '@deepseek-ai/dsh-config-editor'",
    '- id: o04-agent-preset',
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    `    id: ${JSON.stringify(presetId)}`,
    '    name: O04 inert preset',
    '    plugins: []',
    '',
  ].join('\n'))
  const profileContext = {
    name: 'desktop',
    dir: profileDir,
    patchPath: profilePatchPath,
    installAnchor: sdkModules,
    cwd: runRoot,
    home: appHome,
    startedBundles: ['@tradeloom/dsh-business-shell'],
  }
  context.provide('profileContext', profileContext)
  const loaderBaseUrl = pathToFileURL(join(sdkModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
  const include = await appBoot.mountRootInclude(context, profilePatchPath, [], loaderBaseUrl)
  assert.ok(include, 'the real app-boot mountRootInclude API must create the profile Include')
  await context.get('loader').await()
  const includedEntries = [...context.get('loader').entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
  const configEditorEntries = includedEntries.filter(entry => entry.options.name === '@deepseek-ai/dsh-config-editor')
  const presetEntries = includedEntries.filter(entry => entry.options.name === '@deepseek-ai/dsh-agent-preset' && entry.options.config?.id === presetId)
  assert.equal(configEditorEntries.length, 1)
  assert.equal(configEditorEntries[0].fiber?.state, 2)
  assert.equal(presetEntries.length, 1)
  assert.equal(presetEntries[0].fiber?.state, 2)
  assert.equal(context.get('configEditor')?.entries().filter(entry => entry === presetEntries[0]).length, 1)
  await context.plugin(agent.AgentRegistry)
  await context.plugin(systemPrompt.SystemPrompt)
  await context.plugin(tools.ToolRuntime, { mode: 'native' })
  await context.plugin(sessionQuery.SessionQueryEngine)
  await context.plugin(workspace.WorkspaceRegistry)
  await context.plugin(agentLoop.AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  await context.plugin(apiSession.SessionController, { nativeOpen: false })
  const workspacePath = await roleWorkspacePath(role)
  await mkdir(workspacePath, { recursive: true })
  const ownedWorkspace = await context.workspaceRegistry.create(workspacePath, 'O04 isolated workspace')
  const initialSession = await context.sessionController.create({ sessionId, workspaceId: ownedWorkspace.id, agentPreset: presetId })
  assert.equal(initialSession.sessionId, sessionId)
  assert.equal(initialSession.agentPreset, presetId)
  await context.sessionPersistence.flush()
  const initialPersisted = await context.sessionPersistence.stat(sessionId)
  assert.equal(initialPersisted?.header?.id, sessionId)
  assert.equal(initialPersisted?.header?.cwd, workspacePath)
  assert.equal(initialPersisted?.header?.agentPreset, presetId)
  assert.ok(initialPersisted.sizeBytes > 0)
  assert.ok(ownedWorkspace.sessionIds.includes(sessionId))

  const stateStore = await createStateStore()
  await stateStore.transact(draft => {
    replaceRoleBinding(draft, role, { sessionId, workspaceId: ownedWorkspace.id, workspacePath, agentPreset: presetId })
  }, { compareBeforeRename: true, readback: true })
  const businessPaths = ['/home', '/products', '/agent-center', '/artifacts', '/runs']
  const config = {
    version: 1,
    grid: { cols: 4, rows: 4 },
    scenes: [{
      id: 'o04-sdk-scene', label: 'SDK fixture', roleId: role, defaultBusinessRoute: '/home',
      panels: [
        { id: 'o04-sdk-panel', title: 'Chat', type: 'native-chat', col: 1, row: 1, w: 2, h: 2 },
        ...businessPaths.map((path, index) => ({ id: `o04-business-${index}`, title: `Business ${index}`, type: 'business-iframe', path, col: 1, row: 1, w: 1, h: 1 })),
      ],
    }],
    businessRoutes: Object.fromEntries(businessPaths.map((path, index) => [path, { sceneId: 'o04-sdk-scene', panelId: `o04-business-${index}` }])),
  }
  const managedConfigurationDigest = createHash('sha256').update('o04-session-rotation-config').digest('hex')
  const rotation = createSceneRotationHandlers({
    connection: { requestRejection: () => undefined },
    workspaceRegistry: context.get('workspaceRegistry'),
    sessionController: context.get('sessionController'),
  }, {
    createStateStore: async () => stateStore,
    readScenes: async () => JSON.stringify(config),
    readManagedConfigurationIdentityUnderLock: async () => ({ managedConfigurationSequence: 0, roleManagedConfigDigest: managedConfigurationDigest }),
    withManagedConfigurationLock: async (_role, action) => await action(),
    getHostEpoch: () => 'o04-sdk-host-epoch',
    ensureDurableRoleSession: async (_ctx, id, selectedWorkspace, cwd, preset) => {
      const observed = await context.sessionPersistence.stat(id)
      return () => Boolean(observed?.header?.id === id && observed?.header?.cwd === cwd
        && observed?.header?.agentPreset === preset && selectedWorkspace.path === cwd
        && selectedWorkspace.sessionIds.includes(id))
    },
    reconcileCreatedSession: createRotationSessionReconciler(context),
  })
  const preview = await invoke(rotation.preview, { sceneId: 'o04-sdk-scene', panelId: 'o04-sdk-panel' })
  assert.equal(preview.status, 200, JSON.stringify(preview.value))
  const originalAttach = ownedWorkspace.attachSession.bind(ownedWorkspace)
  let failFirstAttach = true
  let attachAttempts = 0
  ownedWorkspace.attachSession = async id => {
    attachAttempts += 1
    if (failFirstAttach) {
      failFirstAttach = false
      throw new Error('injected interruption at the real WorkspaceRegistry attach boundary')
    }
    return await originalAttach(id)
  }
  const confirmed = await invoke(rotation.confirm, { previewToken: preview.value.previewToken })
  assert.equal(confirmed.status, 503, JSON.stringify(confirmed.value))
  const creatingState = await stateStore.read()
  const interrupted = creatingState.sceneRotationOperations[preview.value.operationId]
  assert.equal(interrupted.status, 'creating')
  assert.equal(interrupted.createStarted, true)
  assert.equal(ownedWorkspace.sessionIds.includes(interrupted.newSessionId), false)
  await context.sessionPersistence.flush()
  const interruptedPersisted = await context.sessionPersistence.stat(interrupted.newSessionId)
  assert.equal(interruptedPersisted?.header?.id, interrupted.newSessionId)
  assert.equal(interruptedPersisted?.header?.cwd, workspacePath)
  assert.equal(interruptedPersisted?.header?.agentPreset, presetId)
  const resumed = await invoke(rotation.resume, { operationId: preview.value.operationId })
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value))
  assert.equal(resumed.value.status, 'completed')
  assert.equal(resumed.value.sessionId, interrupted.newSessionId)
  assert.notEqual(resumed.value.sessionId, sessionId)
  const finalState = await stateStore.read()
  assert.equal(finalState.roles[role].sessionId, resumed.value.sessionId)
  assert.equal(finalState.sceneRotationOperations[resumed.value.operationId].status, 'completed')
  assert.ok(context.workspaceRegistry.get(ownedWorkspace.id).sessionIds.includes(resumed.value.sessionId))
  await context.sessionPersistence.flush()
  const rotatedPersisted = await context.sessionPersistence.stat(resumed.value.sessionId)
  assert.equal(rotatedPersisted?.header?.id, resumed.value.sessionId)
  assert.equal(rotatedPersisted?.header?.cwd, workspacePath)
  assert.equal(rotatedPersisted?.header?.agentPreset, presetId)

  const abandonedPreview = await invoke(rotation.preview, { sceneId: 'o04-sdk-scene', panelId: 'o04-sdk-panel' })
  assert.equal(abandonedPreview.status, 200, JSON.stringify(abandonedPreview.value))
  failFirstAttach = true
  const abandonedConfirm = await invoke(rotation.confirm, { previewToken: abandonedPreview.value.previewToken })
  assert.equal(abandonedConfirm.status, 503, JSON.stringify(abandonedConfirm.value))
  const abandonedState = await stateStore.read()
  const abandonedOperation = abandonedState.sceneRotationOperations[abandonedPreview.value.operationId]
  assert.equal(abandonedOperation.status, 'creating')
  await context.sessionPersistence.flush()
  const originalObserve = context.sessionQuery.observeSession.bind(context.sessionQuery)
  let signalObserveStarted
  const observeStarted = new Promise(resolveStarted => { signalObserveStarted = resolveStarted })
  let releaseObserve
  const observeGate = new Promise(resolveGate => { releaseObserve = resolveGate })
  context.sessionQuery.observeSession = async id => {
    if (id === abandonedOperation.newSessionId) {
      signalObserveStarted()
      await observeGate
    }
    return await originalObserve(id)
  }
  const pendingResume = invoke(rotation.resume, { operationId: abandonedOperation.operationId })
  await observeStarted
  const abandoned = await invoke(rotation.abandon, { operationId: abandonedOperation.operationId })
  assert.equal(abandoned.status, 200, JSON.stringify(abandoned.value))
  assert.equal(abandoned.value.status, 'abandoned')
  const attachAttemptsBeforeRelease = attachAttempts
  releaseObserve()
  const rejectedResume = await pendingResume
  context.sessionQuery.observeSession = originalObserve
  assert.equal(rejectedResume.status, 409, JSON.stringify(rejectedResume.value))
  assert.equal(rejectedResume.value.error, 'rotation-abandoned')
  assert.equal(attachAttempts, attachAttemptsBeforeRelease, 'abandoned recovery must not start another SDK attach')
  const finalAbandonedState = await stateStore.read()
  assert.equal(finalAbandonedState.sceneRotationOperations[abandonedOperation.operationId].status, 'abandoned')
  assert.equal(ownedWorkspace.sessionIds.includes(abandonedOperation.newSessionId), false)

  const archivePreview = await invoke(rotation.preview, { sceneId: 'o04-sdk-scene', panelId: 'o04-sdk-panel', archiveOld: true })
  assert.equal(archivePreview.status, 200, JSON.stringify(archivePreview.value))
  assert.equal(archivePreview.value.archiveOld, true)
  const originalArchiveSession = context.workspaceRegistry.archiveSession.bind(context.workspaceRegistry)
  let archiveInvocation
  context.workspaceRegistry.archiveSession = async (id, options) => {
    archiveInvocation = { id, options: { ...options } }
    return await originalArchiveSession(id, options)
  }
  const archivedRotation = await invoke(rotation.confirm, { previewToken: archivePreview.value.previewToken })
  assert.equal(archivedRotation.status, 200, JSON.stringify(archivedRotation.value))
  assert.equal(archivedRotation.value.status, 'completed')
  assert.equal(archiveInvocation.id, resumed.value.sessionId)
  assert.equal(archiveInvocation.options.stopActivity, false)
  assert.ok(context.workspaceRegistry.archivedSessionIds.includes(resumed.value.sessionId))
  assert.ok(context.workspaceRegistry.get(ownedWorkspace.id).sessionIds.includes(resumed.value.sessionId))
  assert.equal((await stateStore.read()).roles[role].sessionId, archivedRotation.value.sessionId)

  const registeredHostRoutes = new Map()
  context.provide('webServer', { register({ kind, path, handler }) {
    assert.equal(typeof handler, 'function')
    if (kind === 'exact') registeredHostRoutes.set(path, handler)
    return () => { if (kind === 'exact') registeredHostRoutes.delete(path) }
  } })
  await context.plugin({ name: 'o04-host-scene-rotation-route-registration', inject: hostInject, apply: applyHost })
  for (const path of [
    '/tradeloom/scene-rotation/preview', '/tradeloom/scene-rotation/confirm',
    '/tradeloom/scene-rotation/status', '/tradeloom/scene-rotation/resume',
    '/tradeloom/scene-rotation/cancel', '/tradeloom/scene-rotation/abandon',
  ]) assert.equal(typeof registeredHostRoutes.get(path), 'function', `Host must register ${path}`)

  const repoRoot = resolve(process.cwd())
  const controllerPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-shell-controller.mjs')
  const preloadPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/lib/tradeloom-source-shell/source-preload.cjs')
  const mainPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js')
  const [controllerSource, preloadSource, mainSource] = await Promise.all([
    readFile(controllerPath, 'utf8'), readFile(preloadPath, 'utf8'), readFile(mainPath, 'utf8'),
  ])
  const extract = (source, startMarker, endMarker, label) => {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, `${label} source boundary exists`)
    return source.slice(start, end)
  }
  const ownerSource = extract(controllerSource, '  const assertWindow = event => {', '\n  const scene =', 'controller owner guard')
  const rotationOwnerSource = extract(controllerSource, '      const rotationOwner = event => {', '\n      const refreshRoleRotationSurfaces =', 'controller rotation owner')
  const refreshSource = extract(controllerSource, '      const refreshRoleRotationSurfaces = async (result, assertCapturedOwner) => {', '\n      const runRotationRequest =', 'controller role refresh')
  const runRequestSource = extract(controllerSource, '      const runRotationRequest = async (event, action, request) => {', "\n      bind('sceneRotationPreview'", 'controller request wrapper')
  const keySource = extract(controllerSource, '  const key = (s, p) => JSON.stringify([s, p])', '\n  const wrap =', 'controller key helper')
  const helpersSource = extract(controllerSource, '  const normalizeOrder = ids =>', '\n  const orderState', 'controller scene ordering helpers')
  const bindSource = extract(controllerSource, '  const bind = (name, fn) => {', '\n  const observeCreatePhase', 'controller IPC binder')
  const previewBinding = extract(controllerSource, "      bind('sceneRotationPreview', (event, request) => runRotationRequest(event, sceneRotationPreview, request))", '\n', 'controller preview binding')
  const confirmBinding = extract(controllerSource, "      bind('sceneRotationConfirm', (event, request) => runRotationRequest(event, sceneRotationConfirm, request))", '\n', 'controller confirm binding')
  const mainSourceRequest = extract(mainSource, 'const sourceRequest = async (path, body) => {', '\n\t};\n\t/* source-shell: role bootstrap loader begin */', 'Main sourceRequest') + '\n\t};'
  const mainForwarder = extract(mainSource, 'async function forwardWebRequest(request, host, cookie, writeWhaleRequestReceipt, trustedNative = false) {', '\n}\n//#endregion', 'Main web request forwarder') + '\n}'
  const mainSourceFailure = extract(mainSource, 'const sourceFailure = (message, code, httpStatus) => Object.assign(new Error(message), {',
    '\n\t});\n\tconst sourceRequest =', 'Main sourceFailure helper') + '\n\t});'
  const hostCookie = 'o04-isolated-auth=fixture-only'
  const hostAdmissionCalls = []
  let lastHostRouteReply
  context.connection.requestRejection = request => {
    hostAdmissionCalls.push(request.headers.cookie)
    return request.headers.cookie === hostCookie ? undefined : 403
  }
  const fetchToRegisteredHost = async (target, init) => {
    const url = new URL(target)
    const handler = registeredHostRoutes.get(url.pathname)
    if (!handler) return new Response(null, { status: 404 })
    const body = init.body ? await new Response(init.body).text() : ''
    const hostRequest = Readable.from(body ? [Buffer.from(body)] : [])
    hostRequest.method = init.method
    hostRequest.url = url.pathname + url.search
    hostRequest.headers = Object.fromEntries(new Headers(init.headers).entries())
    const hostResponse = response()
    await handler(hostRequest, hostResponse)
    lastHostRouteReply = { status: hostResponse.statusCode, body: hostResponse.body }
    return new Response(hostResponse.body, { status: hostResponse.statusCode, headers: hostResponse.headers })
  }
  const mainSandbox = {
    Request, Response, Headers, URL, fetch: fetchToRegisteredHost,
    backend: { host: 'o04-test-host' }, hostUrl: 'http://127.0.0.1:43123', hostCookie,
    classifyWhaleRequestTarget: () => 'host', BUSINESS_PATH: /^\/api\//,
    csrfCookieFromRequest: () => undefined, BUSINESS_CSRF_COOKIE: new Map(), BUSINESS_CSRF_BOOTSTRAP: new Map(),
    WITHHELD_RESPONSE_HEADERS: [], PLUGIN_BUNDLE_PATH: /$a/,
  }
  runInNewContext(`${mainForwarder}\n${mainSourceFailure}\n${mainSourceRequest}\nglobalThis.o04SourceRequest = sourceRequest`, mainSandbox,
    { filename: mainPath })

  const ipcHandlers = new Map()
  const ipcMain = { handle(channel, handler) { ipcHandlers.set(channel, handler) } }
  const sourceUrl = 'dsh-app://app/source-shell/renderer/source-entry.html'
  const sourceWindow = { webContents: { mainFrame: { url: sourceUrl } }, isDestroyed: () => false }
  const channels = []
  const productScenes = JSON.parse(await readFile(join(repoRoot, 'packages/tradeloom-shell/scenes.json'), 'utf8'))
  const currentRotationConfig = async () => {
    const current = await stateStore.read()
    return { ...productScenes, sessionBindings: Object.fromEntries(Object.entries(current.roles ?? {}).map(([id, binding]) => [id, binding.sessionId])) }
  }
  const controllerContext = {
    windows: new Map([['main', sourceWindow]]), accountPopout: undefined, rolePopouts: new Map(), views: new Map(),
    SOURCE_URL: sourceUrl, ACCOUNT_URL: 'dsh-app://app/source-shell/renderer/account-window.html',
    ipcMain, channels, observedOperations: {}, observeFailure() {}, config: await currentRotationConfig(),
    getConfig: currentRotationConfig, resolveBinding: async () => { throw new Error('unexpected resolve in empty-view refresh') },
    registry: {}, ownedPartition: 'persist:o04-private-test-partition',
    sceneRotationPreview: request => mainSandbox.o04SourceRequest('/tradeloom/scene-rotation/preview', request),
    sceneRotationConfirm: request => mainSandbox.o04SourceRequest('/tradeloom/scene-rotation/confirm', request),
  }
  runInNewContext(`(() => { ${keySource}; ${helpersSource}; ${ownerSource}; ${rotationOwnerSource}; ${refreshSource}; ${runRequestSource}; ${bindSource}; ${previewBinding}; ${confirmBinding}; return true })()`,
    controllerContext, { filename: controllerPath })
  const preloadWindow = {}
  const ipcRenderer = { invoke: async (channel, ...args) => {
    const handler = ipcHandlers.get(channel)
    assert.equal(typeof handler, 'function', `registered Main IPC handler exists for ${channel}`)
    return await handler({ sender: sourceWindow.webContents, senderFrame: sourceWindow.webContents.mainFrame }, ...args)
  } }
  runInNewContext(preloadSource, { require: name => {
    assert.equal(name, 'electron')
    return { contextBridge: { exposeInMainWorld(name, value) { preloadWindow[name] = value } }, ipcRenderer }
  } }, { filename: preloadPath })
  await assert.rejects(preloadWindow.app.sceneRotation.preview({}), error => error.code === 'HOST_HTTP_ERROR' && error.httpStatus === 400)
  const validScene = productScenes.scenes.find(item => item.roleId === role)
  const validPanel = validScene?.panels.find(item => item.type === 'native-chat')
  assert.ok(validScene && validPanel, 'the real product scenes config has a selectable panel for the fixture role')
  const realConfiguration = createAgentConfigurationResources(context)
  const realIdentity = await realConfiguration.withManagedConfigurationLock(role,
    () => realConfiguration.readManagedConfigurationIdentityUnderLock(role))
  assert.ok(Number.isSafeInteger(realIdentity.managedConfigurationSequence))
  assert.match(realIdentity.roleManagedConfigDigest, /^[a-f0-9]{64}$/)
  const validPreview = await preloadWindow.app.sceneRotation.preview({ sceneId: validScene.id, panelId: validPanel.id })
  assert.equal(validPreview.sceneId, validScene.id)
  assert.equal(validPreview.panelId, validPanel.id)
  assert.equal(validPreview.roleId, role)
  assert.equal(validPreview.expectedSessionId, (await stateStore.read()).roles[role].sessionId)
  assert.equal(validPreview.impactScope, 'current-config-visible-panels')
  const confirmedThroughMain = await preloadWindow.app.sceneRotation.confirm({ previewToken: validPreview.previewToken })
  assert.equal(confirmedThroughMain.status, 'completed')
  assert.notEqual(confirmedThroughMain.sessionId, validPreview.expectedSessionId)
  const confirmedState = await stateStore.read()
  assert.equal(confirmedState.roles[role].sessionId, confirmedThroughMain.sessionId)
  assert.equal(confirmedState.sceneRotationOperations[confirmedThroughMain.operationId].status, 'completed')
  assert.ok(context.workspaceRegistry.get(ownedWorkspace.id).sessionIds.includes(confirmedThroughMain.sessionId))
  await context.sessionPersistence.flush()
  const confirmedPersisted = await context.sessionPersistence.stat(confirmedThroughMain.sessionId)
  assert.equal(confirmedPersisted?.header?.id, confirmedThroughMain.sessionId)
  assert.equal(confirmedPersisted?.header?.cwd, workspacePath)
  assert.equal(confirmedPersisted?.header?.agentPreset, presetId)
  assert.deepEqual(hostAdmissionCalls, [hostCookie, hostCookie, hostCookie], 'Main forwarder supplies captured Host cookie for invalid preview, valid preview, and confirm')
  assert.equal(modelCalls, 0, 'the inert LLM provider must not be called')

  await context.sessionPersistence.flush()
  await context?.dispose?.()
  context = undefined
  const coldContext = new Context()
  try {
    await jsonl.apply(coldContext, { root: sessionRoot })
    const coldRead = await coldContext.sessionPersistence.stat(resumed.value.sessionId)
    assert.equal(coldRead?.header?.id, resumed.value.sessionId)
    assert.equal(coldRead?.header?.cwd, workspacePath)
    assert.equal(coldRead?.header?.agentPreset, presetId)
  } finally {
    await coldContext?.dispose?.()
  }
})
