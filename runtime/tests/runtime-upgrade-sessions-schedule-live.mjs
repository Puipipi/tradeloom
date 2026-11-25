// Actual released rc4/rc1 npm implementations and temporary on-disk data.
// DSH_OLD_PREFIX=<patched 0.2.1-rc.4> DSH_PREFIX=<patched 0.2.2-rc.1> node --test runtime/tests/runtime-upgrade-sessions-schedule-live.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.DSH_OLD_PREFIX || !process.env.DSH_PREFIX) throw Error('Set DSH_OLD_PREFIX and DSH_PREFIX to isolated patched release prefixes');
const loadFrom = prefix => name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const oldLoad = loadFrom(process.env.DSH_OLD_PREFIX), newLoad = loadFrom(process.env.DSH_PREFIX);
for (const [prefix, version] of [[process.env.DSH_OLD_PREFIX, '0.2.1-rc.4'], [process.env.DSH_PREFIX, '0.2.2-rc.1']]) {
  assert.equal(JSON.parse(await readFile(join(resolve(prefix), 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, version);
}

async function openRuntime(load, root) {
  const { Context } = await load('cordis');
  const { apply } = await load('dsh-session-persistence-jsonl');
  const { JsonStorageBackend } = await load('dsh-storage-json');
  const { DomainFacility } = await load('dsh-storage-domain');
  const { ScheduleService, scheduleDomain } = await load('dsh-schedule');
  const ctx = new Context();
  await apply(ctx, { root: join(root, 'sessions'), compression: 'none', listConcurrency: 1 });
  const backend = new JsonStorageBackend(join(root, 'storage'));
  ctx.provide('storage', { backend: { get: () => backend } });
  const facility = new DomainFacility(ctx, { backend: 'json' });
  return { ctx, backend, facility, ScheduleService, scheduleDomain,
    async close() { await facility.closeAll(); await backend.close(); await ctx.fiber.dispose(); } };
}

function scheduleService(runtime, domain, agent) {
  const service = Object.create(runtime.ScheduleService.prototype);
  const ctx = {
    agents: new Map([[agent.id, agent]]),
    sessionPersistence: runtime.ctx.sessionPersistence,
    sessionController: { resolveAgent: async () => ({ agent }) },
    get(name) {
      if (name === 'userQuestions') return { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: ['授权 / Authorize'] }] }) };
    },
  };
  Object.defineProperty(service, 'ctx', { value: ctx });
  Object.assign(service, {
    chain: Promise.resolve(), stopping: false, dshGoAuthorizationAbort: new AbortController(),
    getDomain: async () => domain, emitChanged() {}, queueNotification() {},
    runtime: { requestDrive() {}, deliveryFloorEnd() {}, isExecutionActive() { return false; } },
  });
  return service;
}

test('actual rc4 session and schedule survive rc1 opening and continue through public writes; rollback limits are explicit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rc4-to-rc1-'));
  const opened = [];
  t.after(async () => { for (const runtime of opened.reverse()) await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const old = await openRuntime(oldLoad, root); opened.push(old);
  const { Session } = await oldLoad('dsh-session');
  const { createUserMessage: oldMessage } = await oldLoad('dsh-llm');
  const session = Session.create('upgrade-session');
  session.append('user/message', oldMessage({ content: [{ type: 'text', text: 'Persisted by actual rc4' }], source: { kind: 'user', rpcId: 'old-request' } }), { surfaceOp: 'append' });
  const writer = await old.ctx.sessionPersistence.create(session.header);
  await writer.append(session.snapshotEvents());
  await writer.flush(); await writer.close();
  const domain = await old.facility.open(old.scheduleDomain);
  const agent = { id: session.id, options: {}, session };
  const service = scheduleService(old, domain, agent);
  const original = await service.create(session.id, { title: 'Upgrade task', prompt: 'Persisted by actual rc4 schedule', every_seconds: 3600 }, new AbortController().signal);
  const schedulePath = join(root, 'storage/schedule.json');
  const oldSchedule = await readFile(schedulePath, 'utf8');
  assert.equal(JSON.parse(oldSchedule).unit.version, 1);
  await old.close();

  const current = await openRuntime(newLoad, root); opened.push(current);
  const reader = await current.ctx.sessionPersistence.open(session.id, 'read');
  const restored = await reader.read(); await reader.close();
  assert.deepEqual(restored.events, session.snapshotEvents());
  const upgradedDomain = await current.facility.open(current.scheduleDomain);
  const migrated = upgradedDomain.table('tasks').get(original.id);
  assert.deepEqual(migrated.record, original);
  assert.deepEqual(migrated.target, { kind: 'session', sessionId: session.id });
  assert.deepEqual(migrated.involvedSessionIds, [session.id]);
  assert.equal(await readFile(schedulePath, 'utf8'), oldSchedule, 'read-only startup does not rewrite the old schedule');
  const upgradedService = scheduleService(current, upgradedDomain, agent);
  const updated = await upgradedService.remoteEdit({ id: original.id, action: 'update', patch: { prompt: 'Continued by actual rc1 schedule' } }, new AbortController().signal);
  assert.equal(updated.prompt, 'Continued by actual rc1 schedule');
  assert.equal(JSON.parse(await readFile(schedulePath, 'utf8')).unit.version, 2);
  const { createUserMessage } = await newLoad('dsh-llm');
  const continued = await current.ctx.sessionPersistence.open(session.id, 'write');
  const next = { type: 'user/message', seq: restored.events.length, time: Date.now(), data: createUserMessage({ content: [{ type: 'text', text: 'Continued by actual rc1' }], source: { kind: 'user', rpcId: 'new-request' } }), surfaceOp: 'append' };
  await continued.append([next]); await continued.flush(); await continued.close();
  await current.close();

  const rollback = await openRuntime(oldLoad, root); opened.push(rollback);
  const rollbackReader = await rollback.ctx.sessionPersistence.open(session.id, 'read');
  const rollbackSession = await rollbackReader.read(); await rollbackReader.close();
  assert.deepEqual(rollbackSession.events, [...session.snapshotEvents(), next], 'ordinary v4 user-message writes remain readable by rc4');
  await assert.rejects(rollback.facility.open(rollback.scheduleDomain), error => error.code === 'version-mismatch');
});
