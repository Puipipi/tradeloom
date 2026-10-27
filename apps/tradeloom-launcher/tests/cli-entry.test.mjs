import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { assertDesktopDevelopmentProjectReady, assertTradeLoomDesktopAppIdentity, desktopAppId, desktopAppManifest, desktopDevelopmentDescriptor } from '../desktop-receipt.mjs'

const launcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('an explicit frozen bundle source rejects missing, relative or duplicate paths before startup writes', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-frozen-source-cli-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const args of [
    ['--bundle-source'],
    ['--bundle-source', 'relative-frozen-package'],
    ['--bundle-source', temporary, '--bundle-source', temporary],
  ]) {
    const untouched = path.join(temporary, 'must-not-be-created')
    const result = spawnSync(process.execPath, [path.join(launcherRoot, 'cli.mjs'), 'start', ...args, '--data-root', untouched], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--bundle-source 必须是唯一且非空的绝对目录路径/)
    await assert.rejects(access(untouched), { code: 'ENOENT' })
  }
})

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

test('previous-runtime is refused for ordinary start and cannot enable an RC2 start path', async t => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-cli-previous-runtime-'))
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [path.join(launcherRoot, 'cli.mjs'), 'start', '--previous-runtime', 'C:\\trusted\\rc2'], {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData, TRADELOOM_DATA_ROOT: path.join(localAppData, 'data') },
    timeout: 10_000,
    windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--previous-runtime 仅支持显式 sync-dev-bundle 迁移/)
})

test('previous-runtime migration is desktop-only before touching an explicit data root', async t => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-cli-previous-web-'))
  const dataRoot = path.join(localAppData, 'owned-data')
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [path.join(launcherRoot, 'cli.mjs'), 'sync-dev-bundle', '--mode', 'web', '--previous-runtime', 'C:\\trusted\\rc2'], {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: localAppData, TRADELOOM_DATA_ROOT: dataRoot },
    timeout: 10_000,
    windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--previous-runtime 仅支持 desktop profile/)
  await assert.rejects(readFile(path.join(dataRoot, '.tradeloom-data-root-owned')), { code: 'ENOENT' })
})

test('previous-runtime migration requires explicit target runtime and an existing data root', async t => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-cli-previous-explicit-'))
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const env = { ...process.env, LOCALAPPDATA: localAppData }
  delete env.TRADELOOM_DATA_ROOT
  const result = spawnSync(process.execPath, [path.join(launcherRoot, 'cli.mjs'), 'sync-dev-bundle', '--mode', 'desktop', '--previous-runtime', 'C:\\trusted\\rc2'], {
    encoding: 'utf8', env, timeout: 10_000, windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /必须显式指定 --runtime 和已存在的 --data-root/)
  await assert.rejects(readFile(path.join(localAppData, 'TradeLoom', '.tradeloom-data-root-owned')), { code: 'ENOENT' })
})

test('source desktop startup preflight rejects a missing development descriptor and accepts the prepared file', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-desktop-project-preflight-'))
  t.after(() => rm(runtime, { recursive: true, force: true }))

  await assert.rejects(assertDesktopDevelopmentProjectReady(runtime), /桌面开发 project 尚未准备.*desktop-runtime\.json/)

  const descriptorPath = path.join(runtime, ...desktopDevelopmentDescriptor.split('/'))
  await mkdir(path.dirname(descriptorPath), { recursive: true })
  await writeFile(descriptorPath, JSON.stringify({
    schemaVersion: 1,
    release: { version: '0.2.1-rc.3', nodeVersion: '24.21.0', pnpmVersion: '11.28.5' },
    platform: 'win32',
    arch: 'x64',
    sharedPackages: [
      { name: '@deepseek-ai/dsh', version: '0.2.1-rc.3', path: 'node_modules/@deepseek-ai/dsh' },
      { name: '@deepseek-ai/dsh-desktop-host', version: '0.2.1-rc.3', path: 'node_modules/@deepseek-ai/dsh-desktop-host' },
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
  await writeFile(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.3' }))
  await assert.rejects(assertTradeLoomDesktopAppIdentity(runtime), /身份与织贸助手不匹配/)
  await writeFile(manifestPath, JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.3', dshDesktopAppId: desktopAppId }))
  assert.equal(await assertTradeLoomDesktopAppIdentity(runtime), manifestPath)
})

test('desktop build lock option rejects relative or duplicate paths before startup', async t => {
  const temporary=await mkdtemp(path.join(os.tmpdir(),'tradeloom-lock-arg-')); t.after(()=>rm(temporary,{recursive:true,force:true}))
  for(const args of [['--desktop-build-lock','relative'],['--desktop-build-lock',temporary,'--desktop-build-lock',temporary]]) {
    const result=spawnSync(process.execPath,[path.join(launcherRoot,'cli.mjs'),'start',...args],{encoding:'utf8',windowsHide:true,timeout:10000})
    assert.equal(result.status,1); assert.match(result.stderr,/--desktop-build-lock/)
  }
})
