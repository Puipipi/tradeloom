// Unit tests for runtime/boot/boot-cache.mjs (the `dsh web` boot cache).
//   node --test runtime/tests/boot-cache.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, createBootCache, PASS } from '../boot/boot-cache.mjs';

const MODULE = fileURLToPath(new URL('../boot/boot-cache.mjs', import.meta.url));

/** A tree with the shapes DSH's install has: hoisted packages, file links, a dir link, an outside link. */
function tree(context) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-cache-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dsh = path.join(base, 'opt/dsh');
  const nm = path.join(dsh, 'node_modules');
  fs.mkdirSync(path.join(nm, '@scope/pkg/lib'), { recursive: true });
  fs.mkdirSync(path.join(nm, 'dep/bin'), { recursive: true });
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@scope/pkg/package.json'), '{"name":"@scope/pkg","version":"1.0.0"}');
  fs.writeFileSync(path.join(nm, '@scope/pkg/lib/index.js'), 'export {};\n');
  fs.writeFileSync(path.join(nm, 'dep/package.json'), '{"name":"dep"}');
  fs.writeFileSync(path.join(nm, 'dep/bin/cli.js'), '');
  fs.writeFileSync(path.join(base, 'outside/target.js'), '');
  fs.symlinkSync('../dep/bin/cli.js', path.join(nm, '.bin/cli'));
  fs.symlinkSync(path.join(base, 'outside/target.js'), path.join(nm, '.bin/away'));
  fs.symlinkSync('@scope/pkg', path.join(nm, 'pkg-dir-link'));
  fs.symlinkSync('missing-target', path.join(nm, '.bin/dangling'));
  return { base, roots: [dsh + '/'], dsh, nm };
}

/** fs with counters; `install` patches this object, never node:fs. */
function spyFs() {
  const calls = { lstat: 0, realpath: 0, native: 0, exists: 0, read: 0 };
  const f = { ...fs };
  f.lstatSync = (...a) => (calls.lstat++, fs.lstatSync(...a));
  f.realpathSync = (...a) => (calls.realpath++, fs.realpathSync(...a));
  f.realpathSync.native = (...a) => (calls.native++, fs.realpathSync.native(...a));
  f.existsSync = (...a) => (calls.exists++, fs.existsSync(...a));
  f.readFileSync = (...a) => (calls.read++, fs.readFileSync(...a));
  f.__calls = calls;
  return { f, calls };
}

/** Counters behind spyFs's wrappers, for a test that did not keep them. */
function spyFsCalls(f) {
  return { calls: f.__calls };
}

const fakeStdout = () => ({ written: [], write(chunk) { this.written.push(String(chunk)); return true; } });

function outcome(fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { code: e.code, syscall: e.syscall, path: e.path };
  }
}

function queries({ base, nm, dsh }) {
  return [
    path.join(nm, '@scope/pkg/lib/index.js'),
    path.join(nm, '@scope/pkg/package.json'),
    path.join(nm, '@scope/pkg/node_modules/dep/package.json'), // missing level
    path.join(nm, '@scope/node_modules/dep'), // missing
    path.join(nm, 'dep/package.json/x'), // through a file: ENOTDIR
    path.join(nm, '.bin/cli'), // file link inside the roots
    path.join(nm, '.bin/away'), // link out of the roots
    path.join(nm, '.bin/dangling'), // dangling link
    path.join(nm, 'pkg-dir-link'), // dir link as the last component
    path.join(nm, 'pkg-dir-link/lib/index.js'), // through a dir link
    path.join(nm, 'dep/bin/../package.json'), // `..`
    path.join(nm, 'dep') + '/', // trailing slash
    dsh,
    path.join(base, 'outside/target.js'), // outside the roots
  ];
}

test('answers match node:fs for every shape', (context) => {
  const t = tree(context);
  const { f } = spyFs();
  const out = fakeStdout();
  const expected = queries(t).map((q) => ({
    q,
    real: outcome(() => fs.realpathSync(q)),
    native: outcome(() => fs.realpathSync.native(q)),
    exists: fs.existsSync(q),
  }));
  // Shapes the cache must answer itself; links out of the roots, dangling links,
  // trailing slashes and other trees go to node:fs.
  const cached = new Set(queries(t).filter((q, i) => [0, 1, 2, 3, 4, 5, 8, 9, 10, 12].includes(i)));
  const { calls } = spyFsCalls(f);
  const uninstall = install({ roots: t.roots, fsImpl: f, stdout: out });
  try {
    for (let round = 0; round < 2; round++) {
      for (const e of expected) {
        const before = calls.realpath + calls.native + calls.exists;
        assert.deepEqual(outcome(() => f.realpathSync(e.q)), e.real, `realpathSync ${e.q}`);
        assert.deepEqual(outcome(() => f.realpathSync.native(e.q)), e.native, `native ${e.q}`);
        assert.equal(f.existsSync(e.q), e.exists, `existsSync ${e.q}`);
        const asked = calls.realpath + calls.native + calls.exists - before;
        const index = queries(t).indexOf(e.q);
        const firstLink = round === 0 && [5, 8].includes(index) ? 2 : 0;
        const expectedCalls = cached.has(e.q) ? firstLink : [6, 7].includes(index) ? 6 : 3;
        assert.equal(asked, expectedCalls, `node:fs asked ${asked}x for ${e.q}`);
      }
    }
  } finally {
    uninstall();
  }
});

test('one lstat per component, misses remembered', (context) => {
  const t = tree(context);
  const { f, calls } = spyFs();
  const uninstall = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    f.realpathSync(path.join(t.nm, '@scope/pkg/lib/index.js'));
    const first = calls.lstat;
    assert.ok(first > 0);
    f.realpathSync(path.join(t.nm, '@scope/pkg/lib/index.js'));
    f.realpathSync.native(path.join(t.nm, '@scope/pkg/lib'));
    assert.equal(calls.lstat, first, 'cached components are not looked up again');
    f.existsSync(path.join(t.nm, '@scope/pkg/package.json'));
    assert.equal(calls.lstat, first + 1, 'a sibling costs one lstat');
    f.existsSync(path.join(t.nm, '@scope/pkg/node_modules/dep/package.json'));
    const afterMiss = calls.lstat;
    f.existsSync(path.join(t.nm, '@scope/pkg/node_modules/other/package.json'));
    assert.equal(calls.lstat, afterMiss, 'a missing directory answers every path below it');
    assert.equal(calls.realpath + calls.native + calls.exists, 0, 'node:fs was not asked');
  } finally {
    uninstall();
  }
});

test('package.json text is read once; other reads pass through', (context) => {
  const t = tree(context);
  const { f, calls } = spyFs();
  const uninstall = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    const pj = path.join(t.nm, 'dep/package.json');
    assert.equal(f.readFileSync(pj, 'utf8'), '{"name":"dep"}');
    assert.equal(f.readFileSync(pj, { encoding: 'utf8' }), '{"name":"dep"}');
    assert.equal(calls.read, 1);
    assert.ok(Buffer.isBuffer(f.readFileSync(pj)), 'no encoding: a Buffer from node:fs');
    f.readFileSync(path.join(t.nm, '@scope/pkg/lib/index.js'), 'utf8');
    assert.equal(calls.read, 3);
    assert.throws(() => f.readFileSync(path.join(t.nm, 'nope/package.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    uninstall();
  }
});

test('the URL line ends it: originals back, nothing cached', (context) => {
  const t = tree(context);
  const { f, calls } = spyFs();
  const originals = [f.realpathSync, f.existsSync, f.readFileSync];
  const out = fakeStdout();
  const originalWrite = out.write;
  install({ roots: t.roots, fsImpl: f, stdout: out });
  const later = path.join(t.nm, 'late/package.json');
  assert.equal(f.existsSync(later), false);
  out.write('starting\n');
  assert.notEqual(f.existsSync, originals[1]);
  out.write('dsh web: http://127.0.0.1:3080/?token=abc\n');
  assert.deepEqual(out.written, ['starting\n', 'dsh web: http://127.0.0.1:3080/?token=abc\n']);
  assert.deepEqual([f.realpathSync, f.existsSync, f.readFileSync], originals);
  assert.equal(out.write, originalWrite);
  fs.mkdirSync(path.dirname(later), { recursive: true });
  fs.writeFileSync(later, '{}');
  assert.equal(f.existsSync(later), true);
  assert.ok(calls.exists > 0);
});

test('a reference taken during boot stops caching afterwards', (context) => {
  const t = tree(context);
  const { f } = spyFs();
  const out = fakeStdout();
  install({ roots: t.roots, fsImpl: f, stdout: out });
  const exists = f.existsSync;
  const later = path.join(t.nm, 'late2/package.json');
  assert.equal(exists(later), false);
  out.write('dsh web: http://127.0.0.1:3080/?token=abc\n');
  fs.mkdirSync(path.dirname(later), { recursive: true });
  fs.writeFileSync(later, '{}');
  assert.equal(exists(later), true);
});

test('gives up after maxMs without a URL line', async (context) => {
  const t = tree(context);
  const { f } = spyFs();
  const original = f.existsSync;
  install({ roots: t.roots, fsImpl: f, stdout: fakeStdout(), maxMs: 20 });
  assert.notEqual(f.existsSync, original);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(f.existsSync, original);
});

test('createBootCache passes on paths outside the roots', (context) => {
  const t = tree(context);
  const cache = createBootCache({ roots: t.roots });
  assert.equal(cache.real(path.join(t.base, 'outside/target.js')), PASS);
  assert.equal(cache.real('relative/path'), PASS);
  assert.equal(cache.real(path.join(t.nm, 'dep/package.json')), path.join(t.nm, 'dep/package.json'));
});

test('as a preload: active for `web` only, inert for other commands', (context) => {
  const script = (marker) =>
    `import fs from 'node:fs';\n` +
    `const patched = fs.existsSync.name === 'existsSync' && !fs.existsSync.toString().includes('[native code]') && fs.existsSync.toString().includes('cache.real');\n` +
    `process.stdout.write('${marker} ' + patched + '\\n');\n` +
    `process.stdout.write('dsh web: http://127.0.0.1:1/?token=x\\n');\n` +
    `process.stdout.write('after ' + fs.existsSync.toString().includes('cache.real') + '\\n');\n`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-cache-preload-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.mjs');
  fs.writeFileSync(file, script('patched'));
  const run = (...args) => spawnSync(process.execPath, ['--import', MODULE, file, ...args], { encoding: 'utf8' });
  const web = run('web', '--port', '1');
  assert.equal(web.status, 0, web.stderr);
  assert.match(web.stdout, /^patched true$/m);
  assert.match(web.stdout, /^after false$/m);
  const other = run('plugin', 'add', 'x');
  assert.match(other.stdout, /^patched false$/m);
  const off = spawnSync(process.execPath, ['--import', MODULE, file, 'web'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_GO_BOOT_CACHE: '0' },
  });
  assert.match(off.stdout, /^patched false$/m);
});

test('a URL line written as bytes ends it too', (context) => {
  const t = tree(context);
  const { f } = spyFs();
  const original = f.existsSync;
  const out = fakeStdout();
  install({ roots: t.roots, fsImpl: f, stdout: out });
  out.write(new TextEncoder().encode('dsh web: http://127.0.0.1:3080/?token=abc\n'));
  assert.equal(f.existsSync, original);
});


test('raw dot parent slash and relative spellings preserve each original API', (context) => {
  const t = tree(context);
  fs.writeFileSync(t.nm + '/marker', 'lexical');
  fs.writeFileSync(t.nm + '/@scope/marker', 'physical');
  fs.symlinkSync('@scope/pkg/package.json', t.nm + '/file-link');
  const raw = [
    t.nm + '/pkg-dir-link/../marker', t.nm + '/dep/package.json/.',
    t.nm + '/dep/package.json/', t.nm + '/file-link/child',
    t.nm + '/pkg-dir-link/./package.json', './' + path.relative(process.cwd(), t.nm + '/dep/package.json'),
  ];
  const { f } = spyFs(); const stop = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    for (const q of raw) {
      assert.deepEqual(outcome(() => f.realpathSync(q)), outcome(() => fs.realpathSync(q)), q);
      assert.deepEqual(outcome(() => f.realpathSync.native(q)), outcome(() => fs.realpathSync.native(q)), q);
      assert.equal(f.existsSync(q), fs.existsSync(q), q);
    }
    assert.notEqual(fs.realpathSync(raw[0]), fs.realpathSync.native(raw[0]), 'fixture retains the native/JS difference');
  } finally { stop(); }
});

test('pnpm links compare original API results once then reuse components', (context) => {
  const t = tree(context);
  const target = t.nm + '/.pnpm/x@1/node_modules/x';
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(target + '/package.json', '{"name":"x"}');
  fs.symlinkSync('.pnpm/x@1/node_modules/x', t.nm + '/x');
  const { f, calls } = spyFs(); const stop = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    const q = t.nm + '/x/package.json';
    assert.equal(f.realpathSync.native(q), fs.realpathSync.native(q));
    assert.equal(calls.native, 1, 'only the first native canonicalization');
    assert.equal(calls.realpath, 1, 'only the first JS agreement check');
    const first = calls.lstat;
    for (let i = 0; i < 20; i++) {
      assert.equal(f.realpathSync.native(q), target + '/package.json'); assert.equal(f.existsSync(q), true);
      assert.equal(f.readFileSync(q, 'utf8'), '{"name":"x"}');
    }
    assert.equal(calls.native, 1); assert.equal(calls.realpath, 1); assert.equal(calls.exists, 0); assert.equal(calls.lstat, first); assert.equal(calls.read, 1);
  } finally { stop(); }
});

test('outside target manifests and dangling or cyclic links stay on original fs', (context) => {
  const t = tree(context);
  fs.writeFileSync(t.base + '/outside/package.json', '{"v":1}');
  fs.symlinkSync(t.base + '/outside', t.nm + '/outside-dir'); fs.symlinkSync('cycle', t.nm + '/cycle');
  const { f } = spyFs(); const stop = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    const q = t.nm + '/outside-dir/package.json'; assert.equal(f.readFileSync(q, 'utf8'), '{"v":1}');
    fs.writeFileSync(t.base + '/outside/package.json', '{"v":2}'); assert.equal(f.readFileSync(q, 'utf8'), '{"v":2}');
    for (const raw of [t.nm + '/cycle/package.json', t.nm + '/.bin/dangling/child']) {
      assert.deepEqual(outcome(() => f.realpathSync(raw)), outcome(() => fs.realpathSync(raw)));
      assert.deepEqual(outcome(() => f.realpathSync.native(raw)), outcome(() => fs.realpathSync.native(raw)));
      assert.equal(f.existsSync(raw), fs.existsSync(raw));
    }
  } finally { stop(); }
});

test('automatic preload maps read-only roots from the actual Direct paths adapter', (context) => {
  const t = tree(context); const file = path.join(t.base, 'direct-probe.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
import { createPaths } from ${JSON.stringify(new URL('../direct/paths.mjs', import.meta.url).href)};
const root = ${JSON.stringify(t.base)};
globalThis[Symbol.for('dsh.go.direct')] = Object.freeze(createPaths(root, []));
let stats = 0; const lstat = fs.lstatSync; fs.lstatSync = (...args) => { stats++; return lstat(...args); };
await import(${JSON.stringify(new URL('../boot/boot-cache.mjs', import.meta.url).href)});
const q = ${JSON.stringify(t.nm + '/dep/package.json')};
const value = fs.realpathSync.native(q); const first = stats;
fs.realpathSync.native(q); fs.existsSync(q);
console.log(JSON.stringify({ value, first, final: stats }));
console.log('dsh web: http://127.0.0.1:1/?token=test');
`);
  const result = spawnSync(process.execPath, [file, 'web'], { encoding: 'utf8', env: { ...process.env, DSH_GO_BOOT_CACHE: '1' } });
  assert.equal(result.status, 0, result.stderr); const data = JSON.parse(result.stdout.split('\n')[0]);
  assert.equal(data.value, t.nm + '/dep/package.json'); assert.ok(data.first > 0); assert.equal(data.final, data.first);
});


test('dot segments hidden in link targets preserve JS and native results with suffixes', (context) => {
  const t = tree(context);
  fs.mkdirSync(t.dsh + '/store/deep', { recursive: true });
  for (const dir of [t.dsh, t.dsh + '/store']) {
    fs.writeFileSync(dir + '/marker', dir);
    fs.mkdirSync(dir + '/branch'); fs.writeFileSync(dir + '/branch/leaf', dir);
  }
  fs.symlinkSync('store/deep', t.dsh + '/dir');
  fs.symlinkSync('dir/../marker', t.dsh + '/hidden-dot-file');
  fs.symlinkSync('dir/../branch', t.dsh + '/hidden-dot-dir');
  const { f } = spyFs(); const stop = install({ roots: t.roots, fsImpl: f, stdout: fakeStdout() });
  try {
    for (const q of [t.dsh + '/hidden-dot-file', t.dsh + '/hidden-dot-dir', t.dsh + '/hidden-dot-dir/leaf']) {
      assert.notEqual(fs.realpathSync(q), fs.realpathSync.native(q), 'fixture retains distinct original API results');
      for (let round = 0; round < 2; round++) {
        assert.deepEqual(outcome(() => f.realpathSync(q)), outcome(() => fs.realpathSync(q)), q);
        assert.deepEqual(outcome(() => f.realpathSync.native(q)), outcome(() => fs.realpathSync.native(q)), q);
        assert.equal(f.existsSync(q), fs.existsSync(q), q);
      }
    }
  } finally { stop(); }
});
