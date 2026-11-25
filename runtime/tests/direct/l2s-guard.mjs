// Real PRoot fake links created after a successful direct preload. No data
// migration and no broad .l2s sandbox grant; only this unique fixture is removed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Context } from '/opt/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalFileSystem } from '/opt/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'use the production-generated direct node wrapper');
const base = fs.mkdtempSync(`${root}/tmp/direct-l2s-`);
const source = `${base}/source.mjs`; const alias = `${base}/alias.mjs`;
const content = 'globalThis.__directL2sModuleExecuted = true; export default 42;\n';
const provider = new LocalFileSystem(new Context(), { cwd: base, diffBasisMaxBytes: 1024 * 1024 });
function guest(file, args) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  fs.writeFileSync(source, content);
  guest('/bin/ln', [source, alias]);
  assert(fs.lstatSync(alias).isSymbolicLink(), 'production --link2symlink was active');
  const backing = fs.realpathSync(alias);
  assert(backing.startsWith(`${root}/root/.l2s/`), backing);
  await assert.rejects(provider.resolve(alias), { code: 'FS_IO_ERROR' });
  await assert.rejects(import(pathToFileURL(alias)), /needs compatible launch/u);
  assert.equal(globalThis.__directL2sModuleExecuted, undefined);
  const child = cp.spawnSync(process.execPath, ['-e', 'console.log("must not execute")'], { encoding: 'utf8' });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /\[dsh-app-direct\] launch failed:.*compatible launch/u);
  assert.equal(fs.readFileSync(backing, 'utf8'), content);
  assert.equal(guest('/bin/cat', [alias]), content, 'the completed guest operation remains usable in compatible mode');
  console.log(JSON.stringify({ node: process.version, nativeBacking: backing, typedFs: 'FS_IO_ERROR',
    module: 'rejected before evaluation', newChildNodeExit: child.status,
    guestReadPreserved: true, bytes: Buffer.byteLength(content) }, null, 2));
} finally {
  guest('/bin/rm', ['-rf', '--', base]);
}
