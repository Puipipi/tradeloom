// Generated and copied files must match their sources.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BRIDGE_DIR, staleFiles } from '../scripts/sync-bridge.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('types are generated from the current schemas and public declaration template', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'gen-types.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('lib/bridge/ is a byte copy of the bridge modules', { skip: existsSync(BRIDGE_DIR) ? false : 'no runtime/ checkout' }, () => {
  assert.deepEqual(staleFiles(), [], 'run node scripts/sync-bridge.mjs')
})

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
test('types compile and reject what the schemas reject', { skip: existsSync(tsc) ? false : 'typescript not installed (npm install in sdk/plugin-kit)' }, () => {
  try {
    const sources = readdirSync(join(root, 'test', 'types')).filter(name => name.endsWith('.ts')).sort()
      .map(name => join(root, 'test', 'types', name))
    execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', ...sources], { encoding: 'utf8' })
  } catch (error) {
    assert.fail(error.stdout || error.message)
  }
})
