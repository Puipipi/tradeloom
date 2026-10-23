import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadErpNextConfigFile } from '../erpnext-config.mjs'

async function configFixture(t, value) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-private-config-'))
  const privateDirectory = path.join(dataRoot, 'private')
  await mkdir(privateDirectory)
  const file = path.join(privateDirectory, 'erpnext.json')
  await writeFile(file, JSON.stringify(value), { encoding: 'utf8' })
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  return { dataRoot, file }
}

const validConfig = () => ({
  version: 1,
  baseUrl: 'http://127.0.0.1:18080',
  instanceId: 'local-erpnext',
  apiKey: 'synthetic-api-key',
  apiSecret: 'synthetic-api-secret',
})

test('reads the exact v1 private config and returns only the four Django settings', async t => {
  const fixture = await configFixture(t, validConfig())
  assert.deepEqual(await loadErpNextConfigFile(fixture.file, fixture.dataRoot), {
    TRADELOOM_ERPNEXT_BASE_URL: 'http://127.0.0.1:18080',
    TRADELOOM_ERPNEXT_INSTANCE_ID: 'local-erpnext',
    TRADELOOM_ERPNEXT_API_KEY: 'synthetic-api-key',
    TRADELOOM_ERPNEXT_API_SECRET: 'synthetic-api-secret',
  })
})

test('rejects incomplete, extra-key, malformed, oversized, and non-loopback HTTP configuration generically', async t => {
  const fixture = await configFixture(t, validConfig())
  const rejected = async update => {
    await writeFile(fixture.file, update, 'utf8')
    await assert.rejects(loadErpNextConfigFile(fixture.file, fixture.dataRoot), error => {
      assert.equal(error.message, 'ERPNext 私密配置无效。')
      assert.doesNotMatch(error.message, /synthetic|erpnext\.json|apiSecret/i)
      return true
    })
  }
  await rejected(JSON.stringify({ ...validConfig(), unexpected: 'field' }))
  await rejected(JSON.stringify({ ...validConfig(), apiSecret: '' }))
  await rejected(JSON.stringify({ ...validConfig(), baseUrl: 'http://erp.example.test' }))
  await rejected('{"version":')
  await rejected(' '.repeat(16 * 1024 + 1))
})

test('refuses an alternate file location even when the file contents are valid', async t => {
  const fixture = await configFixture(t, validConfig())
  const elsewhere = path.join(fixture.dataRoot, 'erpnext.json')
  await writeFile(elsewhere, JSON.stringify(validConfig()), 'utf8')
  await assert.rejects(loadErpNextConfigFile(elsewhere, fixture.dataRoot), /ERPNext 私密配置无效/)
})
