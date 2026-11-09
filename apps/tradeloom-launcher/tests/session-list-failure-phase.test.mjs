import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import test from "node:test"

const fixturePath = process.env.TRADELOOM_SESSION_LIST_PHASE_FIXTURE
const patchPath = resolve(process.cwd(), "apps/tradeloom-launcher/accepted-sdk-overrides/session-list-failure-phase.patch")
const expectedFixtureBytes = 84127
const expectedFixtureSha = "3043de82334846a3a5654b7317830c5403f90e9aeca692d3c15e30e01d16505d"
const gatewayEntry = "dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js"
const sourceNativePath = resolve(process.cwd(), "packages/tradeloom-shell/client.source-native.js")
export const sourceNativeDescriptor = { sceneId: "fixture-scene", panelId: "fixture-panel", sessionId: "fixture-session-id", surface: "files", generation: 7 }

async function sourceWithPatch() {
  assert.ok(fixturePath, "TRADELOOM_SESSION_LIST_PHASE_FIXTURE must point to the frozen R7 gateway client fixture")
  const original = await readFile(fixturePath)
  assert.equal(original.length, expectedFixtureBytes, "frozen gateway fixture byte pin")
  const { createHash } = await import("node:crypto")
  assert.equal(createHash("sha256").update(original).digest("hex"), expectedFixtureSha, "frozen gateway fixture SHA256")
  if (!existsSync(patchPath)) return original.toString("utf8")

  const fixtureRoot = resolve(dirname(fixturePath))
  const work = await mkdtemp(join(fixtureRoot, "patch-application-"))
  const resolvedWork = resolve(work)
  assert.ok(resolvedWork.startsWith(`${fixtureRoot}${process.platform === "win32" ? "\\" : "/"}`), "patch workspace stays under its owned fixture directory")
  try {
    const target = join(work, ...gatewayEntry.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, original, { flag: "wx" })
    execFileSync("git", ["-c", "core.longpaths=true", "apply", "--check", patchPath], { cwd: work, stdio: "pipe" })
    execFileSync("git", ["-c", "core.longpaths=true", "apply", patchPath], { cwd: work, stdio: "pipe" })
    return await readFile(target, "utf8")
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function createGatewayFixture({ rpcCall = async () => ({ ok: true, value: { items: [] } }) } = {}) {
  let definition
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value } } },
    AbortController,
    AbortSignal,
    console: { error() {}, warn() {}, info() {} }
  }
  runInNewContext(await sourceWithPatch(), sandbox, { filename: gatewayEntry })
  assert.equal(typeof definition?.factory, "function")

  const services = new Map()
  class CordisService {
    constructor(ctx, name) {
      this.ctx = ctx
      this.name = name
      ctx.provide(name, this)
    }
  }
  const connection = {
    interactions: "none",
    rpc: {
      open() {},
      call: (...args) => rpcCall(...args)
    },
    openWebSocket() {
      throw new Error("unexpected stream setup")
    }
  }
  const ctx = {
    reflect: { props: Object.create(null) },
    provide(name, value) { services.set(name, value) },
    get(name) { return name === "connection" ? connection : services.get(name) },
    effect() { return () => {} }
  }
  const api = definition.factory(name => {
    assert.equal(name, "@deepseek-ai/cordis")
    return { Service: CordisService }
  })
  const createError = runInNewContext("(message) => new Error(message)", sandbox)
  api.apply(ctx)
  const client = services.get("remote")
  assert.ok(client, "the actual ModuleLoader factory registered its Cordis Remote service")

  const invokeList = async ({ call = rpcCall, decode = value => value, signal, active = true, activeGetter, decodeGetter, resultGetter, rpcCallGetter } = {}) => {
    if (rpcCallGetter) Object.defineProperty(connection.rpc, "call", { configurable: true, get: rpcCallGetter })
    else Object.defineProperty(connection.rpc, "call", { configurable: true, writable: true, value: (...args) => call(...args) })
    const descriptor = {
      namespace: "session",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [{ wire: "_request", codec: { mode: "strict" } }],
      cancellation: { parameter: "signal" },
      result: { mode: "strict", decode }
    }
    const token = { active, abort: new AbortController() }
    if (activeGetter) {
      let reads = 0
      Object.defineProperty(token, "active", { get() { return activeGetter(++reads) } })
    }
    if (decodeGetter) {
      let reads = 0
      Object.defineProperty(descriptor.result, "decode", { get() { return decodeGetter(++reads) } })
    }
    if (resultGetter) {
      let reads = 0
      Object.defineProperty(descriptor, "result", { get() { return resultGetter(++reads) } })
    }
    const values = signal ? [{}, signal] : [{}]
    const result = await client.invoke(descriptor, undefined, token, ctx, values, undefined)
    return { result, token, api, descriptor }
  }
  const getFailurePhase = error => typeof api.getInvocationFailurePhase === "function"
    ? api.getInvocationFailurePhase(error)
    : "unclassified"
  return { api, client, connection, invokeList, getFailurePhase, createError }
}

export async function mountSourceNative({ refresh = async () => {}, remoteList = async () => ({ ok: true, value: { items: [] } }), catalogPhase = "pending", catalogIds = [], gatewayApi, initialDescriptor = sourceNativeDescriptor } = {}) {
  let definition, Component
  const effects = [], cleanups = [], messages = [], stateUpdates = [], refs = []
  let retainCount = 0, remoteListCount = 0
  const React = {
    Fragment: "fragment",
    createElement: (...args) => ({ args }),
    useState: initial => [initial, value => stateUpdates.push(value)],
    useRef: current => { const ref = { current }; refs.push(ref); return ref },
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: effect => effects.push(effect)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { definition = value } } },
    console: { info: (...parts) => messages.push(parts.map(String).join(" ")) },
    AbortController
  }
  runInNewContext(await readFile(sourceNativePath, "utf8"), sandbox, { filename: sourceNativePath })
  assert.equal(typeof definition?.factory, "function")
  const api = definition.factory(name => {
    if (name === "react") return React
    if (name === "@deepseek-ai/dsh-api-gateway/client") return gatewayApi
    assert.fail(`unexpected ModuleLoader dependency: ${name}`)
  })
  const snapshot = { ids: catalogIds, byId: {}, phase: catalogPhase, projectionsBySession: {} }
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_definition, component) => { Component = component; return component },
      snapshot: () => [],
      subscribeFactory: () => () => {},
      getFactoryVersion: () => 0
    },
    layout: { selectPanel: () => {} },
    sessions: {
      list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      refresh,
      retain: () => {
        retainCount++
        if (snapshot.phase === "ready") return { ready: Promise.resolve(), release() {} }
        throw new Error("retain must not run while catalog is pending")
      }
    },
    get: name => name === "connection"
      ? { generation: { getSnapshot: () => 1, subscribe: () => () => {} }, interactions: "answer" }
      : undefined,
    remote: { session: { list: (...args) => { remoteListCount++; return remoteList(...args) } } }
  }
  const bridge = {
    nativeSurfaceDescriptor: async () => initialDescriptor,
    onNativeSurfaceChanged: () => () => {},
    nativeSurfaceMounted: async () => {}
  }
  api.register(ctx, initialDescriptor, bridge)
  assert.equal(typeof Component, "function")
  Component({ SessionProvider: () => null, renderFactorySlot: () => null })
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === "function") cleanups.push(cleanup)
  }
  return {
    messages,
    refs,
    stateUpdates,
    get remoteListCount() { return remoteListCount },
    get retainCount() { return retainCount },
    cleanup: () => { for (const fn of cleanups.reverse()) fn() }
  }
}

function expectedCarrierMessage(message) {
  return `client api: session/list failed: ${message}`
}

if (process.env.TRADELOOM_RUN_GATEWAY_PHASE_TESTS === "1") {
  test("actual Gateway ModuleLoader invoke marks an RPC carrier rejection", async () => {
    const gateway = await createGatewayFixture()
    const { result } = await gateway.invokeList({ call: async () => { throw gateway.createError("fixture rpc rejection") } })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, "gateway/internal")
    assert.equal(result.error.message, expectedCarrierMessage("fixture rpc rejection"))
    assert.equal(gateway.getFailurePhase(result.error), "rpc-call")
    assert.equal(Object.hasOwn(result.error, "phase"), false, "phase is private WeakMap metadata, not an Error property")
  })

  test("actual Gateway ModuleLoader invoke marks only a strict result decoder throw", async () => {
    const gateway = await createGatewayFixture()
    const { result } = await gateway.invokeList({
      call: async () => ({ ok: true, value: { items: [] } }),
      decode: () => { throw gateway.createError("fixture strict decode rejection") }
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, "gateway/internal")
    assert.equal(result.error.message, expectedCarrierMessage("fixture strict decode rejection"))
    assert.equal(gateway.getFailurePhase(result.error), "result-decode")
    assert.equal(Object.hasOwn(result.error, "phase"), false)
  })

  test("success, returned RemoteResult errors, cancellation, withdrawn calls and post-RPC throws stay unclassified", async () => {
    const gateway = await createGatewayFixture()
    const success = await gateway.invokeList({ call: async () => ({ ok: true, value: { items: [] } }) })
    assert.equal(success.result.ok, true)
    assert.equal(success.result.value.items.length, 0)
    assert.equal(gateway.getFailurePhase(success.result), "unclassified")

    const remoteFailure = { isDSHRemoteError: true, code: "gateway/internal", message: "client api: session/list failed: remote prefix collision", details: { phase: "rpc-call" } }
    const returnedFailure = await gateway.invokeList({ call: async () => ({ ok: false, error: remoteFailure }) })
    assert.equal(returnedFailure.result.ok, false)
    assert.equal(returnedFailure.result.error.code, remoteFailure.code)
    assert.equal(returnedFailure.result.error.message, remoteFailure.message)
    assert.equal(returnedFailure.result.error.details, remoteFailure.details, "returned RemoteResult details retain their original reference")
    assert.equal(gateway.getFailurePhase(returnedFailure.result.error), "unclassified")

    const abort = new AbortController()
    const cancelled = await gateway.invokeList({
      signal: abort.signal,
      call: async () => { abort.abort(); throw gateway.createError("fixture abort") }
    })
    assert.equal(cancelled.result.ok, false)
    assert.equal(cancelled.result.error.code, "gateway/cancelled")
    assert.equal(gateway.getFailurePhase(cancelled.result.error), "unclassified")

    const postRpcAbort = new AbortController()
    const postRpc = await gateway.invokeList({
      signal: postRpcAbort.signal,
      call: async () => { postRpcAbort.abort(); return { ok: true, value: {} } }
    })
    assert.equal(postRpc.result.ok, false)
    assert.equal(postRpc.result.error.code, "gateway/cancelled")
    assert.equal(gateway.getFailurePhase(postRpc.result.error), "unclassified")

    const postRpcGetter = await gateway.invokeList({
      activeGetter: reads => {
        if (reads === 1) return true
        throw gateway.createError("fixture post-RPC active getter")
      },
      call: async () => ({ ok: true, value: { items: [] } })
    })
    assert.equal(postRpcGetter.result.ok, false)
    assert.equal(gateway.getFailurePhase(postRpcGetter.result.error), "unclassified")

    const decodeGetter = await gateway.invokeList({
      decodeGetter: () => { throw gateway.createError("fixture decode getter") },
      call: async () => ({ ok: true, value: { items: [] } })
    })
    assert.equal(decodeGetter.result.ok, false)
    assert.equal(gateway.getFailurePhase(decodeGetter.result.error), "unclassified")

    let guardDecoderCalls = 0, actualDecoderCalls = 0, actualDecoderThis, actualDecoderInput
    const orderedDecodeInput = { items: [] }
    const orderedDecode = await gateway.invokeList({
      decodeGetter: reads => reads === 1
        ? function guardReadMustNotRun() { guardDecoderCalls++; throw gateway.createError("wrong decoder invoked") }
        : function actualDecoder(value) {
          actualDecoderCalls++
          actualDecoderThis = this
          actualDecoderInput = value
          throw gateway.createError("fixture ordered decoder rejection")
        },
      call: async () => ({ ok: true, value: orderedDecodeInput })
    })
    assert.equal(orderedDecode.result.ok, false)
    assert.equal(gateway.getFailurePhase(orderedDecode.result.error), "result-decode")
    assert.equal(guardDecoderCalls, 0, "the decoder read used only for the original guard is not invoked")
    assert.equal(actualDecoderCalls, 1, "the actual decoder function is invoked once")
    assert.equal(actualDecoderThis, orderedDecode.descriptor.result, "the actual decoder retains the original receiver")
    assert.equal(actualDecoderInput, orderedDecodeInput, "the actual decoder receives the original RPC result value")

    let resultReads = 0
    let receiverGuardCalls = 0, receiverDecoderCalls = 0, receiverDecoderThis, receiverDecoderInput
    const resultGetterInput = { items: [] }
    const guardResult = { mode: "strict", decode: () => { receiverGuardCalls++; throw gateway.createError("guard decoder must not run") } }
    const receiverResult = {
      mode: "strict",
      decode: function actualDecoder(value) {
        receiverDecoderCalls++
        receiverDecoderThis = this
        receiverDecoderInput = value
        throw gateway.createError("fixture receiver decoder rejection")
      }
    }
    const resultGetterInvocation = await gateway.invokeList({
      resultGetter: reads => {
        resultReads = reads
        return reads === 1 ? { mode: "strict" } : reads === 2 ? guardResult : receiverResult
      },
      call: async () => ({ ok: true, value: resultGetterInput })
    })
    assert.equal(resultReads, 3, "mode, decoder guard and call receiver retain the original descriptor.result read order")
    assert.equal(resultGetterInvocation.result.ok, false)
    assert.equal(gateway.getFailurePhase(resultGetterInvocation.result.error), "result-decode")
    assert.equal(receiverGuardCalls, 0, "the second result object's decoder guard is not called")
    assert.equal(receiverDecoderCalls, 1, "the third result object's actual decoder is called once")
    assert.equal(receiverDecoderThis, receiverResult, "the third descriptor.result object is the original decoder receiver")
    assert.equal(receiverDecoderInput, resultGetterInput, "the result getter sequence preserves decoder input identity")

    const rpcGetter = await gateway.invokeList({
      rpcCallGetter: () => { throw gateway.createError("fixture RPC call getter") },
      call: async () => ({ ok: true, value: { items: [] } })
    })
    assert.equal(rpcGetter.result.ok, false)
    assert.equal(gateway.getFailurePhase(rpcGetter.result.error), "unclassified")

    const withdrawn = await gateway.invokeList({ active: false, call: async () => { throw new Error("must not call") } })
    assert.equal(withdrawn.result.ok, false)
    assert.equal(gateway.getFailurePhase(withdrawn.result.error), "unclassified")
    assert.equal(gateway.getFailurePhase(null), "unclassified")
    assert.equal(gateway.getFailurePhase("not an error"), "unclassified")
  })

  test("failure phase is bound to the exact error object and the producing ModuleLoader factory", async () => {
    const first = await createGatewayFixture()
    const second = await createGatewayFixture()
    const { result } = await first.invokeList({ call: async () => { throw first.createError("fixture rpc rejection") } })
    assert.equal(first.getFailurePhase(result.error), "rpc-call")
    assert.equal(second.getFailurePhase(result.error), "unclassified")
    assert.equal(first.getFailurePhase({ ...result.error }), "unclassified")
    assert.equal(first.getFailurePhase({ isDSHRemoteError: false, code: "gateway/internal", message: "client api: session/list failed: collision" }), "unclassified")
  })
}
