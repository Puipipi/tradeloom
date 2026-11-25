import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as kit from '../lib/index.js'
import { checkView } from '../lib/view-check.js'
import { evaluateFormula, resolveFormulas } from '../lib/formula.js'
import { inputPath, inputBindings } from '../lib/controls-check.js'
import { SchemaSet } from '../lib/json-schema.js'
import { expected } from '../scripts/gen-controls-parity.mjs'

test('controls parity corpus stays reproducible', () => {
  assert.equal(expected(), readFileSync(new URL('./parity/controls-expected.json', import.meta.url), 'utf8'))
})

test('all control builders match the generated schema catalog', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/view.schema.json', import.meta.url), 'utf8'))
  for (const type of schema['x-dsh-go'].controlBuilders) {
    assert.deepEqual(kit[type]({ label: 'A', unused: undefined }), { type, label: 'A' })
  }
  const s = new SchemaSet()
  assert.deepEqual(s.validate({ v: 2, type: 'form', submit: 'save', children: [kit.textField({ label: 'Name', bind: 'data.form.name', required: true, pattern: 'slug' })] }, 'view.schema.json'), [])
  assert.deepEqual(s.validate({ v: 2, type: 'metric', label: 'Total', value: { '=': 'data.price*data.qty' } }, 'view.schema.json'), [])
  assert.ok(s.validate({ v: 2, type: 'textField', label: 'Password', obscureText: true }, 'view.schema.json').length)
  assert.ok(s.validate({ v: 2, type: 'textField', label: 'Bad', pattern: '(a+)+$' }, 'view.schema.json').length)
})

test('v2 structure walks and falls back for missing or legacy caps', () => {
  const source = kit.tabs({ v: 2, items: [{ label: 'Edit', children: [kit.form({ submit: 'save', children: [kit.textField({ label: 'Name', bind: 'data.name' })] })] }] })
  assert.deepEqual([...kit.walkView(source)].map((n) => n.type), ['tabs', 'form', 'textField'])
  const fallback = kit.adaptView(source, undefined)
  assert.equal(fallback.v, 1)
  assert.equal(checkView(fallback).fatal, false)
  assert.deepEqual([...kit.walkView(fallback)].map((n) => n.type), ['stack', 'text', 'stack', 'text'])
  assert.deepEqual(kit.adaptView(source, { components: kit.COMPONENTS }), source)
  assert.equal(kit.hasComponent(undefined, 'textField'), false)
})

test('writable paths exclude arrays, prototype names and excessive depth', () => {
  assert.deepEqual(inputPath('data.form.first-name'), ['form', 'first-name'])
  for (const path of ['data', 'data..x', 'data.a[0]', 'window.x', 'data.__proto__.x', `data.${Array(17).fill('a').join('.')}`]) assert.equal(inputPath(path), null)
  const binding = { $: 'data.template' }
  assert.equal(inputBindings(binding, null), binding)
  assert.deepEqual(inputBindings({ type: 'textField', bind: 'data.name', value: 'wrong' }, null).value, { $: 'data.name' })
})

test('formulas are finite, bounded and match Dart modulo semantics', () => {
  const data = { a: '3', b: 4, rows: [2] }
  assert.equal(evaluateFormula('data.a + data.b * data.rows[0]', data), 11)
  assert.equal(evaluateFormula('data.b-data.a', data), 1)
  assert.equal(evaluateFormula('clamp(abs(-8), 0, max(2, 5))', data), 5)
  assert.equal(evaluateFormula('-5 % -3', data), 1)
  for (const source of ['1/0', '1e999', 'data.missing', 'Math.random()', 'while(true){}', 'data.a=4', 'min(1)', 'clamp(1,3,2)', '1'.repeat(257), '('.repeat(20) + '1' + ')'.repeat(20)]) assert.equal(evaluateFormula(source, data), null, source)
  const missing = Symbol('missing'), invalid = []
  const value = resolveFormulas({ value: { '=': '1/0' }, data: { $: 'data.template' } }, data, (path) => invalid.push(path), missing)
  assert.equal(value.value, missing)
  assert.deepEqual(invalid, ['view.value'])
  assert.deepEqual(value.data, { $: 'data.template' })
})

test('SDK reports exact input paths and keeps v1 grammar', () => {
  assert.equal(checkView(kit.textField({ label: 'Name', bind: 'data.name' })).fatal, true)
  const result = checkView({ v: 2, type: 'stack', children: [kit.textField({ label: 'Name', bind: 'data.name' }), kit.textField({ label: 'Nested', bind: 'data.name.x' })] })
  assert.equal(result.fatal, false)
  assert.ok(result.issues.some(issue => issue.path === 'view.children[1].bind'))
})

test('gallery, emptyState, ring and trend: builders, schema, stand-ins for older apps', () => {
  const album = kit.stack({ v: 2, children: [
    kit.progress({ value: 72, shape: 'ring', label: '本月额度' }),
    kit.metric({ label: '今日', value: '¥3.1', trend: [1.2, null, 2.6, 3.1] }),
    kit.gallery({ columns: 3, items: [{ src: 'asset:stickers/cat.webp', alt: '猫', caption: '开心', action: kit.action('pick', { id: 'cat' }) }, { src: 'asset:stickers/dog.webp' }] }),
    kit.emptyState({ title: '还没有贴纸', icon: 'gallery', action: { label: '导入', action: 'import' } }),
  ] })
  const s = new SchemaSet()
  assert.deepEqual(s.validate(album, 'view.schema.json'), [])
  assert.ok(s.validate(kit.gallery({ v: 2, items: [{ src: 'https://example.com/a.png' }] }), 'view.schema.json').length)
  assert.ok(s.validate(kit.progress({ v: 2, value: 1, shape: 'donut' }), 'view.schema.json').length)
  assert.ok(s.validate(kit.metric({ v: 2, label: 'a', value: 1, trend: [1] }), 'view.schema.json').length)
  assert.ok(s.validate(kit.emptyState({ v: 2, message: '没有标题' }), 'view.schema.json').length)
  const own = checkView(album).issues.filter((i) => !/\.(accent|palette|style)\b/.test(i.path) && i.path !== 'view.accent')
  assert.deepEqual(own, [])

  // An older v2 app: a grid of the pictures, a notice with its button kept.
  const older = kit.adaptView(album, { components: kit.COMPONENTS.filter((c) => c !== 'gallery' && c !== 'emptyState') })
  assert.equal(older.v, 2)
  assert.deepEqual([...kit.walkView(older)].map((n) => n.type), ['stack', 'progress', 'metric', 'grid', 'image', 'image', 'stack', 'callout', 'actions'])
  assert.equal(older.children[2].columns, 3)
  assert.deepEqual(older.children[3].children[1].items, [{ label: '导入', action: 'import' }])
  // A v1 app: no grid either, so a stack of them; the view drops to v1 and checks clean.
  const v1 = kit.adaptView(album, undefined)
  assert.equal(v1.v, 1)
  assert.deepEqual([...kit.walkView(v1)].map((n) => n.type), ['stack', 'progress', 'metric', 'stack', 'image', 'image', 'stack', 'callout', 'actions'])
  assert.equal(checkView(v1).fatal, false)
  assert.deepEqual(checkView(v1).issues, [])
  assert.deepEqual(kit.adaptView(album, { components: kit.COMPONENTS }), album)
})
