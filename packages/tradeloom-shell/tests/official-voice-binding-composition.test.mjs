import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'
const K = new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/', import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function actual(name, contractName, t) {
  assert.ok(process.env.TL_SEVEN_SDK_RUNTIME, 'explicit actual rc2 ASAR/dsh runtime required')
  const require = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
  assert.equal(require('./package.json').version, '0.2.2-rc.2')
  const contract = JSON.parse(await readFile(new URL(contractName, K), 'utf8'))
  assert.ok(contract.entry.startsWith(`dsh/node_modules/${name.replace(/\/client$/, '')}/`))
  const file = join(process.env.TL_SEVEN_SDK_RUNTIME, contract.entry.slice('dsh/'.length)), bytes = await readFile(file)
  let source = bytes.toString('utf8')
  if (sha(bytes) === contract.preimage.sha256) {
    assert.equal(bytes.length, contract.preimage.bytes)
    for (const fragment of contract.fragments) { assert.equal(source.split(fragment.before).length, 2); source = source.replace(fragment.before, fragment.after) }
    t.diagnostic(`${contract.entry}: exact official preimage; authored changes in controlled memory, not replay proof`)
  } else {
    assert.equal(bytes.length, contract.authoredPostimage.bytes); assert.equal(sha(bytes), contract.authoredPostimage.sha256)
    t.diagnostic(`${contract.entry}: exact authored postimage from explicit runtime`)
  }
  assert.equal(sha(Buffer.from(source)), contract.authoredPostimage.sha256)
  return source
}
function hooks() {
  const cells = [], pending = []; let index = 0
  const effect = (fn, deps) => { const id = index++, old = cells[id]; if (!old || !deps || deps.some((item, i) => item !== old.deps?.[i])) { cells[id] = { deps, cleanup: old?.cleanup }; pending.push(() => { cells[id].cleanup?.(); cells[id].cleanup = fn() }) } }
  return { React: { useState(initial) { const id = index++; if (!(id in cells)) cells[id] = typeof initial === 'function' ? initial() : initial; return [cells[id], value => { cells[id] = typeof value === 'function' ? value(cells[id]) : value }] },
    useRef(initial) { const id = index++; return cells[id] ??= { current: initial } }, useEffect: effect, useLayoutEffect: effect },
    render(component, props) { index = 0; const tree = component(props); for (const effect of pending.splice(0)) effect(); return tree },
    dispose() { for (const cell of cells) cell?.cleanup?.() },
  }
}
function find(tree, label) {
  if (!tree || typeof tree !== 'object') return undefined
  if (tree.props?.['aria-label'] === label) return tree
  for (const value of Object.values(tree.props ?? {})) {
    for (const child of Array.isArray(value) ? value.flat(Infinity) : [value]) { if (child !== tree) { const result = find(child, label); if (result) return result } }
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('actual official VoiceInput + InputActions: full owner, late result, editable insertion and explicit submit', async t => {
  const voice = await actual('@deepseek-ai/dsh-experimental-client-ui-voice-input/client', 'voice-native-binding.contract.json', t)
  const conversation = await actual('@deepseek-ai/dsh-client-ui-conversation/client', 'conversation-draft-checked.contract.json', t)
  const start = voice.indexOf('function VoiceInput('), end = voice.indexOf('function createMicrophoneDeviceStore', start)
  assert.ok(start > 0 && end > start)
  const actionsStart = conversation.indexOf('actions={', conversation.indexOf('var SessionInputShell=class')) + 'actions='.length
  const actionsEnd = conversation.indexOf(';core=new SubmitMachine', actionsStart)
  assert.ok(actionsStart > 0 && actionsEnd > actionsStart)
  // Exact official action object; only its editor/submit-machine boundary is
  // controlled here. This is not Lexical, device, model, React or GUI proof.
  const shell = { rev: 1, disposed: false, snapshot: { phase: 'idle' }, text: '', caretSpan: () => ({ start: 0, end: 0 }),
    draftEditor: { insertAsyncText(_span, text) { shell.text += text; shell.rev++; return true } },
    setDraft(text) { this.text = text; this.rev++ }, submit() { submissions++ } }
  let submissions = 0
  const frozenStart = conversation.indexOf('function frozen('), frozenEnd = conversation.indexOf('function sameSummary(', frozenStart)
  assert.ok(frozenStart > 0 && frozenEnd > frozenStart)
  const frozen = new Function(`${conversation.slice(frozenStart, frozenEnd)};return frozen`)()
  const inputActions = new Function('frozen', `return function(){return (${conversation.slice(actionsStart, actionsEnd)})}`)(frozen).call(shell)
  const producer = await sourceRoleIdentity(t), original = await producer.descriptor()
  let unavailable = false, listener, disposed = 0, captures = 0, forced = false, forcedValue
  const nativeBridge = { nativeSurfaceDescriptor: async () => { if (unavailable) throw Error('controlled unavailable'); return forced ? forcedValue : producer.bridge.nativeSurfaceDescriptor() },
    onNativeSurfaceChanged(fn) { listener = fn; const stop = producer.bridge.onNativeSurfaceChanged(fn); return () => { stop(); listener = undefined } } }
  const window = { dshDesktop: nativeBridge, addEventListener() {}, removeEventListener() {} }
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  const effects = hooks(), jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' }
  const primitives = new Proxy({}, { get: (_target, key) => key })
  const component = new Function('react', 'react_jsx_runtime', '_deepseek_ai_dsh_client_ui_primitives', 'VoiceInput_module_css_default', 'window', 'document', 'disposeRecording', 'audioBase64', 'failureText', 'VoiceSetupDialog', 'Waveform', `${voice.slice(start, end)};return VoiceInput`)(
    effects.React, jsx, primitives, new Proxy({}, { get: (_target, key) => key }), window, document, async capture => capture.dispose(), () => 'UklGRg==', () => 'controlled failure', 'VoiceSetupDialog', 'Waveform')
  const requests = []
  const props = { sessionId: original.sessionId, inputActions, locked: false, onActiveChange() {}, openSettings() {}, t: key => key,
    useSpeechReadiness: () => ({ connected: true, catalog: { providers: [{ id: 'official', preparation: { phase: 'ready' } }], selection: { providerId: 'official' }, maxDurationSeconds: 30, maxAudioBytes: 100 } }), usePluginNavigation: () => true,
    createRecording: () => { captures++; return { async start() {}, async stop() { return new Uint8Array([1, 2]) }, async dispose() { disposed++ } } },
    transcribe: (_request, signal) => new Promise(resolve => requests.push({ resolve, signal })),
  }
  const render = () => effects.render(component, props)
  async function record() { find(render(), 'start').props.onClick(); await flush(); find(render(), 'stop').props.onClick(); await flush() }
  try {
    for (const value of [undefined, null, {}, Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'roleId')), Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'bindingRevision'))]) {
      forced = true; forcedValue = value; const before = captures
      find(render(), 'start').props.onClick(); await flush()
      assert.equal(captures, before, 'unknown initial native identity never starts recording'); assert.equal(requests.length, 0)
      find(render(), 'cancel').props.onClick(); await flush()
    }
    forced = false; window.dshDesktop = {}
    const beforeMissingMethod = captures; find(render(), 'start').props.onClick(); await flush(); assert.equal(captures, beforeMissingMethod)
    find(render(), 'cancel').props.onClick(); await flush(); window.dshDesktop = nativeBridge
    // The non-role compatibility descriptor also comes from the actual
    // controller, not an invented kind/default owner. No native bridge is the
    // separate ordinary DSH browser compatibility case.
    forced = true; forcedValue = producer.accountDescriptor
    await record(); requests.shift().resolve({ ok: true, value: { text: 'non-role compatibility' } }); await flush(); assert.equal(shell.text, 'non-role compatibility'); inputActions.setDraft('')
    forced = false; window.dshDesktop = undefined
    await record(); requests.shift().resolve({ ok: true, value: { text: 'ordinary browser compatibility' } }); await flush(); assert.equal(shell.text, 'ordinary browser compatibility'); inputActions.setDraft(''); window.dshDesktop = nativeBridge
    await record(); producer.notifyLayout(); requests.shift().resolve({ ok: true, value: { text: 'editable synthetic' } }); await flush()
    assert.equal(shell.text, 'editable synthetic'); assert.equal(submissions, 0)
    inputActions.setDraft('human edited'); inputActions.submit(); assert.equal(shell.text, 'human edited'); assert.equal(submissions, 1)
    await record(); const old = requests.shift(); await producer.rotateSameSession()
    await record(); const fresh = requests.shift()
    old.resolve({ ok: true, value: { text: 'must not insert old owner' } }); await flush(); assert.equal(shell.text, 'human edited'); assert.equal(old.signal.aborted, true)
    fresh.resolve({ ok: true, value: { text: ' new valid recording' } }); await flush(); assert.equal(shell.text, 'human edited new valid recording')
    await record(); const missing = requests.shift(); unavailable = true
    missing.resolve({ ok: true, value: { text: 'must not insert unknown owner' } }); await flush(); assert.equal(shell.text, 'human edited new valid recording'); assert.equal(missing.signal.aborted, true); unavailable = false
    // Cancel an actual captured recording before the provider is called.
    find(render(), 'start').props.onClick(); await flush(); find(render(), 'cancel').props.onClick(); await flush()
    assert.equal(requests.length, 0); assert.equal(submissions, 1); assert.ok(disposed > 0)
  } finally { effects.dispose() }
  assert.equal(listener, undefined)
})
