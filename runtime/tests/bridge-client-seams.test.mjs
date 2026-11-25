import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const client = readFileSync(new URL('../bridge/dsh-go-bridge/lib/client.js', import.meta.url), 'utf8');
const root = new URL('../../', import.meta.url);
const clone = (value) => JSON.parse(JSON.stringify(value));

// The renderer elects the lowest-priority live entry of each id/key; raw
// entries remain its inspection surface. Notifications are microtask-batched.
function bridgePage() {
  const records = new Map();
  const subscriptions = new Map();
  const owners = new Map();
  const cleanups = [];
  const posts = [];
  const events = new Map();
  let plugin;
  let pending = false;
  const changed = (key) => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      for (const fn of subscriptions.get(key) || []) fn();
    });
  };
  const slots = {
    ctx: { fiber: { entry: { options: { name: 'dsh-go-bridge/client' } } } },
    entries: (key) => [...(records.get(key) || [])].sort((a, b) => (a.options.priority || 0) - (b.options.priority || 0)),
    entriesOfSlot(key) {
      const seen = new Set();
      return this.entries(key).filter((e) => {
        const cell = e.options.id ?? e.options.key;
        if (seen.has(cell)) return false;
        seen.add(cell);
        return true;
      });
    },
    snapshot: () => [...records.keys()].map((name) => ({ type: 'slot', name })),
    _register(options, component) {
      const entry = { options, component, registrant: this.ctx.fiber.name };
      const list = records.get(options.name) || [];
      records.set(options.name, [...list, entry]);
      changed(options.name);
      return () => {
        records.set(options.name, records.get(options.name).filter((e) => e !== entry));
        changed(options.name);
      };
    },
    register(options, component) { return this._register(options, component); },
    subscribe(key, fn) {
      const listeners = subscriptions.get(key) || new Set();
      subscriptions.set(key, listeners);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    inject: (_key, fn) => fn(),
  };
  const window = {
    __DSH_BOOT__: { rev: 'fixture' },
    __ModuleLoader__: { load: (entry) => { plugin = entry.factory(() => {}); } },
  };
  vm.runInNewContext(client, {
    window, location: { hash: '' }, document: { baseURI: 'http://localhost/' },
    URL, console, queueMicrotask,
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: async (_url, options) => { posts.push(JSON.parse(options.body)); return { ok: true }; },
  });
  plugin.apply({
    get: (name) => name === 'slots' ? slots : name === 'loader' ? { entries: () => [...owners.values()] } : undefined,
    on: (event, fn) => { events.set(event, fn); },
    effect: (fn) => { const off = fn(); if (off) cleanups.push(off); },
  });
  function add(pkg, cell, { slot = 'shell.overlay', priority = 0, field = 'id' } = {}) {
    const owner = pkg || 'unresolved';
    if (pkg) owners.set(owner, { fiber: { name: owner }, options: { name: pkg + '/client' } });
    const service = Object.create(slots);
    service.ctx = { fiber: { name: owner, ...(pkg ? { entry: { options: { name: pkg + '/client' } } } : {}) } };
    return service.register({ name: slot, [field]: cell, priority }, () => owner);
  }
  return {
    api: window.__dshGoBridge, add, posts, slots,
    visible: (key = 'shell.overlay') => slots.entriesOfSlot(key).map((e) => e.component()).filter(Boolean),
    dispose: () => { for (const off of cleanups.reverse()) off(); },
  };
}

test('filter isolates package + cell, including official and unresolved occupants; reports stay original', async () => {
  const p = bridgePage();
  p.add('one', 'pet');
  p.add('one', 'other');
  p.add('two', 'pet-two');
  p.add('@deepseek-ai/notice', 'notice');
  p.add(null, 'unknown');
  const before = clone(p.api.occupants('shell.overlay')).map(({ masked, ...o }) => o);
  assert.equal(p.api.filter('shell.overlay', [{ package: 'one', cell: 'pet' }]), true);
  assert.deepEqual(p.visible(), ['one']);
  const after = clone(p.api.occupants('shell.overlay'));
  assert.deepEqual(after.map(({ masked, ...o }) => o), before);
  assert.equal(after.filter((o) => o.masked).length, 4);
  await p.api.report();
  assert.deepEqual(p.posts.at(-1).slots['shell.overlay'], before);
  assert.ok(before.every((o) => o.active));
  assert.ok(!JSON.stringify(p.posts).includes('dsh-go-bridge"'));
  p.dispose();
});

test('filter updates, late registrations and cleanup do not promote shadowed plugins', async () => {
  const p = bridgePage();
  p.add('two', 'shared', { priority: -1 });
  p.add('one', 'shared');
  p.add('one', 'own');
  p.api.filter('shell.overlay', [{ package: 'one', cell: 'shared' }]);
  assert.deepEqual(p.visible(), []);
  assert.equal(p.api.occupants('shell.overlay').find((o) => o.package === 'one' && o.cell === 'shared').active, false);
  p.api.filter('shell.overlay', [{ package: 'one', cell: 'own' }]);
  assert.deepEqual(p.visible(), ['one']);
  p.add('three', 'later');
  p.add('four', 'shared', { priority: -1e12 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.visible(), ['one']);
  p.api.filter('shell.overlay', []);
  assert.deepEqual(p.visible(), []);
  p.dispose();
  assert.deepEqual(p.visible().sort(), ['four', 'one', 'three']);
});

test('legacy mask still hides only official entries and leaves unknown attribution visible', () => {
  const p = bridgePage();
  p.add('one', 'pet');
  p.add(null, 'unknown');
  p.add('@deepseek-ai/notice', 'notice');
  assert.equal(p.api.mask('shell.overlay'), true);
  assert.deepEqual(p.visible().sort(), ['one', 'unresolved']);
  p.dispose();
});

test('long-tail slots each support strict isolation without changing occupancy', () => {
  for (const slot of ['sidebar.footer.action', 'settings.plugins.tab', 'plugins.detail.section']) {
    const p = bridgePage();
    p.add('one', 'entry', { slot });
    p.add('two', 'other', { slot });
    const before = clone(p.api.occupants(slot)).map(({ masked, ...o }) => o);
    assert.equal(p.api.filter(slot, [{ package: 'one', cell: 'entry' }]), true);
    assert.deepEqual(p.visible(slot), ['one']);
    assert.deepEqual(clone(p.api.occupants(slot)).map(({ masked, ...o }) => o), before);
    p.dispose();
  }
});

function island(scenario) {
  return JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('app/test/plugins/islands/support/island_page_harness.mjs', root)),
    fileURLToPath(new URL('app/assets/islands/island.js', root)),
    JSON.stringify(scenario),
  ], { encoding: 'utf8' }));
}

const occupied = (slot) => ({ [slot]: [
  { package: 'one', cell: 'entry', active: true },
  { package: 'two', cell: 'other', active: true },
] });

test('overlay refuses old bridge or failed filter rather than showing all plugins', () => {
  for (const filter of ['missing', 'fail']) {
    const out = island({ target: 'overlay', package: 'one', cell: 'entry', filter, occupants: occupied('shell.overlay') });
    assert.ok(out.messages.some((m) => m.code === 'filter-unavailable'));
    assert.ok(!out.messages.some((m) => m.t === 'ready'));
    assert.equal(out.island, null);
  }
});

test('long-tail recipes navigate real controls before declaring readiness', () => {
  for (const target of ['footer', 'settings-plugin', 'plugin-detail']) {
    const slot = { footer: 'sidebar.footer.action', 'settings-plugin': 'settings.plugins.tab', 'plugin-detail': 'plugins.detail.section' }[target];
    const out = island({ target, package: 'one', cell: 'entry', filter: 'ok', occupants: occupied(slot) });
    assert.ok(out.messages.some((m) => m.t === 'ready'), JSON.stringify(out));
    assert.equal(out.island, 'entry');
    assert.equal(out.filters[0].slot, slot);
    assert.deepEqual(out.filters[0].allow, [{ package: 'one', cell: 'entry' }]);
  }
});

test('settings tab click without selected state and missing plugin detail degrade without ready', () => {
  for (const target of ['settings-plugin', 'plugin-detail']) {
    const slot = target === 'settings-plugin' ? 'settings.plugins.tab' : 'plugins.detail.section';
    const out = island({ target, package: 'one', cell: 'entry', filter: 'ok', ignoreClicks: true, occupants: occupied(slot) });
    assert.ok(!out.messages.some((m) => m.t === 'ready'), JSON.stringify(out));
  }
});
