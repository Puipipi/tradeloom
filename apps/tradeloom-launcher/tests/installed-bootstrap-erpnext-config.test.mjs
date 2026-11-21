import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readPackagedErpNextConfig, withPackagedErpNextConfig } from '../stage5-source06/asar/lib/tradeloom/installed-bootstrap.mjs'

test('packaged bootstrap scopes one synthetic ERP config to Django and tolerates missing or invalid files', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-erpnext-config-'))
  const privateDirectory = path.join(dataRoot, 'private')
  const configPath = path.join(privateDirectory, 'erpnext.json')
  try {
    const missing = await readPackagedErpNextConfig(dataRoot)
    assert.deepEqual(missing, { status: 'not_configured', environment: {} })
    const hostEnvironment = { DSH_HOME: path.join(dataRoot, 'harness-home') }
    const missingDjangoEnvironment = withPackagedErpNextConfig(hostEnvironment, missing)
    assert.deepEqual(hostEnvironment, { DSH_HOME: path.join(dataRoot, 'harness-home') })
    assert.deepEqual(missingDjangoEnvironment, { ...hostEnvironment, TRADELOOM_PACKAGED_ERPNEXT_CONFIG_STATUS: 'not_configured' })

    await mkdir(privateDirectory)
    const syntheticConfig = {
      version: 1,
      baseUrl: 'http://127.0.0.1:39991',
      instanceId: 'synthetic-status-ui-check',
      apiKey: 'synthetic-api-key',
      apiSecret: 'synthetic-api-secret',
    }
    await writeFile(configPath, JSON.stringify(syntheticConfig), { flag: 'wx' })
    const configured = await readPackagedErpNextConfig(dataRoot)
    assert.equal(configured.status, 'configured')
    const djangoEnvironment = withPackagedErpNextConfig({
      ...hostEnvironment,
      TRADELOOM_ERPNEXT_INSTANCE_ID: 'untrusted-inherited-value',
    }, configured)
    assert.equal(djangoEnvironment.TRADELOOM_ERPNEXT_BASE_URL, syntheticConfig.baseUrl)
    assert.equal(djangoEnvironment.TRADELOOM_ERPNEXT_INSTANCE_ID, syntheticConfig.instanceId)
    assert.equal(djangoEnvironment.TRADELOOM_ERPNEXT_API_KEY, syntheticConfig.apiKey)
    assert.equal(djangoEnvironment.TRADELOOM_ERPNEXT_API_SECRET, syntheticConfig.apiSecret)
    assert.equal(djangoEnvironment.TRADELOOM_PACKAGED_ERPNEXT_CONFIG_STATUS, 'configured')
    assert.equal(hostEnvironment.TRADELOOM_ERPNEXT_API_SECRET, undefined)

    await writeFile(configPath, '{ malformed', { flag: 'w' })
    const invalid = await readPackagedErpNextConfig(dataRoot)
    assert.deepEqual(invalid, { status: 'invalid_configuration', environment: {} })
    const invalidDjangoEnvironment = withPackagedErpNextConfig({
      ...hostEnvironment,
      TRADELOOM_ERPNEXT_INSTANCE_ID: 'untrusted-inherited-value',
    }, invalid)
    assert.equal(invalidDjangoEnvironment.TRADELOOM_PACKAGED_ERPNEXT_CONFIG_STATUS, 'invalid_configuration')
    assert.equal(invalidDjangoEnvironment.TRADELOOM_ERPNEXT_INSTANCE_ID, undefined)
    assert.equal(invalidDjangoEnvironment.TRADELOOM_ERPNEXT_API_SECRET, undefined)
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})
