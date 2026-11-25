import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const source = fs.readFileSync(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt', import.meta.url), 'utf8');
const script = source.match(/const val PLUGINS_SCRIPT = """([\s\S]*?)"""/)[1];
const linux = { skip: process.platform !== 'linux', timeout: 20000 };
const ownerPrefix = '.dsh-helper-lock-';
const core = '@deepseek-ai/dsh-base';

// Only schedule the real symlink call; do not reproduce the publisher or fake time.
const preload = String.raw`
const fs = require('fs');
const symlinkSync = fs.symlinkSync;
function stop(point, target, link) {
  fs.writeSync(1, JSON.stringify({ point, target, link, pid: process.pid }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
fs.symlinkSync = function (target, link) {
  if (link !== process.env.DSH_TEST_LOCK) return symlinkSync.apply(this, arguments);
  if (process.env.DSH_TEST_PAUSE === 'before') stop('before', target, link);
  const result = symlinkSync.apply(this, arguments);
  if (process.env.DSH_TEST_PAUSE === 'after') stop('after', target, link);
  return result;
};
`;

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'safe-helper-publication-'));
  const profile = join(home, 'profiles/web');
  fs.mkdirSync(profile, { recursive: true });
  const file = join(profile, 'package.json');
  const before = JSON.stringify({ dsh: { profile: { bundles: [core, 'local-plugin'] } } }) + '\n';
  fs.writeFileSync(file, before);
  const helper = join(home, 'helper.cjs');
  const hook = join(home, 'pause.cjs');
  fs.writeFileSync(helper, script);
  fs.writeFileSync(hook, preload);
  const runs = [];
  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    }
    await Promise.all(runs.map(run => run.closed));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, profile, file, lock: file + '.lock', before, helper, hook, runs };
}

function launch(f, pause) {
  const started = performance.now();
  const args = pause ? ['--require', f.hook, f.helper] : [f.helper];
  const child = spawn(process.execPath, [...args, 'disable', 'local-plugin'], {
    env: { DSH_HOME: f.home, DSH_APP_ORIGINAL_HOME: f.home, DSH_TEST_LOCK: f.lock, DSH_TEST_PAUSE: pause || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', error, timedOut = false, checkpointReady;
  const checkpoint = new Promise(resolve => { checkpointReady = resolve; });
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 12000);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    const end = stdout.indexOf('\n');
    if (end !== -1) checkpointReady(stdout.slice(0, end));
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', value => { error = value; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(watchdog);
    checkpointReady(null);
    resolve({ code, signal, error, timedOut, stdout, stderr, elapsed: performance.now() - started });
  }));
  const run = { child, checkpoint, closed };
  f.runs.push(run);
  return run;
}

function absent(file) {
  // lstat checks the name itself, including dangling symlinks.
  assert.throws(() => fs.lstatSync(file), { code: 'ENOENT' });
}

function ownerNames(f) {
  return fs.readdirSync(f.profile).filter(name => name.startsWith(ownerPrefix)).sort();
}

function exited(result, code) {
  assert.ifError(result.error);
  assert.equal(result.timedOut, false, 'helper exceeded its exit watchdog');
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, code, result.stderr);
}

async function interruptedPublication(t, point) {
  const f = fixture(t);
  const run = launch(f, point);
  const line = await run.checkpoint;
  if (line === null) assert.fail('helper exited before the publication checkpoint: ' + (await run.closed).stderr);
  const record = JSON.parse(line);
  assert.equal(record.point, point);
  assert.equal(record.pid, run.child.pid);
  assert.equal(record.link, f.lock);
  assert.equal(isAbsolute(record.target), false);
  assert.equal(record.target, basename(record.target));
  assert.deepEqual(ownerNames(f), [record.target]);
  const owner = join(f.profile, record.target);
  const ownerStat = fs.lstatSync(owner, { bigint: true });
  assert.ok(ownerStat.isFile());
  assert.equal(Number(ownerStat.mode & 0o777n), 0o600);
  const pidText = run.child.pid + '\n';
  assert.equal(fs.readFileSync(owner, 'utf8'), pidText);
  // The child is stopped inside symlinkSync. Its complete owner must already be closed.
  for (const fd of fs.readdirSync('/proc/' + run.child.pid + '/fd')) {
    let stat;
    try { stat = fs.statSync('/proc/' + run.child.pid + '/fd/' + fd, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(stat.dev !== ownerStat.dev || stat.ino !== ownerStat.ino, 'owner is still open in the helper');
  }
  if (point === 'before') absent(f.lock);
  else {
    assert.ok(fs.lstatSync(f.lock).isSymbolicLink());
    assert.equal(fs.readlinkSync(f.lock), record.target);
    assert.equal(fs.readFileSync(f.lock, 'utf8'), pidText);
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.before);
  assert.equal(run.child.kill('SIGKILL'), true);
  const killed = await run.closed;
  assert.ifError(killed.error);
  assert.equal(killed.timedOut, false);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(killed.code, null);
  exited(await launch(f).closed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).dsh.profile.bundles, [core]);
  absent(f.lock);
  assert.deepEqual(ownerNames(f), [record.target]);
  assert.equal(fs.readFileSync(owner, 'utf8'), pidText);
}

test('kill before helper lock publication leaves no lock name and a fresh helper can disable', linux, async t => {
  await interruptedPublication(t, 'before');
});

test('kill after helper lock publication leaves a complete relative lock that the next helper takes over', linux, async t => {
  await interruptedPublication(t, 'after');
});

test('a live writer causes the real five-second timeout without changing its lock or leaking a new owner', linux, async t => {
  const f = fixture(t);
  const original = process.pid + '\n';
  fs.writeFileSync(f.lock, original, { flag: 'wx', mode: 0o600 });
  const result = await launch(f).closed;
  exited(result, 1);
  assert.match(result.stderr, /package\.json 正被别的进程修改/);
  assert.ok(result.elapsed >= 5000, 'the live writer must use the real production timeout');
  assert.ok(fs.lstatSync(f.lock).isFile());
  assert.equal(fs.readFileSync(f.lock, 'utf8'), original);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.before);
  assert.deepEqual(ownerNames(f), []);
});
