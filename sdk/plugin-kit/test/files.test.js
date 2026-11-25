import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effects, checkEffects } from '../lib/index.js'
import { SchemaSet } from '../lib/json-schema.js'
import { createTestHost } from '../lib/testing.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const schema = new SchemaSet()
const options = { userGesture: true, capabilities: { declared: ['files'], features: ['files'] } }

test('file constructors and schema agree on callback and count, static/deferred stay closed', () => {
  for (const make of [effects.pickFile, effects.pickImage]) {
    const effect = make('selected', { maxFiles: 4 })
    assert.deepEqual(schema.validate(effect, 'invoke.schema.json', '/$defs/effect'), [])
    assert.deepEqual(checkEffects(effect, options).effects, [effect])
    for (const definition of ['staticEffect', 'deferredEffect']) {
      assert.ok(schema.validate(effect, 'invoke.schema.json', `/$defs/${definition}`).length)
    }
    for (const extra of [{ userGesture: false }, { deferred: true }, { fileResult: true }]) {
      assert.equal(checkEffects(effect, { ...options, ...extra }).effects.length, 0)
    }
    assert.equal(checkEffects(effect).violation, false)
    assert.equal(checkEffects(make('selected', { maxFiles: 5 }), options).violation, true)
  }
})

test('wire schemas preserve files negotiation and readonly callback metadata', () => {
  assert.deepEqual(schema.validate({ t: 'hello', v: [1], features: ['files'] }, 'stream.schema.json', '/$defs/up'), [])
  assert.deepEqual(schema.validate({ v: 1, capabilities: ['files'], contributes: {} }, 'manifest.schema.json'), [])
  const file = { handle: 'a'.repeat(32), name: 'a.txt', bytes: 8, mediaType: 'text/plain', access: 'read' }
  assert.deepEqual(schema.validate({ status: 'selected', files: [file] }, 'invoke.schema.json', '/$defs/fileSelection'), [])
  for (const bad of [{ ...file, access: 'write' }, { ...file, bytes: 8388609 }, { ...file, path: '/private' }]) {
    assert.ok(schema.validate(bad, 'invoke.schema.json', '/$defs/pickedFile').length)
  }
  assert.ok(schema.validate({ status: 'selected', files: [file] }, 'invoke.schema.json', '/$defs/fileCompletion').length)
  assert.ok(schema.validate({ status: 'selected', files: [] }, 'invoke.schema.json', '/$defs/fileSelection').length)
  assert.ok(schema.validate({ status: 'cancelled', files: [file] }, 'invoke.schema.json', '/$defs/fileSelection').length)
  assert.deepEqual(schema.validate({ status: 'cancelled', files: [] }, 'invoke.schema.json', '/$defs/fileSelection'), [])
  assert.ok(schema.validate({ v: 1, effects: [effects.pickFile('again')] }, 'invoke.schema.json', '/$defs/fileCompletionResponse').length)
})

test('SDK test-host runs the real negotiation and gesture validator', async () => {
  const host = createTestHost({ pkg: { name: 'files', dshGo: { v: 1, capabilities: ['files'], contributes: {
    'composer.actions': [{ id: 'choose', label: 'Choose', requires: ['files'] }],
  } } }, caps: { features: ['files'] } })
  host.dshGo.on('choose', () => effects.pickFile('selected'))
  assert.equal((await host.invoke('choose')).effects.length, 0)
  const result = await host.invoke('choose', { userGesture: true })
  assert.equal(result.effects[0].type, 'pickFile')
  // The author harness validates effects; production HTTP/WS tests cover upload authority.
  assert.equal(result.effects[0].request, undefined)
  assert.throws(() => host.dshGo.readPickedFile('made-up'), /production bridge upload routes/)
  host.dispose()
})

test('wire validator checks selected-file routes and rejects callback side effects', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-files-wire-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const capture = join(dir, 'capture.jsonl')
  const row = { kind: 'http', method: 'POST', path: `/dsh-go/v1/files/${'a'.repeat(32)}/complete?stream=c1`, status: 200,
    req: { status: 'cancelled' }, res: { v: 1, effects: [{ type: 'toast', text: 'Cancelled' }], issues: [] } }
  const validator = fileURLToPath(new URL('../scripts/validate-wire.mjs', import.meta.url))
  writeFileSync(capture, JSON.stringify(row) + '\n')
  assert.equal(spawnSync(process.execPath, [validator, capture], { encoding: 'utf8' }).status, 0)
  row.res.effects = [effects.pickFile('again')]
  writeFileSync(capture, JSON.stringify(row) + '\n')
  const rejected = spawnSync(process.execPath, [validator, capture], { encoding: 'utf8' })
  assert.equal(rejected.status, 1)
  assert.match(rejected.stdout, /file completion response/)
})
