import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { LocalFileSystem } = await load('dsh-fs-local');
const { WorkspaceFiles } = await load('dsh-api-workspace-files');
const { SystemPrompt } = await load('dsh-system-prompt');
const { ToolRuntime } = await load('dsh-tools');
const fsTools = await load('dsh-tool-fs');
const { Deque } = await load('dsh-deque');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-observations-'));
  await writeFile(join(root, 'watched.txt'), 'watched\n');
  await writeFile(join(root, 'other.txt'), 'other\n');
  const ctx = new Context();
  const controls = [];
  t.after(async () => {
    for (const { control, iterator } of controls) {
      control.abort();
      await iterator.return();
    }
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  // Exercise the public local service API; no remote session lookup is needed.
  const files = new WorkspaceFiles(ctx, WorkspaceFiles.Config({}));
  fsTools.apply(ctx, fsTools.Config({ write: false, edit: false, readImage: false }));
  const exec = { signal: new AbortController().signal };
  const read = path => ctx.tools.get('read').execute({ file_path: path }, exec);
  const follow = async (path = 'watched.txt') => {
    const control = new AbortController();
    const iterator = files.changes({ workspaceRoot: root }, path, control.signal);
    controls.push({ control, iterator });
    assert.deepEqual(await iterator.next(), { done: false, value: { kind: 'ready' } });
    return { control, iterator };
  };
  return { root, ctx, files, read, follow, controls };
}

function observe(t) {
  const items = [];
  const push = Deque.prototype.pushBack;
  t.mock.method(Deque.prototype, 'pushBack', function (value) {
    if (Array.isArray(value) && typeof value[0]?.targetKey === 'string') items.push(value[0].targetKey);
    return push.call(this, value);
  });
  return items;
}

for (const count of [200, 2000]) {
  test(`slow target consumer does not queue ${count} real unrelated read observations`, async t => {
    const f = await fixture(t), stream = await f.follow(), queued = observe(t);
    for (let i = 0; i < count; i++) assert.equal((await f.read('other.txt')).lines[0].text, 'other');
    const unrelated = queued.length;
    await f.read('watched.txt');
    const change = await stream.iterator.next();
    assert.equal(change.done, false);
    assert.equal(change.value.kind, 'change');
    assert.equal(change.value.change.absolutePath, join(f.root, 'watched.txt'));
    assert.equal(change.value.change.version, (await f.ctx.fs.stat(await f.ctx.fs.resolve('watched.txt'), new AbortController().signal)).version);
    t.diagnostic(JSON.stringify({ reads: count, unrelatedQueued: unrelated, targetQueued: queued.length - unrelated }));
    assert.equal(queued.length - unrelated, 1);
    assert.equal(unrelated, 0);
  });
}

test('independent target streams retain every matching invalidation, without coalescing', async t => {
  const f = await fixture(t), first = await f.follow(), second = await f.follow('other.txt');
  const queued = observe(t);
  await f.read('watched.txt');
  await f.read('other.txt');
  await f.read('watched.txt');
  for (const stream of [first, second, first]) {
    const change = await stream.iterator.next();
    assert.equal(change.value.kind, 'change');
    assert.equal(change.value.change.absolutePath, join(f.root, stream === first ? 'watched.txt' : 'other.txt'));
  }
  t.diagnostic(`matching events enqueued=${queued.length}`);
  assert.equal(queued.length, 3);
});

test('events while target resolution is pending remain observable after ready', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const resolveTarget = f.ctx.fs.resolve.bind(f.ctx.fs);
  let gated = false;
  t.mock.method(f.ctx.fs, 'resolve', async function (path, options) {
    const target = await resolveTarget(path, options);
    if (path === 'watched.txt' && options?.cwd === f.root && !gated) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
    return target;
  });
  const queued = observe(t), starting = f.follow();
  await entered.promise;
  try {
    await f.read('other.txt');
    await f.read('watched.txt');
  } finally {
    release.resolve();
  }
  const stream = await starting;
  const change = await stream.iterator.next();
  assert.equal(change.value.change.absolutePath, join(f.root, 'watched.txt'));
  assert.equal(queued.length, 2, 'unknown target preserves original pre-resolution queue');
});

test('cancellation and pre-aborted subscriptions retain their original completion', async t => {
  const f = await fixture(t), stream = await f.follow(), queued = observe(t);
  stream.control.abort();
  assert.deepEqual(await stream.iterator.next(), { done: true, value: undefined });
  await f.read('watched.txt');
  assert.equal(queued.length, 0);
  const error = new Error('fixture cancellation'), signal = AbortSignal.abort(error);
  const aborted = f.files.changes({ workspaceRoot: f.root }, 'watched.txt', signal);
  await assert.rejects(aborted.next(), caught => caught === error);
});

test('a real symlink alias still matches the same target identity', async t => {
  const f = await fixture(t);
  await symlink(join(f.root, 'watched.txt'), join(f.root, 'alias.txt'));
  const stream = await f.follow(), queued = observe(t);
  const direct = await f.ctx.fs.resolve('watched.txt'), alias = await f.ctx.fs.resolve('alias.txt');
  assert.equal(alias.targetKey, direct.targetKey);
  await f.read('alias.txt');
  const change = await stream.iterator.next();
  assert.equal(change.value.change.absolutePath, join(f.root, 'watched.txt'));
  assert.deepEqual(queued, [direct.targetKey]);
});

test('real outside-directory rejection preserves its error code before watcher setup', async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'workspace-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const iterator = f.files.changes({ workspaceRoot: f.root }, outside, new AbortController().signal);
  await assert.rejects(iterator.next(), error => error.code === 'workspace-file/outside-workspace');
});
