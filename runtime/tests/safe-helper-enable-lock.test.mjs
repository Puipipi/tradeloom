import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt', import.meta.url), 'utf8');
const script = source.match(/const val PLUGINS_SCRIPT = """([\s\S]*?)"""/)[1];

function run(t, { uninstall = false, names = ['local-plugin'] } = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), 'safe-enable-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(join(home, 'profiles/web'), { recursive: true });
  const file = join(home, 'profiles/web/package.json');
  const manifest = { dependencies: { 'local-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  fs.writeFileSync(file, JSON.stringify(manifest));
  // Installed means resolvable package metadata, not only a dependency entry.
  for (const name of ['local-plugin', '@deepseek-ai/dsh-web-app']) {
    const dir = join(home, 'profiles/web/node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    fs.writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n');
  }
  if (uninstall) fs.writeFileSync(file + '.lock', String(process.pid));
  let completed = false;
  let stderr = '';
  let stdout = '';
  let status = 0;
  const exit = {};
  // Schedule an existing writer's commit immediately before the helper acquires
  // the real file lock. All manifest reads/writes use the actual filesystem.
  const scheduledFs = { ...fs, symlinkSync(target, link, ...args) {
    if (uninstall && link === file + '.lock' && !completed) {
      assert.ok(fs.existsSync(file + '.lock'));
      delete manifest.dependencies['local-plugin'];
      fs.writeFileSync(file, JSON.stringify(manifest));
      fs.unlinkSync(file + '.lock');
      completed = true;
    }
    return fs.symlinkSync(target, link, ...args);
  } };
  try {
    runInNewContext(script, {
      require: name => {
        if (name === 'fs') return scheduledFs;
        if (name === 'module') return { createRequire: anchor => {
          const local = createRequire(anchor);
          const selected = name => name === '@deepseek-ai/dsh-app-boot'
            ? { // Pure lock tests isolate boot parsing; the *-live suite uses the real runtime parser.
                bundlePatchFiles: bundle => typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch,
                loadOverlayPatches: (_, file) => { fs.readFileSync(file, 'utf8'); return []; },
              } : local(name);
          selected.resolve = local.resolve;
          return selected;
        } };
        return require(name);
      },
      process: { pid: process.pid, argv: ['node', 'helper', 'enable', ...names], env: { DSH_HOME: home },
        stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
        exit: code => { status = code; throw exit; }, kill: process.kill.bind(process) },
    });
  } catch (error) { if (error !== exit) throw error; }
  assert.throws(() => fs.lstatSync(file + '.lock'), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(join(home, 'profiles/web')).filter(name => name.startsWith('.dsh-helper-lock-')), []);
  return { status, stderr, stdout, completed, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('enable refuses a plugin removed by the writer that held the manifest lock', t => {
  const result = run(t, { uninstall: true });
  assert.equal(result.completed, true);
  assert.equal(result.status, 1, 'must reject the now-uninstalled package instead of reporting success');
  assert.match(result.stderr, /local-plugin.*没有安装/);
  assert.doesNotMatch(result.stdout, /已启用/);
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
  assert.deepEqual(result.manifest.dependencies, {});
});

test('enable preserves installed packages and permits bundled official components', t => {
  const result = run(t, { names: ['local-plugin', '@deepseek-ai/dsh-web-app'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'local-plugin', '@deepseek-ai/dsh-web-app']);
});

test('enable with any missing package leaves the entire bundle selection unchanged', t => {
  const result = run(t, { names: ['local-plugin', 'missing-plugin'] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
});


test('real missing-package exit releases the manifest lock without changing its bytes', t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'safe-enable-exit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(join(home, 'profiles/web'), { recursive: true });
  const file = join(home, 'profiles/web/package.json');
  const before = '{ "dependencies": {}, "dsh": { "profile": { "bundles": [] } } }\n';
  fs.writeFileSync(file, before);
  const helper = join(home, 'helper.cjs');
  fs.writeFileSync(helper, script);
  const result = spawnSync(process.execPath, [helper, 'enable', 'missing-plugin'], {
    encoding: 'utf8', env: { DSH_HOME: home },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /missing-plugin.*没有安装/);
  assert.doesNotMatch(result.stdout, /已启用/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => fs.lstatSync(file + '.lock'), { code: 'ENOENT' }, 'real process.exit must not leave a lock name');
  assert.deepEqual(fs.readdirSync(join(home, 'profiles/web')).filter(name => name.startsWith('.dsh-helper-lock-')), []);
});
