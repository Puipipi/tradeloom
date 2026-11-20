import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import path from 'node:path'

const actualModuleLoaderPath = process.env.TL_SEVEN_MODULE_LOADER_ENTRY
  ?? (process.env.TL_SEVEN_SDK_RUNTIME && path.join(process.env.TL_SEVEN_SDK_RUNTIME, 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'))
const actualPackageRoot = process.env.TL_SEVEN_ROLE_CHUNK_PACKAGE

test('actual rc2 ModuleLoader loads all SourceNative extensions before registering the owned main panel', {
  skip: actualModuleLoaderPath && actualPackageRoot ? false : 'explicit pinned rc2 SDK and production business postimage required; not a feature pass',
}, async t => {
  const raw = await readFile(actualModuleLoaderPath)
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'fc491b97b5d923446faf9ebff238dba6d1f8a55b03e8bf71bea90355ee33bec6')
  let definition
  vm.runInNewContext(raw.toString('utf8'), { window: { __ModuleLoader__: { load: value => { definition = value } } } })
  const sdk = definition.factory(name => assert.fail(`unexpected ModuleLoader dependency: ${name}`))
  const owner = '@tradeloom/dsh-business-shell', requested = []
  const target = { mode: 'queue', pendingQueue: [], load(value) { this.pendingQueue.push(value) } }
  const sandbox = vm.createContext({ window: { __ModuleLoader__: target }, console, AbortController })
  const packageManifest = JSON.parse(await readFile(path.join(actualPackageRoot, 'package.json'), 'utf8'))
  const modules = sdk.createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: sdk }, {
    boot: { rev: 'controlled', release: { version: '0.2.2-rc.2' }, entries: [{ id: owner, rev: 'controlled', url: `http://fixture.invalid/??${owner}/client.js&rev=controlled` }], batches: [{ phase: 'application', rev: 'controlled', url: `http://fixture.invalid/??${owner}/client.js&rev=controlled`, entries: [owner] }] },
    // React/slot/transport are controlled; the loader, its manifest parsing,
    // relative-name checks, URL construction, factories and exports are real.
    staticModules: { react: { createElement() {} }, '@deepseek-ai/dsh-api-gateway/client': {} },
    loadBundle: async url => {
      const parsed = new URL(url), prefix = `/${owner}/`
      assert.equal(parsed.origin, 'http://fixture.invalid')
      assert.ok(parsed.pathname.startsWith(prefix))
      const file = parsed.pathname.slice(prefix.length)
      assert.ok(packageManifest.files.includes(file), `chunk absent from production package files: ${file}`)
      requested.push(file)
      vm.runInContext(await readFile(path.join(actualPackageRoot, file), 'utf8'), sandbox, { filename: file })
    },
  })
  // Register the real owner factory without materializing its whole UI graph.
  vm.runInContext(await readFile(path.join(actualPackageRoot, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  const require = modules.makeRequire(owner, new Set())
  const native = await require.async('./client.source-native.js')
  const descriptor = { kind: 'role', sceneId: 'controlled-scene', panelId: 'chat', roleId: 'center', sessionId: 'controlled-session', bindingRevision: '4', generation: 2, surface: 'chat' }
  let faceCalls = 0, panel, selection, acknowledgements = 0
  const ctx = { slots: { hostFace() { faceCalls++; return {} }, inject(_name, callback) { return callback() }, register(options, component) { panel = { options, component } } }, layout: { selectPanel(value) { selection = value } } }
  const bridge = { nativeSurfaceMounted() { acknowledgements++ }, onNativeSurfaceChanged() { return () => {} } }
  await assert.rejects(native.register(ctx, { ...descriptor, bindingRevision: undefined }, bridge), /invalid native surface contract/)
  assert.equal(faceCalls, 0)
  try { await native.register(ctx, descriptor, bridge) }
  catch (error) { t.diagnostic(JSON.stringify({ errorName: error.name, fixedFailure: error.message === 'client-modules: invalid relative chunk request "./scene-drafts.js"' ? 'invalid-relative-draft-chunk' : 'other', requested })); throw error }
  assert.deepEqual(requested, ['client.source-native.js', 'client.scene-memory.js', 'client.scene-drafts.js', 'client.session-audio.js', 'client.mcp-runtime.js', 'client.webai-files.js'])
  assert.equal(faceCalls, 1); assert.equal(panel.options.name, 'main'); assert.equal(panel.options.key, 'source-native'); assert.equal(typeof panel.component, 'function'); assert.equal(selection, 'source-native')
  assert.equal(acknowledgements, 0, 'registration is not a real React commit or mounted ACK')
  assert.equal(packageManifest.files.includes('scene-drafts.js'), false, 'do not retain an unloadable legacy alias')
  const before = requested.length
  await assert.rejects(require.async('./scene-drafts.js'), /invalid relative chunk request/)
  assert.equal(requested.length, before, 'old invalid name rejected before transport')
})

async function actualDraftModule() {
  let module
  vm.runInNewContext(await readFile(new URL('../client.scene-drafts.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => { module = definition.factory(() => ({ createElement() {} })) } } },
  })
  return module
}
test('official serializer actions stay bound across refresh/popout and never remove attachments', async () => {
  const { createBoundDraftActions } = await actualDraftModule()
  const expected = { kind: 'role', sceneId: 'scene-one', panelId: 'chat', roleId: 'center', sessionId: 'one', bindingRevision: '4', generation: 2, surface: 'chat' }
  let current = { ...expected }, live = true, text = 'synthetic draft', saved = '', saves = 0
  const attachments = ['opaque-existing-attachment']
  const actions = createBoundDraftActions({ expected, sessionId: 'one', readDescriptor: async () => current, alive: () => live,
    inputActions: { async persistDraftVerified(sessionId) { saved = text; saves++; return { persisted: true, sessionId, draftRevision: saves } }, async discardDraftVerified(sessionId) { text = ''; saved = text; saves++; return { persisted: true, sessionId, draftRevision: saves } } } })
  await actions.save(); assert.equal(saved, 'synthetic draft')
  current = { ...expected, generation: 3 }
  await assert.rejects(actions.discard(), /draft_binding_changed/)
  assert.equal(text, 'synthetic draft'); assert.equal(saves, 1)
  current = { ...expected }; await actions.discard(); assert.equal(saved, '')
  assert.deepEqual(attachments, ['opaque-existing-attachment'])
  live = false; await assert.rejects(actions.save(), /draft_binding_changed/)
})
test('save errors remain visible to caller; no success marker or implicit discard', async () => {
  const { createBoundDraftActions } = await actualDraftModule()
  const expected = { sessionId: 'one', generation: 1 }
  const failure = Error('storage quota')
  let cleared = false
  const actions = createBoundDraftActions({ expected, sessionId: 'one', readDescriptor: async () => expected, alive: () => true,
    inputActions: { async persistDraftVerified() { throw failure }, async discardDraftVerified() { cleared = true } } })
  await assert.rejects(actions.save(), error => error === failure)
  assert.equal(cleared, false)
})

test('actual refresh callback preserves the composer/upload instance on identical tuple and rejects late old generation', async () => {
  // Execute the exact production callback with controlled React setters; this
  // proves its lifecycle trigger, not browser layout/React/attachment storage.
  const source = (await readFile(new URL('../client.source-native.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  const definitions = source.slice(source.indexOf('    const valid = '), source.indexOf('    const reportRoleGuestPhase'))
  const callback = source.slice(source.indexOf('          const refreshDescriptor = '), source.indexOf('          const stop=bridge.onNativeSurfaceChanged(refreshDescriptor)'))
  const original = { kind: 'role', sceneId: 'one', panelId: 'chat', roleId: 'center', sessionId: 'one', bindingRevision: '4', generation: 2, surface: 'chat' }
  const composer = { attachments: [{ opaque: 'existing-controlled-upload' }], text: 'unsent synthetic draft' }
  let activeComposer = composer, loading = 0, descriptorChanges = 0, current = original, confirmed = false, failNext = false
  const pending = []
  const make = new Function('bridge', 'initial', 'setState', 'setNotice', 'setDescriptor', 'setIdentityConfirmed', `${definitions}\nlet live=true;const latest={current:initial},request={current:0},announcedGeneration={current:initial.generation};${callback}\nreturn {refresh:refreshDescriptor,latest,end(){live=false;request.current++}}`)
  let controller
  controller = make({ nativeSurfaceDescriptor: () => failNext ? Promise.reject(Error('controlled transient')) : new Promise(resolve => pending.push(resolve)) }, original,
    state => { if (state.phase === 'loading') { loading++; activeComposer = null } }, () => {}, value => { descriptorChanges++; current = value; controller.latest.current = value }, value => { confirmed = value })
  controller.refresh({ ...original }); pending.shift()({ ...original })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(loading, 0); assert.equal(descriptorChanges, 0)
  assert.equal(activeComposer, composer); assert.equal(activeComposer.attachments[0], composer.attachments[0])
  assert.equal(confirmed, true)
  controller.refresh(); pending.shift()(undefined)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(confirmed, false); assert.equal(activeComposer, composer); assert.equal(loading, 0)
  controller.refresh(original); pending.shift()({ ...original })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(confirmed, true); assert.equal(activeComposer, composer); assert.equal(descriptorChanges, 0)
  failNext = true; controller.refresh()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(confirmed, false); assert.equal(activeComposer, composer); assert.equal(loading, 0)
  failNext = false; controller.refresh(original); pending.shift()({ ...original })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(confirmed, true); assert.equal(activeComposer, composer); assert.equal(descriptorChanges, 0)
  // An older pending descriptor result must not replace the newer identity.
  controller.refresh({ ...original })
  const oldReply = pending.shift(), next = { ...original, generation: 3, bindingRevision: '5' }
  controller.refresh(next)
  assert.equal(activeComposer, composer); assert.equal(confirmed, false)
  const nextReply = pending.shift(); nextReply(next); oldReply(original)
  await Promise.resolve(); await Promise.resolve()
  assert.equal(descriptorChanges, 1); assert.equal(current.generation, 3); assert.equal(activeComposer, null); assert.ok(loading > 0)
  const { createBoundDraftActions } = await actualDraftModule()
  const oldActions = createBoundDraftActions({ expected: original, sessionId: 'one', readDescriptor: async () => current, alive: () => true,
    inputActions: { persistDraft() { assert.fail('stale generation saved') }, setDraft() { assert.fail('stale generation cleared uploads/text') } } })
  await assert.rejects(oldActions.save(), /draft_binding_changed/)
  controller.end(); controller.refresh({ ...next, generation: 4 }); pending.shift()({ ...next, generation: 4 })
  await Promise.resolve(); await Promise.resolve(); assert.equal(descriptorChanges, 1)
})
