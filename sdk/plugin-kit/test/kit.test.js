import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actions, adaptView, appAtLeast, bind, callout, chart, COMPONENTS, confirm, effects, hasComponent, hasSurface,
  image, isBinding, keyValue, list, localize, metric, options, progress, protocolAtLeast, row, stack, table, text,
  toolCard, toLosslessJson, VIEW_KEY, viewOfMeta, walkView,
} from '../lib/index.js'
import { readFileSync } from 'node:fs'

const viewSchema = JSON.parse(readFileSync(new URL('../schema/view.schema.json', import.meta.url), 'utf8'))

test('builders: plain JSON, undefined props dropped, both call styles', () => {
  assert.deepEqual(metric({ label: 'a', value: 1, tone: undefined }), { type: 'metric', label: 'a', value: 1 })
  assert.deepEqual(stack([text('x')], { title: 't' }), { type: 'stack', title: 't', children: [{ type: 'text', text: 'x' }] })
  assert.deepEqual(stack({ title: 't', children: [] }), { type: 'stack', title: 't', children: [] })
  assert.deepEqual(row(bind('rows')), { type: 'row', children: { $: 'data.rows' } })
  assert.deepEqual(text({ text: 'x', tone: 'muted' }), { type: 'text', text: 'x', tone: 'muted' })
  assert.deepEqual(callout('c', { tone: 'warn' }), { type: 'callout', text: 'c', tone: 'warn' })
  assert.deepEqual(confirm('go'), { type: 'confirm', id: 'go' })
  assert.deepEqual(progress(40, { label: 'p' }), { type: 'progress', value: 40, label: 'p' })
  assert.deepEqual(progress(bind('data.p')), { type: 'progress', value: { $: 'data.p' } })
  assert.deepEqual(image('asset:a.png', { aspect: 2 }), { type: 'image', src: 'asset:a.png', aspect: 2 })
  assert.deepEqual(keyValue({ items: { a: '1' } }), { type: 'keyValue', items: { a: '1' } })
  assert.deepEqual(list([{ title: 'a' }]), { type: 'list', items: [{ title: 'a' }] })
  assert.deepEqual(actions([{ label: 'x', action: 'go' }]), { type: 'actions', items: [{ label: 'x', action: 'go' }] })
  assert.deepEqual(chart({ kind: 'line', categories: ['a'], series: [{ values: [1] }] }).type, 'chart')
  assert.deepEqual(table({ columns: ['a'], rows: [] }).type, 'table')
  assert.deepEqual(options({ id: 'o', options: ['a'] }).type, 'options')
})

test('bind: data prefix added once; isBinding needs exactly one key', () => {
  assert.deepEqual(bind('a.b'), { $: 'data.a.b' })
  assert.deepEqual(bind('data.a'), { $: 'data.a' })
  assert.deepEqual(bind('data[0]'), { $: 'data[0]' })
  assert.equal(isBinding({ $: 'data.a' }), true)
  assert.equal(isBinding({ $: 'data.a', x: 1 }), false)
})

test('COMPONENTS matches the view schema catalog, in order', () => {
  assert.deepEqual([...COMPONENTS], viewSchema.$defs.node.properties.type.enum)
})

test('walkView visits every component, depth first', () => {
  const v = stack([row([metric({ label: 'a', value: 1 })]), text('x')])
  assert.deepEqual([...walkView(v)].map((n) => n.type), ['stack', 'row', 'metric', 'text'])
})

test('toolCard: never throws, lossless, capped at 8 KiB', () => {
  const card = toolCard((_a, v) => metric({ label: 'x', value: v.n, caption: v.c }))
  assert.deepEqual(card({}, { n: Number.NaN }), { [VIEW_KEY]: { type: 'metric', label: 'x', value: null } })
  assert.deepEqual(card({}, { n: -0, c: undefined }), { [VIEW_KEY]: { type: 'metric', label: 'x', value: 0 } })
  assert.deepEqual(card({}, null), {}, 'a throwing builder gives no card')
  assert.deepEqual(toolCard(() => null)({}, {}), {})
  const big = toolCard(() => text('x'.repeat(9000)))
  const errors = []
  assert.deepEqual(toolCard(() => text('x'.repeat(9000)), { onError: (e) => errors.push(e) })({}, {}), {})
  assert.deepEqual(big({}, {}), {})
  assert.match(String(errors[0]), /over 8192/)
  const withMeta = toolCard(() => text('x'), { meta: () => ({ other: 1, bad: undefined }) })
  assert.deepEqual(withMeta({}, {}), { other: 1, [VIEW_KEY]: { type: 'text', text: 'x' } })
  assert.equal(toLosslessJson(10n), undefined)
  assert.deepEqual(viewOfMeta({ [VIEW_KEY]: 1 }), 1)
  assert.equal(viewOfMeta(null), undefined)
})

test('caps: lists when sent, the v1 catalog when not', () => {
  assert.equal(hasComponent(undefined, 'table'), true)
  assert.equal(hasComponent(undefined, 'slider'), false)
  assert.equal(hasComponent({ components: ['stack'] }, 'table'), false)
  assert.equal(hasSurface({}, 'panels'), true)
  assert.equal(hasSurface({ surfaces: ['panels'] }, 'composer.strip'), false)
  assert.equal(protocolAtLeast({ protocol: 1 }, 2), false)
  assert.equal(appAtLeast({ app: '0.10.0' }, '0.9.12'), true)
  assert.equal(appAtLeast({ app: '0.10.0' }, '0.10.1'), false)
  assert.equal(appAtLeast({}, '0.1.0'), false)
})

test('localize: exact, language, en, zh, first', () => {
  const t = { 'zh-TW': '用量（繁）', zh: '用量', en: 'Usage', ja: '使用量' }
  assert.equal(localize('zh-TW', t), '用量（繁）')
  assert.equal(localize({ locale: 'zh-CN' }, t), '用量')
  assert.equal(localize('fr', t), 'Usage')
  assert.equal(localize('fr', { zh: '用量', ja: 'x' }), '用量')
  assert.equal(localize('fr', { ja: 'x' }), 'x')
  assert.equal(localize('en', 'plain'), 'plain')
})

test('adaptView: newer components degrade for an app that lacks them', () => {
  const v = stack([
    list([{ title: 'a', trailing: '1' }, { title: 'b' }]),
    keyValue([['k', 'v']]),
    progress(30, { label: 'p', max: 60 }),
    table({ columns: ['a', 'b'], rows: [['1', 2]] }),
    actions([{ label: 'x', action: 'go' }]),
    image('data:image/png;base64,AA=='),
  ], { title: 'T' })
  const old = { components: ['stack', 'row', 'text', 'metric', 'chart', 'compare', 'steps', 'callout', 'options', 'confirm'] }
  assert.deepEqual(adaptView(v, old), {
    type: 'stack',
    title: 'T',
    children: [
      { type: 'text', text: '- a · 1\n- b' },
      { type: 'text', text: 'k：v' },
      { type: 'metric', label: 'p', value: '50%' },
      { type: 'text', text: '1 · 2' },
    ],
  })
  assert.deepEqual(adaptView(v, undefined), v, 'nothing to adapt for a current app')
})

test('effects: constructors match the protocol shapes', () => {
  assert.deepEqual(effects.insert('a'), { type: 'insert', text: 'a' })
  assert.deepEqual(effects.command('goal', 'x'), { type: 'command', name: 'goal', args: 'x' })
  assert.deepEqual(effects.openPanel('usage'), { type: 'open', page: 'panel:usage' })
  assert.deepEqual(effects.refresh(), { type: 'refresh' })
  assert.deepEqual(effects.patch({ a: 1 }, 'p'), { type: 'patch', data: { a: 1 }, id: 'p' })
})

test('checkEffects / checkPending: the bridge reading of a handler result', async () => {
  const { checkEffects, checkPending } = await import('../lib/index.js')
  const r = checkEffects({ copy: 'x', toast: '已复制' })
  assert.deepEqual(r, { effects: [{ type: 'copy', text: 'x' }, { type: 'toast', text: '已复制' }], issues: [], violation: false })
  assert.equal(checkEffects({ open: 'panel:nope' }).violation, true)
  assert.equal(checkEffects({ open: 'panel:usage' }, { panels: ['usage'] }).violation, false)
  assert.equal(checkEffects({ link: 'https://x.dev' }, { deferred: true }).violation, true)
  assert.equal(checkPending({ insert: 'x' }), undefined)
  const p = checkPending(effects.deferred(async () => ({ insert: 'x' }), { label: '一二三四五六七八九十一二三四五六七' }))
  assert.equal(p.ok, true)
  assert.equal(p.label.length, 16)
  assert.equal(checkPending({ pending: true }).ok, false, 'pending needs result')
})
