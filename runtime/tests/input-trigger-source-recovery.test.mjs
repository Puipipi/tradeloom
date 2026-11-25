// Load the whole pinned browser factory and exercise its public controller.
// Source responses and the snapshot-store peer are adapters, not a browser/Host.
// DSH_PREFIX=<patched prefix> node --test runtime/tests/input-trigger-source-recovery.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the pinned test prefix');
const bundle = join(resolve(process.env.DSH_PREFIX),
  'node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js');

function snapshotStore(value) {
  // No rendering or subscription is needed for this controller contract.
  return { getSnapshot: () => value, set(next) { value = next; } };
}

function peer(name) {
  switch (name) {
    case '@deepseek-ai/dsh-client-store': return { createSnapshotStore: snapshotStore };
    // Only the exported service class declaration uses this peer at load time.
    // The tests instantiate InputTriggerController, not that Cordis service.
    case '@deepseek-ai/cordis': return { Service: class {} };
    case 'react':
    case 'react/jsx-runtime':
    case '@deepseek-ai/dsh-client-ui-primitives': return {};
    default: throw Error(`Unexpected browser peer: ${name}`);
  }
}

let exports;
runInNewContext(readFileSync(bundle, 'utf8'), {
  window: { __ModuleLoader__: { load(entry) {
    assert.equal(entry.id, '@deepseek-ai/dsh-client-ui-input-trigger');
    exports = entry.factory(peer);
  } } },
  AbortController,
  // A failed candidate source is deliberately logged by the product.
  console: { error() {} },
}, { filename: bundle });
assert.equal(typeof exports?.InputTriggerController, 'function');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, skillCandidates) {
  const sources = [{
    trigger: '/', name: 'command', order: 1,
    async candidates(_session, { query }) {
      // These queries are prefixes of real built-in command names.
      return [{ name: 'permission' }, { name: 'plan' }]
        .filter(row => row.name.startsWith(query));
    },
  }, {
    trigger: '/', name: 'skill', order: 2, candidates: skillCandidates,
  }];
  const controller = new exports.InputTriggerController({
    actx: { bail() { throw Error('Reading candidates must not execute a command'); } },
    sessionId: 'source-recovery-session',
    roster: { all: () => sources, sources: trigger => sources.filter(s => s.trigger === trigger) },
  });
  t.after(() => controller.dispose());
  let revision = 0;
  return {
    controller,
    type(text) { controller.track(text, text.length, { tier: 'plain' }, ++revision); },
    state: () => controller.menu.getSnapshot(),
  };
}

const groupNames = state => Array.from(state.groups, group => group.source);
function itemNames(state, source) {
  const group = state.groups.find(group => group.source === source);
  assert(group, `missing ${source} group`);
  return Array.from(group.items, item => item.name);
}

test('new slash query restores a failed skill group while commands keep the menu open', async t => {
  const first = deferred();
  const queries = [];
  const f = fixture(t, async (_session, { query }) => {
    queries.push(query);
    return queries.length === 1 ? first.promise : [{ name: 'dsh-go-plugin' }];
  });
  f.type('/');
  await settle();
  assert.equal(f.state().open, true);
  assert.deepEqual(groupNames(f.state()), ['command', 'skill']);
  first.reject(Error('temporary skills/list failure'));
  await settle();
  assert.equal(f.state().open, true);
  assert.deepEqual(groupNames(f.state()), ['command']);

  f.type('/p');
  await settle();
  assert.deepEqual(queries, ['', 'p']);
  assert.equal(f.state().open, true);
  assert.deepEqual(groupNames(f.state()), ['command', 'skill']);
  assert.deepEqual(itemNames(f.state(), 'skill'), ['dsh-go-plugin']);
});

test('recovering a source keeps superseded query results out of the current menu', async t => {
  const first = deferred();
  const oldQuery = deferred();
  const signals = [];
  const f = fixture(t, async (_session, { query, signal }) => {
    signals.push(signal);
    if (query === '') return first.promise;
    if (query === 'p') return oldQuery.promise;
    return [{ name: 'dsh-go-plugin' }];
  });
  f.type('/');
  await settle();
  first.reject(Error('temporary skills/list failure'));
  await settle();
  assert.deepEqual(groupNames(f.state()), ['command']);

  f.type('/p');
  await settle();
  assert.equal(f.state().open, true);
  f.type('/pl');
  await settle();
  assert.equal(signals[1].aborted, true);
  assert.equal(f.state().hit.query, 'pl');
  assert.deepEqual(itemNames(f.state(), 'skill'), ['dsh-go-plugin']);
  oldQuery.resolve([{ name: 'dsh-go-support' }]);
  await settle();
  assert.equal(f.state().hit.query, 'pl');
  assert.deepEqual(itemNames(f.state(), 'skill'), ['dsh-go-plugin']);
});

test('healthy slash query refinement preserves its existing highlighted command', async t => {
  const f = fixture(t, async () => [{ name: 'dsh-go-plugin' }]);
  f.type('/');
  await settle();
  f.controller.hover('command', 1);
  assert.deepEqual({ ...f.state().highlight }, { source: 'command', index: 1 });
  f.type('/p');
  assert.deepEqual({ ...f.state().highlight }, { source: 'command', index: 1 });
  await settle();
  assert.deepEqual({ ...f.state().highlight }, { source: 'command', index: 1 });
  assert.deepEqual(groupNames(f.state()), ['command', 'skill']);
});

test('an empty remainder still closes the menu and a later input opens a fresh roster', async t => {
  const first = deferred();
  let calls = 0;
  const f = fixture(t, async () => ++calls === 1 ? first.promise : [{ name: 'dsh-go-plugin' }]);
  f.type('/zz');
  await settle();
  first.reject(Error('temporary skills/list failure'));
  await settle();
  assert.equal(f.state().open, false);
  assert.deepEqual(groupNames(f.state()), []);
  f.type('/p');
  await settle();
  assert.equal(calls, 2);
  assert.equal(f.state().open, true);
  assert.deepEqual(groupNames(f.state()), ['command', 'skill']);
  assert.deepEqual(itemNames(f.state(), 'skill'), ['dsh-go-plugin']);
});
