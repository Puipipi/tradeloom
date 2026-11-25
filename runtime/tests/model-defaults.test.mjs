// Actual rc.1 service, settings forms, and extracted controller methods; no live Host.
// DSH_PREFIX=/private/patched/prefix node --test runtime/tests/model-defaults.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to a private patched candidate');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { AgentDefaultModelConfig } = await load('dsh-agent-default-model');
const { SettingsForms } = await load('dsh-settings');
const { ReasoningEffortId } = await load('dsh-llm');
const { RemoteError, remoteErrorOf } = await load('dsh-typert-protocol');
const source = readFileSync(join(base, 'dsh-api-session-controller/lib/index.js'), 'utf8');
const commandsStart = source.indexOf('var SessionCommandController = class');
const commandsEnd = source.indexOf('//#endregion', commandsStart);
assert(commandsStart >= 0 && commandsEnd > commandsStart, 'real controller class exists');
const SessionCommandController = Function('ReasoningEffortId', 'RemoteError', 'remoteErrorOf',
  `${source.slice(commandsStart, commandsEnd)}; return SessionCommandController;`)(ReasoningEffortId, RemoteError, remoteErrorOf);
const initializeStart = source.indexOf('async initializeDefaultModel() {');
const initializeEnd = source.indexOf('\n\t\t/**', initializeStart);
assert(initializeStart >= 0 && initializeEnd > initializeStart, 'real initialization method exists');
const initializeSource = source.slice(initializeStart, initializeEnd);
const old = { provider: 'fixture', model: 'old', reasoningEffort: 'high' };
const next = { provider: 'fixture', model: 'next', reasoningEffort: 'max' };
const fixedReceipt = { status: 'skipped', code: 'settings/fixed-default' };
const failedReceipt = { status: 'failed', code: 'settings/default-save-failed' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(raw = old, { beforeEdit, missingEntry, missingEditor } = {}) {
  const writes = [];
  const entry = { id: 'entry', options: { id: 'agent-default-model', config: structuredClone(raw) } };
  entry.fiber = { uid: 1, state: 2, runtime: { Config: AgentDefaultModelConfig.Config }, ctx: {} };
  const defaults = Object.create(AgentDefaultModelConfig.prototype);
  const update = value => {
    entry.options.config = structuredClone(value);
    entry.fiber.config = AgentDefaultModelConfig.Config(structuredClone(value));
    entry.fiber.effectiveConfig = entry.fiber.config;
    defaults.config = entry.fiber.config;
  };
  update(raw);
  const editor = {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: { ...old }, override: entry.options.config }],
    async edit(target, change) {
      assert.equal(target, entry);
      await beforeEdit?.();
      const config = await change(structuredClone(entry.options.config), old);
      update(config);
      writes.push(structuredClone(config));
    },
  };
  const events = [];
  defaults.ownerContext = { fiber: { entry: missingEntry ? undefined : entry } };
  defaults.ctx = { get: name => name === 'configEditor' && !missingEditor ? editor : undefined };
  defaults.saves = Promise.resolve();
  const settings = Object.create(SettingsForms.prototype);
  Object.assign(settings, {
    ownerContext: { configEditor: editor, emit: (...args) => events.push(args) },
    revisions: new Map(), presentations: new Map(),
  });
  return { defaults, settings, entry, writes, events, update, raw: () => entry.options.config };
}

function commands(defaults, { resolveCallConfig, requireModel } = {}) {
  const selected = [];
  const logs = [];
  const agent = { id: 'session-fixture', model: { select: value => selected.push(value) } };
  const ctx = {
    agentDefaultModel: defaults,
    llm: { resolveCallConfig: resolveCallConfig ?? (async value => value) },
    logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  };
  const controller = new SessionCommandController(ctx, {
    serializeImageAdmission: (_agent, run) => run(),
    selectForNextRequest: (target, value) => { assert.equal(target, agent); selected.push(value); },
  });
  controller.resolveAgent = async () => agent;
  controller.requireModel = requireModel ?? (async () => {});
  return { controller, selected, logs };
}

function startup(f, { catalog, apiKey = false, catalogGate } = {}) {
  let catalogCalls = 0, keyCalls = 0;
  const initialize = Function('hasProviderApiKey', 'buildModelCatalog', 'RemoteError', 'ReasoningEffortId',
    `return ({${initializeSource}}).initializeDefaultModel;`)(
    async () => { keyCalls++; return apiKey; },
    async (_ctx, current) => {
      catalogCalls++;
      await catalogGate?.promise;
      return catalog ?? {
        default: current,
        groups: [{ id: 'deepseek-account', models: [{ id: 'account-first', reasoning: { defaultEffort: 'max', efforts: [{ id: 'max' }] } }] }],
        failures: [],
      };
    }, RemoteError, ReasoningEffortId);
  return { run: () => initialize.call({ ctx: { agentDefaultModel: f.defaults } }),
    catalogCalls: () => catalogCalls, keyCalls: () => keyCalls };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('settings namespace exposes editable boolean mode, defaulting old profiles to remember', async () => {
  const f = fixture();
  const descriptor = f.settings.describe().find(row => row.ns === 'agent-default-model');
  assert.equal(descriptor.value.rememberLastSelection, true);
  const root = descriptor.schema.refs[descriptor.schema.uid];
  const mode = descriptor.schema.refs[root.dict.rememberLastSelection];
  assert.equal(mode.type, 'boolean');
  assert.equal(mode.meta.default, true);
  await f.settings.mutate('agent-default-model', [
    { op: 'set', path: ['rememberLastSelection'], value: false },
    { op: 'set', path: ['model'], value: 'fixed' },
    { op: 'set', path: ['reasoningEffort'], value: 'max' },
  ], descriptor.revision);
  assert.deepEqual(f.defaults.currentSelection(), { provider: 'fixture', model: 'fixed', reasoningEffort: 'max' });
  assert.equal(f.defaults.remembersLastSelection(), false);
  assert.equal(f.writes.length, 1, 'existing mutate remains one atomic configuration edit');
});

test('remember writes model and effort, preserves explicit mode and unrelated raw config', async () => {
  const f = fixture({ ...old, rememberLastSelection: true, retained: 'synthetic' });
  assert.deepEqual(await f.defaults.saveSelection(next), { status: 'saved' });
  assert.deepEqual(f.raw(), { ...next, rememberLastSelection: true, retained: 'synthetic' });
  assert.deepEqual(await f.defaults.saveSelection({ provider: 'fixture', model: 'plain' }), { status: 'saved' });
  assert(!Object.hasOwn(f.raw(), 'reasoningEffort'), 'omitted effort clears the previous effort');
});

test('fixed default skips persistence but installs the Session selection', async () => {
  const f = fixture({ ...old, rememberLastSelection: false });
  const c = commands(f.defaults);
  assert.deepEqual(await c.controller.selectModel({ sessionId: 'session-fixture', ...next }), { selected: next, defaultSave: fixedReceipt });
  assert.deepEqual(c.selected, [next]);
  assert.deepEqual(f.raw(), { ...old, rememberLastSelection: false });
  assert.equal(f.writes.length, 0);
});

test('selectModel waits for persistence and keeps the requested route after validation', async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture(old, { beforeEdit: () => { entered.resolve(); return gate.promise; } });
  const c = commands(f.defaults, { resolveCallConfig: async requested => {
    assert.deepEqual(requested, next);
    return { ...next, reasoningEffort: 'high' };
  } });
  let returned = false;
  const pending = c.controller.selectModel({ sessionId: 'session-fixture', ...next }).then(value => { returned = true; return value; });
  await entered.promise;
  await flush();
  assert.deepEqual(c.selected, [next]);
  assert.equal(returned, false);
  gate.resolve();
  assert.deepEqual(await pending, { selected: next, defaultSave: { status: 'saved' } });
});

test('queued remember save rechecks fixed mode under the editor lock, even with stale live refs', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(old, { beforeEdit: () => { entered.resolve(); return gate.promise; } });
  const c = commands(f.defaults);
  const pending = c.controller.selectModel({ sessionId: 'session-fixture', ...next });
  await entered.promise;
  // Model the explicit settings mutation winning the editor lock before this callback.
  f.entry.options.config = { ...old, model: 'fixed', rememberLastSelection: false };
  gate.resolve();
  assert.deepEqual(await pending, { selected: next, defaultSave: fixedReceipt });
  assert.equal(f.raw().model, 'fixed');
  assert.equal(f.raw().rememberLastSelection, false);
  assert.equal(f.writes.length, 0, 'skipped callback never writes an unchanged profile');
});

test('save submission queue also rechecks a mode change before entering the editor', async () => {
  const f = fixture();
  const queue = deferred();
  f.defaults.saves = queue.promise;
  const pending = f.defaults.saveSelection(next);
  f.update({ ...old, rememberLastSelection: false });
  queue.resolve();
  assert.deepEqual(await pending, fixedReceipt);
  assert.equal(f.writes.length, 0);
});

for (const kind of ['disk', 'missingEntry', 'missingEditor']) test(`persistence ${kind} failure is separate, stable, and never logs private errors`, async () => {
  const secret = 'SYNTHETIC_KEY /private/synthetic/profile logger-sensitive';
  const f = fixture(old, kind === 'disk' ? { beforeEdit: () => { throw Error(secret); } } : { [kind]: true });
  const c = commands(f.defaults);
  const result = await c.controller.selectModel({ sessionId: 'session-fixture', ...next });
  assert.deepEqual(result, { selected: next, defaultSave: failedReceipt });
  assert.deepEqual(c.selected, [next]);
  assert(!JSON.stringify(result).includes(secret));
  assert.deepEqual(c.logs, []);
});

test('a failed automatic save does not block later saves or reverse submission order', async () => {
  let edits = 0;
  const f = fixture(old, { beforeEdit: () => { if (++edits === 1) throw Error('synthetic write failure'); } });
  const failed = f.defaults.saveSelection(next);
  const second = f.defaults.saveSelection({ ...next, model: 'second' });
  const third = f.defaults.saveSelection({ ...next, model: 'third' });
  await assert.rejects(failed);
  assert.deepEqual(await second, { status: 'saved' });
  assert.deepEqual(await third, { status: 'saved' });
  assert.deepEqual(f.writes.map(row => row.model), ['second', 'third']);
});

test('model validation failure still rejects without changing Session or defaults', async () => {
  const f = fixture();
  const c = commands(f.defaults, { requireModel: () => { throw new RemoteError('session/model-unavailable', 'synthetic unavailable', {}); } });
  await assert.rejects(c.controller.selectModel({ sessionId: 'session-fixture', ...next }), error => remoteErrorOf(error)?.code === 'session/model-unavailable');
  assert.deepEqual(c.selected, []);
  assert.equal(f.writes.length, 0);
});

test('login initialization does not consult credentials or catalog for a fixed default', async () => {
  const f = fixture({ ...old, rememberLastSelection: false });
  const s = startup(f);
  await s.run();
  assert.equal(s.keyCalls(), 0);
  assert.equal(s.catalogCalls(), 0);
  assert.equal(f.writes.length, 0);
});

for (const provider of ['fixture', 'deepseek-account']) test(`login retains valid existing ${provider} model and effort`, async () => {
  const f = fixture({ ...old, provider });
  const s = startup(f, { catalog: { groups: [{ id: provider, models: [
    { id: 'first' }, { id: 'old', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] } },
  ] }], failures: [] } });
  await s.run();
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.defaults.currentSelection(), { ...old, provider });
});

test('login preserves an existing default whose provider temporarily fails discovery', async () => {
  const f = fixture();
  await startup(f, { catalog: { groups: [], failures: [{ id: 'fixture' }] } }).run();
  assert.equal(f.writes.length, 0);
});

test('login fills an unavailable default from the account catalog including default effort', async () => {
  const f = fixture();
  await startup(f).run();
  assert.deepEqual(f.defaults.currentSelection(), { provider: 'deepseek-account', model: 'account-first', reasoningEffort: 'max' });
});

test('login initialization cannot overwrite a newer explicit model change during discovery', async () => {
  const f = fixture();
  const gate = deferred();
  const s = startup(f, { catalogGate: gate });
  const pending = s.run();
  await flush();
  assert.equal(s.catalogCalls(), 1);
  f.update({ ...next, rememberLastSelection: true });
  gate.resolve();
  await pending;
  assert.deepEqual(f.raw(), { ...next, rememberLastSelection: true });
  assert.equal(f.writes.length, 0);
});

test('login initialization cannot overwrite fixed mode enabled during discovery', async () => {
  const f = fixture();
  const gate = deferred();
  const s = startup(f, { catalogGate: gate });
  const pending = s.run();
  await flush();
  f.update({ ...old, rememberLastSelection: false });
  gate.resolve();
  await pending;
  assert.equal(f.raw().rememberLastSelection, false);
  assert.equal(f.writes.length, 0);
});

test('login write failure returns only the safe stable error', async () => {
  const f = fixture(old, { beforeEdit: () => { throw Error('SYNTHETIC_KEY /private/profile'); } });
  await assert.rejects(startup(f).run(), error => {
    assert.equal(remoteErrorOf(error)?.code, 'settings/default-save-failed');
    assert(!String(error).includes('SYNTHETIC_KEY'));
    assert(!String(error).includes('/private/profile'));
    return true;
  });
});
