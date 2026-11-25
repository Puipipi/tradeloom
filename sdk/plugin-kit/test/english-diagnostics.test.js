import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkView, formatCatalogMessage } from '../lib/view-check.js'

test('English text, child and byte limits render numeric messages, not ICU source', () => {
  const text = checkView({ type: 'text', text: 'a'.repeat(2001) }, { lang: 'en' })
  assert.ok(text.issues.some(i => i.message === '2001 characters, exceeding the limit of 2000'))
  const children = checkView({ type: 'row', children: Array.from({ length: 6 }, () => ({ type: 'text', text: 'x' })) }, { lang: 'en', budget: 'strip' })
  assert.ok(children.issues.some(i => i.message === 'Exceeded 4 items; last 2 items truncated'))
  const bytes = checkView({ type: 'text', text: 'x'.repeat(40000) }, { lang: 'en' })
  assert.equal(bytes.fatal, true)
  assert.match(bytes.issues[0].message, /^View is \d+ bytes, exceeding the limit of 32768 bytes$/)
})

test('English donut singular follows the App catalogue, while inserted arguments remain literal', () => {
  const result = checkView({ type: 'chart', kind: 'donut', categories: ['one'], series: [{ values: [1] }, { values: [2] }] }, { lang: 'en' })
  assert.ok(result.issues.some(i => i.message === 'Donut chart uses one series; 1 other series ignored'))
  const unknown = checkView({ type: '{second}' }, { lang: 'en' })
  assert.match(unknown.issues[0].message, /Unknown component "\{second\}"; available:/)
})

test('the shipped Chinese and English corpus covers ordinary and plural diagnostics', () => {
  const input = JSON.parse(readFileSync(new URL('./parity/inputs.json', import.meta.url), 'utf8'))
  for (const lang of ['zh', 'en']) {
    for (const c of input) {
      const result = checkView(c.view, { budget: c.budget, data: c.data, lang })
      for (const issue of result.issues) assert.doesNotMatch(issue.message, /,\s*plural\s*,/, `${lang} ${c.name}`)
    }
  }
})

test('all shipped catalogue templates format exact one and other without reinterpreting values', () => {
  const catalog = JSON.parse(readFileSync(new URL('../lib/messages.json', import.meta.url), 'utf8'))
  for (const lang of ['zh', 'en']) {
    for (const [key, pattern] of Object.entries(catalog[lang])) {
      for (const n of [0, 1, 2]) {
        const values = Object.fromEntries((catalog.params[key] ?? []).map(name => [name, n]))
        assert.doesNotMatch(formatCatalogMessage(pattern, values), /,\s*plural\s*,/, `${lang} ${key} ${n}`)
      }
    }
  }
  assert.equal(formatCatalogMessage('{n, plural, =1{one {value}} other{{n} values: {value}}}', { n: 1, value: '{n}' }), 'one {n}')
  assert.equal(formatCatalogMessage('{n, plural, =1{one} other{{n} values}}', { n: 0 }), '0 values')
  for (const pattern of ['{n, select, other{a}}', '{n, plural, offset:1 other{a}}', '{n, plural, one{a} other{b}}', '{n, plural, other{#}}', "'{n}'"]) {
    assert.throws(() => formatCatalogMessage(pattern, { n: 2 }), TypeError)
  }
})
