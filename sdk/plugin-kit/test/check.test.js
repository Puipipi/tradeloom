import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPlugin, checkViewText, exitCode, formatReport } from '../lib/check.js'
import { checkView, formatValue, imageSize, measureJson } from '../lib/view-check.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const examples = join(root, '..', '..', 'examples', 'plugins')
const broken = join(root, 'test', 'fixtures', 'plugins', 'broken')
const cli = (args, input) => spawnSync(process.execPath, [join(root, 'bin', 'check.mjs'), ...args], { encoding: 'utf8', input })

test('parity cases: the twin still says what test/parity/expected.json says', () => {
  const inputs = JSON.parse(readFileSync(join(root, 'test', 'parity', 'inputs.json'), 'utf8'))
  const expected = JSON.parse(readFileSync(join(root, 'test', 'parity', 'expected.json'), 'utf8'))
  assert.deepEqual(Object.keys(expected), inputs.map((c) => c.name))
  for (const c of inputs) {
    const r = checkView(c.view, { budget: c.budget, data: c.data })
    assert.deepEqual({ fatal: r.fatal, title: r.title, issues: r.issues.map(({ path, message, kind }) => ({ path, message, kind })) }, expected[c.name], c.name)
  }
})

test('twin helpers match the app: numbers, JSON size, image headers', () => {
  assert.deepEqual([1, 12345, 12345.678, -0.5, 1e16, 3.10].map(formatValue), ['1', '12,345', '12,345.68', '-0.5', '10,000,000,000,000,000', '3.1'])
  assert.equal(measureJson({ a: [1, 'é', null, true] }, 1000).bytes, JSON.stringify({ a: [1, 'é', null, true] }).length + 1)
  assert.equal(measureJson({ a: { b: { c: 1 } } }, 1000, 2).tooDeep, true)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  assert.deepEqual(imageSize(png), [1, 1])
  assert.deepEqual(imageSize(Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1')), [16, 32])
  assert.equal(imageSize(Buffer.from([1, 2, 3])), null)
})

test('English wording comes from the app too', () => {
  const r = checkView({ type: 'stack', children: [{ type: 'gauge' }, { type: 'text', text: 'x' }] }, { lang: 'en' })
  assert.match(r.issues[0].message, /^Unknown component "gauge"/)
})

test('examples: clean, statically and with the host half loaded', async () => {
  for (const name of ['dsh-go-example-weather', 'dsh-go-example-usage', 'dsh-go-example-quick']) {
    for (const load of [false, true]) {
      const report = await checkPlugin(join(examples, name), { load })
      assert.equal(exitCode(report), 0, `${name} load=${load}\n${formatReport(report)}`)
      assert.deepEqual(report.package, [], name)
      assert.deepEqual(report.manifest?.issues ?? [], [], name)
    }
  }
})

test('a broken plugin: bridge issues, app issues, loading issues, view issues', async () => {
  const report = await checkPlugin(broken, { load: true })
  assert.equal(exitCode(report), 1)
  const codes = report.manifest.issues.map((i) => `${i.code} ${i.path}`)
  for (const want of [
    'unknown-field /dshGo/extra',
    'invalid-field /dshGo/wants/1',
    'duplicate-id /dshGo/contributes/composer.actions/1/id',
    'too-many /dshGo/contributes/composer.actions/3',
    'invalid-field /dshGo/contributes/message.actions/0/effect',
    'invalid-field /dshGo/contributes/composer.strip/0/panel',
    'invalid-field /dshGo/contributes/panels/0/placement/1',
    'unknown-surface /dshGo/contributes/pets',
    'too-long /dshGo/contributes/composer.actions/0/label',
    'unknown-icon /dshGo/icon',
    'no-handler /dshGo/contributes/composer.actions/0',
  ]) assert.ok(codes.includes(want), `missing ${want}\n${codes.join('\n')}`)
  assert.deepEqual(report.package.map((i) => i.path), ['/dsh/bundle/patch', '/engines/dsh'])
  assert.equal(report.load.notes.length, 2, 'top-level dshGo inject and dshGo?')
  assert.equal(report.views.length, 1)
  assert.equal(report.views[0].placeholders, 2)
  const text = formatReport(report)
  assert.match(text, /错误 \/dshGo\/wants\/1：unknown want telepathy/)
  assert.match(text, /错误 view\.children\[1\]\.value：应该是字符串或数字/)
})

test('view files: tool-card meta picks the tool-card budget and flags bindings and buttons', () => {
  const meta = { 'dsh-go/view': { type: 'stack', children: [{ type: 'metric', label: 'a', value: { $: 'data.a' } }, { type: 'actions', items: [{ label: 'x', action: 'y' }] }] } }
  const r = checkViewText(JSON.stringify(meta), { target: 'card.json' })
  assert.equal(r.views[0].budget, 'toolCard')
  assert.deepEqual(r.views[0].issues.map((i) => i.path), ['view.children[0].value', 'view'])
  assert.equal(exitCode(r), 0, 'notes only')
  assert.equal(exitCode(checkViewText('{"type":"gauge"}')), 2)
  assert.equal(exitCode(checkViewText('{nope')), 3)
})

test('CLI: text, --json, stdin, exit codes', () => {
  const ok = cli([join(examples, 'dsh-go-example-quick')])
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /^dsh-go-example-quick 0\.1\.0\n {2}原生界面能显示（胶囊 2 · 菜单 2）/)
  const json = cli([broken, '--json'])
  assert.equal(json.status, 1)
  assert.equal(JSON.parse(json.stdout).manifest.state, 'ok')
  const stdin = cli(['-', '--budget', 'strip', '--lang', 'en'], '{"type":"row","children":[{"type":"text","text":"1"},{"type":"text","text":"2"},{"type":"text","text":"3"},{"type":"text","text":"4"},{"type":"text","text":"5"}]}')
  assert.equal(stdin.status, 0)
  assert.match(stdin.stdout, /View - \(strip\): renders, 1 problem\(s\)/)
  assert.equal(cli(['/nonexistent/x.json']).status, 3)
})

test('--load waits for async data functions, and not for ever', async (t) => {
  const plugin = (name, contributes, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-go-check-async-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'lib/index.js', dshGo: { v: 1, contributes } }))
    writeFileSync(join(dir, 'lib', 'index.js'), `export const name = '${name}'\nexport function apply(ctx) { ctx.inject(['dshGo'], (ctx) => { ${body} }) }\n`)
    return dir
  }
  const failing = await checkPlugin(plugin('async-failing', { 'turn.note': [{ id: 'fails' }], 'composer.strip': [{ id: 'late' }] }, `
    ctx.dshGo.turnNote('fails', async () => { await null; throw new Error('boom') })
    ctx.dshGo.strip('late', async (scope, emit) => { await null; emit('not an object') })
  `), { load: true })
  const messages = failing.load.notes.map((n) => `${n.path} ${n.message}`).join('\n')
  assert.match(messages, /\/runtime\/fails .*boom/)
  assert.match(messages, /\/runtime\/late .*non-object/)
  const stuck = await checkPlugin(plugin('async-stuck', { 'composer.strip': [{ id: 'never' }] }, `
    ctx.dshGo.strip('never', () => new Promise(() => {}))
  `), { load: true })
  assert.equal(stuck.load.ok, true)
  assert.deepEqual(stuck.load.notes, [])
})
