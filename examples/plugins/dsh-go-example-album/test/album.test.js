import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { adaptView, COMPONENTS, walkView } from '../../../../sdk/plugin-kit/lib/index.js'
import { SchemaSet } from '../../../../sdk/plugin-kit/lib/json-schema.js'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { checkView, imageSize } from '../../../../sdk/plugin-kit/lib/view-check.js'
import { apply } from '../lib/index.js'
import { STICKERS, albumView } from '../lib/view.js'

const own = (issues) => issues.filter((i) => !/\.(accent|palette|style)\b/.test(i.path) && i.path !== 'view.accent')

test('both looks, both languages: valid, bounded, and drawn without a problem of their own', () => {
  for (const locale of ['zh-CN', 'en']) {
    for (const stickers of [[...STICKERS], []]) {
      const view = albumView({ stickers }, { locale })
      assert.deepEqual(new SchemaSet().validate(view, 'view.schema.json'), [])
      for (const budget of ['panel', 'toolCard']) {
        const result = checkView(view, { budget, lang: locale === 'en' ? 'en' : 'zh' })
        assert.equal(result.fatal, false)
        assert.deepEqual(own(result.issues), [], `${locale} ${stickers.length} ${budget}`)
      }
      const types = [...walkView(view)].map((n) => n.type)
      assert.ok(types.includes(stickers.length ? 'gallery' : 'emptyState'))
    }
  }
})

test('an older app gets images and a notice instead, and still draws it clean', () => {
  const view = albumView({ stickers: [...STICKERS] }, { locale: 'zh-CN' })
  const older = adaptView(view, { components: COMPONENTS.filter((c) => c !== 'gallery' && c !== 'emptyState') })
  assert.deepEqual([...walkView(older)].filter((n) => n.type === 'image').length, STICKERS.length)
  assert.equal(checkView(older).fatal, false)
  const empty = adaptView(albumView({ stickers: [] }, {}), undefined)
  assert.equal(empty.v, 1)
  assert.ok([...walkView(empty)].some((n) => n.type === 'callout'))
  assert.equal(checkView(empty).fatal, false)
})

test('the stickers are the package\'s own small pictures', () => {
  for (const id of STICKERS) {
    const bytes = readFileSync(new URL(`../assets/stickers/${id}.png`, import.meta.url))
    const [w, h] = imageSize(bytes)
    assert.ok(w > 0 && w <= 512 && h === w, id)
  }
})

test('a tap puts the sticker in the composer; clear and restore switch the looks', async () => {
  const host = createTestHost({ dir: fileURLToPath(new URL('..', import.meta.url)) })
  try {
    apply(host.ctx)
    assert.deepEqual(host.registrations().panels, ['album'])
    assert.ok((await host.view('album')).view.children.some((n) => n.type === 'gallery'))
    const picked = await host.invoke('album', { surface: 'panel', action: 'pick', value: { id: 'sunset' } })
    assert.deepEqual(picked.effects[0], { type: 'insert', text: '[日落]' })
    assert.deepEqual((await host.invoke('album', { surface: 'panel', action: 'pick', value: { id: 'nope' } })).effects, [])
    await host.invoke('album', { surface: 'panel', action: 'clear' })
    assert.ok((await host.view('album', {}, { locale: 'en' })).view.children.some((n) => n.type === 'emptyState'))
    await host.invoke('album', { surface: 'panel', action: 'restore' })
    assert.ok((await host.view('album')).view.children.some((n) => n.type === 'gallery'))
    assert.equal(host.violations.length, 0)
  } finally {
    host.dispose()
  }
})
