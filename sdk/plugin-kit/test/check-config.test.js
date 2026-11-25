import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { checkPlugin, exitCode } from '../lib/check.js'

const cliPath = fileURLToPath(new URL('../bin/check.mjs', import.meta.url))
function fixture(t, source) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-check-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'config-fixture', version: '1.0.0', type: 'module', main: 'index.js', engines: { dsh: '*' }, dsh: { bundle: { patch: 'patch.yml' } } }))
  writeFileSync(join(dir, 'patch.yml'), '[]\n')
  writeFileSync(join(dir, 'index.js'), source)
  return dir
}
const check = dir => checkPlugin(dir, { load: true, lang: 'en' })
const cli = dir => spawnSync(process.execPath, [cliPath, dir, '--load', '--json', '--lang', 'en'], { encoding: 'utf8' })

// A plugin-owned Standard Schema has no checker dependency. The same protocol
// is applied by Cordis before invoking a plugin with its effective config.
test('load applies default Config before registering tools, through API and CLI', async t => {
  const dir = fixture(t, `
    let calls = 0;
    export const Config = { '~standard': { version: 1, vendor: 'fixture', validate(input) {
      if (++calls !== 1 || Object.keys(input).length !== 0 || this.vendor !== 'fixture') throw Error('wrong validation invocation');
      return { value: { label: 'Ordinary_Default', enabled: true } };
    } } };
    export function apply(ctx, config) {
      if (config.enabled) ctx.tools.register({ name: config.label.toLowerCase() });
    }
  `)
  const report = await check(dir)
  assert.equal(report.load.ok, true)
  assert.deepEqual(report.load.tools, ['ordinary_default'])
  assert.equal(exitCode(report), 0)
  const result = cli(dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout).load.tools, ['ordinary_default'])
})

test('load preserves a normalized false config and the schema-free empty config', async t => {
  const normalized = fixture(t, `
    export const Config = { '~standard': { version: 1, vendor: 'fixture', validate: () => ({ value: false }) } };
    export function apply(ctx, config) {
      if (config !== false) throw Error('normalized false was replaced');
      ctx.tools.register({ name: 'normalized_false' });
    }
  `)
  assert.deepEqual((await check(normalized)).load.tools, ['normalized_false'])
  const plain = fixture(t, `
    export function apply(ctx, config) {
      if (JSON.stringify(config) !== '{}') throw Error('schema-free config changed');
      ctx.tools.register({ name: 'plain' });
    }
  `)
  assert.deepEqual((await check(plain)).load.tools, ['plain'])
})

test('invalid Config reports the schema issue and never applies the plugin', async t => {
  const dir = fixture(t, `
    export const Config = { '~standard': { version: 1, vendor: 'fixture', validate: () => ({ issues: [{ message: 'A workspace is required', path: ['workspace'] }] }) } };
    export function apply() { throw Error('apply must not run'); }
  `)
  const report = await check(dir)
  assert.equal(report.load.ok, false)
  assert.equal(exitCode(report), 2)
  assert.match(report.load.error, /A workspace is required/)
  assert.doesNotMatch(report.load.error, /apply must not run/)
  const result = cli(dir)
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stdout).load.error, /A workspace is required/)
})

test('async Config is refused before apply, as in the Host', async t => {
  const dir = fixture(t, `
    export const Config = { '~standard': { version: 1, vendor: 'fixture', validate: async () => ({ value: {} }) } };
    export function apply() { throw Error('apply must not run'); }
  `)
  const report = await check(dir)
  assert.equal(report.load.ok, false)
  assert.equal(exitCode(report), 2)
  assert.match(report.load.error, /Async config validation is not supported/)
})

test('a throwing Config retains its diagnostic without applying the plugin', async t => {
  const dir = fixture(t, `
    export const Config = { '~standard': { version: 1, vendor: 'fixture', validate() { throw Error('Config lookup failed'); } } };
    export function apply() { throw Error('apply must not run'); }
  `)
  const report = await check(dir)
  assert.equal(report.load.ok, false)
  assert.match(report.load.error, /Config lookup failed/)
})

test('rejecting async Config remains a CLI load failure without an unhandled rejection', t => {
  const dir = fixture(t, `
    export const Config = { '~standard': { version: 1, vendor: 'fixture', async validate() { throw Error('async validation failed'); } } };
    export function apply() { throw Error('apply must not run'); }
  `)
  const result = cli(dir)
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(JSON.parse(result.stdout).load.error, /Async config validation is not supported/)
})
