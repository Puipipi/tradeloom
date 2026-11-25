import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as module from 'node:module';
import { runInNewContext } from 'node:vm';

const require = module.createRequire(import.meta.url);
assert.ok(process.env.DSH_PREFIX, 'set DSH_PREFIX to an existing DSH installation prefix');
const installedRequire = module.createRequire(join(process.env.DSH_PREFIX, 'node_modules/@deepseek-ai/dsh/package.json'));
const boot = installedRequire('@deepseek-ai/dsh-app-boot');
const source = fs.readFileSync(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt', import.meta.url), 'utf8');
const script = source.match(/const val PLUGINS_SCRIPT = """([\s\S]*?)"""/)[1];

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'safe-enable-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profile = join(home, 'profiles/web');
  const installation = join(root, 'installation/node_modules');
  const anchor = join(installation, '@deepseek-ai/dsh/package.json');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(join(installation, '@deepseek-ai/dsh'), { recursive: true });
  fs.writeFileSync(anchor, '{"name":"@deepseek-ai/dsh"}');
  const manifest = join(profile, 'package.json');
  function put(name, { installed = false, bundle = true, exports = undefined } = {}) {
    const dir = join(installed ? installation : join(profile, 'node_modules'), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports,
      ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}) }));
    fs.writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n');
    return dir;
  }
  function run(names, { dependencies = {}, ioError = null, beforeLock = null } = {}) {
    const before = JSON.stringify({ dependencies, dsh: { profile: { bundles: [] } }, keep: 'original' }, null, 2) + '\n';
    fs.writeFileSync(manifest, before);
    let status = 0, stdout = '', stderr = '';
    const exit = {};
    let lockEntered = false;
    const trackedFs = { ...fs,
      writeFileSync(file, ...args) {
        if (file === manifest + '.lock') {
          beforeLock?.();
          lockEntered = true;
        }
        return fs.writeFileSync(file, ...args);
      },
      readFileSync(file, ...args) {
        if (ioError && file === ioError) {
          assert.equal(lockEntered, true, 'validation must occur inside the manifest lock');
          throw Object.assign(new Error('controlled unreadable bundle manifest'), { code: 'EACCES' });
        }
        return fs.readFileSync(file, ...args);
      },
    };
    try {
      runInNewContext(script, {
        require(name) {
          if (name === 'fs') return trackedFs;
          if (name === 'module') return { ...module, createRequire(file) {
            const local = module.createRequire(file === '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json' ? anchor : file);
            const selected = name => name === '@deepseek-ai/dsh-app-boot' ? boot : local(name);
            selected.resolve = local.resolve;
            return selected;
          } };
          return require(name);
        },
        process: { pid: process.pid, env: { DSH_HOME: home }, argv: ['node', 'helper', 'enable', ...names],
          stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } },
          exit(code) { status = code; throw exit; }, kill: process.kill.bind(process) },
      });
    } catch (error) { if (error !== exit) throw error; }
    assert.equal(fs.existsSync(manifest + '.lock'), false, 'all validation exits release the lock');
    return { status, stdout, stderr, before, after: fs.readFileSync(manifest, 'utf8') };
  }
  return { put, run, profile };
}

for (const names of [['@deepseek-ai/nonexistent-bundle'], ['valid', '@deepseek-ai/nonexistent-bundle']]) {
  test('missing official name rejects the whole enable transaction: ' + names.join(','), t => {
    const f = fixture(t); f.put('valid');
    const r = f.run(names, { dependencies: { valid: '1.0.0' } });
    assert.equal(r.status, 1);
    assert.equal(r.after, r.before);
    assert.doesNotMatch(r.stdout, /已启用/);
  });
}
test('dependency entry without installed package is rejected', t => {
  const r = fixture(t).run(['ghost'], { dependencies: { ghost: '1.0.0' } });
  assert.equal(r.status, 1); assert.equal(r.after, r.before);
});
test('installation-only bundle resolves without exported package.json', t => {
  const f = fixture(t); f.put('@deepseek-ai/installed', { installed: true, exports: { '.': './entry.js' } });
  const r = f.run(['@deepseek-ai/installed']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.after).dsh.profile.bundles, ['@deepseek-ai/installed']);
});
test('profile bundle and pnpm-style symlink resolve', t => {
  const f = fixture(t); const dir = f.put('actual');
  fs.symlinkSync(dir, join(f.profile, 'node_modules/linked'), 'dir');
  const r = f.run(['linked'], { dependencies: { linked: '1.0.0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.after).dsh.profile.bundles, ['linked']);
});
test('installation resolution has priority over profile copy', t => {
  const f = fixture(t); f.put('@deepseek-ai/dual', { installed: true, bundle: false }); f.put('@deepseek-ai/dual');
  const r = f.run(['@deepseek-ai/dual']);
  assert.equal(r.status, 1); assert.equal(r.after, r.before);
});
test('unreadable first resolved manifest is not swallowed or retried on profile', t => {
  const f = fixture(t); const dir = f.put('@deepseek-ai/dual', { installed: true }); f.put('@deepseek-ai/dual');
  const r = f.run(['@deepseek-ai/dual'], { ioError: join(dir, 'package.json') });
  assert.equal(r.status, 1); assert.match(r.stderr, /controlled unreadable/); assert.equal(r.after, r.before);
});
test('package removed before lock acquisition cannot be enabled', t => {
  const f = fixture(t); const dir = f.put('removed');
  const r = f.run(['removed'], { dependencies: { removed: '1.0.0' }, beforeLock: () => fs.rmSync(dir, { recursive: true }) });
  assert.equal(r.status, 1); assert.equal(r.after, r.before);
});

for (const kind of ['missing-file', 'missing-field', 'invalid-array', 'malformed-yaml', 'non-list-yaml']) {
  test('rejects unreadable bundle patches atomically: ' + kind, t => {
    const f = fixture(t), name = '@deepseek-ai/broken';
    const dir = f.put(name);
    if (kind === 'missing-file') fs.unlinkSync(join(dir, 'cordis.patch.yml'));
    if (kind === 'missing-field' || kind === 'invalid-array') {
      fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: {
        bundle: kind === 'missing-field' ? {} : { patch: ['./cordis.patch.yml', 7] },
      } }));
    }
    if (kind === 'malformed-yaml') fs.writeFileSync(join(dir, 'cordis.patch.yml'), '[unterminated');
    if (kind === 'non-list-yaml') fs.writeFileSync(join(dir, 'cordis.patch.yml'), 'not: a-list');
    const result = f.run([name]);
    assert.equal(result.status, 1, kind);
    assert.equal(result.after, result.before);
    assert.doesNotMatch(result.stdout, /已启用/);
  });
}
for (const patches of [[], ['./first.yml', './second.yml']]) {
  test('accepts the runtime legal patch array: ' + JSON.stringify(patches), t => {
    const f = fixture(t), name = '@deepseek-ai/array';
    const dir = f.put(name);
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: patches } } }));
    fs.writeFileSync(join(dir, 'first.yml'), '[]\n');
    // Loader expressions are parsed data, never evaluated while enabling.
    fs.writeFileSync(join(dir, 'second.yml'), '- id: test\n  config: !!js "(() => { throw new Error(\'must not execute\'); })()"\n');
    const beforePatch = fs.readFileSync(join(dir, 'second.yml'), 'utf8');
    const result = f.run([name]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.after).dsh.profile.bundles, [name]);
    assert.equal(fs.readFileSync(join(dir, 'second.yml'), 'utf8'), beforePatch);
  });
}
