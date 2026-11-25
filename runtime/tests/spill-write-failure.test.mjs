import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base, 'cordis/lib/index.js')));
const { LocalSpillStore, sessionDir } = await import(pathToFileURL(join(base, 'dsh-spill-local/lib/index.js')));
const execute = promisify(execFile), child = fileURLToPath(new URL('./fixtures/spill-file-limit.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux' ? 'real RLIMIT_FSIZE/SIGXFSZ fixture requires Linux' : false };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spill-write-failure-')), ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 });
  const save = (content, sessionId = 'fixture-session') => ctx.spillStore.saveText({
    owner: { sessionId }, source: { kind: 'tool', toolName: 'fixture', callId: 'ordinary', label: 'result' },
    suggestedName: 'result.txt', content,
  });
  return { root, ctx, save };
}

async function limited(root, blocks, size = 4096) {
  // All variable values are positional arguments, never interpolated shell code.
  const { stdout, stderr } = await execute('bash', ['-c', 'ulimit -S -f "$1"; shift; exec "$@"', '_',
    String(blocks), process.execPath, child, root, String(size)], { env: process.env });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

for (const blocks of [0, 1]) {
  test(`real ${blocks}-block EFBIG removes only its unpublished spill file`, linux, async t => {
    const f = await fixture(t), previous = await f.save('earlier complete'), other = await f.save('other session', 'other-session');
    const dir = sessionDir(f.root, 'fixture-session'), sentinel = join(dir, 'sentinel.txt');
    await writeFile(sentinel, 'fixed sentinel');
    const result = await limited(f.root, blocks);
    assert.equal(result.error.code, 'EFBIG');
    assert.equal(result.saved, undefined);
    assert.equal(await readFile(previous.locator, 'utf8'), 'earlier complete');
    assert.equal(await readFile(other.locator, 'utf8'), 'other session');
    assert.equal(await readFile(sentinel, 'utf8'), 'fixed sentinel');
    const recovered = await f.save('recovered after failure');
    assert.equal(await readFile(recovered.locator, 'utf8'), 'recovered after failure');
    const ownedFailures = result.files.filter(file => file.name.endsWith('-limited.txt'));
    t.diagnostic(JSON.stringify({ blocks, error: result.error.code, unpublished: ownedFailures }));
    assert.deepEqual(ownedFailures, []);
    assert.deepEqual((await readdir(dir)).sort(), [basename(previous.locator), basename(recovered.locator), 'sentinel.txt'].sort());
  });
}

test('a successful empty save under zero limit keeps its published file', linux, async t => {
  const f = await fixture(t), result = await limited(f.root, 0, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.saved.bytes, 0);
  assert.equal(await readFile(result.saved.locator, 'utf8'), '');
  assert.deepEqual(result.files, [{ name: basename(result.saved.locator), size: 0 }]);
});

test('successful Unicode saves preserve content, bytes and distinct locators', async t => {
  const f = await fixture(t), content = '你好🙂\n';
  const first = await f.save(content), second = await f.save(content);
  assert.notEqual(first.locator, second.locator);
  for (const saved of [first, second]) {
    assert.equal(saved.bytes, Buffer.byteLength(content));
    assert.equal(await readFile(saved.locator, 'utf8'), content);
  }
});

test('failure before exclusive creation does not remove the blocking existing file', async t => {
  const f = await fixture(t), blocker = join(f.root, 'blocked');
  await writeFile(blocker, 'existing data');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LocalSpillStore, { root: join(blocker, 'spill'), cleanupPeriodDays: 0 });
  await assert.rejects(ctx.spillStore.saveText({
    owner: { sessionId: 'fixture-session' }, source: { kind: 'tool', toolName: 'fixture', callId: 'blocked', label: 'result' },
    suggestedName: 'result.txt', content: 'not written',
  }), error => error.code === 'ENOTDIR');
  assert.equal(await readFile(blocker, 'utf8'), 'existing data');
});
