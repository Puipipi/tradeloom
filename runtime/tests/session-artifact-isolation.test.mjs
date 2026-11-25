import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

let modules;
async function runtime() {
  if (!modules) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to the runtime under test');
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    modules = Promise.all(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-storage',
      'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-session-persistence',
      'dsh-session-format-v2-to-v3'].map(load));
  }
  return modules;
}
async function tree(path) {
  const result = {};
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        result[`${name}/`] = null;
        await visit(join(dir, entry.name), `${name}/`);
      } else result[name] = (await fs.readFile(join(dir, entry.name))).toString('hex');
    }
  }
  await visit(path);
  return result;
}
async function fixture(t, compression, ids = ['good', 'bad']) {
  const [{ Context }, { Session }, jsonl, { Storage }, json, domain, { WorkspaceRegistry }, errors] = await runtime();
  const root = await fs.mkdtemp(join(tmpdir(), 'session-artifact-isolation-'));
  const cwd = join(root, 'workspace');
  const store = join(root, 'sessions');
  await fs.mkdir(cwd);
  const contexts = [];
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const writer = new Context();
  contexts.push(writer);
  await jsonl.apply(writer, { root: store, compression, listConcurrency: 2 });
  const paths = {};
  for (const id of ids) {
    const header = Session.create(id, undefined, { ...Session.create(id).header, cwd }).header;
    const handle = await writer.sessionPersistence.create(header);
    await handle.flush();
    await handle.close();
    paths[id] = (await writer.sessionPersistence.stat(id)).location.path;
  }
  await writer.fiber.dispose();
  async function reader() {
    const ctx = new Context();
    contexts.push(ctx);
    const warnings = [];
    ctx.logger.exporter({ colors: 0, export: message => {
      if (message.type === 'warn') warnings.push(message.args.map(String).join(' '));
    } });
    await jsonl.apply(ctx, { root: store, compression, listConcurrency: 2 });
    return { ctx, warnings };
  }
  async function workspace(ctx) {
    await ctx.plugin(Storage).await();
    await ctx.plugin(json, { root: join(root, 'storages') }).await();
    await ctx.plugin(domain, { backend: 'json' }).await();
    await ctx.plugin(WorkspaceRegistry).await();
  }
  return { root, cwd, store, paths, reader, workspace, errors };
}

for (const compression of ['none', 'zstd']) {
  test(`${compression}: a flat legacy file does not hide valid siblings or prime strict checks`, async t => {
    const f = await fixture(t, compression);
    const flat = join(dirname(dirname(f.paths.good)), compression === 'zstd' ? 'old.jsonl.zstd' : 'old.jsonl');
    await fs.copyFile(f.paths.bad, flat);
    const before = await tree(f.store);
    const { ctx, warnings } = await f.reader();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(row => row.header.id).sort(), ['bad', 'good']);
    await f.workspace(ctx);
    assert.ok(warnings.some(line => line.includes(flat)));
    assert.deepEqual(await tree(f.store), before);
    await assert.rejects(ctx.sessionPersistence.stat('good'), error =>
      error instanceof f.errors.SessionFormatUnsupportedError && /flat-file layout/.test(error.message));
    // Explicit fixture repair after the non-mutating checks must permit the old strict retry.
    await fs.unlink(flat);
    assert.equal((await ctx.sessionPersistence.stat('good')).header.id, 'good');
  });

  test(`${compression}: mixed-encoding entry is isolated without caching a strict success`, async t => {
    const f = await fixture(t, compression);
    const bytes = await fs.readFile(f.paths.bad);
    const opposite = compression === 'zstd' ? f.paths.bad.slice(0, -5) : `${f.paths.bad}.zstd`;
    await fs.writeFile(opposite, compression === 'zstd' ? zstdDecompressSync(bytes) : zstdCompressSync(bytes));
    const before = await tree(f.store);
    const { ctx, warnings } = await f.reader();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(row => row.header.id), ['good']);
    await f.workspace(ctx);
    assert.ok(warnings.some(line => line.includes(opposite)));
    assert.deepEqual(await tree(f.store), before);
    await assert.rejects(ctx.sessionPersistence.stat('good'), error =>
      error instanceof f.errors.SessionFormatUnsupportedError && /configured for compression/.test(error.message));
  });

  test(`${compression}: released-v3 listing includes its corpus despite an unrelated flat artifact`, async t => {
    const f = await fixture(t, compression);
    const [, { Session }, , , , , , , { releasedV3SessionFormatCodec }] = await runtime();
    const header = { ...Session.create('good').header, version: 3, cwd: f.cwd, delegationDepth: 0 };
    const encoded = Buffer.from(`${JSON.stringify(releasedV3SessionFormatCodec.encodeHeader(header, 0))}\n`);
    const historical = f.paths.good.replace('session.v4.', 'session.v3.');
    await fs.unlink(f.paths.good);
    await fs.writeFile(historical, compression === 'zstd' ? zstdCompressSync(encoded) : encoded);
    const flat = join(dirname(dirname(historical)), 'unrelated.jsonl');
    await fs.writeFile(flat, 'old unselected file\n');
    const before = await tree(f.store);
    const { ctx } = await f.reader();
    const rows = await ctx.sessionPersistence.list();
    assert.deepEqual(rows.map(row => row.header.id).sort(), ['bad', 'good']);
    const old = rows.find(row => row.header.id === 'good');
    assert.equal(old.formatStatus, 'migration-required');
    assert.equal(old.header.version, 4);
    assert.equal(old.location.path, historical);
    assert.equal(typeof old.revision, 'string');
    await f.workspace(ctx);
    assert.deepEqual(await tree(f.store), before, 'list does not publish a migrated successor');
  });

  test(`${compression}: duplicate physical IDs are all excluded without selecting a winner`, async t => {
    const f = await fixture(t, compression);
    const second = await fixture(t, compression, ['bad']);
    const project = dirname(dirname(second.paths.bad));
    const copied = join(f.store, basename(project));
    await fs.cp(project, copied, { recursive: true });
    const before = await tree(f.store);
    const { ctx, warnings } = await f.reader();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(row => row.header.id), ['good']);
    await f.workspace(ctx);
    assert.ok(warnings.some(line => line.includes('duplicate JSONL session id "bad"') && line.includes(copied)));
    assert.deepEqual(await tree(f.store), before);
    await assert.rejects(ctx.sessionPersistence.open('bad', 'read'), /duplicate JSONL session id/);
  });
}

for (const compression of ['none', 'zstd']) {
  for (const kind of ['bak', 'retired', 'hidden', 'filename-version', 'malformed', 'unsupported', 'directory']) {
    test(`${compression}: isolate ${kind} artifact, preserve bytes and start workspace`, async t => {
      const f = await fixture(t, compression);
      let badPath = f.paths.bad;
      const originalDir = resolve(badPath, '..');
      if (['bak', 'retired', 'hidden'].includes(kind)) {
        const name = { bak: 'bad.bak-2026', retired: '.retired-bad', hidden: '.backup-bad' }[kind];
        const target = join(resolve(originalDir, '..'), name);
        await fs.rename(originalDir, target);
        badPath = join(target, badPath.slice(originalDir.length + 1));
      } else if (kind === 'filename-version') {
        const target = badPath.replace('session.v4.', 'session.v3.');
        await fs.rename(badPath, target);
        badPath = target;
      } else if (kind === 'directory') {
        await fs.unlink(badPath);
        await fs.mkdir(badPath);
      } else {
        const bytes = await fs.readFile(badPath);
        const text = (compression === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8');
        const content = kind === 'malformed' ? '{broken-json\n' : `${JSON.stringify({ ...JSON.parse(text.trim()), version: 999 })}\n`;
        await fs.writeFile(badPath, compression === 'zstd' ? zstdCompressSync(Buffer.from(content)) : content);
        if (kind === 'unsupported') {
          const target = badPath.replace('session.v4.', 'session.v999.');
          await fs.rename(badPath, target);
          badPath = target;
        }
      }
      const before = await tree(f.store);
      const { ctx, warnings } = await f.reader();
      const results = await Promise.allSettled([ctx.sessionPersistence.list(), f.workspace(ctx)]);
      assert.deepEqual(await tree(f.store), before, 'listing never changes original names or bytes');
      assert.equal(results[0].status, 'fulfilled', String(results[0].reason));
      assert.equal(results[1].status, 'fulfilled', String(results[1].reason));
      assert.deepEqual(results[0].value.map(row => row.header.id), ['good']);
      assert.ok(warnings.some(line => line.includes(badPath)), `warning must name ${badPath}: ${warnings.join('\n')}`);
    });
  }
  test(`${compression}: valid dot-prefixed identities remain visible`, async t => {
    const ids = ['good', '.ordinary', '.retired-valid'];
    const f = await fixture(t, compression, ids);
    const { ctx } = await f.reader();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(row => row.header.id).sort(), ids.sort());
    await f.workspace(ctx);
  });
  test(`${compression}: direct identity mismatch stat/open remains corruption`, async t => {
    const f = await fixture(t, compression);
    const bytes = await fs.readFile(f.paths.bad);
    const text = (compression === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8');
    const content = `${JSON.stringify({ ...JSON.parse(text.trim()), id: 'different-id' })}\n`;
    await fs.writeFile(f.paths.bad, compression === 'zstd' ? zstdCompressSync(Buffer.from(content)) : content);
    const { ctx } = await f.reader();
    for (const operation of [() => ctx.sessionPersistence.stat('bad'), () => ctx.sessionPersistence.open('bad', 'read')]) {
      await assert.rejects(operation, error => error instanceof f.errors.SessionPersistenceCorruptionError);
    }
  });
}

test('root ENOTDIR propagates and preaborted list preserves cancellation', async t => {
  const [{ Context }, , jsonl] = await runtime();
  const root = await fs.mkdtemp(join(tmpdir(), 'session-artifact-root-'));
  const file = join(root, 'not-directory');
  await fs.mkdir(file);
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await jsonl.apply(ctx, { root: file, compression: 'none', listConcurrency: 1 });
  await fs.rmdir(file);
  await fs.writeFile(file, 'ordinary file');
  await assert.rejects(ctx.sessionPersistence.list(), error => error.code === 'ENOTDIR');
  const reason = new Error('caller cancelled before listing');
  await assert.rejects(ctx.sessionPersistence.list({ signal: AbortSignal.abort(reason) }), error => error === reason);
});

test('unreadable individual log is isolated where chmod enforces EACCES', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('chmod cannot demonstrate EACCES on Windows or uid 0; no privilege changes');
    return;
  }
  const f = await fixture(t, 'none');
  await fs.chmod(f.paths.bad, 0);
  try {
    const { ctx, warnings } = await f.reader();
    assert.deepEqual((await ctx.sessionPersistence.list()).map(row => row.header.id), ['good']);
    await f.workspace(ctx);
    assert.ok(warnings.some(line => line.includes(f.paths.bad)));
  } finally {
    await fs.chmod(f.paths.bad, 0o600);
  }
});
