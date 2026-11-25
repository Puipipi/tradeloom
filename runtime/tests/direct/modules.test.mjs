// Run with the locked rootfs loader and --test-isolation=none, without preload.
// The actual production helper is installed once after all test imports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire, registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPaths } from '../../direct/paths.mjs';
import { installModules, nativeDescriptorAlias } from '../../direct/modules.mjs';

const root = fs.mkdtempSync(`${os.tmpdir()}/dsh-module-load-`);
const outside = fs.mkdtempSync(`${os.tmpdir()}/dsh-module-outside-`);
const require = createRequire(import.meta.url);
const fakeNative = 'not an ELF addon';
const nativeFakes = Array.from({ length: 128 }, (_, i) => write(`opt/dsh/node_modules/fixture/invalid-${i}.node`, fakeNative));
const inventory = { schema: 1, files: Object.fromEntries(nativeFakes.map((file) =>
  [file.slice(root.length), createHash('sha256').update(fakeNative).digest('hex')])) };
const hooks = installModules(createPaths(root), inventory);
after(() => {
  hooks.deregister();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
function write(name, content) {
  const file = `${root}/${name}`;
  fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('normal ESM, CJS, JSON and Node package type/attributes remain intact', async () => {
  assert.equal((await import(pathToFileURL(write('plain.mjs', 'export default 42;')))).default, 42);
  assert.equal(require(write('plain.cjs', 'module.exports = 43;')), 43);
  const json = write('data.json', '{"answer":44}');
  assert.equal((await import(pathToFileURL(json), { with: { type: 'json' } })).default.answer, 44);
  assert.equal(require(json).answer, 44);
  await assert.rejects(import(pathToFileURL(json)), { code: 'ERR_IMPORT_ATTRIBUTE_MISSING' });
  write('esm/package.json', '{"type":"module"}');
  assert.equal((await import(pathToFileURL(write('esm/index.js', 'export default 45;')))).default, 45);
  write('cjs/package.json', '{"type":"commonjs"}');
  assert.equal(require(write('cjs/index.js', 'module.exports = 46;')), 46);
});

test('ambiguous JS, TypeScript, query identity and normal require cache still work', async () => {
  assert.equal((await import(pathToFileURL(write('ambiguous.js', 'export default 47;')))).default, 47);
  assert.equal((await import(pathToFileURL(write('typed.mts', 'const answer: number = 48; export default answer;')))).default, 48);
  const queried = pathToFileURL(write('spaces and #/query.mjs', 'export default import.meta.url;'));
  assert.equal((await import(`${queried.href}?version=1#fragment`)).default, `${queried.href}?version=1#fragment`);
  const cached = write('cached.cjs', 'module.exports = {};');
  assert.equal(require(cached), require(cached));
});

test('load rechecks a path replaced after successful resolve, for ESM and CJS', async () => {
  for (const extension of ['mjs', 'cjs']) {
    const file = write(`between-resolve-load.${extension}`, extension === 'mjs' ? 'export default 1;' : 'module.exports=1;');
    const target = `${outside}/outside.${extension}`;
    fs.writeFileSync(target, 'globalThis.__directLoadOutsideExecuted=true;');
    const saved = `${file}.saved`;
    let switched = false;
    const mutation = registerHooks({
      load(url, context, nextLoad) {
        if (url !== pathToFileURL(file).href) return nextLoad(url, context);
        switched = true;
        fs.renameSync(file, saved);
        fs.symlinkSync(target, file);
        try { return nextLoad(url, context); }
        finally { fs.unlinkSync(file); fs.renameSync(saved, file); }
      },
    });
    try {
      if (extension === 'mjs') await assert.rejects(import(pathToFileURL(file)), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
      else assert.throws(() => require(file), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
      assert(switched, 'the first resolve succeeded before the path was replaced');
      assert.equal(globalThis.__directLoadOutsideExecuted, undefined);
    } finally { mutation.deregister(); }
  }
});

test('the executed CJS source is from the verified FD, not a second path read', () => {
  const file = write('descriptor-source.cjs', 'module.exports = "verified descriptor";');
  const original = fs.readFileSync;
  let secondReads = 0;
  fs.readFileSync = function(path, options) {
    const name = path instanceof URL ? fileURLToPath(path) : path;
    if (name === file) {
      secondReads++;
      const substituted = 'globalThis.__directSecondReadExecuted = true; module.exports = "unverified second read";';
      return options === 'utf8' ? substituted : Buffer.from(substituted);
    }
    return original(path, options);
  };
  try {
    assert.equal(require(file), 'verified descriptor');
    assert(secondReads > 0, 'locked CJS default load made the controlled second path read');
    assert.equal(globalThis.__directSecondReadExecuted, undefined);
  } finally { fs.readFileSync = original; }
});

test('source changed during the next load step is refused before evaluation', async () => {
  const file = write('changed-during-load.mjs', 'globalThis.__directChangedSourceExecuted = true; export default 1;');
  const mutation = registerHooks({
    load(url, context, nextLoad) {
      if (url !== pathToFileURL(file).href) return nextLoad(url, context);
      const result = nextLoad(url, context);
      // A hook after ours can already execute arbitrary JS. This test does not
      // claim to sandbox it; it verifies a second guard around the load chain.
      fs.appendFileSync(file, '\n// changed');
      return result;
    },
  });
  // Install the exact helper again so this guard surrounds the controlled
  // next-load mutation and sees the changed inode metadata before compilation.
  const priorDlopen = process.dlopen;
  const outer = installModules(createPaths(root));
  try {
    await assert.rejects(import(pathToFileURL(file)), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
    assert.equal(globalThis.__directChangedSourceExecuted, undefined);
  } finally { outer.deregister(); mutation.deregister(); process.dlopen = priorDlopen; }
});

test('native descriptor aliases are distinct, equivalent and have a hard length bound', () => {
  const file = write('alias-target.txt', 'one open inode');
  const fd = fs.openSync(file, 'r');
  try {
    const aliases = new Set();
    for (const thread of [0, 1, 2, 255, Number.MAX_SAFE_INTEGER]) for (const serial of [1n, 2n, 3n, 255n, 65536n]) {
      const alias = nativeDescriptorAlias(fd, thread, serial);
      assert(alias.length <= 1024);
      assert.equal(fs.realpathSync.native(alias), file);
      aliases.add(alias);
    }
    assert.equal(aliases.size, 25);
    assert.throws(() => nativeDescriptorAlias(fd, 0, 2n ** 600n), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
    assert.throws(() => nativeDescriptorAlias(fd, Number.MAX_SAFE_INTEGER + 1, 1n), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  } finally { fs.closeSync(fd); }
});

test('unlisted and modified native bytes are refused without changing files', () => {
  const unlisted = write('opt/dsh/node_modules/user/unlisted.node', fakeNative);
  assert.throws(() => process.dlopen({ exports: {} }, unlisted), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  fs.writeFileSync(nativeFakes[0], fakeNative.replace('n', 'N'));
  assert.throws(() => process.dlopen({ exports: {} }, nativeFakes[0]), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  assert.equal(fs.readFileSync(nativeFakes[0], 'utf8'), fakeNative.replace('n', 'N'));
  fs.writeFileSync(nativeFakes[0], fakeNative);
});

test('native filenames require primitive strings before coercion or other argument effects', () => {
  let effects = 0;
  const module = { get exports() { effects++; throw new Error('exports must not be read'); } };
  const flags = { [Symbol.toPrimitive]() { effects++; throw new Error('flags must not be coerced'); } };
  const inputs = [undefined, null, true, 1, 1n, Symbol('filename'),
    Buffer.from(nativeFakes[0]), new String(nativeFakes[0]), pathToFileURL(nativeFakes[0]),
    [nativeFakes[0]], () => nativeFakes[0],
    { toString() { effects++; return nativeFakes[0]; } },
    { [Symbol.toPrimitive]() { effects++; return nativeFakes[0]; } },
    new Proxy({}, { get() { effects++; throw new Error('filename properties must not be read'); } }),
  ];
  for (const filename of inputs) {
    assert.throws(() => process.dlopen(module, filename, flags), {
      name: 'TypeError', message: 'process.dlopen filename must be a string',
    });
  }
  assert.equal(effects, 0, 'rejection must not run filename/module/flags callbacks');
});

test('repeated failed native loads release every temporary descriptor', () => {
  const before = fs.readdirSync('/proc/self/fd').length;
  for (const file of nativeFakes) assert.throws(() => process.dlopen({ exports: {} }, file), { code: 'ERR_DLOPEN_FAILED' });
  assert.throws(() => process.dlopen({ exports: {} }, nativeFakes[0]), { code: 'ERR_DLOPEN_FAILED' });
  assert.equal(fs.readdirSync('/proc/self/fd').length, before);
});
