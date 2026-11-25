import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { checkView } from '../../../../sdk/plugin-kit/lib/view-check.js'
import { SchemaSet } from '../../../../sdk/plugin-kit/lib/json-schema.js'
import { apply } from '../lib/index.js'
import { focusData, focusView } from '../lib/view.js'

test('the bilingual dashboard is bounded, valid and keeps all v1 fallback fields', () => {
  for (const locale of ['zh-CN', 'en']) {
    const view = focusView({}, { locale })
    assert.deepEqual(new SchemaSet().validate(view, 'view.schema.json'), [])
    const result = checkView(view, { data: focusData, lang: locale === 'en' ? 'en' : 'zh' })
    assert.equal(result.fatal, false)
    assert.ok(result.bytes < 8192)
    assert.ok(result.components < 40)
    assert.ok(result.issues.every(issue => issue.kind === 'note'))
    const legacy = JSON.parse(JSON.stringify(view), (key, value) => ['v', 'accent', 'style', 'spans'].includes(key) ? undefined : value)
    assert.equal(checkView(legacy, { data: focusData }).fatal, false)
  }
})

test('host registration, data, copy and explicit link effects work', async () => {
  const host = createTestHost({ dir: fileURLToPath(new URL('..', import.meta.url)) })
  try {
    apply(host.ctx)
    assert.deepEqual(host.registrations().panels, ['focus'])
    assert.equal((await host.view('focus')).view.v, 2)
    assert.deepEqual(host.subscribe('focus').data, focusData)
    const copied = await host.invoke('focus', { surface: 'panel', action: 'copy', locale: 'en' })
    assert.equal(copied.effects[0].type, 'copy')
    assert.match(copied.effects[0].text, /Weekly focus/)
    const linked = await host.invoke('focus', { surface: 'panel', action: 'guide' })
    assert.equal(linked.effects[0].type, 'link')
    assert.equal(host.violations.length, 0)
  } finally { host.dispose() }
})
