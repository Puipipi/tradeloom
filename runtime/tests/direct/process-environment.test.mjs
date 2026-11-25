// Linux host regression: real child_process/Node/sh, private wrapper stand-ins.
// This does not run the generated Android wrappers, PRoot, or the guest suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fields = ['PROBE_VALUE', 'OWN_VALUE', 'HOME', 'TMPDIR', 'DSH_HOME', 'DSH_AGENTS_HOME',
  'PATH', 'DSH_GO_GUEST_PATH', '__proto__', 'HIDDEN_VALUE'];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-process-env-'));
const worker = String.raw`
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createPaths } from ${JSON.stringify(new URL('../../direct/paths.mjs', import.meta.url).href)};
import { installCommands, shellQuote } from ${JSON.stringify(new URL('../../direct/processes.mjs', import.meta.url).href)};

const base = ${JSON.stringify(base)};
const rootfs = path.join(base, 'private-root');
const bin = path.join(rootfs, 'direct', 'bin');
fs.mkdirSync(bin, { recursive: true });
const node = process.execPath;
const native = cp.spawnSync;
const guestProgram = path.join(rootfs, 'print-env');
const nodeScript = '#!/bin/sh\nexec ' + shellQuote(node) + ' "$@"\n';
fs.writeFileSync(path.join(bin, 'node'), nodeScript, { mode: 0o700 });
fs.writeFileSync(guestProgram, nodeScript, { mode: 0o700 });
fs.writeFileSync(path.join(bin, 'guest'), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
const fields = ${JSON.stringify(fields)};
const args = ['-p', 'JSON.stringify(Object.fromEntries(' + JSON.stringify(fields) +
  '.map(key => [key, process.env[key] ?? null])))'];
const rows = [];
for (const route of ['node', 'guest']) {
  for (const inherited of [false, true]) {
    const values = Object.fromEntries([
      ['PROBE_VALUE', 'inherited'], ['HOME', '/root/custom'], ['TMPDIR', '/tmp/custom'],
      ['DSH_HOME', '/root/dsh'], ['DSH_AGENTS_HOME', '/root/agents'],
      ['PATH', bin + ':' + rootfs + '/usr/bin:/custom/bin'], ['__proto__', 'literal-key'],
    ]);
    const env = inherited ? Object.create(values) : values;
    env.OWN_VALUE = 'own';
    Object.defineProperty(env, 'HIDDEN_VALUE', { value: 'not-enumerable' });
    const options = { env, encoding: 'utf8', timeout: 5000 };
    const file = route === 'node' ? node : guestProgram;
    const result = native(file, args, options);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    rows.push({ route, inherited, file, options, before: fields.map(key => env[key]),
      ownKeys: Object.keys(env), prototype: Object.getPrototypeOf(env),
      native: JSON.parse(result.stdout) });
  }
}
installCommands({ rootfs, bin, node, hostShell: '/bin/sh' }, createPaths(rootfs));
const results = rows.map(row => {
  const result = cp.spawnSync(row.route === 'node' ? 'node' : row.file, args, row.options);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fields.map(key => row.options.env[key]), row.before);
  assert.deepEqual(Object.keys(row.options.env), row.ownKeys);
  assert.strictEqual(Object.getPrototypeOf(row.options.env), row.prototype);
  return { route: row.route, inherited: row.inherited,
    native: row.native, adapted: JSON.parse(result.stdout) };
});
console.log(JSON.stringify({ rootfs, bin, rows: results }));
`;

// Isolate installCommands' global child_process/execPath changes in one worker.
let run;
try {
  run = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
    encoding: 'utf8', timeout: 15_000,
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
assert.ifError(run.error);
assert.equal(run.status, 0, run.stderr);
const result = JSON.parse(run.stdout);
assert.equal(result.rows.length, 4);

for (const row of result.rows) {
  test(`${row.route} preserves ${row.inherited ? 'inherited' : 'own'} environment and path mappings`, () => {
    const normal = {
      PROBE_VALUE: 'inherited', OWN_VALUE: 'own', HOME: '/root/custom', TMPDIR: '/tmp/custom',
      DSH_HOME: '/root/dsh', DSH_AGENTS_HOME: '/root/agents',
      PATH: `${result.bin}:${result.rootfs}/usr/bin:/custom/bin`, DSH_GO_GUEST_PATH: null,
      ['__proto__']: 'literal-key', HIDDEN_VALUE: null,
    };
    assert.deepEqual(row.native, normal, 'the native control includes enumerable prototype keys');
    const expected = { ...normal };
    if (row.route === 'node') {
      for (const key of ['HOME', 'TMPDIR', 'DSH_HOME', 'DSH_AGENTS_HOME']) {
        expected[key] = result.rootfs + normal[key];
      }
    } else expected.DSH_GO_GUEST_PATH = '/usr/bin:/custom/bin';
    assert.deepEqual(row.adapted, expected);
  });
}
