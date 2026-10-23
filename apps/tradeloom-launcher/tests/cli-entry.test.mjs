import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { assertDesktopDevelopmentProjectReady, assertTradeLoomDesktopAppIdentity, desktopAppId, desktopAppManifest, desktopDevelopmentDescriptor } from '../desktop-receipt.mjs'

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

test('source desktop startup preflight rejects a missing development descriptor and accepts the prepared file', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-project-preflight-'))
  t.after(() => rm(runtime, { recursive: true, force: true }))

  await assert.rejects(assertDesktopDevelopmentProjectReady(runtime), /桌面开发 project 尚未准备.*desktop-runtime\.json/)

  const descriptorPath = path.join(runtime, ...desktopDevelopmentDescriptor.split('/'))
  await mkdir(path.dirname(descriptorPath), { recursive: true })
  await writeFile(descriptorPath, JSON.stringify({
    schemaVersion: 1,
    release: { version: '0.2.1-rc.2', nodeVersion: '22.19.0', pnpmVersion: '11.28.5' },
    platform: 'win32',
    arch: 'x64',
    sharedPackages: [
      { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2', path: 'node_modules/@deepseek-ai/dsh' },
      { name: '@deepseek-ai/dsh-desktop-host', version: '0.2.1-rc.2', path: 'node_modules/@deepseek-ai/dsh-desktop-host' },
    ],
    files: [],
  }))
  assert.equal(await assertDesktopDevelopmentProjectReady(runtime), descriptorPath)
})

test('source desktop startup requires the real app manifest to carry the TradeLoom identity', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-identity-preflight-'))
  t.after(() => rm(runtime, { recursive: true, force: true }))
  const manifestPath = path.join(runtime, ...desktopAppManifest.split('/'))

  await assert.rejects(assertTradeLoomDesktopAppIdentity(runtime), /桌面应用身份缺失/)
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' }))
  await assert.rejects(assertTradeLoomDesktopAppIdentity(runtime), /身份与织贸助手不匹配/)
  await writeFile(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2', dshDesktopAppId: desktopAppId }))
  assert.equal(await assertTradeLoomDesktopAppIdentity(runtime), manifestPath)
})
