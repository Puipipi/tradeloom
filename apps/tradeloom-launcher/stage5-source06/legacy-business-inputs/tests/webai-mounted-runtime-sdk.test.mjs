import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createWebAiNativeTargets } from '../webai-native-site-adapter.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createWebAiRuntimeFiles } from '../webai-runtime-files.js'
import { createExecutionOriginAuthority } from '../execution-origin-authority.js'
import { createWebAiDirectoryPolicies } from '../webai-directory-policy.js'
import { createScopedToolPolicy } from '../tool-policy.js'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'
import { executeNativeTool } from '../workflow-native-command-attribution.js'
import { createStateStore, HOME_MARKER, HOME_MARKER_VALUE, replaceRoleBinding, getRoleBindingRevision } from '../state.js'

test('actual rc2 ToolsService alias + existing sandboxed FS executes bounded files without replacing the provider', async t => {
  assert.ok(process.env.TL_SEVEN_SDK_RUNTIME && process.env.TL_SEVEN_TEST_ROOT, 'explicit rc2 runtime/owned test root required')
  const require = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  assert.equal(require('./package.json').version, '0.2.2-rc.2')
  const { Context, Service } = require('@deepseek-ai/cordis'), { ToolsService, ToolRuntime } = require('@deepseek-ai/dsh-tools')
  const { ToolExecutionPipeline } = require('@deepseek-ai/dsh-tools/pipeline')
  assert.equal(ToolsService, ToolRuntime, 'actual public rc2 alias, not a compatibility fake')
  const { LocalFileSystem } = require('@deepseek-ai/dsh-fs-local'), { SandboxedFileSystem } = require('@deepseek-ai/dsh-fs-sandbox')
  const { FsError } = require('@deepseek-ai/dsh-fs'), { scopeOf } = require('@deepseek-ai/dsh-scope')
  const { SessionStore } = require('@deepseek-ai/dsh-session'), { SessionProjectionRegistry } = require('@deepseek-ai/dsh-session-projection')
  const { AgentRegistry } = require('@deepseek-ai/dsh-agent'), { AgentLoop } = require('@deepseek-ai/dsh-agent-loop'), { SystemPrompt } = require('@deepseek-ai/dsh-system-prompt')
  const toolFs = require('@deepseek-ai/dsh-tool-fs')
  await mkdir(process.env.TL_SEVEN_TEST_ROOT, { recursive: true }); const root = await mkdtemp(join(process.env.TL_SEVEN_TEST_ROOT, 'mounted-files-'))
  await writeFile(join(root, 'synthetic.txt'), 'synthetic-only')
  const ctx = new Context()
  ctx.provide('llm', { prepareCall() { throw Error('no model request in filesystem composition') } })
  ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access' }) })
  ctx.provide('workingDirectory', { defaultDirectory: root, get: () => root, ensure: async () => root })
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(AgentRegistry); await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService); await ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin(SandboxedFileSystem, { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
  await ctx.plugin(toolFs, { read: false, readImage: false, write: true, edit: false, applyPatch: false })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  const originalFs = ctx.fs, actor = await ctx.agentLoop.create('file-owner', {}, { agentPreset: 'tradeloom-center' })
  const nestedEvidence = []
  ctx.on('tools/execute', async (exec, next) => {
    const value = await next()
    if (exec.parent !== undefined) nestedEvidence.push({ name: exec.name, parent: typeof exec.parent, rootCallId: exec.rootCallId, isError: value.isError, error: value.error, value: value.value })
    return value
  }, { global: true, prepend: true })
  const runtime = createWebAiRuntimeFiles(ctx, { ToolRuntime: ToolsService, ToolExecutionPipeline, LocalFileSystem, SandboxedFileSystem, FsError, scopeOf, standardFsTools: toolFs }, { enableFullRead: true, enableStandardWrite: true, useMountedFileSystem: true })
  t.after(async () => { await runtime.dispose(); await ctx.fiber.dispose() })
  let current = true, allowWrite = false, capability
  ctx.tools.register({ name: 'controlled_webai_request', description: 'Controlled real SDK operation; Main issuer is separately tested.',
    parameters: { type: 'object', additionalProperties: false, required: ['request'], properties: { request: { type: 'object', additionalProperties: true } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      capability = await runtime.bind({ exec, root, getRoot: () => root, isCurrent: () => current, getDeniedTools: () => allowWrite ? [] : ['write'] })
      return runtime.execute(capability, args.request)
    },
  })
  let call = 0
  const execute = (request, signal = new AbortController().signal) => executeNativeTool(ctx.tools, { name: 'controlled_webai_request', arguments: { request }, callId: `controlled-${++call}`, agent: actor, signal })
  const listed = await execute({ op: 'list', path: '.', requestId: 'list' })
  assert.equal(listed.value.ok, true, JSON.stringify(listed)); assert.ok(listed.value.entries.some(row => row.name === 'synthetic.txt'))
  assert.equal((await execute({ op: 'read', path: 'synthetic.txt', requestId: 'read' })).value.content, 'synthetic-only')
  assert.equal((await execute({ op: 'read', path: '../outside.txt', requestId: 'escape' })).value.ok, false)
  assert.equal((await execute({ op: 'write_new', path: 'created.txt', content: 'synthetic-new', requestId: 'no-write' })).value.ok, false)
  allowWrite = true
  const written = await execute({ op: 'write_new', path: 'created.txt', content: 'synthetic-new', requestId: 'write' })
  assert.equal(written.value.created, true, JSON.stringify({ written, nestedEvidence }))
  assert.equal((await execute({ op: 'write_new', path: 'created.txt', content: 'must not replace', requestId: 'duplicate' })).value.ok, false)
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'synthetic-new')
  assert.ok(nestedEvidence.every(row => row.parent === 'symbol' && row.rootCallId.startsWith('controlled-')))
  // Pause the actual public write-intent seam after its body was entered. The
  // real SDK still owns cancellation, finalization and the filesystem write.
  for (const mode of ['abort', 'revoke']) {
    let entered, release
    const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const stop = ctx.on('fs/write-intent', async (target, exec, next) => {
      if (target.displayPath.endsWith(`${mode}.txt`)) { entered(); await gate }
      return next()
    }, { global: true, prepend: true })
    const abort = new AbortController()
    const pending = execute({ op: 'write_new', path: `${mode}.txt`, content: 'must not publish', requestId: mode }, abort.signal)
    await started
    if (mode === 'abort') abort.abort(); else assert.equal(runtime.revoke(capability), true)
    release()
    const cancelled = await pending
    assert.ok(cancelled.isError || cancelled.value?.ok === false, JSON.stringify(cancelled))
    await assert.rejects(readFile(join(root, `${mode}.txt`)), { code: 'ENOENT' })
    assert.equal((await runtime.execute(capability, { op: 'list', path: '.', requestId: 'after-end' })).ok, false)
    stop()
  }
  // Cordis returns a fresh context-tracing proxy on each get(). Its documented
  // per-Service tracker is owned by the underlying provider, not the proxy.
  assert.equal(ctx.fs[Service.tracker] === originalFs[Service.tracker], true, 'the same provider owns both traced handles'); assert.ok(originalFs instanceof SandboxedFileSystem)
  t.diagnostic('actual nested list/read/create completed with original sandbox provider')
  current = false
  assert.equal((await runtime.execute(capability, { op: 'read', path: 'synthetic.txt', requestId: 'old' })).ok, false)
  assert.equal((await execute({ op: 'read', path: 'synthetic.txt', requestId: 'revoked' })).isError, true)
  await runtime.dispose()
  t.diagnostic('first scoped runtime disposed; starting Main-owner/Host composition')
  let resolving = false
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (!resolving && specifier.startsWith('@deepseek-ai/')) {
      resolving = true; try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } } finally { resolving = false }
    }
    return next(specifier, context)
  } }); t.after(() => hook.deregister())
  const { createWebAiDirectoryHost, createWebAiTaskHandler, WEB_AI_TASK_ROUTE } = await import(process.env.TL_SEVEN_DIRECTORY_HOST_SOURCE ? pathToFileURL(process.env.TL_SEVEN_DIRECTORY_HOST_SOURCE).href : '../webai-directory-host.js')
  assert.equal(typeof createWebAiTaskHandler, 'function', 'the actual Host must expose its authenticated task consumer')
  t.diagnostic('Host module loaded')
  let descriptorChanged = () => {}
  const producer = await sourceRoleIdentity(t, { sessionId: actor.session.id, onNativeDescriptorChanged: (...args) => descriptorChanged(...args) }), produced = await producer.descriptor()
  t.diagnostic('actual controller descriptor produced')
  let source = { ...produced, scope: 'role', guestId: producer.view().webContents.id,
    workspaceId: 'controlled', workspacePath: root, agentPreset: 'tradeloom-center' }
  const home = join(root, 'host-owned-home'); await mkdir(home); await writeFile(join(home, HOME_MARKER), HOME_MARKER_VALUE)
  const store = await createStateStore({ env: { DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home } })
  await store.transact(state => replaceRoleBinding(state, 'center', { sessionId: source.sessionId, workspaceId: source.workspaceId, workspacePath: root, agentPreset: source.agentPreset }))
  const authority = createExecutionOriginAuthority({ stateStore: store, isSessionLive: origin => origin.sessionId === actor.session.id, isSessionDurable: async origin => origin.bindingRevision === getRoleBindingRevision(await store.read(), 'center') })
  ctx.provide('sceneMemoryOriginAuthority', authority)
  const bytes = Buffer.from(JSON.stringify({ id: randomUUID() })), endpoint = 'tradeloom/controlled-webai-native-ask'
  const grant = await authority.registerGrant({ issuer: source, endpoint, httpMethod: 'POST', bodyBytes: bytes })
  const origin = await authority.verifyRequest({ token: grant.token, endpoint, routePath: endpoint, httpMethod: 'POST', method: endpoint,
    rpcId: JSON.parse(bytes).id, bodyBytes: bytes, bodyDigest: createHash('sha256').update(bytes).digest('hex'), peerId: 'controlled-owner', peerPrincipal: 'owner' })
  const owner = { ...source, operationId: origin.operationId }, target = { targetId: 'controlled', providerId: 'deepseek', windowId: 'controlled', conversationId: 'synthetic', generation: 1, available: true }
  const policies = createWebAiDirectoryPolicies({ readTarget: async () => target, assertOwner: async value => assert.equal(value.operationId, origin.operationId), chooseDirectory: async () => root, confirmAccess: async () => true })
  const permission = await policies.select(owner, target.targetId)
  const resolved = await policies.resolve(permission.id, owner, target, 'read')
  const host = createWebAiDirectoryHost(ctx, { getAuthority: async () => authority, assertBinding: async value => { assert.equal(value.bindingRevision, getRoleBindingRevision(await store.read(), 'center')) } })
  t.diagnostic('Host service registered')
  t.after(async () => { await host.dispose(); policies.dispose(); authority.dispose() })
  host.acceptControl({ action: 'mount', id: permission.id, owner, target, rootPath: resolved.rootPath, write: false, expiresAt: permission.expiresAt }, source)
  await authority.withVerifiedRequestOrigin(origin, async () => {
    const actualHostCall = args => {
      const work = authority.retainOriginWork(origin, { kind: 'queue', owner: actor })
      return executeNativeTool(ctx.tools, { name: 'tradeloom_webai_file', arguments: args, callId: `host-${++call}`, agent: actor,
        signal: new AbortController().signal, operationOrigin: origin, operationOriginWorkId: work })
    }
    const result = await actualHostCall({ grantId: permission.id, request: { op: 'read', path: 'synthetic.txt', requestId: 'host-read' } })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.content, 'synthetic-only')
    const releasePolicy = createScopedToolPolicy(actor.ctx, { deniedTools: ['read'] }, scopeOf)
    try {
      const denied = await actualHostCall({ grantId: permission.id, request: { op: 'read', path: 'synthetic.txt', requestId: 'role-denied' } })
      assert.equal(denied.value.ok, false); assert.equal(denied.value.error.code, 'TOOL_DENIED')
    } finally { releasePolicy() }
    host.acceptControl({ action: 'revoke', id: permission.id }, source)
    assert.equal((await actualHostCall({ grantId: permission.id, request: { op: 'read', path: 'synthetic.txt', requestId: 'after-revoke' } })).isError, true)
  })
  // Real issuer/state + SDK/FS, with a controlled Main dialog/target. No live
  // website adapter, Electron frame, CSRF transport or continuation is claimed.
  // New automatic envelope loop: the HTTP admission is controlled, while the
  // body-bound grant, canonical origin, actual SDK exec/FS and cleanup are real.
  const taskInput = { id: randomUUID(), providerId: 'deepseek', prompt: 'synthetic directory analysis' }
  const taskBytes = Buffer.from(JSON.stringify(taskInput)), taskEndpoint = WEB_AI_TASK_ROUTE.slice(1)
  const taskGrant = await authority.registerGrant({ issuer: source, endpoint: taskEndpoint, httpMethod: 'POST', bodyBytes: taskBytes })
  let taskOrigin, responseStatus, responseBody
  const wrappedAuthority = { ...authority, verifyRequest: async input => { taskOrigin = await authority.verifyRequest(input); return taskOrigin } }
  const handler = createWebAiTaskHandler({ connection: { requestRejection: req => req.controlledAuthenticated ? undefined : 403 } }, wrappedAuthority, host)
  const request = () => Object.assign(Readable.from([taskBytes]), { method: 'POST', headers: { 'x-tradeloom-origin': taskGrant.token }, controlledAuthenticated: true })
  const res = { setHeader() {}, set statusCode(value) { responseStatus = value }, end(value) { responseBody = JSON.parse(value) } }
  const deniedRequest = request(); deniedRequest.controlledAuthenticated = false
  await handler(deniedRequest, res); assert.equal(responseStatus, 403)
  await handler(request(), res); assert.equal(responseStatus, 200, JSON.stringify(responseBody))
  assert.deepEqual(Object.keys(responseBody.result), ['taskId'], 'HTTP cannot obtain task owner/nonce or issue observations')
  const taskId = responseBody.result.taskId
  const task = await host.taskControl({ action: 'task-read', taskId }, source)
  assert.equal(task.owner.operationId, taskOrigin.operationId)
  await assert.rejects(host.taskControl({ action: 'task-read', taskId }, { ...source, guestId: source.guestId + 1 }), { code: 'webai_task_unavailable' })
  const contents = new EventEmitter(); contents.id = 771; contents.isDestroyed = () => false
  const window = { id: 772, webContents: contents, isDestroyed: () => false }
  let receive, change, sends = [], fileExecutions = 0, throwStop = false, throwConversationStop = false
  const stopExecutionCount = ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'tradeloom_webai_file') fileExecutions++; return next() }, { global: true, prepend: true })
  t.after(stopExecutionCount)
  // Execute the exact author Main caller block. Electron IPC/transport and the
  // OS dialogs are controlled; the sender descriptor comes from real controller.
  const mainBegin = producer.mainSource.indexOf('\tlet webAiDirectoryPromise'), mainEnd = producer.mainSource.indexOf('\n\tlet sourceStartup;', mainBegin)
  assert.ok(mainBegin > 0 && mainEnd > mainBegin)
  const mainHandlers = new Map(), sourceContents = producer.view().webContents, mainApp = new EventEmitter(), shutdownErrors = []
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const makeMain = new AsyncFunction('join', 'process', 'pathToFileURL', 'app', 'randomUUID', 'backend', 'aiWebWindows', 'webContents', 'dialog', 'ordinaryMessageBox', 'ipcMain', 'assertDesktopSender', 'sourceController', 'console',
    producer.mainSource.slice(mainBegin, mainEnd) + ';return webAiDirectory();')
  const main = await makeMain((...parts) => parts[0] === 'controlled-resources' ? fileURLToPath(new URL('../', import.meta.url)) : join(...parts), { resourcesPath: 'controlled-resources' }, pathToFileURL, mainApp, randomUUID,
    { host: { async issueSceneMemoryOriginGrant(request) {
      assert.equal(request.endpoint, 'tradeloom/webai-directory-control'); assert.equal(request.httpMethod, 'POST')
      assert.equal(request.source.guestId, sourceContents.id)
      if (!['task-cancel', 'revoke'].includes(request.nativeDirectory.action)) {
        const current = producer.controller.nativeDescriptor(sourceContents, sourceContents.mainFrame)
        for (const key of ['generation', 'sceneId', 'panelId', 'roleId', 'sessionId', 'bindingRevision']) assert.equal(request.source[key], current[key])
      }
      const nativeDirectoryResult = request.nativeDirectory.action.startsWith('task-')
        ? await host.taskControl(request.nativeDirectory, request.source) : host.acceptControl(request.nativeDirectory, request.source)
      return { nativeDirectoryResult }
    } } },
    { windows: new Map([['deepseek', { liveWindow: () => window }]]) }, { fromId: id => id === sourceContents.id ? sourceContents : undefined },
    { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) }, async () => ({ response: 1 }),
    { handle: (name, handler) => mainHandlers.set(name, handler) }, event => { if (event.sender !== sourceContents || event.senderFrame !== sourceContents.mainFrame) throw Error('controlled rejected sender') }, producer.controller, { error: (...args) => shutdownErrors.push(args) })
  const registry = main.targets
  descriptorChanged = (contents, next) => main.invalidateSource(contents, next)
  t.after(() => registry.dispose())
  registry.register('deepseek', { inspect: async () => ({ conversationId: 'controlled-conversation', observedAt: Date.now() }),
    send: async (_contents, message) => { sends.push(message.content) },
    onAssistantMessage: (_contents, listener) => { receive = listener; return () => { receive = null; if (throwStop) throw Error('controlled_subscription_disposal_failed') } },
    onConversationChange: (_contents, listener) => { change = listener; return () => { change = null; if (throwConversationStop) throw Error('controlled_conversation_stop_failure') } } })
  const callMain = request => mainHandlers.get('dsh-desktop:webai-directory')(producer.roleEvent(), request)
  await assert.rejects(mainHandlers.get('dsh-desktop:webai-directory')({ sender: contents, senderFrame: {} }, { action: 'status' }), /rejected sender/)
  const running = callMain({ action: 'run-task', taskId, write: false })
  const until = async predicate => { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(predicate(), 'controlled loop must settle') }
  await until(() => sends.length === 1)
  producer.notifyLayout()
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(registry.status()[0].available, true, 'same full tuple layout notification preserves pending task')
  assert.ok(sends[0].includes(taskId))
  const observe = (messageId, request) => receive({ source: 'untrusted-content', role: 'assistant', isNew: true, complete: true,
    conversationId: 'controlled-conversation', messageId, content: JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId, ...request }) })
  observe('message-read', { requestId: 'automatic-read', op: 'read', path: 'synthetic.txt' })
  await until(() => sends.length === 2)
  const automatic = JSON.parse(sends[1]); assert.equal(automatic.result.content, 'synthetic-only'); assert.equal(fileExecutions, 1)
  observe('message-read-duplicate', { requestId: 'automatic-read', op: 'read', path: 'synthetic.txt' })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(sends.length, 2); assert.equal(fileExecutions, 1)
  observe('message-no-write', { requestId: 'automatic-no-write', op: 'write_new', path: 'automatic-denied.txt', content: 'must not write' })
  await until(() => sends.length === 3)
  assert.equal(JSON.parse(sends[2]).result.ok, false)
  await assert.rejects(readFile(join(root, 'automatic-denied.txt')), { code: 'ENOENT' })
  // Plain final analysis completes the owned task; it never executes as a tool.
  receive({ role: 'assistant', isNew: true, complete: true, conversationId: 'controlled-conversation', messageId: 'final', content: 'synthetic final analysis' })
  assert.equal((await running).completed, true)
  assert.equal(receive, null)
  await assert.rejects(async () => authority.withVerifiedRequestOrigin(taskOrigin, async () => {}), { code: 'operation_terminal' })
  assert.deepEqual(await host.taskControl({ action: 'task-cancel', taskId }, source), { cancelled: true }, 'normal cleanup is idempotent')
  assert.equal(registry.status()[0].available, false)
  const createFreshTask = async () => {
    const input = { ...taskInput, id: randomUUID() }, bytes = Buffer.from(JSON.stringify(input))
    const grant = await authority.registerGrant({ issuer: source, endpoint: taskEndpoint, httpMethod: 'POST', bodyBytes: bytes })
    await handler(Object.assign(Readable.from([bytes]), { method: 'POST', headers: { 'x-tradeloom-origin': grant.token }, controlledAuthenticated: true }), res)
    assert.equal(responseStatus, 200, JSON.stringify(responseBody))
    return { taskId: responseBody.result.taskId, origin: taskOrigin }
  }
  for (const mode of ['cancel', 'stop-throws']) {
    const fresh = await createFreshTask(), beforeSend = sends.length
    const run = callMain({ action: 'run-task', taskId: fresh.taskId, write: true }); void run.catch(() => {})
    await until(() => sends.length === beforeSend + 1)
    let entered, release
    const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const stopWrite = ctx.on('fs/write-intent', async (target, exec, next) => { if (target.displayPath.endsWith(`automatic-${mode}.txt`)) { entered(); await gate }; return next() }, { global: true, prepend: true })
    receive({ role: 'assistant', isNew: true, complete: true, conversationId: 'controlled-conversation', messageId: mode,
      content: JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: fresh.taskId, requestId: mode, op: 'write_new', path: `automatic-${mode}.txt`, content: 'must not commit' }) })
    await started
    throwStop = mode === 'stop-throws'
    const cancelled = callMain({ action: 'cancel-task', taskId: fresh.taskId }); void cancelled.catch(() => {})
    release()
    await cancelled
    await assert.rejects(run, error => mode === 'stop-throws' ? error instanceof AggregateError && error.errors.some(value => value.message === 'controlled_subscription_disposal_failed') : true)
    throwStop = false; stopWrite()
    await assert.rejects(readFile(join(root, `automatic-${mode}.txt`)), { code: 'ENOENT' })
    await assert.rejects(async () => authority.withVerifiedRequestOrigin(fresh.origin, async () => {}), { code: 'operation_terminal' })
    assert.equal(receive, null); assert.equal(registry.status()[0].available, false)
  }
  const throwing = await createFreshTask(), beforeThrow = sends.length
  const throwRun = callMain({ action: 'run-task', taskId: throwing.taskId, write: false })
  await until(() => sends.length === beforeThrow + 1)
  const stopThrow = ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'tradeloom_webai_file') throw Error('controlled_sdk_execution_failure'); return next() }, { global: true, prepend: true })
  receive({ role: 'assistant', isNew: true, complete: true, conversationId: 'controlled-conversation', messageId: 'throws', content: JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: throwing.taskId, requestId: 'throws', op: 'read', path: 'synthetic.txt' }) })
  await until(() => sends.length === beforeThrow + 2)
  assert.equal(JSON.parse(sends.at(-1)).result.ok, false)
  assert.equal(sends.at(-1).includes('controlled_sdk_execution_failure'), false, 'raw SDK error is not sent to the page')
  stopThrow()
  receive({ role: 'assistant', isNew: true, complete: true, conversationId: 'controlled-conversation', messageId: 'throws-final', content: 'synthetic final' })
  await throwRun
  await assert.rejects(async () => authority.withVerifiedRequestOrigin(throwing.origin, async () => {}), { code: 'operation_terminal' })
  // A real controller generation/binding notification, not a JSON key-only mock.
  const rebinding = await createFreshTask(), beforeBinding = sends.length
  const oldRun = callMain({ action: 'run-task', taskId: rebinding.taskId, write: false }); void oldRun.catch(() => {})
  await until(() => sends.length === beforeBinding + 1)
  const nextDescriptor = await producer.rotateSameSession()
  await assert.rejects(oldRun)
  await assert.rejects(async () => authority.withVerifiedRequestOrigin(rebinding.origin, async () => {}), { code: 'operation_terminal' })
  assert.equal(registry.status()[0].available, false)
  source = { ...source, ...nextDescriptor }
  source.workspaceId = 'controlled-next-workspace'
  await store.transact(state => replaceRoleBinding(state, 'center', { sessionId: source.sessionId, workspaceId: source.workspaceId, workspacePath: root, agentPreset: source.agentPreset }))
  assert.equal(getRoleBindingRevision(await store.read(), 'center'), source.bindingRevision)
  const closing = await createFreshTask(), beforeClose = sends.length
  const closeRun = callMain({ action: 'run-task', taskId: closing.taskId, write: true }); void closeRun.catch(() => {})
  await until(() => sends.length === beforeClose + 1)
  let closeEntered, closeRelease
  const closeStarted = new Promise(resolve => { closeEntered = resolve }), closeGate = new Promise(resolve => { closeRelease = resolve })
  const stopCloseWrite = ctx.on('fs/write-intent', async (target, exec, next) => { if (target.displayPath.endsWith('automatic-close.txt')) { closeEntered(); await closeGate }; return next() }, { global: true, prepend: true })
  receive({ role: 'assistant', isNew: true, complete: true, conversationId: 'controlled-conversation', messageId: 'close-write', content: JSON.stringify({ version: 1, kind: 'tradeloom-file-task', taskId: closing.taskId, requestId: 'close-write', op: 'write_new', path: 'automatic-close.txt', content: 'must not commit' }) })
  await closeStarted
  producer.controller.destroy()
  const disposing = host.dispose(); closeRelease()
  await assert.rejects(closeRun)
  await disposing; stopCloseWrite()
  await assert.rejects(readFile(join(root, 'automatic-close.txt')), { code: 'ENOENT' })
  await assert.rejects(async () => authority.withVerifiedRequestOrigin(closing.origin, async () => {}), { code: 'operation_terminal' })
  assert.equal(receive, null)
  throwConversationStop = true
  assert.doesNotThrow(() => mainApp.emit('will-quit'), 'target cleanup error must not skip remaining exit cleanup or block ordinary exit')
  assert.ok(registry.status().every(row => !row.available && !row.transportReady))
  assert.equal(change, null)
  assert.deepEqual(shutdownErrors, [['webai directory shutdown cleanup failed', { failures: 1 }]])
  t.diagnostic('actual Main/Host/SDK loop: read/dedup/default-deny; in-flight cancel/stop-throw/dispose no write; same tuple survives, rebind/destroy terminal; transport/dialog/auth admission controlled, no site/model')
})

test('target disposal removes both targets/listeners even when conversation subscriptions throw', () => {
  const windows = new Map(['deepseek', 'doubao'].map((provider, index) => {
    const contents = new EventEmitter(); contents.id = index + 1; contents.isDestroyed = () => false
    return [provider, { id: index + 10, webContents: contents, isDestroyed: () => false }]
  }))
  let stopped = 0, revoked = 0
  const registry = createWebAiNativeTargets({ findWindow: provider => windows.get(provider), revokeTarget: () => { revoked++ } })
  for (const provider of windows.keys()) registry.register(provider, { inspect() {}, send() {}, onAssistantMessage() {},
    onConversationChange() { return () => { stopped++; throw Error('controlled_conversation_stop_failure') } } })
  assert.throws(() => registry.dispose(), error => error instanceof AggregateError && error.errors.length === 2)
  assert.equal(stopped, 2); assert.equal(revoked, 2)
  for (const window of windows.values()) { assert.equal(window.webContents.listenerCount('did-start-navigation'), 0); assert.equal(window.webContents.listenerCount('destroyed'), 0) }
  assert.ok(registry.status().every(row => !row.available && !row.transportReady))
  registry.dispose()
})

test('actual Main validator/control/consumer accepts only correlated private revocation receipts', async () => {
  const inputs = JSON.parse(await readFile(process.env.TL_SEVEN_DESKTOP_INPUTS, 'utf8'))
  const raw = await readFile(inputs.main.path)
  assert.equal(createHash('sha256').update(raw).digest('hex'), inputs.main.sha256)
  const source = raw.toString()
  const slice = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return source.slice(start, end) }
  const validator = new Function(slice('function isDesktopHostEvent(', '\nasync function exitsWithin(') + ';return isDesktopHostEvent;')()
  for (const malformed of ['bad', 1, true, null, undefined]) {
    let accepted
    assert.doesNotThrow(() => { accepted = validator({ type: 'scene-memory-origin-grant', requestId: 1, grant: malformed }, () => false) })
    assert.equal(accepted, false, 'malformed grant must be rejected, never thrown or accepted')
  }
  const methods = new Function('return ({' + slice('\tasync control(request,', '\n\t/**') + ',' + slice('\tasync issueSceneMemoryOriginGrant(request)', '\n};') + '});')()
  const subscribe = new Function('child', 'isDesktopHostEvent', 'observeStartup', 'DesktopHostFatalError', slice('\t\tchild.on("message", (message) => {', '\n\t\tchild.once("error"'))
  const call = async (request, receipt) => {
    const child = new EventEmitter(); child.connected = true; let killAttempts = 0
    child.kill = () => { killAttempts++ }
    child.send = (message, callback) => { queueMicrotask(() => { child.emit('message', { type: 'scene-memory-origin-grant', requestId: message.requestId, grant: receipt }); callback(null) }) }
    const owner = { ...methods, child, nextControlId: 1, controlRequests: new Map(), operationBridge: { isRunId: () => false },
      fail(error) { this.failureReported = true; for (const pending of this.controlRequests.values()) pending.reject(error) } }
    subscribe.call(owner, child, validator, () => {}, Error)
    try { const value = await owner.issueSceneMemoryOriginGrant(request); assert.equal(killAttempts, 0); assert.equal(owner.controlRequests.size, 0); return value }
    finally { child.removeAllListeners() }
  }
  const revoke = action => ({ endpoint: 'tradeloom/webai-directory-control', httpMethod: 'POST', nativeDirectory: { action, ...(action === 'revoke' ? { id: 'controlled' } : { taskId: 'controlled' }) } })
  const normal = { endpoint: 'tradeloom/scene-memory', httpMethod: 'POST' }
  const grant = { token: 'controlled-token', expiresAt: Date.now() + 1000, hostEpoch: 'controlled-epoch' }
  assert.deepEqual(await call(normal, grant), grant)
  assert.deepEqual(await call(revoke('task-cancel'), { controlOnly: true, nativeDirectoryResult: { cancelled: true } }), { controlOnly: true, nativeDirectoryResult: { cancelled: true } })
  assert.deepEqual(await call(revoke('revoke'), { controlOnly: true, nativeDirectoryResult: false }), { controlOnly: true, nativeDirectoryResult: false })
  for (const [request, receipt] of [
    [normal, { controlOnly: true, nativeDirectoryResult: { cancelled: true } }],
    [revoke('task-read'), { controlOnly: true, nativeDirectoryResult: { cancelled: true } }],
    [{ ...revoke('revoke'), endpoint: 'tradeloom/other' }, { controlOnly: true, nativeDirectoryResult: true }],
    [revoke('task-cancel'), { controlOnly: true, nativeDirectoryResult: { cancelled: false } }],
    [revoke('revoke'), { controlOnly: true, nativeDirectoryResult: { cancelled: true } }],
    [revoke('task-cancel'), { controlOnly: true, nativeDirectoryResult: { cancelled: true }, extra: true }],
  ]) await assert.rejects(call(request, receipt), /invalid IPC event|invalid grant/)
})
