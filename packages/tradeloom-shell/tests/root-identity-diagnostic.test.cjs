const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const prefix = '[UI18_ROOT_IDENTITY_V1]';
const sdk = process.env.TL_ROOT_IDENTITY_SDK;
const entry = process.env.TL_ROOT_IDENTITY_ENTRY;
const root = process.env.TL_ROOT_IDENTITY_TEST_ROOT;
const main = process.env.TL_ROOT_IDENTITY_MAIN;
const enabled = Boolean(sdk && entry && root && main);
const sha = value => createHash('sha256').update(value).digest('hex');

test('actual rc2 boot/reload diagnostic compares identities without changing the Include fence', { skip: !enabled }, async () => {
  assert.equal(typeof registerHooks, 'function', 'the already pinned Electron Node must support public module hooks');
  const req = createRequire(path.join(sdk, 'package.json'));
  assert.equal(req('./package.json').version, '0.2.2-rc.2');
  const canonical = req.resolve('@deepseek-ai/dsh-app-boot');
  const original = await fs.readFile(canonical);
  assert.equal(sha(original), 'a8d2138bb274bd982079df14a615f6c0d5d7589c9faeae81973128a72293b6de');
  const source = await fs.readFile(entry, 'utf8');
  const url = pathToFileURL(canonical).href;
  // Only the precise public app-boot entry is substituted. All of its imports,
  // Cordis, Loader, boot, recompose and disposal execute the actual installed SDK.
  // The second URL below proves diagnostic mechanics, never the live failure cause.
  const hook = registerHooks({ load(target, context, next) {
    if (target.startsWith(url + '?tl-root-identity-test=')) return { format: 'module', source, shortCircuit: true };
    return next(target, context);
  } });
  const actualMain = await fs.readFile(main, 'utf8');
  const start = actualMain.indexOf('const UI18_ROOT_IDENTITY_PREFIX =');
  const end = actualMain.indexOf('function createUi18RootIdentityWriter(', start);
  assert.ok(start > 0 && end > start);
  const parse = new Function(actualMain.slice(start, end) + ';return parseUi18RootIdentityReceipt;')();
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith(prefix)) { lines.push(chunk.trim()); return true; }
    return write.call(this, chunk, ...args);
  };
  const contexts = [];
  try {
    await fs.mkdir(root, { recursive: true });
    const config = path.join(root, 'cordis.yml');
    await fs.writeFile(config, '[]\n', { flag: 'wx' });
    const first = await import(url + '?tl-root-identity-test=first');
    const ctx = await first.boot('dsh', config); contexts.push(ctx);
    assert.equal(lines.length, 1, 'boot must emit through the existing root identity sink protocol');
    assert.deepEqual(parse(lines.at(-1)), { rootCount: 1, moduleCount: 1, rootIncludePresent: true, ownerRootMatchesBootRoot: true, appBootModuleInstanceMatches: true });
    await first.reconcileProfilePatches(ctx, [], 'dsh');
    assert.equal(lines.length, 2, 'successful reload also reports the original get result');
    assert.equal(parse(lines.at(-1)).rootIncludePresent, true);
    const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href);
    const stranger = new Context(); contexts.push(stranger);
    const missing = { name: 'Error', message: 'dsh: profile reload requires the root Include entry' };
    await assert.rejects(first.reconcileProfilePatches(stranger, [], 'dsh'), missing);
    assert.deepEqual(parse(lines.at(-1)), { rootCount: 1, moduleCount: 1, rootIncludePresent: false, ownerRootMatchesBootRoot: false, appBootModuleInstanceMatches: true });
    const diagnostic = process[Symbol.for('tradeloom.root-identity-diagnostic.v1')];
    assert.ok(diagnostic.firstRoot instanceof WeakRef);
    // Deterministically model a collected referent at the diagnostic-only seam;
    // do not replace a Context, Include, reload result or authority check.
    Object.defineProperty(diagnostic.firstRoot, 'deref', { value: () => undefined, configurable: true });
    try {
      await assert.rejects(first.reconcileProfilePatches(stranger, [], 'dsh'), missing);
      assert.deepEqual(parse(lines.at(-1)), { rootCount: 1, moduleCount: 1, rootIncludePresent: false });
    } finally { delete diagnostic.firstRoot.deref; }
    const second = await import(url + '?tl-root-identity-test=second');
    await assert.rejects(second.reconcileProfilePatches(ctx, [], 'dsh'), missing);
    assert.deepEqual(parse(lines.at(-1)), { rootCount: 1, moduleCount: 2, rootIncludePresent: false, ownerRootMatchesBootRoot: true, appBootModuleInstanceMatches: false });
    const other = await second.boot('dsh', config); contexts.push(other);
    assert.deepEqual(parse(lines.at(-1)), { rootCount: 2, moduleCount: 2, rootIncludePresent: true }, 'multiple roots omit ambiguous comparisons');
    for (const label of ['third', 'fourth']) {
      const observed = await import(url + '?tl-root-identity-test=' + label);
      const extra = await observed.boot('dsh', config); contexts.push(extra);
    }
    assert.deepEqual(parse(lines.at(-1)), { rootCount: 3, moduleCount: 3, rootIncludePresent: true }, 'both counters saturate without leaking context/module identities');
    // A diagnostic write failure must neither fail a valid reload nor replace the
    // exact existing rejection for an unregistered context.
    const capture = process.stdout.write;
    let failedWrites = 0;
    process.stdout.write = function (chunk, ...args) { if (typeof chunk === 'string' && chunk.startsWith(prefix)) { failedWrites++; throw new Error('controlled diagnostic sink failure'); } return capture.call(this, chunk, ...args); };
    try {
      await first.reconcileProfilePatches(ctx, [], 'dsh');
      await assert.rejects(first.reconcileProfilePatches(stranger, [], 'dsh'), missing);
    } finally { process.stdout.write = capture; }
    for (let i = 0; i < 20; i++) await assert.rejects(first.reconcileProfilePatches(stranger, [], 'dsh'), missing);
    assert.equal(failedWrites, 2, 'successful and rejected reloads both attempt the diagnostic sink');
    assert.equal(lines.length + failedWrites, 16, 'producer budget includes failed writes');
    for (const line of lines) {
      const value = parse(line);
      assert.ok(value, 'actual unchanged Main whitelist accepts every receipt');
      assert.ok(Buffer.byteLength(line) < 512);
      assert.ok(!line.includes(root) && !line.includes('cordis.yml') && !line.includes('controlled diagnostic'));
      assert.equal(parse(prefix + JSON.stringify({ ...value, stack: 'not permitted' })), undefined);
      assert.equal(parse(prefix + JSON.stringify({ ...value, rootCount: 4 })), undefined);
    }
    assert.match(source, /new WeakRef\(ctx\)/, 'diagnostics must not retain the boot root strongly');
    assert.equal(source.match(/const bootstrapIncludes = \/\* @__PURE__ \*\/ new WeakMap\(\);/g)?.length, 1);
    const observer = source.slice(source.indexOf('function reportRootIdentity('), source.indexOf('const userPatchesSchema'));
    assert.ok(!observer.includes('bootstrapIncludes.get'), 'observer must use the original lookup result without repeating the Include lookup');
    console.log(JSON.stringify({ phase: 'root-identity-diagnostic-complete', actualSdk: true, controlledSecondModule: true, contexts: contexts.length, receipts: lines.length, liveCauseProved: false }));
  } finally {
    process.stdout.write = write;
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    hook.deregister();
    console.log(JSON.stringify({ phase: 'root-identity-diagnostic-disposed', pid: process.pid, parentPid: process.ppid, nodeVersion: process.versions.node, controlledContextsDisposed: true }));
  }
});
