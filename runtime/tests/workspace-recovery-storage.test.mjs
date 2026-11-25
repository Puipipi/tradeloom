// Actual DomainFacility + JsonStorageBackend; no copied implementation or timers.
// DSH_PREFIX selects the same pinned main45 modules before/after the patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to the locked runtime prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const { DomainFacility, descriptorOf } = await load('dsh-storage-domain');
const { JsonStorageBackend } = await load('dsh-storage-json');
const { workspaceDomainSpec } = await load('dsh-workspace');
const recoveryName = 'dsh_go_workspace_recovery';
const empty = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };

async function fixture(t, flag) {
  const before = process.env.DSH_APP_WORKSPACE_RECOVERY;
  if (flag === undefined) delete process.env.DSH_APP_WORKSPACE_RECOVERY;
  else process.env.DSH_APP_WORKSPACE_RECOVERY = flag;
  const root = await mkdtemp(join(tmpdir(), 'workspace-recovery-'));
  const ctx = new Context();
  const backend = new JsonStorageBackend(root);
  const routes = [], descriptors = [], changes = [];
  ctx.on('domain/changed', change => changes.push(change));
  ctx.provide('storage', { backend: { get(name) {
    routes.push(name);
    assert.equal(name, 'routed-workspace', 'the logical workspace route must remain selected');
    return { kv: { open(descriptor) {
      descriptors.push(structuredClone(descriptor));
      return backend.kv.open(descriptor);
    } } };
  } } });
  const facility = new DomainFacility(ctx, { backend: 'wrong-default', routes: { workspace: 'routed-workspace', notes: 'routed-workspace' } });
  t.after(async () => {
    await facility.closeAll();
    await backend.close();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
    if (before === undefined) delete process.env.DSH_APP_WORKSPACE_RECOVERY;
    else process.env.DSH_APP_WORKSPACE_RECOVERY = before;
  });
  return { root, ctx, backend, facility, routes, descriptors, changes };
}

for (const flag of [undefined, '0', 'true', '01']) {
  test(`only explicit 1 enables recovery: ${String(flag)}`, async t => {
    const f = await fixture(t, flag);
    const domain = await f.facility.open(workspaceDomainSpec);
    await domain.global.set(empty);
    assert.equal(f.descriptors[0].name, 'workspace');
    assert.equal(JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8')).unit.name, 'workspace');
    await assert.rejects(readFile(join(f.root, `${recoveryName}.json`)), { code: 'ENOENT' });
  });
}

test('recovery bypasses unreadable original medium and keeps logical identity, route and events', async t => {
  const f = await fixture(t, '1');
  const original = Buffer.from('original malformed medium must remain byte-identical\n');
  await writeFile(join(f.root, 'workspace.json'), original);
  const domain = await f.facility.open(workspaceDomainSpec);
  assert.equal(domain.name, 'workspace');
  assert.equal(f.facility.get('workspace'), domain);
  assert.equal(f.facility.get(recoveryName), undefined);
  await domain.global.set(empty);
  assert.deepEqual(f.routes, ['routed-workspace']);
  assert.equal(f.descriptors[0].name, recoveryName);
  assert.equal(f.changes.at(-1).domain, 'workspace');
  assert.equal(JSON.parse(await readFile(join(f.root, `${recoveryName}.json`), 'utf8')).unit.name, recoveryName);
  assert.deepEqual(await readFile(join(f.root, 'workspace.json')), original);
});

test('recovery does not rename any other logical domain', async t => {
  const f = await fixture(t, '1');
  const domain = await f.facility.open({ ...workspaceDomainSpec, name: 'notes' });
  await domain.global.set(empty);
  assert.equal(f.descriptors[0].name, 'notes');
  assert.equal(f.changes.at(-1).domain, 'notes');
  assert.equal(JSON.parse(await readFile(join(f.root, 'notes.json'), 'utf8')).unit.name, 'notes');
});

test('off then on reopens the same rescue index and does not mutate the original', async t => {
  const f = await fixture(t, '1');
  const original = Buffer.from('unreadable original retained for diagnosis\n');
  await writeFile(join(f.root, 'workspace.json'), original);
  const first = await f.facility.open(workspaceDomainSpec);
  const saved = { ...empty, defaultWorkspaceId: 'retained-default-id' };
  await first.global.set(saved);
  await first.close();
  process.env.DSH_APP_WORKSPACE_RECOVERY = '0';
  await assert.rejects(f.facility.open(workspaceDomainSpec), error => error.code === 'malformed-medium');
  process.env.DSH_APP_WORKSPACE_RECOVERY = '1';
  const second = await f.facility.open(workspaceDomainSpec);
  assert.deepEqual(second.global.get(), saved);
  assert.deepEqual(await readFile(join(f.root, 'workspace.json')), original);
});

test('existing broken rescue medium fails explicitly without fallback or replacement', async t => {
  const f = await fixture(t, '1');
  const original = JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: empty, tables: { workspaces: {} } });
  const broken = 'broken rescue bytes\n';
  await writeFile(join(f.root, 'workspace.json'), original);
  await writeFile(join(f.root, `${recoveryName}.json`), broken);
  await assert.rejects(f.facility.open(workspaceDomainSpec), error => error.code === 'malformed-medium');
  assert.equal(await readFile(join(f.root, `${recoveryName}.json`), 'utf8'), broken);
  assert.equal(await readFile(join(f.root, 'workspace.json'), 'utf8'), original);
});

for (const name of ['workspace', recoveryName]) {
  test(`${name} preserves existing deletion fence before durable publication and reopen`, async t => {
    const f = await fixture(t, '0');
    f.backend.dshGoDeletion = () => ({ deleted: id => id === 'deleted-session' });
    const descriptor = { ...descriptorOf(workspaceDomainSpec), name };
    const unit = await f.backend.kv.open(descriptor);
    await unit.putRecord('workspaces', 'workspace-a', { path: '/retained', title: 'Retained', sessionIds: ['deleted-session', 'live-session'], createdAt: '2026-11-05', updatedAt: '2026-11-05' });
    await unit.setGlobal({ ...empty, workspaceIds: ['workspace-a'], archivedSessionIds: ['deleted-session'], pinnedSessionIds: ['deleted-session', 'live-session'] });
    await unit.close();
    const reopened = await f.backend.kv.open(descriptor);
    const snapshot = await reopened.loadAll();
    assert.deepEqual(snapshot.tables.workspaces['workspace-a'].sessionIds, ['live-session']);
    assert.deepEqual(snapshot.global.archivedSessionIds, []);
    assert.deepEqual(snapshot.global.pinnedSessionIds, ['live-session']);
    await reopened.close();
  });
}
