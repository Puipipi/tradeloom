import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPlugin } from '../../../../sdk/plugin-kit/lib/check.js'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { apply } from '../lib/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function host() {
  const h = createTestHost({ pkg, dir: fileURLToPath(new URL('..', import.meta.url)) })
  apply(h.ctx)
  return h
}

test('every place is ready, with no issues', () => {
  const row = host().contributions()
  assert.deepEqual(row.issues, [])
  for (const list of Object.values(row.contributes)) for (const item of list) assert.equal(item.ready, true, item.id)
})

test('a template tool opens its panel without host code', () => {
  const row = host().contributions()
  assert.deepEqual(row.contributes['composer.tools'][0].effect, [{ type: 'open', page: 'panel:picker' }])
  assert.equal(row.contributes.panels[0].presentation, 'sheet')
})

test('count reads the draft', async () => {
  const r = await host().invoke('count', { scope: { sessionId: 's' }, context: { draft: '你好' } })
  assert.equal(r.effects[0].text, '输入框里有 2 个字')
})

test('turn notes cover a conversation', () => {
  const feed = host().subscribe('turn', { sessionId: 's' })
  assert.equal(feed.data['3'].text, '第 3 轮')
  feed.stop()
})

test('check --load has nothing to say about it', async () => {
  const report = await checkPlugin(fileURLToPath(new URL('..', import.meta.url)), { load: true, lang: 'en' })
  assert.deepEqual(report.manifest.issues, [])
})
