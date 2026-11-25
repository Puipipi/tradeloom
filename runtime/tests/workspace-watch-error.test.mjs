// Real rc1 filesystem/service with controlled watcher failure and metadata boundary.
// DSH_PREFIX=/path/to/patched-rc1 node --test runtime/tests/workspace-watch-error.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = name => import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { LocalFileSystem } = await load('dsh-fs-local');
const { WorkspaceFiles } = await load('dsh-api-workspace-files');
async function fixture(t, { uncancellableStat = false, setupError } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-watch-error-'));
  const ctx = new Context();
  const control = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers(), stopped = Promise.withResolvers();
  let iterator, emit, held = false, unwatches = 0;
  t.after(async () => { release.resolve(); control.abort(); await iterator?.return().catch(() => {}); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'file.txt'), 'synthetic');
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const watch = ctx.fs.watch.bind(ctx.fs), stat = ctx.fs.stat.bind(ctx.fs);
  t.mock.method(ctx.fs, 'watch', async (target, callback, signal) => {
    emit = callback;
    signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    const unwatch = await watch(target, callback, signal);
    if (setupError) callback(setupError);
    return async () => { unwatches++; await unwatch(); };
  });
  t.mock.method(ctx.fs, 'stat', async (target, signal) => {
    if (held) { entered.resolve(); await release.promise; }
    return stat(target, uncancellableStat ? new AbortController().signal : signal);
  });
  const files = new WorkspaceFiles(ctx, WorkspaceFiles.Config({}));
  iterator = files.changes({ workspaceRoot: root }, 'file.txt', control.signal);
  return { iterator, control, ctx, entered, release, stopped,
    hold: () => { held = true; }, emit: error => emit(error), unwatches: () => unwatches };
}
for (const uncancellableStat of [false, true]) {
  test(`watch failure during metadata read is propagated (stat completes=${uncancellableStat})`, async t => {
    const f = await fixture(t, { uncancellableStat });
    assert.equal((await f.iterator.next()).value.kind, 'ready');
    f.hold(); f.emit();
    const outcome = f.iterator.next().then(value => ({ value }), error => ({ error }));
    await f.entered.promise;
    const error = Object.assign(new Error('synthetic watcher EIO'), { code: 'EIO' });
    f.emit(error);
    f.emit(new Error('second callback cannot replace the first failure'));
    f.release.resolve();
    assert.equal((await outcome).error, error);
    assert.equal(f.unwatches(), 1);
  });
}
for (const dispose of [false, true]) {
  test(`${dispose ? 'service disposal' : 'caller cancellation'} during metadata read ends normally`, async t => {
    const f = await fixture(t);
    assert.equal((await f.iterator.next()).value.kind, 'ready');
    f.hold(); f.emit();
    const outcome = f.iterator.next();
    await f.entered.promise;
    const disposal = dispose ? f.ctx.fiber.dispose() : undefined;
    if (!dispose) f.control.abort();
    await f.stopped.promise;
    f.emit(new Error('late watcher callback after subscription closed'));
    f.release.resolve();
    assert.deepEqual(await outcome, { done: true, value: undefined });
    await disposal;
    assert.equal(f.unwatches(), 1);
  });
}
test('idle watcher failure retains the same error and releases its watcher', async t => {
  const f = await fixture(t);
  assert.equal((await f.iterator.next()).value.kind, 'ready');
  const error = new Error('synthetic idle failure');
  const outcome = f.iterator.next();
  f.emit(error);
  await assert.rejects(outcome, caught => caught === error);
  assert.equal(f.unwatches(), 1);
});
test('setup watcher failure retains the existing remote error contract', async t => {
  const f = await fixture(t, { setupError: new Error('synthetic setup failure') });
  await assert.rejects(f.iterator.next(), error => error.code === 'workspace-file/watch-unsupported');
  assert.equal(f.unwatches(), 1);
});
