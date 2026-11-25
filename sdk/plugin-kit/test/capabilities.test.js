import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkEffects } from '../lib/effect-check.js'
import { createTestHost } from '../lib/testing.js'
import { parseManifest } from '../lib/bridge/manifest.js'
import { normalize } from '../lib/bridge/effects.js'
import { microModel } from '../lib/bridge/capabilities.js'
const pkg = { name: 'voice', dshGo: { v: 1, capabilities: ['audio', 'micro', 'overlay'], contributes: {
  'composer.actions': [{ id: 'go', label: 'Go', requires: ['audio'] }], media: [{ id: 'clip' }], micro: [{ id: 'text' }], overlays: [{ id: 'overlay', channel: 'text' }], panels: [{ id: 'panel', title: 'Panel', micro: 'text' }],
} } }
test('new SDK registrations and callback probes use shared validators', async () => {
  const h = createTestHost({ pkg, caps: { features: ['audio', 'micro'] } })
  h.dshGo.media('clip', () => ({ body: new Uint8Array([1]), contentType: 'audio/wav' }))
  h.dshGo.on('go', () => ({ type: 'audio', op: 'play', instance: 'one', src: 'media:clip' }))
  h.dshGo.micro('text', { data(s, emit) { emit({ text: '你好' }); emit({ text: 'bad', tree: {} }) } })
  const row = h.contributions(); assert.equal(row.contributes['composer.actions'][0].ready, true); assert.equal(row.contributes.panels[0].micro, 'text')
  assert.equal((await h.invoke('go')).effects[0].src, 'media:clip'); assert.equal((await h.media('clip')).body.length, 1)
  const feed = h.subscribeMicro('text'); assert.deepEqual(feed.data, { text: '你好' }); assert.equal(feed.errors.length, 1)
  let called = 0; h.dshGo.onCapability(() => { called++; return { command: 'ignored' } }); assert.equal(await h.capabilityEvent({}, { instance: 'one', event: 'audio.ended', seq: 1 }), undefined); assert.equal(called, 1); h.dispose()
})
test('requires fails closed without feature; new declaration is retained', async () => {
  const h = createTestHost({ pkg }); h.dshGo.on('go', () => ({ toast: 'Hi' })); assert.equal(h.contributions().contributes['composer.actions'][0].ready, false)
  assert.deepEqual(h.contributions().capabilities, pkg.dshGo.capabilities); await assert.rejects(h.invoke('go'), { code: 'unsupported' })
})
test('static/deferred, absolute URLs, foreign media and undeclared capability are rejected', () => {
  const opts = { panels: new Set(), capabilities: { declared: ['audio'], features: ['audio'], media: ['clip'] } }
  for (const src of ['https://example.com/a', 'http://127.0.0.1:8765/a', 'file:/a', 'media:other']) assert.equal(normalize({ type: 'audio', op: 'play', instance: 'one', src }, opts).effects.length, 0)
  const good = { type: 'audio', op: 'play', instance: 'one', src: 'media:clip' }
  assert.equal(checkEffects(good, opts).effects.length, 1)
  assert.equal(checkEffects(good).effects.length, 0)
  for (const extra of [{ static: true }, { deferred: true }, { capabilities: undefined }]) assert.equal(normalize(good, { ...opts, ...extra }).effects.length, 0)
  assert.equal(microModel({ text: 'x', effect: {} }), undefined)
})
test('new contribution ids share old uniqueness and reject missing features', () => {
  const invalid = structuredClone(pkg); invalid.dshGo.contributes.media[0].id = 'go'; invalid.dshGo.capabilities = ['audio']; const p = parseManifest(invalid, '.')
  assert.equal(p.items.media.length, 0); assert.equal(p.items.micro.length, 0); assert.ok(p.issues.length > 0)
})

test('a micro feed settles like the others, and records what fails', async () => {
  const subscribe = (data) => {
    const h = createTestHost({ pkg, caps: { features: ['micro'] } })
    h.dshGo.micro('text', { data })
    return h.subscribeMicro('text')
  }
  const tick = () => new Promise((done) => setImmediate(done))
  const failing = subscribe(async () => { throw new Error('boom') })
  await failing.settled
  assert.deepEqual(failing.errors, ['boom'])
  const thrown = subscribe(() => { throw new Error('thrown') })
  await thrown.settled
  assert.deepEqual(thrown.errors, ['thrown'])
  const late = subscribe(async () => async () => { throw new Error('late') })
  late.stop()
  await late.settled
  await tick()
  assert.deepEqual(late.errors, ['late'])
  const live = subscribe(() => async () => { throw new Error('rejected') })
  await live.settled
  live.stop()
  await tick()
  assert.deepEqual(live.errors, ['rejected'])
})
