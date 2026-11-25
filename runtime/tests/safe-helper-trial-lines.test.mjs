import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt', import.meta.url), 'utf8');
const script = source.match(/const val PLUGINS_SCRIPT = """([\s\S]*?)"""/)[1];

// Run the shipped helper against real Node streams. Only the child and clock
// are controlled; no DSH installation, model, Android or real waiting is needed.
function trial(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  t.after(() => { child.stdout.destroy(); child.stderr.destroy(); });
  const kills = [];
  child.kill = signal => { kills.push(signal); return true; };
  let now = 1000;
  let tick;
  let status;
  let stdout = '';
  const exited = {};
  runInNewContext(script, {
    require: name => name === 'child_process' ? { spawn: () => child } : require(name),
    Date: { now: () => now },
    setInterval: callback => { tick = callback; return 1; },
    clearInterval: () => {},
    setTimeout: () => ({ unref() {} }),
    process: {
      argv: ['node', 'helper', 'trial'],
      env: { DSH_APP_PATCH: '/absent-trial-fixture.patch.yml', TRIAL_HOLD: '0', TRIAL_LIMIT: '1' },
      stdout: { write: text => { stdout += text; } },
      stderr: { write: () => {} },
      exit: code => { status = code; throw exited; },
    },
  });
  function run(action) {
    try { action(); } catch (error) { if (error !== exited) throw error; }
  }
  return {
    child, kills,
    tick: () => run(() => { now += 1500; tick(); }),
    exit: () => run(() => child.emit('exit', 0, null)),
    get status() { return status; },
    get stdout() { return stdout; },
  };
}

for (const stream of ['stdout', 'stderr']) {
  test(`trial recognizes a login marker split across ${stream} chunks`, t => {
    const run = trial(t);
    run.child[stream].write('http://127.0.0.1:12345/?to');
    run.child[stream].write('ken=fixture-only\n');
    run.tick();
    assert.deepEqual(run.kills, ['SIGTERM'], 'the complete login line should enter the healthy hold path');
    run.exit();
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /PASS:/);
  });
}

test('trial preserves an ordinary complete login line', t => {
  const run = trial(t);
  run.child.stdout.write('dsh web: http://127.0.0.1:12345/?token=fixture-only\n');
  run.tick();
  assert.deepEqual(run.kills, ['SIGTERM']);
  run.exit();
  assert.equal(run.status, 0, run.stdout);
});

test('trial keeps stdout and stderr line fragments separate', t => {
  const run = trial(t);
  run.child.stdout.write('to');
  run.child.stderr.write('ken=fixture-only\n');
  run.child.stdout.write('\n');
  run.tick();
  assert.deepEqual(run.kills, ['SIGKILL']);
  assert.equal(run.status, 1);
});

test('trial still fails when no login line arrives', t => {
  const run = trial(t);
  run.child.stdout.write('ordinary startup output\n');
  run.tick();
  assert.deepEqual(run.kills, ['SIGKILL']);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL:/);
});

for (const stream of ['stdout', 'stderr']) {
  for (const split of ['name', 'value']) {
    test(`trial masks a ${split} split across ${stream} chunks before failure`, t => {
      const run = trial(t);
      const value = 'SYNTHETIC_TRIAL_VALUE';
      const prefix = 'http://127.0.0.1:12345/?';
      const parts = split === 'name' ? [prefix + 'to', 'ken=' + value] : [prefix + 'token=', value];
      for (const part of parts) run.child[stream].write(part);
      run.exit();
      assert.equal(run.status, 1);
      assert.equal(run.stdout.includes(value), false, 'the captured credential must not reach the failure tail');
      assert.equal(run.stdout.includes('token=***'), true, 'the unfinished line is flushed after masking');
    });
  }
}

test('trial masks split warning output after a healthy hold', t => {
  const run = trial(t);
  run.child.stdout.write('warning: http://127.0.0.1:12345/?token=');
  run.child.stdout.write('SYNTHETIC_TRIAL_VALUE\n');
  run.tick();
  run.exit();
  assert.equal(run.status, 0);
  assert.equal(run.stdout.includes('SYNTHETIC_TRIAL_VALUE'), false);
  assert.equal(run.stdout.includes('warning: http://127.0.0.1:12345/?token=***'), true);
});

test('trial keeps bounded line prefixes without losing a later login marker', t => {
  const run = trial(t);
  run.child.stdout.write('warning: ' + 'x'.repeat(200_000));
  run.child.stdout.write('token=fixture-only');
  run.tick();
  assert.deepEqual(run.kills, ['SIGTERM']);
  run.exit();
  assert.equal(run.status, 0);
  assert.equal(run.stdout.includes('warning: '), true);
  assert.equal(run.stdout.includes('…'), true);
  assert.equal(run.stdout.includes('fixture-only'), false);
  assert.ok(run.stdout.length < 3000, 'a single unterminated line must not grow the failure tail');
});

test('trial keeps a UTF-8 character whole across pipe buffers', t => {
  const run = trial(t);
  const bytes = Buffer.from('ordinary 中 output\n');
  const boundary = Buffer.byteLength('ordinary ') + 1;
  run.child.stderr.write(bytes.subarray(0, boundary));
  run.child.stderr.write(bytes.subarray(boundary));
  run.exit();
  assert.equal(run.status, 1);
  assert.equal(run.stdout.includes('ordinary 中 output'), true);
});
