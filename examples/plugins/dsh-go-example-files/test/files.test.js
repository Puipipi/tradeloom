import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { apply, fileView } from '../lib/index.js'
import { checkView } from '../../../../sdk/plugin-kit/lib/check.js'

test('both languages and old-app fallback remain valid v1 views', () => {
  for (const locale of ['zh-CN', 'en']) {
    for (const features of [[], ['files']]) {
      const view = fileView({}, { locale, features })
      assert.equal(checkView(view).ok, true)
      if (features.length === 0) assert.equal(view.type, 'text')
      else assert.equal(view.children[1].items.length, 2)
    }
  }
})

test('selected callback consumes bytes, not a path or metadata-only placeholder', () => {
  let panel, reads = 0
  const bytes = Buffer.from('selected content')
  apply({ inject: (deps, fn) => fn({ dshGo: {
    panel: (id, def) => { assert.equal(id, 'files'); panel = def },
    readPickedFile: handle => { assert.equal(handle, 'once'); reads++; return Buffer.from(bytes) },
  } }) })
  assert.deepEqual(panel.actions.chooseImages(), { type: 'pickImage', action: 'selected', maxFiles: 4 })
  const result = panel.actions.selected({}, { locale: 'en', value: { status: 'selected', files: [
    { handle: 'once', name: 'a.txt', bytes: bytes.length, mediaType: 'text/plain', access: 'read' },
  ] } })
  assert.equal(reads, 1)
  assert.equal(result.data.files[0].subtitle, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.data.files[0].trailing, `${bytes.length} B`)
  assert.equal(panel.actions.selected({}, { value: { status: 'cancelled', files: [] } }), undefined)
  assert.equal(reads, 1)
})
