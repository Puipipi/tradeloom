import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NATIVE_WEB_AI_TOOLS, mountOptionalWebAiHost } from '../candidates/webai-native-bridge/split/host-native.mjs'
import { createMainWebAiTransport } from '../candidates/webai-native-bridge/split/main.mjs'
import { WEB_AI_NATIVE_HEADER, WEB_AI_NATIVE_PATH } from '../candidates/webai-native-bridge/split/wire.mjs'

const dshRoot = process.env.TRADELOOM_DSH_RUNTIME_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'Temp', 'tlr4p', 'targets', 'win-x64', 'dsh')
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
const sdk = async name => import(pathToFileURL(requireFromDsh.resolve(name)).href)
const fixtureBridgeKey = randomUUID() + randomUUID()
const phases = ['sdk-load', 'context-start', 'cookie-exchange', 'http-admission', 'carrier-only', 'target-register', 'agent-loop', 'ask-roundtrip', 'cleanup']
let phase = phases[0]

function invariant(value, code) {
  if (!value) throw Object.assign(new Error(code), { code })
}

function cookiePair(response) {
  const setCookie = response.headers.getSetCookie?.() ?? []
  invariant(setCookie.length === 1, 'COOKIE_EXCHANGE_FAILED')
  const pair = setCookie[0].split(';', 1)[0]
  invariant(pair.includes('='), 'COOKIE_EXCHANGE_FAILED')
  return pair
}

function rawRequest(url, body, headers = {}) {
  const target = new URL(url)
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(target.port), path: target.pathname,
      method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolveRequest({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', rejectRequest)
    request.end(JSON.stringify(body))
  })
}

function assertOwnedPortRefused(port) {
  return new Promise(resolveCheck => {
    const socket = netConnect({ host: '127.0.0.1', port })
    let finished = false
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      resolveCheck(result)
    }
    const timer = setTimeout(() => finish(false), 1000)
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error?.code === 'ECONNREFUSED'))
  })
}

function resultFor(agent, modules, callId) {
  return agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.source.callId === modules.llm.ToolCallId(callId))?.data?.message
}

class FixtureWebContents extends EventEmitter {
  destroyed = false
  constructor(id, url) { super(); this.id = id; this.url = url }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
}

async function within(promise, timeoutMs, code) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

function safeErrorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(error.code)) return error.code
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/credential.*(?:service|provider)|(?:service|provider).*credential/iu.test(message)) return 'CREDENTIALS_PROVIDER_REQUIRED'
  if (/webserver/iu.test(message)) return 'WEBSERVER_SERVICE_REQUIRED'
  if (/duplicate|already registered/iu.test(message)) return 'SDK_SERVICE_CONFLICT'
  if (/config|schema|invalid/iu.test(message)) return 'SDK_CONFIG_INVALID'
  const missingProperty = message.match(/reading ['"]([A-Za-z][A-Za-z0-9_]*)['"]/u)?.[1]
  if (missingProperty && ['credentials', 'getRecord', 'resolve', 'webServer', 'register'].includes(missingProperty)) return `SDK_MISSING_${missingProperty.toUpperCase()}`
  if (/credential/iu.test(message)) return 'SDK_CREDENTIALS_FAILURE'
  if (/BrowserAuth|browser-session/iu.test(message)) return 'SDK_BROWSER_AUTH_FAILURE'
  if (/service|inject/iu.test(message)) return 'SDK_SERVICE_INJECTION_FAILURE'
  if (/undefined|not a function/iu.test(message)) return 'SDK_REQUIRED_VALUE_MISSING'
  if (/record/iu.test(message)) return 'SDK_CREDENTIAL_RECORD_FAILURE'
  return error?.name ?? 'ERROR'
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'tl-webai-sdk-http-'))
  const privateRoot = join(root, 'private')
  const credentialsPath = join(privateRoot, '.credentials.yaml')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(privateRoot, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })

  let ctx
  let feature
  let mainTransport
  let pumpTask
  let pumpStop = false
  let webOrigin
  let ownedPort
  let testAgent
  let testsPassed = false
  let resultToPrint
  let failureToPrint
  let listenerClosed = false
  let tempRootRemoved = false
  try {
    phase = 'sdk-load'
    const [cordis, webserver, connection, credentialsLocal, llm, sessions, projections,
      systemPrompt, tools, agents, agentLoop, fsSandbox, sandboxPolicy,
      workingDirectory, scope] = await Promise.all([
      sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-host-webserver'),
      sdk('@deepseek-ai/dsh-client-connection'), sdk('@deepseek-ai/dsh-credentials-local'),
      sdk('@deepseek-ai/dsh-llm'), sdk('@deepseek-ai/dsh-session'),
      sdk('@deepseek-ai/dsh-session-projection'), sdk('@deepseek-ai/dsh-system-prompt'),
      sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-agent'), sdk('@deepseek-ai/dsh-agent-loop'),
      sdk('@deepseek-ai/dsh-fs-sandbox'), sdk('@deepseek-ai/dsh-sandbox-policy'),
      sdk('@deepseek-ai/dsh-working-directory'), sdk('@deepseek-ai/dsh-scope'),
    ])
    const modules = { cordis, webserver, connection, credentialsLocal, llm, sessions, projections,
      systemPrompt, tools, agents, agentLoop, fsSandbox, sandboxPolicy, workingDirectory, scope }

    phase = 'context-create'
    ctx = new cordis.Context()
    phase = 'credentials-plugin'
    await ctx.plugin(credentialsLocal.default, { path: credentialsPath, dshHome: join(root, 'home'), watch: false })
    invariant(ctx.credentials && typeof ctx.credentials.readRecord === 'function', 'CREDENTIALS_SERVICE_UNAVAILABLE')
    phase = 'webserver-plugin'
    await ctx.plugin(webserver.default, { host: '127.0.0.1', port: 0 })
    invariant(ctx.webServer && typeof ctx.webServer.register === 'function', 'WEBSERVER_SERVICE_UNAVAILABLE')
    phase = 'connection-plugin'
    await connection.apply(ctx, { trustedHosts: [] })
    phase = 'llm-plugin'
    await ctx.plugin(llm.default)
    phase = 'sessions-plugin'
    await ctx.plugin(sessions.default)
    phase = 'projection-plugin'
    await ctx.plugin(projections.default)
    phase = 'system-prompt-plugin'
    await ctx.plugin(systemPrompt.default, { personaPrefix: '' })
    phase = 'tools-plugin'
    await ctx.plugin(tools.default)
    phase = 'agents-plugin'
    await ctx.plugin(agents.default)
    phase = 'sandbox-policy-plugin'
    await ctx.plugin(sandboxPolicy.default, { mode: 'workspace-write', workspaceRoot })
    phase = 'filesystem-plugin'
    await ctx.plugin(fsSandbox.default, { cwd: workspaceRoot })
    phase = 'working-directory-plugin'
    await ctx.plugin(workingDirectory.default, { defaultDirectory: workspaceRoot })
    phase = 'agent-loop-plugin'
    await ctx.plugin(agentLoop.default, { agents: [] })
    const nativeKey = fixtureBridgeKey
    const target = { targetId: 'http-test-target', generation: 1, providerId: 'deepseek',
      windowId: 'fixture-provider-window', conversationId: 'fixture-conversation', available: true }
    phase = 'optional-host-install'
    feature = mountOptionalWebAiHost(ctx, {
      getNativeBridgeKey: () => nativeKey,
      loadRuntimeSdk: async () => ({ ToolRuntime: tools.default, scopeOf: scope.scopeOf }),
      authorizeTarget: ({ action, caller, target: selected }) => caller.agent === testAgent
        && selected.targetId === target.targetId && selected.generation === targetGeneration
        && selected.windowId === String(providerWebContents.id)
        && (action === 'list' || action === 'ask'),
    })
    const ready = await feature.ready
    invariant(ready.available === true, 'OPTIONAL_HOST_INSTALL_FAILED')
    phase = 'carrier-ready-check'
    webOrigin = ctx.webServer.getOrigin()
    invariant(new URL(webOrigin).hostname === '127.0.0.1' && ctx.webServer.port > 0, 'SERVER_BIND_FAILED')
    ownedPort = ctx.webServer.port
    invariant(ctx.connection && ctx.credentials, 'SDK_CONNECTION_UNAVAILABLE')
    invariant((await stat(credentialsPath)).isFile(), 'ISOLATED_CREDENTIAL_STORE_MISSING')

    phase = 'cookie-exchange'
    const launchUrl = ctx.connection.authenticatedUrl(`${webOrigin}/connect?interactions=none`)
    const exchange = await fetch(launchUrl, { redirect: 'manual', headers: { origin: webOrigin } })
    invariant(exchange.status === 302, 'COOKIE_EXCHANGE_FAILED')
    const cookie = cookiePair(exchange)
    invariant(exchange.headers.get('location') === './api/remote.mux', 'COOKIE_EXCHANGE_FAILED')

    const http = async (body, { includeCookie = true, key = nativeKey, origin = webOrigin, host } = {}) => {
      const headers = { 'content-type': 'application/json', [WEB_AI_NATIVE_HEADER]: key }
      if (includeCookie) headers.cookie = cookie
      if (origin !== undefined) headers.origin = origin
      if (host !== undefined) headers.host = host
      return fetch(`${webOrigin}${WEB_AI_NATIVE_PATH}`, {
        method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body),
      })
    }

    phase = 'http-admission'
    const noCookie = await http({ type: 'hello', mainInstanceId: randomUUID() }, { includeCookie: false })
    invariant(noCookie.status === 401, 'NO_COOKIE_NOT_REJECTED')
    const wrongKey = await http({ type: 'hello', mainInstanceId: randomUUID() }, { key: randomUUID() + randomUUID() })
    invariant(wrongKey.status === 401, 'WRONG_NATIVE_KEY_NOT_REJECTED')
    const missingKey = await fetch(`${webOrigin}${WEB_AI_NATIVE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: webOrigin },
      body: JSON.stringify({ type: 'hello', mainInstanceId: randomUUID() }),
    })
    invariant(missingKey.status === 401, 'MISSING_NATIVE_KEY_NOT_REJECTED')
    const badOrigin = await http({ type: 'hello', mainInstanceId: randomUUID() }, { origin: 'http://invalid.example' })
    invariant(badOrigin.status === 403, 'BAD_ORIGIN_NOT_REJECTED')
    const badHost = await rawRequest(`${webOrigin}${WEB_AI_NATIVE_PATH}`, { type: 'hello', mainInstanceId: randomUUID() },
      { cookie, host: 'invalid.example', [WEB_AI_NATIVE_HEADER]: nativeKey })
    invariant(badHost.status === 403, `BAD_HOST_NOT_REJECTED_${badHost.status}`)

    const mainInstanceId = randomUUID()
    const hello = await http({ type: 'hello', mainInstanceId })
    invariant(hello.status === 200, 'AUTHENTICATED_HELLO_FAILED')
    const helloBody = await hello.json()
    invariant(typeof helloBody.hostInstanceId === 'string' && helloBody.ok === true, 'AUTHENTICATED_HELLO_FAILED')
    const hostInstanceId = helloBody.hostInstanceId
    invariant(feature.transport?.hostInstanceId === hostInstanceId, 'HTTP_HOST_EPOCH_MISMATCH')

    if (process.argv.includes('--carrier-only')) {
      testsPassed = true
      resultToPrint = { ok: true, phase: 'carrier-only', statuses: {
        cookieExchange: exchange.status, noCookie: noCookie.status, wrongNativeKey: wrongKey.status,
        missingNativeKey: missingKey.status, badOrigin: badOrigin.status, badHost: badHost.status,
        authenticatedHello: hello.status,
      }, isolatedCredentialStore: true, listenerBoundToLoopback: true }
      return
    }

    phase = 'main-transport-attach'
    let pageAskCount = 0
    let releaseCommandCount = 0
    let settledEventCount = 0
    let targetRegisterStatus
    let targetGeneration = 0
    let conversationListener
    const ownerWebContents = new FixtureWebContents(4101, 'file:///fixture-owner.html')
    const providerWebContents = new FixtureWebContents(4102, 'https://chat.deepseek.com/')
    const pageAdapter = {
      inspect: async ({ signal }) => {
        invariant(!signal?.aborted, 'PAGE_INSPECT_CANCELLED')
        return { conversationId: target.conversationId, draftText: '', attachmentCount: 0 }
      },
      onConversationChange: listener => {
        conversationListener = listener
        return () => { if (conversationListener === listener) conversationListener = undefined }
      },
      ask: async ({ requestId, taskNonce, conversationId, signal, prompt }) => {
        invariant(!signal?.aborted && conversationId === target.conversationId
          && prompt === 'Use the selected provider page.', 'PAGE_FIXTURE_REQUEST_INVALID')
        pageAskCount++
        return {
          source: 'native-assistant-observation', role: 'assistant', isNew: true,
          complete: true, generating: false, messageId: randomUUID(), conversationId,
          taskNonce, requestId, content: 'HTTP carrier fixture answer',
        }
      },
    }
    const hostFetch = async (path, init) => {
      const sent = JSON.parse(init.body)
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      headers.set('origin', webOrigin)
      const response = await fetch(`${webOrigin}${path}`, { ...init, headers })
      if (sent.type === 'target') targetRegisterStatus = response.status
      if (response.ok && sent.type === 'next') {
        const body = await response.clone().json()
        if (body.command?.type === 'release') releaseCommandCount++
      }
      if (response.ok && sent.type === 'event' && sent.kind === 'settled') settledEventCount++
      return response
    }
    mainTransport = createMainWebAiTransport({ nativeBridgeKey: nativeKey, hostFetch })
    invariant(mainTransport.available === true, 'MAIN_TRANSPORT_UNAVAILABLE')
    const mainHostInstanceId = await mainTransport.start()
    invariant(mainHostInstanceId === hostInstanceId, 'MAIN_HOST_EPOCH_MISMATCH')
    const attached = await mainTransport.attachTarget({
      targetId: target.targetId, providerId: target.providerId,
      ownerWebContents, webContents: providerWebContents, adapter: pageAdapter,
    })
    targetGeneration = attached.generation
    invariant(attached.available === true && attached.conversationId === target.conversationId, 'MAIN_TARGET_INSPECT_FAILED')
    invariant(targetRegisterStatus === 200, 'MAIN_TARGET_REGISTER_STATUS_NOT_OK')
    invariant(feature.transport.targets.get(target.targetId)?.windowId === String(providerWebContents.id), 'MAIN_WINDOW_ID_NOT_DERIVED')
    invariant(mainTransport.statusForOwner(ownerWebContents, target.targetId).available === true, 'MAIN_OWNER_STATUS_FAILED')
    invariant(feature.transport.targets.get(target.targetId)?.generation === targetGeneration, 'HOST_TARGET_SYNC_FAILED')

    phase = 'agent-loop'
    class ScriptAdapter extends llm.LlmAdapter {
      calls = 0
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
      async *stream() {
        this.calls++
        if (this.calls === 1) yield* toolCallResponse(llm.ToolCallId, 'http-native-list', NATIVE_WEB_AI_TOOLS.list, {})
        else if (this.calls === 2) yield* toolCallResponse(llm.ToolCallId, 'http-native-ask', NATIVE_WEB_AI_TOOLS.ask,
          { targetId: target.targetId, prompt: 'Use the selected provider page.' })
        else if (this.calls === 3) yield* toolCallResponse(llm.ToolCallId, 'http-native-files', NATIVE_WEB_AI_TOOLS.ask,
          { targetId: target.targetId, prompt: 'Files must stay unavailable.', withFiles: true })
        else yield* textResponse('local script finished')
      }
    }
    const scriptAdapter = new ScriptAdapter()
    ctx.llm.registerAdapter(['webai-http-test'], scriptAdapter)
    testAgent = await ctx.agentLoop.create(sessions.SessionId(`webai-http-${randomUUID()}`), {
      provider: 'webai-http-test', model: 'local-script',
    })
    phase = 'ask-roundtrip'
    let agentFinished = false
    pumpTask = (async () => {
      const deadline = Date.now() + 20_000
      while (!pumpStop && Date.now() < deadline) {
        await mainTransport.pollOnce({ timeoutMs: 1000 })
        if (agentFinished && releaseCommandCount === 1 && settledEventCount === 1
          && mainTransport.jobs.size === 0 && feature.transport.jobs.size === 0) return
      }
      invariant(false, 'MAIN_PUMP_TIMEOUT')
    })()
    void pumpTask.catch(() => {})
    testAgent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'run the local HTTP carrier check' }], source: { kind: 'user' } }))
    await within(testAgent.whenIdle(), 15_000, 'AGENT_LOOP_TIMEOUT')
    agentFinished = true
    await pumpTask
    invariant(pageAskCount === 1 && releaseCommandCount === 1 && settledEventCount === 1,
      'MAIN_RELEASE_SETTLED_LIFECYCLE_MISMATCH')
    invariant(scriptAdapter.calls === 4 && pageAskCount === 1, 'AGENT_LOOP_DID_NOT_COMPLETE')

    const listResult = resultFor(testAgent, { llm }, 'http-native-list')
    invariant(listResult && listResult.isError === false, 'SDK_LIST_TOOL_FAILED')
    const listText = listResult.content?.map(item => item.text ?? '').join('\n') ?? ''
    invariant(listText.includes(target.targetId) && listText.includes(target.conversationId), 'SDK_LIST_RECEIPT_MISMATCH')
    const askResult = resultFor(testAgent, { llm }, 'http-native-ask')
    invariant(askResult && askResult.isError === false, 'SDK_ASK_TOOL_FAILED')
    const askText = askResult.content?.map(item => item.text ?? '').join('\n') ?? ''
    let askPayload
    try { askPayload = JSON.parse(askText) } catch { invariant(false, 'SDK_ASK_RECEIPT_INVALID') }
    invariant(askPayload.answer === 'HTTP carrier fixture answer'
      && askPayload.requestId === String(llm.ToolCallId('http-native-ask')), 'SDK_ASK_RECEIPT_MISMATCH')
    const filesResult = resultFor(testAgent, { llm }, 'http-native-files')
    invariant(filesResult && filesResult.isError === true, 'SDK_FILES_TOOL_SHOULD_FAIL')
    invariant(filesResult.content?.map(item => item.text ?? '').join('\n').includes('FILES_POLICY_UNAVAILABLE'), 'SDK_FILES_POLICY_RESULT_MISMATCH')
    invariant(pageAskCount === 1, 'FILES_REQUEST_REACHED_PAGE_ADAPTER')
    invariant(mainTransport.jobs.size === 0 && feature.transport.jobs.size === 0, 'TRANSPORT_JOBS_NOT_SETTLED')

    testsPassed = true
    resultToPrint = { ok: true, phase: 'complete', statuses: {
      cookieExchange: exchange.status, noCookie: noCookie.status, wrongNativeKey: wrongKey.status,
      missingNativeKey: missingKey.status, badOrigin: badOrigin.status, badHost: badHost.status,
      authenticatedHello: hello.status, targetRegister: targetRegisterStatus,
    }, hostToolReceipts: { list: 'success', ask: 'success', withFiles: 'FILES_POLICY_UNAVAILABLE' },
    pageAskCount, releaseCommandCount, settledEventCount, isolatedCredentialStore: true, listenerBoundToLoopback: true,
    actualSdkModules: true, model: 'deterministic-local-script', providerPage: 'fixture' }
  } catch (error) {
    failureToPrint = { ok: false, phase, code: safeErrorCode(error) }
    process.exitCode = 1
  } finally {
    phase = 'cleanup'
    try {
      await mainTransport?.dispose?.()
      if (mainTransport && (mainTransport.targets.size !== 0 || mainTransport.jobs.size !== 0)) {
        testsPassed = false
        process.exitCode = 1
      }
    } catch { testsPassed = false; process.exitCode = 1 }
    pumpStop = true
    try { await pumpTask } catch { if (testsPassed) { testsPassed = false; process.exitCode = 1 } }
    try { await feature?.dispose?.() } catch { testsPassed = false; process.exitCode = 1 }
    if (ctx) {
      try { await ctx.fiber.dispose() } catch { testsPassed = false; process.exitCode = 1 }
    }
    if (Number.isSafeInteger(ownedPort) && ownedPort > 0) {
      listenerClosed = await assertOwnedPortRefused(ownedPort)
      if (!listenerClosed) { testsPassed = false; process.exitCode = 1 }
    }
    const safeRoot = resolve(root)
    const tempRoot = resolve(tmpdir())
    const prefix = `tl-webai-sdk-http-`
    if (!safeRoot.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)
      || !safeRoot.split(/[\\/]/).at(-1).startsWith(prefix)) {
      testsPassed = false
      process.exitCode = 1
    } else {
      try {
        await rm(safeRoot, { recursive: true, force: true })
        try { await stat(safeRoot) } catch (error) { tempRootRemoved = error?.code === 'ENOENT' }
        if (!tempRootRemoved) { testsPassed = false; process.exitCode = 1 }
      } catch { testsPassed = false; process.exitCode = 1 }
    }
    if (process.exitCode !== 1 && !testsPassed) process.exitCode = 1
    if (process.exitCode !== 1 && testsPassed && resultToPrint) {
      console.log(JSON.stringify({ ...resultToPrint, listenerClosed, tempRootRemoved }))
    } else if (failureToPrint) {
      console.log(JSON.stringify(failureToPrint))
    } else {
      console.log(JSON.stringify({ ok: false, phase: 'cleanup', code: 'CLEANUP_FAILED' }))
    }
  }
}

function toolCallResponse(ToolCallId, id, name, args) {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

await main()
