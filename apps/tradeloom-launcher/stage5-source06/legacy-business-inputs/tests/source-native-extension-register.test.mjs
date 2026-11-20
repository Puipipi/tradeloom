import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'

const root = process.env.TL_SEVEN_ROLE_CHUNK_PACKAGE
const loaderPath = process.env.TL_SEVEN_MODULE_LOADER_ENTRY
const corePath = process.env.TL_SEVEN_SLOT_CORE_ENTRY
const registryPath = process.env.TL_SEVEN_SLOT_REGISTRY_ENTRY
const sdkRoot = process.env.TL_SEVEN_SDK_RUNTIME
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('actual rc2 loader and slot services register/release all five native extensions through the owner exports', {
  skip: root && loaderPath && corePath && registryPath && sdkRoot ? false : 'explicit pinned actual rc2 SDK and production postimage required; discovery only',
}, async () => {
  const coreRaw = await readFile(corePath)
  assert.equal(hash(coreRaw), 'd0a784c4868bd9188af70ecd124f69c69daa67af30e671c13adb15cff28aabe6')
  // Unmodified RN public export expression from the pinned rc2 frontend entry.
  // Its register, id/key validation, declaration and disposal methods are real.
  const coreExports = vm.runInNewContext(coreRaw.toString(), { queueMicrotask, console })
  const registryRaw = await readFile(registryPath)
  assert.equal(hash(registryRaw), '6facb89754f0d21af91491a32646be87ff1b4a25891e44cce1732b02b0fe123b')
  const registryText = registryRaw.toString()
  const start = registryText.indexOf('var SlotRegistry=')
  const end = registryText.indexOf('function requireScopeKey(', start)
  assert.ok(start >= 0 && end > start)
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'))
  const cordis = sdkRequire('@deepseek-ai/cordis')
  const SlotRegistry = vm.runInNewContext(registryText.slice(start, end) + ';SlotRegistry;', {
    _deepseek_ai_dsh_client_ui_slots: coreExports, _deepseek_ai_cordis: cordis, queueMicrotask, console,
  })
  const ctx = new cordis.Context()
  new SlotRegistry(ctx)
  // A controlled parent declaration exposes the list contract. This is not a
  // complete conversation factory/React mount or proof of live dock rendering.
  const parent = ctx.slots.register({ name: 'root', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, () => null)
  const releases = []
  try {
    // Browser React is a ModuleLoader builtin, not a Node package. No hooks or
    // component render run here; only createElement is needed by the factories.
    const React = { createElement() {} }
    const loaderRaw = await readFile(loaderPath)
    assert.equal(hash(loaderRaw), 'fc491b97b5d923446faf9ebff238dba6d1f8a55b03e8bf71bea90355ee33bec6')
    let definition
    vm.runInNewContext(loaderRaw.toString(), { window: { __ModuleLoader__: { load: value => { definition = value } } } })
    const loader = definition.factory(() => assert.fail('unexpected loader dependency'))
    const owner = '@tradeloom/dsh-business-shell'
    const target = { mode: 'queue', pendingQueue: [], load(value) { this.pendingQueue.push(value) } }
    const sandbox = vm.createContext({ window: { __ModuleLoader__: target }, console, AbortController })
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const fetched = []
    const modules = loader.createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: loader }, {
      boot: { rev: 'controlled', release: { version: '0.2.2-rc.2' }, entries: [{ id: owner, rev: 'controlled', url: `http://fixture.invalid/??${owner}/client.js&rev=controlled` }], batches: [{ phase: 'application', rev: 'controlled', url: `http://fixture.invalid/??${owner}/client.js&rev=controlled`, entries: [owner] }] },
      staticModules: { react: React, 'react-dom': {} },
      loadBundle: async url => {
        const parsed = new URL(url), prefix = `/${owner}/`
        assert.equal(parsed.origin, 'http://fixture.invalid')
        assert.ok(parsed.pathname.startsWith(prefix))
        const file = parsed.pathname.slice(prefix.length)
        assert.ok(manifest.files.includes(file), file)
        fetched.push(file)
        vm.runInContext(await readFile(path.join(root, file), 'utf8'), sandbox, { filename: file })
      },
    })
    vm.runInContext(await readFile(path.join(root, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
    const requireModule = modules.makeRequire(owner, new Set())
    const descriptor = Object.freeze({ kind: 'role', sceneId: 'controlled-scene', panelId: 'chat', roleId: 'center', sessionId: 'controlled-session', bindingRevision: '4', generation: 2, surface: 'chat' })
    const bridge = { nativeSurfaceDescriptor: async () => ({ ...descriptor }), onNativeSurfaceChanged: () => () => {}, nativeSurfaceMounted: () => assert.fail('no React commit in register-only proof') }
    const names = ['client.scene-memory.js', 'client.scene-drafts.js', 'client.session-audio.js', 'client.mcp-runtime.js', 'client.webai-files.js']
    for (const name of names) {
      const extension = await requireModule.async('./' + name)
      const release = await extension.register(ctx, descriptor, bridge)
      assert.equal(typeof release, 'function')
      releases.push(release)
    }
    assert.deepEqual(fetched, names, 'owner entry comes from the module table, not invalid ./client.js transport')
    assert.equal(typeof requireModule(owner).AgentDirectory, 'function', 'actual owner factory exports the native configuration editor')
    const entries = ctx.slots.entries('conversation.composer.dock')
    assert.deepEqual(Array.from(entries, entry => entry.options.id), ['tradeloom-scene-memory', 'tradeloom-bound-draft-lifecycle', 'tradeloom-session-audio', 'tradeloom-mcp-runtime', 'tradeloom-webai-directory-grant'])
    const first = await requireModule.async('./client.scene-memory.js')
    await assert.rejects(async () => first.register(ctx, descriptor, bridge), /already has an entry with id/)
  } finally {
    for (const release of releases.reverse()) release()
    assert.equal(ctx.slots.entries('conversation.composer.dock').length, 0)
    parent()
    await ctx.fiber.dispose()
  }
})
