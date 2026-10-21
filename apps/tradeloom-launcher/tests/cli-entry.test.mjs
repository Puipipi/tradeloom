import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const launcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('normal stop entry loads without importing the unfinished dev bundle synchronizer', async t => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-cli-entry-'))
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [path.join(launcherRoot, 'cli.mjs'), 'stop'], {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData, TRADELOOM_DATA_ROOT: path.join(localAppData, 'data') },
    timeout: 10_000,
    windowsHide: true,
  })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未找到由本启动器管理的运行实例/)
  assert.doesNotMatch(result.stderr, /sync-dev-bundle|does not provide an export/)
})
