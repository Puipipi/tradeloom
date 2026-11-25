import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { checkView } from '../../../../sdk/plugin-kit/lib/view-check.js'
import { apply, initialForm } from '../lib/index.js'

const dir = fileURLToPath(new URL('..', import.meta.url))
test('new app gets v2; old and absent caps get a usable v1 summary', async () => {
  const host = createTestHost({ dir }); apply(host.ctx)
  const feed = host.subscribe('workbench')
  const modern = await host.view('workbench')
  assert.equal(modern.view.v, 2)
  const checked = checkView(modern.view, { data: feed.data })
  assert.equal(checked.fatal, false)
  assert.ok(checked.issues.every(issue => issue.kind === 'note' && /(?:accent|color)$/.test(issue.path)))
  for (const caps of [{ components: ['stack', 'text', 'keyValue'] }, { components: undefined }]) {
    const old = await host.view('workbench', {}, caps)
    assert.equal(old.view.v, 1)
    assert.equal(checkView(old.view, { data: feed.data }).fatal, false)
  }
  host.dispose()
})
test('change and submit validate, publish, and return existing patch effects', async () => {
  const host = createTestHost({ dir }); apply(host.ctx)
  const feed = host.subscribe('workbench')
  const change = await host.invoke('workbench', { surface: 'panel', action: 'change', value: { bind: 'data.form.level', value: 65 } })
  assert.equal(change.effects[0].type, 'patch')
  assert.equal(feed.data.form.level, 65)
  const values = Object.fromEntries(Object.entries({ ...initialForm, name: '  Grace  ', level: 65 }).map(([k, v]) => [`data.form.${k}`, v]))
  const saved = await host.invoke('workbench', { surface: 'panel', action: 'save', value: { values } })
  assert.deepEqual(saved.effects.map((e) => e.type), ['patch', 'toast'])
  assert.equal(feed.data.form.name, 'Grace')
  assert.equal(feed.data.saves, 1)
  host.dispose()
})
test('host checks cannot be bypassed with an arbitrary writable path', async () => {
  const host = createTestHost({ dir }); apply(host.ctx)
  await assert.rejects(host.invoke('workbench', { surface: 'panel', action: 'change', value: { bind: 'data.form.__proto__', value: {} } }))
  host.dispose()
})
