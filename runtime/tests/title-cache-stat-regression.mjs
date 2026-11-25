// Real Domain + per-record JSON checks. Run: node title-cache-stat-regression.mjs <dsh-prefix>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = resolve(process.argv[2]);
const load = name => import(pathToFileURL(`${prefix}/node_modules/${name}/lib/index.js`));
const { Context } = await load('@deepseek-ai/cordis');
const { DomainFacility, defineDomain, domainTable } = await load('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await load('@deepseek-ai/dsh-storage-json');
const { z } = await import(pathToFileURL(`${prefix}/node_modules/zod/index.js`));
const gate = () => { let release; const promise = new Promise(r => release = r); return { promise, release }; };
let passed = 0;
async function check(name, run) {
  const disk = await mkdtemp(join(tmpdir(), 'title-stat-'));
  let domain;
  const owner = new Context();
  try {
    const backend = new JsonStorageBackend(disk);
    let unit, reads = 0, parses = 0;
    const context = { fiber: owner.fiber, emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => ({ kv: {
      async open(descriptor) {
        unit = await backend.kv.open(descriptor);
        const read = unit.readRecord.bind(unit);
        unit.readRecord = (...args) => { reads++; return read(...args); };
        return unit;
      },
    } }) } } };
    domain = await new DomainFacility(context, { backend: 'json' }).open(defineDomain({
      name: 'stamp_test', version: 1, layout: 'per-record',
      tables: { sessions: domainTable(z.object({ title: z.string() }).transform(v => { parses++; return v; })) },
    }));
    const table = domain.table('sessions');
    const file = join(disk, 'stamp_test/sessions/s.json');
    const external = async title => {
      await mkdir(join(disk, 'stamp_test/sessions'), { recursive: true });
      await writeFile(file + '.next', JSON.stringify({ version: 1, record: { title } }));
      await rename(file + '.next', file);
    };
    await run({ unit, table, file, external, counts: () => ({ reads, parses }) });
    passed++; console.log('PASS ' + name);
  } finally {
    await domain?.close();
    await owner.fiber.dispose();
    await rm(disk, { recursive: true, force: true });
  }
}
await check('stable stamp skips second read and parse', async ({ table, external, counts }) => {
  await external('one'); await table.refresh('s'); const first = counts();
  assert.deepEqual(first, { reads: 1, parses: 1 });
  assert.equal((await table.refresh('s')).title, 'one'); assert.deepEqual(counts(), first);
});
await check('equal length and restored mtime atomic replacement is fresh', async ({ table, file, external }) => {
  await external('one'); await utimes(file, 1000000000, 1000000000); await table.refresh('s');
  const before = await stat(file, { bigint: true });
  await external('two'); await utimes(file, 1000000000, 1000000000);
  const after = await stat(file, { bigint: true });
  assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.notEqual(after.ino, before.ino);
  assert.equal((await table.refresh('s')).title, 'two');
});
await check('replacement after the read is seen by the next refresh', async ({ unit, table, external, counts }) => {
  await external('one'); const read = unit.readRecord.bind(unit); let replace = true;
  unit.readRecord = async (...args) => { const value = await read(...args); if (replace) { replace = false; await external('two'); } return value; };
  assert.equal((await table.refresh('s')).title, 'one');
  assert.equal((await table.refresh('s')).title, 'two'); assert.equal(counts().reads, 2);
  await table.refresh('s'); assert.equal(counts().reads, 2);
});
await check('missing malformed schema-invalid and read-error never negative-cache', async ({ table, file, external, counts }) => {
  await external('one'); await table.refresh('s');
  for (const shape of ['missing', 'malformed', 'schema', 'directory']) {
    await rm(file, { recursive: true, force: true });
    if (shape === 'malformed') await writeFile(file, '{broken');
    if (shape === 'schema') await writeFile(file, JSON.stringify({ version: 1, record: { wrong: true } }));
    if (shape === 'directory') await mkdir(file); // real EISDIR from readFile, including root hosts
    const before = counts().reads;
    assert.equal(await table.refresh('s'), undefined); assert.equal(await table.refresh('s'), undefined);
    assert.equal(counts().reads, before + 2, shape);
    if (shape === 'directory') await rm(file, { recursive: true });
    await external('restored'); assert.equal((await table.refresh('s')).title, 'restored');
  }
});
await check('queued refresh follows put update and delete, with no old stamp', async ({ unit, table, external, counts }) => {
  await external('old'); await table.refresh('s');
  for (const operation of ['put', 'update', 'delete']) {
    const method = operation === 'delete' ? 'deleteRecord' : 'putRecord';
    const original = unit[method].bind(unit); const entered = gate(), release = gate();
    unit[method] = async (...args) => { entered.release(); await release.promise; return original(...args); };
    const change = operation === 'put' ? table.put('s', { title: 'put' }) : operation === 'update' ? table.update('s', () => ({ title: 'update' })) : table.delete('s');
    await entered.promise; const before = counts().reads; const refresh = table.refresh('s');
    await new Promise(r => setImmediate(r)); assert.equal(counts().reads, before, operation);
    release.release(); await change; await refresh; unit[method] = original;
    assert.equal(counts().reads, before + 1, operation);
    assert.equal(table.get('s')?.title, operation === 'delete' ? undefined : operation);
  }
});
await check('failed put update delete clear old stamp; queue remains usable', async ({ unit, table, external, counts }) => {
  await external('old'); await table.refresh('s');
  for (const operation of ['put', 'update', 'delete']) {
    const method = operation === 'delete' ? 'deleteRecord' : 'putRecord';
    const original = unit[method].bind(unit);
    unit[method] = async () => { throw new Error('test write rejected'); };
    const change = operation === 'put' ? table.put('s', { title: 'lost' }) : operation === 'update' ? table.update('s', () => ({ title: 'lost' })) : table.delete('s');
    await assert.rejects(change, /test write rejected/);
    const before = counts().reads; await table.refresh('s'); assert.equal(counts().reads, before + 1, operation);
    assert.equal(table.get('s').title, 'old'); unit[method] = original;
  }
  await table.put('s', { title: 'ok' }); assert.equal((await table.refresh('s')).title, 'ok');
});
await check('late refresh cannot overwrite later queued local mutation', async ({ unit, table, external }) => {
  await external('one'); const read = unit.readRecord.bind(unit); const entered = gate(), release = gate();
  unit.readRecord = async (...args) => { const value = await read(...args); entered.release(); await release.promise; return value; };
  const refresh = table.refresh('s'); await entered.promise;
  const put = table.put('s', { title: 'local' }); release.release(); await Promise.all([refresh, put]);
  assert.equal(table.get('s').title, 'local'); unit.readRecord = read;
  assert.equal((await table.refresh('s')).title, 'local');
});
await check('rc.1 batch deletion serializes refresh and permits later external recreation', async ({ unit, table, external, counts }) => {
  await external('old'); await table.refresh('s');
  const original = unit.deleteRecords.bind(unit), entered = gate(), release = gate();
  unit.deleteRecords = async (...args) => { entered.release(); await release.promise; return original(...args); };
  const removal = table.deleteMany(['s', 's', 'missing']);
  await entered.promise;
  const before = counts().reads, refresh = table.refresh('s');
  await new Promise(r => setImmediate(r)); assert.equal(counts().reads, before);
  release.release(); assert.equal(await removal, 1); assert.equal(await refresh, undefined);
  assert.equal(counts().reads, before + 1);
  await external('recreated'); assert.equal((await table.refresh('s')).title, 'recreated');
});
console.log(JSON.stringify({ suite: 'title-cache-stat-regression', passed }));
