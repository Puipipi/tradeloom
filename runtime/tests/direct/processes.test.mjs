// Run through the production-generated direct/bin/node wrapper, inside rootfs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'use the generated node wrapper');
const config = JSON.parse(fs.readFileSync(`${root}/opt/dsh-app/direct/config.json`, 'utf8'));
const adapter = globalThis[Symbol.for('dsh.go.direct')];
const base = fs.mkdtempSync(`${root}/tmp/direct-process-test-`);
const guestBase = base.slice(root.length);
process.chdir(base);
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));

function run(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 20_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  return result.stdout;
}

test('physical and legacy paths retain one spelling; unbound storage stays inside rootfs', () => {
  assert.equal(adapter.toHost('/root/workspace/a.md'), `${root}/root/workspace/a.md`);
  assert.equal(adapter.toHost(`${root}/root/workspace/a.md`), `${root}/root/workspace/a.md`);
  assert.equal(adapter.toGuest(`${root}/root/workspace/a.md`), '/root/workspace/a.md');
  assert.equal(adapter.toHost('/sdcard/a.md'), `${root}/sdcard/a.md`);
  assert.equal(adapter.toHost('README.md'), 'README.md');
  assert.equal(adapter.toHost('/root/link/../a'), `${root}/root/link/../a`);
  assert.throws(() => adapter.cwd(new URL('https://example.invalid/')), { code: 'ERR_INVALID_URL_SCHEME' });
});

test('process.execPath spawns recursively and module hooks accept old absolute paths', () => {
  assert.equal(process.execPath, `${config.bin}/node`);
  fs.writeFileSync(`${base}/child.mjs`, `import cp from 'node:child_process';\nconsole.log(JSON.stringify({execPath:process.execPath,cwd:process.cwd(),main:process.env.DSH_GO_DIRECT_MAIN??null,nested:cp.execFileSync(process.execPath,['-p','6*7'],{encoding:'utf8'}).trim()}));`);
  const value = JSON.parse(run(process.execPath, [`${guestBase}/child.mjs`], { cwd: pathToFileURL(base) }));
  assert.equal(value.execPath, process.execPath);
  assert.equal(value.cwd, base);
  assert.equal(value.main, null);
  assert.equal(value.nested, '42');
});

test('fork IPC survives wrapper exec, URL module paths and an explicitly scrubbed environment', async () => {
  fs.writeFileSync(`${base}/ipc.mjs`, `process.send({answer:42,execPath:process.execPath});process.disconnect();`);
  const child = cp.fork(pathToFileURL(`${guestBase}/ipc.mjs`), [], {
    cwd: guestBase, env: { PATH: '/usr/bin:/bin' }, silent: true,
  });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = await once(child, 'message');
  const [code] = await once(child, 'exit');
  assert.deepEqual(message[0], { answer: 42, execPath: process.execPath });
  assert.equal(code, 0, stderr);
});

test('shell, bash, Python, git and apt use the guest; cwd is visible at the same long path', () => {
  const output = run('/bin/bash', ['-c', 'printf "cwd="; pwd -P; printf "os="; . /etc/os-release; echo "$ID:$VERSION_ID"; python3 -c "print(6*7)"; git --version; apt-get check -q'], { cwd: guestBase });
  assert(output.includes(`cwd=${base}\n`), output);
  assert(output.includes('os=ubuntu:24.04\n'), output);
  assert(output.includes('\n42\n'), output);
  assert(output.includes('git version 2.43.0'), output);
  assert.equal(cp.execSync('printf "%s" "shell; literal"', { cwd: guestBase, encoding: 'utf8' }), 'shell; literal');
  assert.equal(run('printf', ['%s', 'semi;$(literal)'], { cwd: guestBase }), 'semi;$(literal)');
  fs.writeFileSync(`${base}/custom-direct-tool`, '#!/bin/sh\nprintf custom-path-ok', { mode: 0o700 });
  assert.equal(run('custom-direct-tool', [], { cwd: guestBase, env: { PATH: guestBase } }), 'custom-path-ok');
});

test('exec/execFile Promise shape and native validation are retained', async () => {
  const pending = promisify(cp.exec)('printf async-ok', { cwd: guestBase });
  assert(pending.child?.pid > 0);
  assert.deepEqual(await pending, { stdout: 'async-ok', stderr: '' });
  assert.deepEqual(await promisify(cp.execFile)('/bin/sh', ['-c', 'printf file-ok'], { cwd: guestBase }), { stdout: 'file-ok', stderr: '' });
  assert.throws(() => cp.spawn('node', 'bad args'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => cp.spawn('node', [], null), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => cp.spawn(''), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => cp.fork('x', 3), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(cp.execFileSync('/bin/printf', ['%s', 'null-options'], null).toString(), 'null-options');
});

test('packaged ripgrep runs directly and searches physical file paths', () => {
  fs.writeFileSync(`${base}/search.txt`, 'alpha\ndirect-fixture-token\nomega\n');
  const plan = adapter.command(config.ripgrep.path, ['-n', 'direct-fixture-token', `${base}/search.txt`]);
  assert.notEqual(plan.file, `${config.bin}/guest`);
  const out = run(config.ripgrep.path, ['-n', 'direct-fixture-token', `${base}/search.txt`]);
  assert.equal(out, '2:direct-fixture-token\n');
});

test('the locked pnpm accepts and reports the forced copy policy', () => {
  const value = run(`${config.bin}/pnpm`, ['config', 'get', 'packageImportMethod']).trim();
  assert.equal(value, 'copy');
});

test('subprocess cancellation and timeout settle without leaving the direct child alive', async () => {
  const controller = new AbortController();
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, stdio: 'ignore' });
  const pid = child.pid;
  const error = once(child, 'error');
  const closed = new Promise((resolve) => child.once('close', resolve));
  controller.abort();
  assert.equal((await error)[0].code, 'ABORT_ERR');
  await closed;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const timed = cp.spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200 });
  assert.equal(timed.error?.code, 'ETIMEDOUT');
});
