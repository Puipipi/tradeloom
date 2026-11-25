// Real bundled addons, through the production-generated wrapper and FD guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.env.DSH_GO_DIRECT_ROOTFS;
assert(root, 'production direct wrapper required');
const base = fs.mkdtempSync(`${root}/tmp/direct-native-`);
const outside = fs.mkdtempSync('/tmp/direct-native-outside-');
const arch = process.arch;
const addonPaths = [
  [`@deepseek-ai/node-addon-system-linux-${arch}/bin/glibc/system.node`, 'tryLock'],
  [`node-pty/prebuilds/linux-${arch}/pty.node`, 'fork'],
  [`@koromix/koffi-linux-${arch}/linux_${arch}/koffi.node`, 'load'],
  [`node-addon-require-builtin-linux-${arch}-gnu/prebuilt/linux-${arch}-gnu-napi-v9.node`, 'requireBuiltin'],
  [`@img/sharp-linux-${arch}/lib/sharp-linux-${arch}-0.35.5.node`, 'metadata'],
  [`sherpa-onnx-linux-${arch}/sherpa-onnx.node`, 'createOnlineRecognizer'],
];
const report = { node: process.version, arch, rows: [] };
function guest(file, args) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  // Different addons in one process catch reuse of a dlopen pathname such as
  // /proc/self/fd/21 after closing the previous addon descriptor.
  for (const [relative, symbol] of addonPaths) {
    const file = `${root}/opt/dsh/node_modules/${relative}`;
    const exports = require(file);
    assert.equal(typeof exports[symbol], 'function', `${relative}: ${symbol}`);
    report.rows.push({ relative, symbol, loaded: true });
  }
  const sharp = require(`${root}/opt/dsh/node_modules/sharp`);
  const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 3); assert.equal(metadata.height, 2);
  report.sharpImage = { width: metadata.width, height: metadata.height, bytes: image.length };
  const workerFile = `${base}/native-worker.mjs`;
  fs.writeFileSync(workerFile, `import { createRequire } from 'node:module';
import { parentPort, workerData, threadId } from 'node:worker_threads';
const require = createRequire(import.meta.url);
const rows = workerData.map(([file, symbol]) => {
  delete require.cache[require.resolve(file)];
  return { symbol, loaded: typeof require(file)[symbol] === 'function' };
});
parentPort.postMessage({ pid: process.pid, threadId, rows });\n`);
  const workerAddons = [addonPaths[0], addonPaths[4]].map(([relative, symbol]) => [`${root}/opt/dsh/node_modules/${relative}`, symbol]);
  async function worker(reverse) {
    const inputs = reverse ? [...workerAddons].reverse() : workerAddons;
    return new Promise((resolve, reject) => {
      const value = new Worker(pathToFileURL(workerFile), { workerData: [...inputs, ...inputs] });
      let message;
      value.on('message', (row) => { message = row; });
      value.on('error', reject);
      value.on('exit', (code) => {
        if (code !== 0 || !message?.rows.every((row) => row.loaded)) reject(new Error(JSON.stringify({ code, message })));
        else resolve(message);
      });
    });
  }
  report.workers = [await worker(false)];
  const descriptorsAfterWarmWorker = fs.readdirSync('/proc/self/fd').length;
  report.workers.push(await worker(true), ...await Promise.all([worker(false), worker(true)]));
  assert.equal(new Set(report.workers.map((row) => row.threadId)).size, 4);
  assert(report.workers.every((row) => row.pid === process.pid));
  const descriptorsAfterWorkers = fs.readdirSync('/proc/self/fd').length;
  assert(descriptorsAfterWorkers <= descriptorsAfterWarmWorker + 2, 'native loader must not retain descriptors after worker teardown');
  report.workerDescriptors = { afterWarmWorker: descriptorsAfterWarmWorker, afterAllWorkers: descriptorsAfterWorkers };
  // Delete the Node module cache to exercise another real dlopen in the main
  // thread after workers have closed their descriptors and unloaded addons.
  for (const [file, symbol] of [...workerAddons].reverse()) {
    delete require.cache[require.resolve(file)];
    assert.equal(typeof require(file)[symbol], 'function');
  }
  const sourceAddon = `${root}/opt/dsh/node_modules/${addonPaths[0][0]}`;
  const external = `${outside}/system.node`;
  fs.copyFileSync(sourceAddon, external);
  const externalAlias = `${base}/external.node`;
  fs.symlinkSync(external, externalAlias);
  assert.throws(() => process.dlopen({ exports: {} }, externalAlias), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  const source = `${base}/source.node`; const alias = `${base}/alias.node`;
  fs.copyFileSync(sourceAddon, source);
  report.argumentBoundaries = [];
  for (const [location, file] of [['bundled', sourceAddon], ['unlisted', source]]) {
    let coercions = 0;
    const inputs = [
      ['buffer', Buffer.from(file)], ['string-object', new String(file)],
      ['to-string-object', { toString() { coercions++; return file; } }],
      ['changing-primitive', { [Symbol.toPrimitive]() { coercions++; return coercions === 1 ? sourceAddon : source; } }],
      ['url-object', pathToFileURL(file)],
    ];
    for (const [kind, filename] of inputs) {
      const module = { exports: {} };
      assert.throws(() => process.dlopen(module, filename), {
        name: 'TypeError', message: 'process.dlopen filename must be a string',
      });
      assert.deepEqual(Object.keys(module.exports), []);
      assert.equal(coercions, 0, 'non-string filenames must never be coerced');
      report.argumentBoundaries.push({ location, kind, rejected: true, coercions });
    }
  }
  // Only the filename argument chooses a library. Preserve a documented
  // numeric flag and never substitute a module object's own filename field.
  const explicit = { exports: {}, get filename() { throw new Error('module.filename must not select a native library'); } };
  process.dlopen(explicit, sourceAddon, osConstants.dlopen.RTLD_NOW);
  assert.equal(typeof explicit.exports.tryLock, 'function');
  report.explicitNumericFlagLoaded = true;
  assert.throws(() => process.dlopen({ exports: {} }, source), { code: 'DSH_DIRECT_MODULE_IDENTITY' },
    'even an identical user-profile copy is not a bundled native addon grant');
  require.resolve(source); // only prime Node's resolver, never execute this copy
  guest('/bin/ln', [source, alias]);
  assert(fs.realpathSync(source).startsWith(`${root}/root/.l2s/`));
  assert.throws(() => require(source), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  assert.throws(() => process.dlopen({ exports: {} }, alias), { code: 'DSH_DIRECT_MODULE_IDENTITY' });
  assert.equal(Buffer.compare(Buffer.from(guest('/usr/bin/sha256sum', [alias]).split(' ')[0]),
    Buffer.from(guest('/usr/bin/sha256sum', [sourceAddon]).split(' ')[0])), 0);
  report.externalRefused = true; report.warmL2sRefused = true; report.guestBytesPreserved = true;
} finally {
  guest('/bin/rm', ['-rf', '--', base]);
  fs.rmSync(outside, { recursive: true, force: true });
}
assert.equal(fs.readdirSync(`${root}/root/.l2s`).length, 0);
console.log(JSON.stringify(report, null, 2));
