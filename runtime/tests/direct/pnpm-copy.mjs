// A real offline pnpm install: store on tmpfs, project on the app/rootfs fs.
// Run with the generated direct node wrapper. Outputs measurements as JSON.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'direct wrapper required');
const base = fs.mkdtempSync(`${root}/tmp/direct-pnpm-`);
const store = fs.mkdtempSync('/dev/shm/direct-pnpm-store-');
const config = JSON.parse(fs.readFileSync(`${root}/opt/dsh-app/direct/config.json`, 'utf8'));
function run(file, args, cwd) {
  const result = cp.spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : [];
  });
}
function size(paths) {
  return paths.reduce((total, file) => {
    const stat = fs.statSync(file);
    return { bytes: total.bytes + stat.size, allocatedBytes: total.allocatedBytes + stat.blocks * 512, files: total.files + 1 };
  }, { bytes: 0, allocatedBytes: 0, files: 0 });
}
try {
  const fixture = path.join(base, 'fixture'); fs.mkdirSync(fixture);
  const project = path.join(base, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'direct-copy-fixture', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(fixture, 'index.js'), 'module.exports = 42;\n');
  // Deterministic non-sparse bytes, large enough that allocation differences are visible.
  const blob = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < blob.length; offset += 32) createHash('sha256').update(String(offset)).digest().copy(blob, offset);
  fs.writeFileSync(path.join(fixture, 'blob.bin'), blob);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'direct-copy-project', version: '1.0.0', private: true }));
  run('/bin/tar', ['-czf', `${base}/fixture.tgz`, '--transform=s,^,package/,', '-C', fixture, '.'], base);
  const output = run(`${config.bin}/pnpm`, ['add', `file:${base}/fixture.tgz`, '--offline', '--ignore-scripts', '--store-dir', store], project);
  const installed = fs.realpathSync(path.join(project, 'node_modules/direct-copy-fixture/blob.bin'));
  const matching = files(store).find((file) => fs.statSync(file).size === blob.length && fs.readFileSync(file).equals(blob));
  assert(matching, 'content-addressed store blob found');
  const sourceStat = fs.statSync(matching); const targetStat = fs.statSync(installed);
  assert.notEqual(sourceStat.dev, targetStat.dev, 'fixture actually crosses filesystems');
  assert.equal(targetStat.nlink, 1, 'installed content is a copy, not a hardlink');
  assert(fs.readFileSync(installed).equals(blob));
  assert.equal(run(process.execPath, ['-p', 'require("direct-copy-fixture")'], project).trim(), '42');
  fs.writeFileSync(installed, 'project changed\n');
  assert(fs.readFileSync(matching).equals(blob), 'project mutation cannot modify the store');
  const beforeMutation = { bytes: targetStat.size, allocatedBytes: targetStat.blocks * 512, links: targetStat.nlink };
  fs.writeFileSync(installed, blob);
  console.log(JSON.stringify({
    node: process.version, pnpm: run(`${config.bin}/pnpm`, ['--version'], project).trim(),
    policy: run(`${config.bin}/pnpm`, ['config', 'get', 'packageImportMethod'], project).trim(),
    rootfsDevice: targetStat.dev, storeDevice: sourceStat.dev,
    fixtureBlob: beforeMutation, storeBlob: { bytes: sourceStat.size, allocatedBytes: sourceStat.blocks * 512, links: sourceStat.nlink },
    store: size(files(store)), project: size(files(project)), output,
    interpretation: 'This fixture pays for a distinct project copy plus the store copy. Counts are host filesystem measurements, not an Android percentage.',
  }, null, 2));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
}
