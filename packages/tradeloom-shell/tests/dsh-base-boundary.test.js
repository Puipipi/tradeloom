import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBoundary } from '../../../scripts/check-dsh-base-boundary.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('the DSH base boundary stays declared, patched only through the sanctioned list, and importable', async () => {
  const result = await checkBoundary(repoRoot)
  assert.deepEqual(result.problems, [], `DSH base boundary violations: ${result.problems.join(' | ')}`)
  assert.ok(result.ok)
  assert.equal(result.manifest.base.version, '0.2.1-rc.3', 'the declared base version matches every engine pin')
  assert.ok(result.checks.some(line => line.startsWith('profile bundles 3')),
    'all three profile bundles remain declared in installed-bootstrap.mjs')
  assert.ok(result.checks.some(line => line.startsWith('plugin exports 26/')),
    'the TradeLoom plugin still exports every declared entry so it can be imported directly')
})