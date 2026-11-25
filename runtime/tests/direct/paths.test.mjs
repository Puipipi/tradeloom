// Actual LocalFileSystem and ESM resolution, through the generated direct Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPaths } from '/opt/dsh-go/direct/paths.mjs';
import { Context } from '/opt/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalFileSystem } from '/opt/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'use the production-generated direct node wrapper');
const base = fs.mkdtempSync(`${root}/tmp/direct-paths-`);
const outside = fs.mkdtempSync('/tmp/dsh-direct-outside-');
const provider = new LocalFileSystem(new Context(), { cwd: base, diffBasisMaxBytes: 1024 * 1024 });
const paths = globalThis[Symbol.for('dsh.go.direct')];
process.on('exit', () => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('actual mounts control storage and the most specific hidden mount wins', () => {
  const off = createPaths('/runtime', [{ host: '/proc', guest: '/proc' }]);
  assert.equal(off.toHost('/sdcard/a'), '/runtime/sdcard/a');
  assert.equal(off.containsExecutionPath('/storage/emulated/0/a'), false);
  const on = createPaths('/runtime', [
    { host: '/storage/emulated/0', guest: '/sdcard' },
    { host: '/storage', guest: '/storage' },
    { host: '/sys', guest: '/sys' },
    { host: '/runtime/empty', guest: '/sys/fs/selinux' },
  ]);
  assert.equal(on.toHost('/sdcard/a'), '/storage/emulated/0/a');
  assert.equal(on.toHost('/storage/emulated/0/a'), '/storage/emulated/0/a');
  assert.equal(on.toGuest('/storage/emulated/0/a'), '/sdcard/a');
  assert.equal(on.toHost('/sys/fs/selinux/a'), '/runtime/empty/a');
  assert.equal(on.containsExecutionPath('/sys/fs/selinux/a'), false);
  assert.equal(on.containsExecutionPath('/sys/fs/selinux-other/a'), true);
  assert.equal(on.containsExecutionPath('/runtime/empty/a'), true);
  assert.equal(on.containsExecutionPath('/storage/emulated/0/a'), true);
  assert.equal(on.containsExecutionPath('/storage-other/a'), false);
});

test('native symlink outside the execution world is refused for existing and missing targets', async () => {
  fs.writeFileSync(`${outside}/existing.txt`, 'outside fixture must remain untouched');
  fs.symlinkSync(outside, `${base}/external`);
  await assert.rejects(provider.resolve(`${base}/external/existing.txt`), { code: 'FS_IO_ERROR' });
  await assert.rejects(provider.resolve(`${base}/external/missing/nested.txt`), { code: 'FS_IO_ERROR' });
  assert.equal(fs.readFileSync(`${outside}/existing.txt`, 'utf8'), 'outside fixture must remain untouched');
  assert.equal(fs.existsSync(`${outside}/missing`), false);
});

test('module symlink outside the execution world is rejected before evaluation', async () => {
  fs.writeFileSync(`${outside}/module.mjs`, 'globalThis.__outsideDirectModuleExecuted=true; export default 42;');
  await assert.rejects(import(pathToFileURL(`${base}/external/module.mjs`)), /needs compatible launch/u);
  assert.equal(globalThis.__outsideDirectModuleExecuted, undefined);
});

test('existing physical symlink parent traversal and missing suffix identity are preserved', async () => {
  fs.mkdirSync(`${base}/real/deep`, { recursive: true });
  fs.mkdirSync(`${base}/inside`);
  fs.symlinkSync('../real/deep', `${base}/inside/link`);
  fs.writeFileSync(`${base}/real/parent.txt`, 'physical parent');
  const existing = await provider.resolve(`${base}/inside/link/../parent.txt`);
  assert.equal(existing.targetKey, `${base}/real/parent.txt`);
  const missing = await provider.resolve(`${base}/inside/link/new/child.txt`);
  assert.equal(missing.targetKey, `${base}/real/deep/new/child.txt`);
});

test('session directories accept guest, physical and relative paths inside the execution world', async () => {
  const guest = base.slice(root.length);
  const target = await paths.prepareDirectory(`${guest}/new/session`);
  assert.equal(target, `${base}/new/session`);
  fs.mkdirSync(target, { recursive: true });
  assert.equal(await paths.prepareDirectory(target), target);
  const previous = process.cwd();
  try {
    process.chdir(base);
    assert.equal(await paths.prepareDirectory('relative/session'), `${base}/relative/session`);
    fs.mkdirSync(await paths.prepareDirectory('relative/session'), { recursive: true });
    assert(fs.statSync(`${base}/relative/session`).isDirectory());
  } finally { process.chdir(previous); }
});

test('session mkdir retains physical symlink parent semantics and rejects unresolved parent traversal', async () => {
  const target = await paths.prepareDirectory(`${base}/inside/link/../created/child`);
  assert.equal(target, `${base}/real/created/child`);
  fs.mkdirSync(target, { recursive: true });
  assert(fs.statSync(`${base}/real/created/child`).isDirectory());
  assert.equal(fs.existsSync(`${base}/inside/created`), false);
  await assert.rejects(paths.prepareDirectory(`${base}/missing-parent/../must-not-create`), /parent traversal crosses a missing directory/u);
  assert.equal(fs.existsSync(`${base}/missing-parent`), false);
});

test('session mkdir refuses native aliases outside the execution world and into L2S', async () => {
  await assert.rejects(paths.prepareDirectory(`${base}/external/new/session`), /needs compatible launch/u);
  fs.symlinkSync(`${root}/root/.l2s`, `${base}/backing-alias`);
  await assert.rejects(paths.prepareDirectory(`${base}/backing-alias/new/session`), /needs compatible launch/u);
  await assert.rejects(paths.prepareDirectory('/root/.l2s/new/session'), /needs compatible launch/u);
  assert.equal(fs.existsSync(`${outside}/new`), false);
  assert.equal(fs.existsSync(`${root}/root/.l2s/new`), false);
});

test('session mkdir respects an explicit mounted directory and cannot create a dangling external alias target', async () => {
  const mounted = createPaths(root, [{ host: outside, guest: '/test-mount' }]);
  const target = await mounted.prepareDirectory('/test-mount/allowed/session');
  assert.equal(target, `${outside}/allowed/session`);
  fs.mkdirSync(target, { recursive: true });
  assert(fs.statSync(target).isDirectory());
  fs.symlinkSync(`${outside}/not-present`, `${base}/dangling-external`);
  await assert.rejects(async () => fs.promises.mkdir(await paths.prepareDirectory(`${base}/dangling-external/child`), { recursive: true }));
  assert.equal(fs.existsSync(`${outside}/not-present`), false);
});
