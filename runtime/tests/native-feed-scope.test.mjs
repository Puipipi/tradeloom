import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { normalizeScope } from '../bridge/dsh-go-bridge/lib/native/util.js';
import { LIMITS } from '../bridge/dsh-go-bridge/lib/native/limits.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const dir = mkdtempSync(join(tmpdir(), 'native-feed-scope-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scope-fixture', version: '1.0.0', dshGo: {
    v: 1, contributes: { panels: [{ id: 'p', title: 'P' }, { id: 'q', title: 'Q' }] },
  } }));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n');
  const entry = { options: { name: join(dir, 'index.js') }, parent: { tree: { ctx: { baseUrl: pathToFileURL(`${dir}/`).href } } } };
  entry.fiber = { uid: 1, entry, parent: { fiber: null } };
  const core = new NativeCore({ get: name => name === 'loader' ? { entries: () => [entry] } : undefined }, LIMITS, 'test');
  const caller = { fiber: { parent: { fiber: entry.fiber } }, effect: fn => fn() };
  const emissions = new Map();
  core.service.panel.call({ ctx: caller }, 'p', { view: {}, data(scope, emit, caps) {
    emissions.set(`${scope.sessionId}:${caps.locale}`, emit);
    // The plugin receives its own copy, so mutation must not change routing.
    if (scope.sessionId === 'silent') return;
    scope.sessionId = 'plugin-mutated';
    emit({ n: 0, keep: true });
  } });
  core.service.panel.call({ ctx: caller }, 'q', { view: {} });
  t.after(() => { core.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return { core, emissions };
}

for (const count of [1, 16, 64]) {
  test(`patchFeed avoids repeat scope serialization across ${count} live feeds`, t => {
    const { core } = setup(t);
    const scopes = Array.from({ length: count }, (_, i) => normalizeScope({ sessionId: `s${i}` }));
    const identities = new Set(scopes.map(scope => scope.scope));
    const original = JSON.stringify;
    let constructionSerializations = 0;
    JSON.stringify = function(value, ...args) {
      if (identities.has(value)) constructionSerializations++;
      return original.call(this, value, ...args);
    };
    let feeds;
    try { feeds = scopes.map(scope => core.feed('scope-fixture', 'p', 'panel', scope)); }
    finally { JSON.stringify = original; }
    t.mock.timers.tick(1);
    let serializations = 0;
    JSON.stringify = function(value, ...args) {
      if (identities.has(value)) serializations++;
      return original.call(this, value, ...args);
    };
    try {
      for (let i = 0; i < 100; i++) core.patchFeed('scope-fixture', 'p', scopes[0], { n: i });
    } finally { JSON.stringify = original; }
    t.diagnostic(`feeds=${count} patches=100 construction=${constructionSerializations} patch-scope-serializations=${serializations}`);
    assert.equal(feeds[0].pending.value.n, 99);
    for (const feed of feeds.slice(1)) assert.equal(feed.pending, undefined);
    assert.equal(serializations, 0, 'canonical scopes do not change between patch effects');
    assert.equal(constructionSerializations, count, 'one key serialization per new feed');
  });
}

test('patch scope remains exact across locale, pending emits, plugin mutation and recreated feeds', t => {
  const { core, emissions } = setup(t);
  const scope = normalizeScope({ turnId: 't1', sessionId: 's1' });
  const reordered = normalizeScope({ sessionId: 's1', turnId: 't1' });
  const zh = core.feed('scope-fixture', 'p', 'panel', scope, 'zh-CN');
  const en = core.feed('scope-fixture', 'p', 'panel', reordered, 'en');
  const partial = core.feed('scope-fixture', 'p', 'panel', normalizeScope({ sessionId: 's1' }));
  const sibling = core.feed('scope-fixture', 'p', 'panel', normalizeScope({ sessionId: 's1', turnId: 't2' }));
  const silentScope = normalizeScope({ sessionId: 'silent' });
  const silent = core.feed('scope-fixture', 'p', 'panel', silentScope);
  const empty = core.feed('scope-fixture', 'q', 'panel', scope);
  t.mock.timers.tick(1);
  emissions.get('s1:en')({ n: 7, keep: 'latest', nested: { a: 1 } });
  core.patchFeed('wrong-package', 'p', scope, { wrong: true });
  core.patchFeed('scope-fixture', 'wrong-id', scope, { wrong: true });
  core.patchFeed('scope-fixture', 'p', reordered, { x: 1, nested: { b: 2 } });
  assert.deepEqual(zh.pending.value, { n: 0, keep: true, x: 1, nested: { b: 2 } });
  assert.deepEqual(en.pending.value, { n: 7, keep: 'latest', nested: { a: 1, b: 2 }, x: 1 });
  assert.equal(partial.pending, undefined);
  assert.equal(sibling.pending, undefined);
  core.patchFeed('scope-fixture', 'p', silentScope, { mustNotInitialize: true });
  assert.equal(silent.pending, undefined);
  core.patchFeed('scope-fixture', 'q', scope, { mustNotInitialize: true });
  assert.equal(empty.pending, undefined);
  assert.deepEqual(zh.scope, { sessionId: 's1', turnId: 't1' });
  zh.stop();
  const replacement = core.feed('scope-fixture', 'p', 'panel', scope, 'zh-CN');
  t.mock.timers.tick(1);
  core.patchFeed('scope-fixture', 'p', scope, { replacement: true });
  assert.notEqual(replacement, zh);
  assert.equal(replacement.pending.value.replacement, true);
  assert.equal(zh.stopped, true);
});


for (const aliases of [
  ['zh_CN', 'ZH-cn', 'zh-CN'],
  ['zh_Hant_TW', 'ZH-hAnT-tW', 'zh_Hant-TW', 'zh-Hant_TW'],
  ['en_Latn_US_posix', 'EN-lAtN-us-POSIX', 'en_Latn-US_posix'],
]) {
  test(`feed locale aliases share one data source: ${aliases[0]}`, t => {
    const { core, emissions } = setup(t);
    const scope = normalizeScope({ sessionId: 'locale' });
    const feed = core.feed('scope-fixture', 'p', 'panel', scope, aliases[0]);
    for (const alias of aliases.slice(1)) {
      assert.equal(core.feed('scope-fixture', 'p', 'panel', scope, alias) === feed, true,
        `${alias} must reuse ${aliases[0]}`);
    }
    assert.equal(emissions.size, 1, 'aliases start the plugin data function only once');
    assert.deepEqual([...emissions.keys()], [`locale:${aliases[0]}`], 'the first caller locale stays unchanged');
    assert.notEqual(core.feed('scope-fixture', 'p', 'panel', scope, 'fr-FR'), feed);
    assert.notEqual(core.feed('scope-fixture', 'p', 'panel', normalizeScope({ sessionId: 'other' }), aliases[0]), feed);
    assert.equal(emissions.size, 3, 'a different locale and a different scope stay independent');
  });
}
