// Use the shipped Web Search factory, its public slot actions, and the real
// bundled SettingsFormModel/store closures. Only scopes, RPC replies and the
// effect/slot boundary are adapters; no React, Host, credentials or network run.
// DSH_PREFIX=<patched prefix> node --test runtime/tests/web-search-key-write-result.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the pinned test prefix');
const packages = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const assets = join(packages, 'dsh-web-frontend/dist/assets');
const entries = readdirSync(assets).filter(name => /^index-.*\.js$/.test(name));
assert.equal(entries.length, 1, 'One shipped frontend entry is required');
const frontendPath = join(assets, entries[0]);
const frontend = readFileSync(frontendPath, 'utf8');
const pagePath = join(packages, 'dsh-client-ui-settings-web-search/lib/client.js');

function between(source, start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert(begin >= 0 && finish > begin, `Missing shipped region: ${start}`);
  assert.equal(source.indexOf(start, begin + start.length), -1,
    `Ambiguous shipped region: ${start}`);
  assert.equal(source.indexOf(end, finish + end.length), -1,
    `Ambiguous shipped region end: ${end}`);
  return source.slice(begin, finish);
}

// The first region starts inside a const declaration; retain the complete
// Zustand/Immer/store closure and add only its declaration prefix. The second
// region contains the real field helpers and the complete SettingsFormModel.
const primitives = runInNewContext(`const ${between(frontend, 'iI={},oI=', 'function II(')}
${between(frontend, 'function fA(e){', ';const mA=')};
({store: SI, SettingsFormModel: pA, settingsNumberField: fA, settingsTextField: hA})`,
{ console, queueMicrotask }, { filename: frontendPath });

function peer(name) {
  switch (name) {
    case '@deepseek-ai/dsh-client-store': return primitives.store;
    case '@deepseek-ai/dsh-client-ui-primitives': return primitives;
    // The factory registers its component, but this fixture does not render it.
    case 'react/jsx-runtime': return {};
    default: throw Error(`Unexpected browser peer: ${name}`);
  }
}

let api;
runInNewContext(readFileSync(pagePath, 'utf8'), {
  queueMicrotask,
  window: { __ModuleLoader__: { load(entry) {
    assert.equal(entry.id, '@deepseek-ai/dsh-client-ui-settings-web-search');
    api = entry.factory(peer);
  } } },
}, { filename: pagePath });
assert.equal(typeof api?.apply, 'function');

const REF = 'DEEPSEEK_API_KEY';
const DRAFT = 'fixture-replacement-not-a-real-key';
const ok = value => ({ ok: true, value });
const refused = () => ({
  ok: false,
  error: { code: 'credential/rejected', message: 'fixture publication refused' },
});
const described = configured => ok({ [REF]: { configured, writable: true } });

async function fixture(t, { configured = true, writes, readback } = {}) {
  const disposers = [];
  const waiters = new Set();
  const registrations = new Map();
  const writeReplies = [...writes];
  const calls = [];
  let closed = false;
  const scope = (value) => ({
    ...primitives.store.createSnapshotStore({
      status: 'ready', writable: true, revision: 1, base: value, value, user: {},
    }),
    mutate() { throw Error('A key-only edit must use credentials, not settings.mutate'); },
  });
  const scopes = new Map([
    ['web', scope({ searchProvider: 'deepseek-official', fetchProvider: 'http' })],
    ['web-search-deepseek', scope({ apiKeyEnv: REF, baseURL: '', maxUses: 5 })],
    ['web-deepseek-api', scope({ apiKeyEnv: REF, baseURL: '', count: 10 })],
  ]);
  function close() {
    if (closed) return;
    closed = true;
    // Every RPC adapter settles immediately. Release only test-side listeners
    // if an assertion or the bounded test timeout interrupts an awaiting save.
    for (const waiter of waiters) {
      waiter.off();
      waiter.resolve();
    }
    waiters.clear();
    for (const dispose of disposers.reverse()) dispose?.();
  }
  t.after(close);
  const ctx = {
    effect(setup) {
      const dispose = setup();
      disposers.push(dispose);
      return dispose;
    },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      inject(name, mount) {
        assert.equal(name, 'plugins.item');
        return mount();
      },
      register(options, component) {
        assert.equal(options.name, 'plugins.item');
        assert.equal(registrations.has(options.id), false);
        const entry = { options, component };
        registrations.set(options.id, entry);
        return () => { registrations.delete(options.id); };
      },
    },
    configForms: {
      get(namespace) {
        assert(scopes.has(namespace), `Unexpected settings scope: ${namespace}`);
        return scopes.get(namespace);
      },
      whileServed(namespaces, mount) {
        assert.deepEqual([...namespaces], ['web-search-deepseek']);
        return mount();
      },
    },
    remote: {
      $on: () => () => {},
      credentials: {
        async describe(refs) {
          assert.deepEqual([...refs], [REF]);
          if (calls.length > 0 && readback) return readback();
          return described(configured);
        },
        async set(ref, value) {
          calls.push({ ref, value });
          const result = writeReplies.shift();
          assert(result, 'Unexpected extra credential write');
          if (result.ok) configured = true;
          return result;
        },
      },
    },
  };
  api.apply(ctx);
  const registration = registrations.get('web-search');
  assert(registration, 'apply must register the actual Web Search page');
  const actions = registration.options.inject();
  const store = actions.hooks.webSearchCard;
  // Drain the constructor's already-scheduled credential read, including the
  // cross-realm Promise continuation. This is an event turn, not a timed sleep.
  await settle();
  assert.equal(store.getSnapshot().apiKeyConfigured, configured);
  assert.equal(store.getSnapshot().apiKeyWritable, true);
  return {
    calls,
    state: () => store.getSnapshot(),
    edit: () => actions.edit('apiKey', DRAFT),
    async save() {
      assert.equal(store.getSnapshot().saving, false);
      const completion = Promise.withResolvers();
      let started = false;
      const off = store.subscribe(() => {
        if (store.getSnapshot().saving) started = true;
        else if (started) completion.resolve();
      });
      const waiter = { off, resolve: completion.resolve };
      waiters.add(waiter);
      try {
        // Use the same fire-and-forget action injected into the real Save button.
        actions.save();
        assert.equal(started, true, 'The existing Save action must start a write');
        await completion.promise;
      } finally {
        off();
        waiters.delete(waiter);
      }
    },
  };
}

function retained(f) {
  assert.equal(f.state().apiKey.text, DRAFT);
  assert.equal(f.state().dirty, true);
  assert.equal(f.state().failed, true);
  assert.equal(f.state().saving, false);
}

function cleared(f) {
  assert.equal(f.state().apiKey.text, '');
  assert.equal(f.state().dirty, false);
  assert.equal(f.state().failed, false);
  assert.equal(f.state().saving, false);
}

function submitted(f, count) {
  assert.deepEqual(f.calls, Array.from({ length: count }, () => ({ ref: REF, value: DRAFT })));
}

test('a refused key replacement preserves its draft despite an already configured key and retries without retyping',
{ timeout: 10000 }, async t => {
  const f = await fixture(t, { writes: [refused(), ok(undefined)] });
  f.edit();
  await f.save();
  submitted(f, 1);
  assert.equal(f.state().apiKeyConfigured, true);
  retained(f);
  await f.save();
  submitted(f, 2);
  cleared(f);
});

test('an acknowledged key write with a configured readback clears the staged value',
{ timeout: 10000 }, async t => {
  const f = await fixture(t, { writes: [ok(undefined)] });
  f.edit();
  await f.save();
  submitted(f, 1);
  assert.equal(f.state().apiKeyConfigured, true);
  cleared(f);
});

test('an acknowledged write still retains its draft when the readback is unconfigured',
{ timeout: 10000 }, async t => {
  const f = await fixture(t, {
    writes: [ok(undefined)], readback: () => described(false),
  });
  f.edit();
  await f.save();
  submitted(f, 1);
  assert.equal(f.state().apiKeyConfigured, false);
  retained(f);
});

test('a failed readback retains the draft and releases saving for both a remote refusal and a local throw',
{ timeout: 10000 }, async t => {
  // Ordinary transport/business failures resolve RemoteResult. The throw is a
  // separate local-interface boundary, not a claim about the network contract.
  for (const readback of [
    () => ({ ok: false, error: { code: 'gateway/internal', message: 'fixture read unavailable' } }),
    () => { throw Error('fixture local read assembly fault'); },
  ]) {
    const f = await fixture(t, { writes: [ok(undefined)], readback });
    f.edit();
    await f.save();
    submitted(f, 1);
    assert.equal(f.state().apiKeyConfigured, true);
    retained(f);
  }
});

test('an initially unconfigured key stays staged after refusal and the next explicit save can configure it',
{ timeout: 10000 }, async t => {
  const f = await fixture(t, { configured: false, writes: [refused(), ok(undefined)] });
  f.edit();
  await f.save();
  submitted(f, 1);
  assert.equal(f.state().apiKeyConfigured, false);
  retained(f);
  await f.save();
  submitted(f, 2);
  assert.equal(f.state().apiKeyConfigured, true);
  cleared(f);
});
