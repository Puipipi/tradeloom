import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SchemaSet } from '../lib/json-schema.js'

const s = new SchemaSet()
const ok = (v, f, p) => assert.deepEqual(s.validate(v, f, p), [])
const bad = (v, f, p, re) => {
  const e = s.validate(v, f, p)
  assert.ok(e.length > 0, 'expected errors')
  if (re) assert.match(`${e[0].path} ${e[0].message}`, re)
}

test('views: discriminated components, unevaluated properties, bindings', () => {
  ok({ type: 'stack', title: 'T', v: 1, children: [{ type: 'metric', label: 'a', value: { $: 'data.a' } }, { type: 'list', items: { $: 'data.rows' } }] }, 'view.schema.json')
  bad({ type: 'metric', label: 'a', value: 1, color: 'red' }, 'view.schema.json', '', /unevaluated property color/)
  bad({ type: 'gauge' }, 'view.schema.json', '', /\/type not one of/)
  bad({ type: 'metric', label: 'a', value: { $: 'nope' } }, 'view.schema.json')
})

test('manifest, invoke, stream, contributions defs resolve across files', () => {
  ok({ v: 1, contributes: { 'composer.actions': [{ id: 'a', label: { zh: '甲' }, effect: { type: 'insert', text: 'x' } }] } }, 'manifest.schema.json')
  bad({ v: 1, contributes: { 'composer.actions': [{ id: 'a', label: 'x', effect: { type: 'refresh' } }] } }, 'manifest.schema.json')
  ok({ v: 1, pkg: 'a', id: 'b', surface: 'composer.actions', context: { clipboard: 'x' } }, 'invoke.schema.json')
  ok({ v: 1, effects: [{ type: 'copy', text: 'x' }] }, 'invoke.schema.json', '/$defs/response')
  ok({ t: 'hello', v: [1], locale: 'zh-CN' }, 'stream.schema.json', '/$defs/up')
  bad({ t: 'sub', sub: 's', pkg: 'Bad Name', id: 'x' }, 'stream.schema.json', '/$defs/up', /closest: \/pkg does not match/)
  ok({ v: 1, error: { code: 'not-found', message: 'x' } }, 'contributions.schema.json', '/$defs/error')
})

test('string length counts code points', () => {
  // toast text ≤ 40 characters: 40 CJK characters are 40, not 120 bytes.
  ok({ v: 1, effects: [{ type: 'toast', text: '字'.repeat(40) }] }, 'invoke.schema.json', '/$defs/response')
  bad({ v: 1, effects: [{ type: 'toast', text: '字'.repeat(41) }] }, 'invoke.schema.json', '/$defs/response')
})

test('v1.2 schemas validate new envelopes but keep static and deferred closed', () => {
  ok({ v: 1, capabilities: ['audio', 'micro'], contributes: { media: [{ id: 'clip' }], micro: [{ id: 'caption' }] } }, 'manifest.schema.json')
  const play = { type: 'audio', op: 'play', instance: 'one', src: 'media:clip' }
  ok(play, 'invoke.schema.json', '/$defs/effect')
  bad({ type: 'audio', op: 'play', instance: 'one' }, 'invoke.schema.json', '/$defs/effect')
  bad({ ...play, op: 'pause' }, 'invoke.schema.json', '/$defs/effect')
  bad(play, 'invoke.schema.json', '/$defs/staticEffect')
  bad(play, 'invoke.schema.json', '/$defs/deferredEffect')
  ok({ t: 'cap.event', lease: 'opaque', seq: 1, event: 'voice.speechStart' }, 'stream.schema.json', '/$defs/up')
  ok({ t: 'micro.data', sub: 'one', rev: '0123456789abcdef.1', data: { text: '你好', progress: null } }, 'stream.schema.json', '/$defs/down')
  bad({ text: 'a', effects: [] }, 'stream.schema.json', '/$defs/microData')
  bad({ progress: -1 }, 'stream.schema.json', '/$defs/microData')
})

test('NJS1 micro rev has its own epoch and positive safe-integer sequence grammar', () => {
  const frame = rev => ({ t: 'micro.data', sub: 's', rev, data: { text: 'x' } })
  for (const seq of ['1', '9', '123456789012345', '9007199254740990', '9007199254740991']) ok(frame(`0123456789abcdef.${seq}`), 'stream.schema.json', '/$defs/down')
  for (const rev of ['legacy', 'epoch.1', '0123456789ABCDEF.1', '0123456789abcde.1', '0123456789abcdef.0', '0123456789abcdef.01', '0123456789abcdef.-1', '0123456789abcdef.1.2', '0123456789abcdef.9007199254740992', '0123456789abcdef.9999999999999999', '0123456789abcdef.10000000000000000']) bad(frame(rev), 'stream.schema.json', '/$defs/down')
  ok({ t: 'data', sub: 's', rev: 'legacy-arbitrary-rev', data: {} }, 'stream.schema.json', '/$defs/down')
})

test('a tool writes panel or effect, not both', () => {
  const tool = (t) => ({ v: 1, contributes: { 'composer.tools': [{ id: 'a', label: 'x', ...t }] } })
  ok(tool({ panel: 'p' }), 'manifest.schema.json')
  ok(tool({ effect: { type: 'toast', text: 'x' } }), 'manifest.schema.json')
  bad(tool({ panel: 'p', effect: { type: 'toast', text: 'x' } }), 'manifest.schema.json')
})
