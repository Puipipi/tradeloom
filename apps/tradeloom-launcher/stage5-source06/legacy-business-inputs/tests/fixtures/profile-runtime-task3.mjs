import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const rootInput = process.env.TASK3_PROFILE_RUN_ROOT ?? ''
const repoInput = process.env.TASK3_REPO_ROOT ?? ''
const candidateInput = process.env.TRADELOOM_DSH_PINNED_SOURCE ?? ''
const root = isAbsolute(rootInput) ? resolve(rootInput) : ''
const repo = isAbsolute(repoInput) ? resolve(repoInput) : ''
const candidate8 = isAbsolute(candidateInput) ? resolve(candidateInput) : ''
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const fail = code => { const error = new Error(code); error.code = code; throw error }
let profileRuntime
let httpHandler
let httpServer
let cleanupRoot
let providerServer

async function jsonRequest(client, path, method = 'GET', body) {
  const response = await client.request(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let value
  try { value = await response.json() } catch { value = undefined }
  return { status: response.status, value }
}

function editableServer(server) {
  const secretMap = values => Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, {
    envName: value.envName, scheme: value.scheme,
  }]))
  if (server.transport === 'stdio') return { ...server, env: secretMap(server.env) }
  return { ...server, headers: secretMap(server.headers) }
}

async function hasPersistedSessionDirectory(root, sessionId) {
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name.includes(sessionId)) return true
      pending.push(join(directory, entry.name))
    }
  }
  return false
}

async function authenticatedClient(ctx) {
  const origin = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const setCookie = login.headers.get('set-cookie')
  if (login.status !== 303 || !setCookie) fail(`AUTH_EXCHANGE_${login.status}`)
  const cookie = setCookie.split(';', 1)[0]
  return {
    async request(path, init = {}) {
      return fetch(new URL(path, `${origin}/`), {
        ...init,
        headers: { ...init.headers, cookie },
        redirect: 'manual',
      })
    },
  }
}

async function startMcpFixture() {
  const require = createRequire(join(candidate8, 'packages', 'mcp', 'mcp-client', 'package.json'))
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server')
  const { toNodeHandler } = require('@modelcontextprotocol/node')
  const { z } = require('zod')
  const calls = { authenticated: false, ping: 0 }
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'task3-profile-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('ping', { description: 'synthetic loopback ping', inputSchema: z.object({}) }, async () => {
      calls.ping += 1
      return { content: [{ type: 'text', text: 'task3-profile-pong' }] }
    })
    return server
  })
  const serve = toNodeHandler(handler)
  const expectedAuthorization = `Bearer ${process.env.TASK3_PROFILE_MCP_TOKEN}`
  httpServer = createServer((request, response) => {
    if (request.headers.authorization === expectedAuthorization) calls.authenticated = true
    void serve(request, response)
  })
  httpServer.listen(0, '127.0.0.1')
  await new Promise((resolveListen, reject) => {
    httpServer.once('listening', resolveListen)
    httpServer.once('error', reject)
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') fail('MCP_FIXTURE_BIND_FAILED')
  httpHandler = handler
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls }
}

async function main() {
  const dshHomeInput = process.env.DSH_HOME ?? ''
  const appHomeInput = process.env.TRADELOOM_DSH_APP_HOME ?? ''
  if (!root || !repo || !candidate8 || !isAbsolute(dshHomeInput) || !isAbsolute(appHomeInput)
    || resolve(dshHomeInput) !== resolve(appHomeInput)) fail('ISOLATED_ENV_INVALID')
  const evidenceRoot = resolve(fileURLToPath(new URL('../../../../../workspace/testing/agent-capability-configuration-20261023/', import.meta.url)))
  const [actualEvidenceRoot, actualRunRoot, actualRepo, actualCandidate] = await Promise.all([
    realpath(evidenceRoot).catch(() => undefined), realpath(root).catch(() => undefined),
    realpath(repo).catch(() => undefined), realpath(candidate8).catch(() => undefined),
  ])
  if (!actualEvidenceRoot || !actualRunRoot || !actualRepo || !actualCandidate
    || dirname(actualRunRoot) !== actualEvidenceRoot || actualRunRoot === actualRepo
    || actualRunRoot === actualCandidate || actualRepo === actualCandidate) fail('ISOLATED_ROOT_INVALID')
  cleanupRoot = await realpath(root)
  const dshHome = resolve(dshHomeInput)
  if (dirname(dshHome) !== cleanupRoot || dshHome === actualRepo || dshHome === actualCandidate) fail('ISOLATED_DSH_HOME_INVALID')
  const isolated = join(cleanupRoot, 'isolated-profile-runtime')
  await mkdir(isolated, { recursive: true })
  const isolatedReal = await realpath(isolated)
  if (dirname(isolatedReal) !== cleanupRoot) fail('ISOLATED_ROOT_INVALID')
  const dirs = {
    home: join(isolatedReal, 'home'), userProfile: join(isolatedReal, 'user-profile'),
    roaming: join(isolatedReal, 'appdata'), local: join(isolatedReal, 'localappdata'),
    temp: join(isolatedReal, 'temp'), dsh: dshHome,
  }
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
  await writeFile(join(dirs.dsh, '.tradeloom-owned'), 'tradeloom-dsh-apphome-v1\n', { encoding: 'utf8', flag: 'wx' })
  process.env.HOME = dirs.home
  process.env.USERPROFILE = dirs.userProfile
  process.env.APPDATA = dirs.roaming
  process.env.LOCALAPPDATA = dirs.local
  process.env.TEMP = dirs.temp
  process.env.TMP = dirs.temp
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.chdir(isolatedReal)

  const profileBoot = await import(pathToFileURL(join(candidate8, 'apps', 'cli', 'lib', 'profile-boot.js')).href)
  const profileName = 'tradeloom'
  let profile = profileBoot.prepareProfile(profileName, true, 'web')
  const packageRoot = join(repo, 'packages', 'tradeloom-shell')
  const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const link = join(profile.dir, 'node_modules', ...packageManifest.name.split('/'))
  await mkdir(dirname(link), { recursive: true })
  await symlink(packageRoot, link, 'junction')
  const profileManifestPath = join(profile.dir, 'package.json')
  const manifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
  manifest.dependencies ??= {}
  manifest.dependencies[packageManifest.name] = 'workspace:*'
  manifest.dsh.profile.bundles.push(packageManifest.name)
  await writeFile(profileManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  profile = profileBoot.prepareProfile(profileName, true)

  const mcp = await startMcpFixture()
  const toolName = 'mcp__task3profile__ping'
  const overlayPath = join(cleanupRoot, 'synthetic-provider.patch.yml')
  await writeFile(overlayPath, JSON.stringify([{ id: 'llm-pi-ai', config: { providers: {
    'task3-local': { apiKeyEnv: 'TASK3_LOCAL_MODEL_KEY', displayName: 'Task3 synthetic local model', api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'task3-only', name: 'Task3 local placeholder', contextWindow: 8192, maxTokens: 512 }] },
  } } }]), 'utf8')
  const [launchEnvironmentModule] = await Promise.all([
    import(pathToFileURL(join(candidate8, 'packages', 'util', 'launch-environment', 'lib', 'index.js')).href),
  ])
  const environment = launchEnvironmentModule.createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }])
  const booted = await profileBoot.runProfile({ environment, profile: profileName,
    resolvedProfile: { profile, installAnchor: profileBoot.INSTALL_ANCHOR }, patchFiles: [overlayPath],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
  })
  profileRuntime = booted
  const ctx = booted.ctx
  const origin = ctx.webServer.getOrigin()
  const client = await authenticatedClient(ctx)

  const firstSessionResponse = await jsonRequest(client, '/tradeloom/session', 'POST', { role: 'center' })
  if (firstSessionResponse.status !== 200 || typeof firstSessionResponse.value?.sessionId !== 'string') fail('INITIAL_SESSION_CREATE_FAILED')
  const firstSessionId = firstSessionResponse.value.sessionId
  const selected = await ctx.sessionController.selectModel({ sessionId: firstSessionId, provider: 'task3-local', model: 'task3-only' })
  if (selected.selected?.provider !== 'task3-local' || selected.selected?.model !== 'task3-only') fail('SYNTHETIC_MODEL_SELECTION_FAILED')

  const cfg0 = await jsonRequest(client, '/tradeloom/agent-configuration?role=center')
  if (cfg0.status !== 200 || !Array.isArray(cfg0.value?.mcpServers)) fail(`CONFIG_GET_BEFORE_${cfg0.status}`)
  const server = {
    id: 'tradeloom-mcp-task3profile', transport: 'streamable-http', serverName: 'task3profile',
    toolCallTimeoutMs: 5000, failOnStartupError: true, url: mcp.url,
    headers: { Authorization: { envName: 'TASK3_PROFILE_MCP_TOKEN', scheme: 'bearer' } },
  }
  const put0 = await jsonRequest(client, '/tradeloom/agent-configuration?role=center', 'PUT', {
    expectedRevision: cfg0.value.revision, mcpServers: [server],
    skill: { includeDefaultRoots: true, customSkillDirs: [] }, deniedTools: [],
  })
  if (put0.status !== 200 || put0.value?.appliedForNewAgents !== true || put0.value?.currentSessionUnchanged !== true) {
    const safeError = ['configuration-unavailable', 'profile-not-owned', 'revision-conflict', 'unsupported-managed-config',
      'invalid-configuration', 'server-name-conflict', 'configuration-apply-failed'].includes(put0.value?.error)
      ? put0.value.error.toUpperCase().replaceAll('-', '_') : 'OTHER'
    fail(`CONFIG_PUT_ENV_REFERENCE_${put0.status}_${safeError}`)
  }
  const cfg1 = await jsonRequest(client, '/tradeloom/agent-configuration?role=center')
  const projectedServer = cfg1.value?.mcpServers?.[0]
  if (cfg1.status !== 200 || projectedServer?.headers?.Authorization?.envName !== 'TASK3_PROFILE_MCP_TOKEN'
    || projectedServer.headers.Authorization.scheme !== 'bearer' || projectedServer.headers.Authorization.present !== true
    || JSON.stringify(cfg1.value).includes(process.env.TASK3_PROFILE_MCP_TOKEN)) fail('CONFIG_ENV_REFERENCE_PROJECTION_FAILED')

  const operation1 = randomUUID()
  const newSessionRequest1 = { role: 'center', expectedSessionId: firstSessionId, operationId: operation1 }
  const created1 = await jsonRequest(client, '/tradeloom/session/new', 'POST', newSessionRequest1)
  if (created1.status !== 201 || created1.value?.sessionId !== `session-${operation1}`) fail('NEW_SESSION_CREATE_FAILED')
  const replay1 = await jsonRequest(client, '/tradeloom/session/new', 'POST', newSessionRequest1)
  if (replay1.status !== 200 || replay1.value?.replayed !== true || replay1.value.sessionId !== created1.value.sessionId) fail('NEW_SESSION_REPLAY_FAILED')
  const generation1 = ctx.agents.get(created1.value.sessionId)
  if (!generation1 || await ctx.get('agentPresets').composedPreset(generation1.ctx) !== 'tradeloom-center') fail('FIRST_GENERATION_PRESET_MISMATCH')
  const schemas1 = ctx.tools.schemas(generation1)
  if (!Array.isArray(schemas1) || !schemas1.some(schema => schema?.name === toolName)) fail('MCP_TOOL_NOT_VISIBLE')
  const oldObsBefore = await ctx.sessionQuery.observeSession(firstSessionId)
  const firstHeader = structuredClone(oldObsBefore.header)
  const firstHistoryLength = oldObsBefore.events.length
  oldObsBefore[Symbol.dispose]()
  const call1 = await ctx.tools.execute({ callId: `task3-profile-${randomUUID()}`, signal: new AbortController().signal,
    name: toolName, arguments: {}, agent: generation1 })
  if (call1?.content?.[0]?.text !== 'task3-profile-pong') fail('MCP_TOOL_EXECUTION_FAILED')

  const editor = ctx.get('configEditor')
  const presetEntry = editor.entries().find(entry => entry?.options?.config?.id === 'tradeloom-center')
  if (!presetEntry) fail('ACTIVE_PRESET_ENTRY_MISSING')
  const configBeforeFailedReconcile = JSON.stringify(presetEntry.options.config)
  const patchBeforeFailedReconcile = await readFile(ctx.get('profileContext').patchPath, 'utf8')
  const failedReconcile = await jsonRequest(client, '/tradeloom/agent-configuration?role=center', 'PUT', {
    expectedRevision: cfg1.value.revision,
    mcpServers: [
      editableServer(projectedServer),
      {
        id: 'tradeloom-mcp-task3offline', transport: 'streamable-http', serverName: 'task3offline',
        toolCallTimeoutMs: 3000, failOnStartupError: true, url: 'http://127.0.0.1:9/unavailable',
        headers: { Authorization: { envName: 'TASK3_PROFILE_MCP_TOKEN', scheme: 'bearer' } },
      },
    ],
    skill: cfg1.value.skill, deniedTools: cfg1.value.deniedTools,
  })
  if (failedReconcile.status !== 503 || failedReconcile.value?.error !== 'configuration-apply-failed') {
    fail(`FAILED_RECONCILE_STATUS_${failedReconcile.status}`)
  }
  const afterFailedReconcile = await jsonRequest(client, '/tradeloom/agent-configuration?role=center')
  const presetAfterFailedReconcile = editor.entries().find(entry => entry?.options?.config?.id === 'tradeloom-center')
  const patchAfterFailedReconcile = await readFile(ctx.get('profileContext').patchPath, 'utf8')
  const reconcileRollback = afterFailedReconcile.status === 200
    && afterFailedReconcile.value.revision === cfg1.value.revision
    && afterFailedReconcile.value.mcpServers.length === 1
    && !JSON.stringify(afterFailedReconcile.value).includes('task3offline')
    && JSON.stringify(presetAfterFailedReconcile?.options?.config) === configBeforeFailedReconcile
    && patchAfterFailedReconcile === patchBeforeFailedReconcile
  if (!reconcileRollback) fail('CONFIG_RECONCILE_ROLLBACK_FAILED')
  const call1AfterFailedReconcile = await ctx.tools.execute({ callId: `task3-profile-${randomUUID()}`, signal: new AbortController().signal,
    name: toolName, arguments: {}, agent: generation1 })
  if (call1AfterFailedReconcile?.content?.[0]?.text !== 'task3-profile-pong') fail('OLD_GENERATION_CHANGED_AFTER_FAILED_RECONCILE')

  const recoveryOperation = randomUUID()
  const recoverySession = await jsonRequest(client, '/tradeloom/session/new', 'POST', {
    role: 'center', expectedSessionId: created1.value.sessionId, operationId: recoveryOperation,
  })
  if (recoverySession.status !== 201 || recoverySession.value?.sessionId !== `session-${recoveryOperation}`) {
    fail('SESSION_CREATE_AFTER_COMPENSATION_FAILED')
  }
  const recoveryAgent = ctx.agents.get(recoverySession.value.sessionId)
  if (!recoveryAgent || await ctx.get('agentPresets').composedPreset(recoveryAgent.ctx) !== 'tradeloom-center'
    || !ctx.tools.schemas(recoveryAgent).some(schema => schema?.name === toolName)) fail('RECOVERY_GENERATION_NOT_AVAILABLE')
  const recoveryCall = await ctx.tools.execute({ callId: `task3-profile-${randomUUID()}`, signal: new AbortController().signal,
    name: toolName, arguments: {}, agent: recoveryAgent })
  if (recoveryCall?.content?.[0]?.text !== 'task3-profile-pong') fail('RECOVERY_GENERATION_MCP_FAILED')

  const cfg2 = await jsonRequest(client, '/tradeloom/agent-configuration?role=center')
  if (cfg2.status !== 200) fail('CONFIG_GET_FOR_POLICY_FAILED')
  const put1 = await jsonRequest(client, '/tradeloom/agent-configuration?role=center', 'PUT', {
    expectedRevision: cfg2.value.revision, mcpServers: cfg2.value.mcpServers.map(editableServer),
    skill: cfg2.value.skill, deniedTools: [toolName],
  })
  if (put1.status !== 200) {
    const safeError = ['configuration-unavailable', 'profile-not-owned', 'revision-conflict', 'unsupported-managed-config',
      'invalid-configuration', 'server-name-conflict', 'configuration-apply-failed'].includes(put1.value?.error)
      ? put1.value.error.toUpperCase().replaceAll('-', '_') : 'OTHER'
    fail(`CONFIG_PUT_POLICY_${put1.status}_${safeError}`)
  }
  const operation2 = randomUUID()
  const newSessionRequest2 = { role: 'center', expectedSessionId: recoverySession.value.sessionId, operationId: operation2 }
  const created2 = await jsonRequest(client, '/tradeloom/session/new', 'POST', newSessionRequest2)
  if (created2.status !== 201 || created2.value?.sessionId !== `session-${operation2}`) fail('SECOND_NEW_SESSION_CREATE_FAILED')
  const generation2 = ctx.agents.get(created2.value.sessionId)
  if (!generation2 || await ctx.get('agentPresets').composedPreset(generation2.ctx) !== 'tradeloom-center') fail('SECOND_GENERATION_PRESET_MISMATCH')
  const call2 = await ctx.tools.execute({ callId: `task3-profile-${randomUUID()}`, signal: new AbortController().signal,
    name: toolName, arguments: {}, agent: generation2 })
  if (call2?.isError !== true) fail('NEW_POLICY_DID_NOT_DENY_TOOL')
  const call1Again = await ctx.tools.execute({ callId: `task3-profile-${randomUUID()}`, signal: new AbortController().signal,
    name: toolName, arguments: {}, agent: generation1 })
  if (call1Again?.content?.[0]?.text !== 'task3-profile-pong') fail('OLD_GENERATION_CHANGED_AFTER_SAVE')
  const oldObsAfter = await ctx.sessionQuery.observeSession(firstSessionId)
  const oldPreserved = JSON.stringify(oldObsAfter.header) === JSON.stringify(firstHeader) && oldObsAfter.events.length === firstHistoryLength
  oldObsAfter[Symbol.dispose]()
  const diskState = JSON.parse(await readFile(join(dirs.dsh, 'tradeloom-state', 'state.json'), 'utf8'))
  const diskBindingPersisted = diskState?.roles?.center?.sessionId === created2.value.sessionId
  const oldDiskSession = await hasPersistedSessionDirectory(dirs.dsh, firstSessionId)
  const newDiskSession = await hasPersistedSessionDirectory(dirs.dsh, created2.value.sessionId)
  if (!oldPreserved || mcp.calls.ping !== 4 || !mcp.calls.authenticated
    || !diskBindingPersisted || !oldDiskSession || !newDiskSession) fail('GENERATION_OR_DISK_PERSISTENCE_ASSERTION_FAILED')

  output({ ok: true, profileBoot: true, officialConfigEditor: Boolean(ctx.get('configEditor')),
    officialSessionController: true, officialSessionQuery: true, officialWorkspaceRegistry: true,
    productToolPolicy: true, mcpAuthorizationEnvReferenceRoundTrip: true,
    mcpPingCalls: mcp.calls.ping, mcpAuthorizationObserved: mcp.calls.authenticated,
    configEditorStartupFailureRollback: reconcileRollback,
    recoveryGenerationAfterRollback: recoveryCall?.content?.[0]?.text === 'task3-profile-pong',
    newSessionReplay: true, oldSessionHistoryPreserved: oldPreserved,
    diskStateBindingPersisted: diskBindingPersisted,
    oldSessionDiskArtifact: oldDiskSession, newSessionDiskArtifact: newDiskSession,
    oldGenerationAllowedAfterSave: call1Again?.content?.[0]?.text === 'task3-profile-pong',
    newGenerationDenied: call2?.isError === true,
  })
}

try {
  await main()
} catch (error) {
  output({ ok: false, code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'RUNTIME_FIXTURE_FAILED' })
  process.exitCode = 1
} finally {
  if (profileRuntime?.shutdown) {
    try { await profileRuntime.shutdown.shutdown(0) } catch {}
  }
  if (httpHandler) { try { await httpHandler.close() } catch {} }
  if (httpServer?.listening) await new Promise(resolveClose => httpServer.close(resolveClose))
  if (providerServer?.listening) await new Promise(resolveClose => providerServer.close(resolveClose))
}
