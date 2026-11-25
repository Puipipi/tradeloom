// Load the whole pinned browser factory through apply() and its registered slot.
// Stores, effects, slots, RPC replies and Session summaries are boundary adapters;
// the Section controller, blank capture and Seat controller remain product code.
// No React rendering, browser transport or Host execution is represented here.
// DSH_PREFIX=<patched prefix> node --test runtime/tests/web-preset-save-freshness.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the pinned test prefix');
const bundle = join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js');

function snapshotStore(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    set(next) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function peer(name) {
  switch (name) {
    case '@deepseek-ai/dsh-client-store': return { createSnapshotStore: snapshotStore };
    // The registered components are not rendered by this fixture.
    case 'react':
    case 'react/jsx-runtime':
    case '@deepseek-ai/dsh-client-ui-primitives': return {};
    default: throw Error(`Unexpected browser peer: ${name}`);
  }
}

let api;
runInNewContext(readFileSync(bundle, 'utf8'), {
  window: { __ModuleLoader__: { load(entry) {
    assert.equal(entry.id, '@deepseek-ai/dsh-client-ui-agent-preset');
    api = entry.factory(peer);
  } } },
}, { filename: bundle });
assert.equal(typeof api?.apply, 'function');

const A = 'standard';
const B = 'cordis';
const SESSION = 'preset-save-blank';
const NS = 'agent-preset-registry';
const ok = value => ({ ok: true, value });
const failure = message => ({ ok: false, error: { code: 'fixture/refused', message } });
const roster = (defaultId, ids = [A, B]) => ok({
  presets: ids.map(id => ({ id, isDefault: id === defaultId })),
});
const defaultId = state => state.rows.find(row => row.isDefault)?.id;

function effectScope() {
  const disposers = [];
  return {
    effect(setup) {
      const cleanup = setup();
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        await cleanup?.();
      };
      disposers.push(dispose);
      return dispose;
    },
    async dispose() {
      for (const dispose of [...disposers].reverse()) await dispose();
    },
  };
}

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      let group = listeners.get(name);
      if (!group) listeners.set(name, group = new Set());
      group.add(listener);
      return () => { group.delete(listener); };
    },
    emit(name, ...args) {
      const group = [...(listeners.get(name) ?? [])];
      for (const listener of group) listener(...args);
      return group.length;
    },
  };
}

async function fixture(t, currentPreset = A) {
  const rootScope = effectScope();
  const bindingScope = effectScope();
  const remoteEvents = events();
  const contextEvents = events();
  const registrations = new Map();
  const gates = new Set();
  const operations = new Set();
  const lists = [], writes = [], selections = [];
  let closing = false;
  let closePromise;
  const summary = {
    id: SESSION, blank: true, projectionValues: { agentPreset: currentPreset },
    retainedBy: { mainView: 1 },
  };
  const sessions = snapshotStore({ ids: [SESSION], byId: { [SESSION]: summary } });
  const retained = snapshotStore({ retainedBy: { mainView: 1 } });
  let binding = { sessionId: SESSION, ctx: bindingScope };
  // Known-on Coding Tools makes the actual mount reconciliation a no-op, rather
  // than replacing it. The third preset in one failure test is therefore legal.
  const toolsSettings = snapshotStore({ status: 'ready', value: { enabled: true } });
  const presetSettings = snapshotStore({
    status: 'ready', writable: true, revision: 'fixture-revision', value: { selectedDefault: A },
  });
  const developerTools = snapshotStore(true);

  function request(log, args) {
    if (closing) return Promise.resolve(failure('fixture disposed'));
    const completion = Promise.withResolvers();
    const call = {
      args,
      reply(value) {
        if (!gates.delete(call)) return;
        completion.resolve(value);
      },
    };
    gates.add(call);
    log.push(call);
    return completion.promise;
  }
  function track(promise) {
    operations.add(promise);
    const done = () => { operations.delete(promise); };
    promise.then(done, done);
    return promise;
  }
  async function retireBinding() {
    binding = undefined;
    await bindingScope.dispose();
  }
  function close() {
    return closePromise ??= (async () => {
      closing = true;
      await retireBinding();
      // Release every manual request even when a preceding assertion failed.
      // Any cleanup continuation issuing a new RPC receives an immediate refusal.
      for (const gate of [...gates]) gate.reply(failure('fixture disposed'));
      await settle();
      await rootScope.dispose();
      await Promise.allSettled([...operations]);
    })();
  }
  t.after(close);

  const slots = {
    register(options, component) {
      const key = `${options.name}:${options.id ?? ''}`;
      assert.equal(registrations.has(key), false, `duplicate slot ${key}`);
      const entry = { options, component };
      registrations.set(key, entry);
      return () => {
        if (registrations.get(key) === entry) registrations.delete(key);
      };
    },
    inject(_name, mount) { return rootScope.effect(mount); },
  };
  const ctx = {
    effect: rootScope.effect,
    inject(_dependencies, mount) { return mount(ctx); },
    on: contextEvents.on,
    slots,
    locale: { register: () => () => {}, bind: () => key => key },
    configForms: {
      get(namespace) {
        if (namespace === 'ui-settings') return toolsSettings;
        assert.equal(namespace, NS);
        return presetSettings;
      },
      developerTools: { enabled: developerTools },
    },
    sessions: {
      list: sessions,
      binding: id => id === SESSION ? binding : undefined,
      retainInfo(id) { assert.equal(id, SESSION); return retained; },
    },
    conversation: {},
    uiWorkspace: { startSession() { throw Error('Saving a default must not create a Session'); } },
    get: () => undefined,
    remote: {
      $on: remoteEvents.on,
      agentPresets: {
        list: (...args) => request(lists, args),
        select(sessionId, id) {
          selections.push([sessionId, id]);
          return Promise.resolve(ok(id));
        },
      },
      settings: { update: (...args) => request(writes, args) },
    },
  };
  api.apply(ctx);
  const registration = registrations.get('settings.section:agent-presets');
  assert(registration, 'apply must register the real settings section');
  const props = registration.options.inject();
  // Let the real initial reconciliation finish before any save can overlap it.
  await settle();
  assert.equal(lists.length, 0);
  assert.equal(writes.length, 0);
  return {
    lists, writes, selections, close,
    state: () => props.hooks.agentPresetSection.getSnapshot(),
    load: () => track(props.load()),
    save: id => track(props.makeDefault(id)),
    documentUpdated() {
      assert.equal(remoteEvents.emit('settings/document-updated', NS), 1);
    },
    beginTurn() {
      const before = sessions.getSnapshot();
      sessions.set({ ...before, byId: {
        ...before.byId, [SESSION]: { ...before.byId[SESSION], blank: false },
      } });
    },
    retireBinding,
  };
}

async function loadInitial(f, ids = [A, B]) {
  const loading = f.load();
  await settle();
  assert.equal(f.lists.length, 1);
  f.lists[0].reply(roster(A, ids));
  await loading;
  assert.equal(f.state().status, 'ready');
  assert.equal(defaultId(f.state()), A);
}

test('saving a default waits for the older roster and then synchronizes the blank from a fresh read', async t => {
  const f = await fixture(t);
  await loadInitial(f);
  const olderRead = f.load();
  await settle();
  assert.equal(f.lists.length, 2);
  const saving = f.save(B);
  await settle();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].args[0], NS);
  assert.deepEqual({ ...f.writes[0].args[1] }, { selectedDefault: B });
  assert.equal(f.state().saving, true);
  f.writes[0].reply(ok(undefined));
  await settle();

  // Deliver the event through the handler registered by apply(). Section.load
  // shares the older read; the label, unbound Seat and bound Seat each read anew.
  f.documentUpdated();
  await settle();
  assert.equal(f.lists.length, 5);
  for (const call of f.lists.slice(2)) call.reply(roster(B));
  await settle();
  assert.deepEqual(f.selections, []);
  f.lists[1].reply(roster(A));
  await olderRead;
  await settle();

  // Check before awaiting saving: the old implementation lacks this request,
  // so it must fail an assertion rather than hang on a never-created gate.
  assert.equal(f.lists.length, 6, 'save must read again after the older roster settles');
  f.lists[5].reply(roster(B));
  await saving;
  assert.deepEqual(f.selections, [[SESSION, B]]);
  assert.equal(defaultId(f.state()), B);
  assert.equal(f.state().error, null);
  assert.equal(f.state().saving, false);
});

test('a failed post-save roster does not synchronize stale rows and the next explicit save recovers', async t => {
  // PTC makes an erroneous sync to stale A observable as a select call. It is
  // only this failure-path observation arrangement, not needed by the main case.
  const ids = [A, B, 'ptc'];
  const f = await fixture(t, 'ptc');
  await loadInitial(f, ids);
  const firstSave = f.save(B);
  await settle();
  assert.equal(f.writes.length, 1);
  f.writes[0].reply(ok(undefined));
  await settle();
  assert.equal(f.lists.length, 2);
  f.lists[1].reply(failure('temporary roster read failure'));
  await firstSave;
  assert.equal(f.state().status, 'error');
  assert.equal(f.state().error, 'temporary roster read failure');
  assert.equal(defaultId(f.state()), A);
  assert.equal(f.state().saving, false);
  assert.deepEqual(f.selections, []);

  const retry = f.save(B);
  await settle();
  assert.equal(f.writes.length, 2);
  f.writes[1].reply(ok(undefined));
  await settle();
  assert.equal(f.lists.length, 3);
  f.lists[2].reply(roster(B, ids));
  await retry;
  assert.deepEqual(f.selections, [[SESSION, B]]);
  assert.equal(f.state().status, 'ready');
  assert.equal(defaultId(f.state()), B);
  assert.equal(f.state().error, null);
  assert.equal(f.state().saving, false);
});

test('a refused default write still refreshes the roster, keeps its error, and releases saving', async t => {
  const f = await fixture(t);
  await loadInitial(f);
  const saving = f.save(B);
  await settle();
  assert.equal(f.writes.length, 1);
  f.writes[0].reply(failure('default write refused'));
  await settle();
  assert.equal(f.lists.length, 2, 'a write refusal must still refresh the roster');
  // A subsequent read error must not replace the original write refusal.
  f.lists[1].reply(failure('roster failed after refused write'));
  await saving;
  assert.equal(f.state().status, 'error');
  assert.equal(defaultId(f.state()), A);
  assert.equal(f.state().error, 'default write refused');
  assert.equal(f.state().saving, false);
  assert.deepEqual(f.selections, []);
});

test('a save without an in-flight roster performs one fresh read and synchronizes its effective default', async t => {
  const f = await fixture(t);
  await loadInitial(f);
  const saving = f.save(B);
  await settle();
  assert.equal(f.writes.length, 1);
  f.writes[0].reply(ok(undefined));
  await settle();
  assert.equal(f.lists.length, 2);
  f.lists[1].reply(roster(B));
  await saving;
  await settle();
  assert.equal(f.lists.length, 2, 'no redundant post-save roster read');
  assert.deepEqual(f.selections, [[SESSION, B]]);
  assert.equal(f.state().status, 'ready');
  assert.equal(defaultId(f.state()), B);
  assert.equal(f.state().error, null);
  assert.equal(f.state().saving, false);
});

test('a blank that starts or whose binding retires while refreshing is not synchronized', async t => {
  for (const change of ['started', 'retired']) {
    const f = await fixture(t);
    await loadInitial(f);
    const saving = f.save(B);
    await settle();
    assert.equal(f.writes.length, 1);
    f.writes[0].reply(ok(undefined));
    await settle();
    assert.equal(f.lists.length, 2);
    if (change === 'started') f.beginTurn();
    else await f.retireBinding();
    f.lists[1].reply(roster(B));
    await saving;
    assert.deepEqual(f.selections, [], change);
    assert.equal(f.state().status, 'ready', change);
    assert.equal(defaultId(f.state()), B, change);
    assert.equal(f.state().saving, false, change);
    await f.close();
  }
});
