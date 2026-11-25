import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contrast, initStyles, readStyle, readableColor } from '../lib/style-check.js'
import { checkView } from '../lib/view-check.js'
import { SchemaSet } from '../lib/json-schema.js'

const schema = JSON.parse(readFileSync(new URL('../schema/view.schema.json', import.meta.url), 'utf8'))
const spec = schema['x-dsh-go'].v2Styles
const set = new SchemaSet()
const text = (style = {}, spans) => ({ v: 2, type: 'text', text: 'fallback', style, ...(spans === undefined ? {} : { spans }) })
function inspect(view, budget = 'panel') {
  const ctx = { p: { name: budget, text: budget === 'strip' ? 200 : 2000 }, m: (key, ...args) => `${key}:${args}`, note() {} }
  initStyles(view, ctx, { isMissing: () => false, show: String, str: v => typeof v === 'string' ? v : null })
  const style = readStyle(view, 'view', ctx)
  return { ctx, style }
}
function assertReadable(style) {
  for (let i = 0; i < 2; i++) {
    for (const color of [style.foreground, style.accent, style.muted]) assert.ok(contrast(color[i], style.background[i]) >= 4.5)
    for (const span of style.spans) assert.ok(contrast(span.color[i], (span.background ?? style.background)[i]) >= 4.5)
    for (const color of [...style.chartColors, ...(style.chartOther === null ? [] : [style.chartOther])]) assert.ok(contrast(color[i], style.background[i]) >= 3)
  }
}

test('v2 schema accepts bounded typography, cards, binding values and spans', () => {
  for (const size of Object.keys(spec.fontPixels)) {
    const view = { v: 2, accent: 'teal', type: 'row', style: { card: 'outlined', padding: 'L', gap: 'S', columns: [1, 2], dividers: true }, children: [
      text({ size, weight: 'bold', italic: true, underline: true, strike: true, align: 'end', maxLines: 20, color: '#aAbBcC' }, [
        { text: 'first', color: 'accent', background: 'pink', weight: 'medium', mono: true },
      ]), text({ size: { $: 'data.size' }, maxLines: { $: 'data.lines' } }),
    ] }
    assert.deepEqual(set.validate(view, 'view.schema.json'), [])
  }
})

test('schema closes arbitrary geometry, external spans, bad alpha and missing fallback', () => {
  for (const bad of [
    text({ color: '#ffffff80' }), text({ maxLines: 21 }), text({ fontSize: 19 }), text({ radius: 100 }),
    text({}, [{ text: 'click', href: 'https://example.com' }]),
    { v: 2, type: 'text', spans: [{ text: 'no fallback' }] },
    { v: 2, type: 'row', children: [], style: { columns: [1, 13] } },
  ]) assert.ok(set.validate(bad, 'view.schema.json').length > 0)
})

test('malformed spacing is diagnosed without coercing JSON values to property keys', () => {
  for (const value of [['S'], { toString: null }, {}, 8, true]) {
    const view = { v: 2, type: 'stack', style: { padding: value, gap: value }, children: [{ type: 'text', text: 'ok' }] }
    assert.ok(set.validate(view, 'view.schema.json').length > 0)
    const result = checkView(JSON.stringify(view), { lang: 'en' })
    assert.equal(result.fatal, false)
    for (const path of ['view.style.padding', 'view.style.gap']) {
      assert.ok(result.issues.some(issue => issue.path === path && issue.message === 'Invalid style; expected S / M / L'), path)
    }
    const style = inspect(view).style
    assert.equal(style.padding, 0)
    assert.equal(style.gap, 16)
  }
})

test('SDK corrections are quantised, stable when readable and above the exact bound', () => {
  assert.equal(contrast(0, 0xffffff), 21)
  assert.ok(contrast(0x777777, 0xffffff) < 4.5)
  assert.ok(contrast(0x767676, 0xffffff) > 4.5)
  let seed = 0x125678
  for (let i = 0; i < 512; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) & 0xffffff
    for (const background of [0, 0xffffff, 0x777777, 0x808080, 0xf8fafe, 0x272a33, 0xf0f3f9, 0x30343f]) {
      const corrected = readableColor(seed, background)
      assert.ok(contrast(corrected, background) >= 4.5)
      if (contrast(seed, background) >= 4.5) assert.equal(corrected, seed)
    }
  }
})

test('every semantic size/weight and named colour retains 4.5 in both themes', () => {
  for (const size of Object.keys(spec.fontPixels)) for (const weight of spec.weights) {
    for (const color of [...Object.keys(spec.namedColors), 'accent', '#000000', '#FFFFFF']) {
      assertReadable(inspect(text({ size, weight, color }, [{ text: 'x', color, background: 'pink', weight }])).style)
    }
  }
})

test('correction diagnostics contain the actual light/dark colours and ratio', () => {
  const result = checkView(text({ color: '#FFFFFF' }), { lang: 'en' })
  assert.ok(result.issues.some(i => i.path === 'view.style.color' && i.message === 'light: #FFFFFF adjusted to #737373, contrast at least 4.5:1'))
  assert.ok(result.issues.some(i => i.path === 'view.accent' && i.message.includes('dark:')))
})

test('privileged roles fail locally while ordinary new properties fail softly', () => {
  for (const role of spec.reservedRoles) assert.equal(checkView({ ...text(), role }).fatal, true)
  const result = checkView(text({ opacity: 0, position: 'fixed', fontFamily: 'System', newKey: 1 }))
  assert.equal(result.fatal, false)
  assert.ok(result.issues.some(i => i.path === 'view.style.newKey'))
  assert.equal(checkView({ ...text(), v: 1 }).issues.length, 0)
})

test('rich spans have per-node, per-view and character budgets', () => {
  const spans = Array.from({ length: 33 }, () => ({ text: 'x' }))
  assert.equal(inspect(text({}, spans)).style.spans.length, 32)
  assert.equal(inspect(text({}, spans), 'strip').style.spans.length, 16)
  assert.equal(inspect(text({}, [{ text: 'x'.repeat(5000) }])).style.spans[0].text.length, 2001)
  const { ctx } = inspect(text())
  for (let i = 0; i < 10; i++) readStyle(text({}, spans), `view.children[${i}]`, ctx)
  assert.equal(ctx.richSpans, 256)
})

test('chart categories are corrected against actual v2 container backgrounds', () => {
  for (const background of [...Object.keys(spec.namedColors), '#000000', '#FFFFFF']) {
    const { ctx, style: container } = inspect({ v: 2, type: 'stack', style: { background } })
    ctx.styleBackground = container.background
    const chart = readStyle({ type: 'chart' }, 'view.children[0]', ctx)
    assert.equal(chart.chartColors.length, 6)
    assertReadable(chart)
  }
})
