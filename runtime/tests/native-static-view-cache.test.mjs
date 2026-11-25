import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { createNativeRoutes } from '../bridge/dsh-go-bridge/lib/native/routes.js';
import { effectiveLimits } from '../bridge/dsh-go-bridge/lib/native/limits.js';

const MARKER = 'native-static-cost';

async function fixture(t, initial) {
  const dir = mkdtempSync(join(tmpdir(), 'native-static-cache-'));
  const file = join(dir, 'view.json');
  let version = 0;
  const write = (raw) => {
    writeFileSync(file, raw);
    const time = new Date(1_700_000_000_000 + ++version * 1000);
    utimesSync(file, time, time);
  };
  write(initial);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'static-cache-test', version: '1.0.0', dshGo: {
    v: 1, contributes: { panels: [{ id: 'panel', title: { en: 'Panel', zh: '面板' }, view: 'view.json' }] },
  } }));
  writeFileSync(join(dir, 'index.js'), '');
  const entry = { options: { name: pathToFileURL(join(dir, 'index.js')).href },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(dir + '/').href } } }, fiber: { uid: 7 } };
  const disposers = [];
  const core = new NativeCore({ get: name => name === 'loader' ? { entries: () => [entry] } : undefined,
    logger: { warn() {} } }, effectiveLimits({}), 'test');
  const routes = createNativeRoutes(core);
  const service = Object.assign(Object.create(core.service), { ctx: { fiber: { entry },
    effect(fn) { const off = fn(); disposers.push(off); return off; } } });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    routes.handle(req, res, url.pathname, url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    routes.dispose(); core.dispose();
    while (disposers.length) disposers.pop()();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (locale = 'en') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/dsh-go/v1/views/static-cache-test/panel?locale=${locale}`);
    return { status: res.status, ...await res.json() };
  };
  return { file, write, core, service, get };
}

function observeJson(t) {
  const stringify = JSON.stringify, parse = JSON.parse;
  const counts = { viewStringify: 0, viewParse: 0, responseStringify: 0 };
  JSON.stringify = function (value, ...args) {
    if (value?.marker === MARKER) counts.viewStringify++;
    if (value?.view?.marker === MARKER) counts.responseStringify++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  };
  JSON.parse = function (text, ...args) {
    if (typeof text === 'string' && text.startsWith(`{"marker":"${MARKER}"`)) counts.viewParse++;
    return Reflect.apply(parse, JSON, [text, ...args]);
  };
  t.after(() => { JSON.stringify = stringify; JSON.parse = parse; });
  return counts;
}

for (const length of [64, 8192, 24000]) test(`warm static view skips repeated normalization (${length} text bytes)`, async t => {
  const model = { marker: MARKER, type: 'text', text: 'x'.repeat(length) };
  const text = JSON.stringify(model), bytes = Buffer.byteLength(text);
  const f = await fixture(t, text);
  const counts = observeJson(t);
  const first = await f.get();
  assert.equal(first.status, 200);
  assert.deepEqual(first.view, model);
  assert.deepEqual(counts, { viewStringify: 1, viewParse: 2, responseStringify: 1 });
  counts.viewStringify = counts.viewParse = counts.responseStringify = 0;
  for (let i = 0; i < 20; i++) {
    const result = await f.get(i % 2 ? 'zh' : 'en');
    assert.equal(result.status, 200);
    assert.deepEqual(result.view, model);
    assert.equal(result.title, i % 2 ? '面板' : 'Panel');
    assert.deepEqual(result.stats, { bytes, nodes: 1, depth: 1 });
  }
  console.log(JSON.stringify({ textBytes: length, requests: 20, ...counts }));
  assert.equal(counts.responseStringify, 20, 'wire responses still serialize separately');
  assert.equal(counts.viewStringify, 0);
  assert.equal(counts.viewParse, 0);
});

test('same-size file changes with a new mtime refresh the normalized value', async t => {
  const f = await fixture(t, '{"type":"text","text":"OLD"}');
  assert.equal((await f.get()).view.text, 'OLD');
  f.write('{"type":"text","text":"NEW"}');
  const first = await f.get(), second = await f.get();
  assert.equal(first.view.text, 'NEW');
  assert.deepEqual(first, second);
});

test('normalization keeps JSON number and own-key semantics across warm reads', async t => {
  const f = await fixture(t, '{"type":"text","text":"numbers","n":1e400,"z":-0,"__proto__":{"kept":true}}');
  for (let i = 0; i < 2; i++) {
    const r = await f.get();
    assert.equal(r.status, 200); assert.equal(r.view.n, null);
    assert.equal(Object.is(r.view.z, -0), false);
    assert.equal(Object.hasOwn(r.view, '__proto__'), true);
    assert.deepEqual(r.view.__proto__, { kept: true });
    assert.equal({}.kept, undefined);
  }
});

test('dynamic views continue observing caller-owned mutable data', async t => {
  const f = await fixture(t, '{"type":"text","text":"STATIC"}');
  assert.equal((await f.get()).view.text, 'STATIC');
  const dynamic = { type: 'text', text: 'FIRST' };
  const off = f.service.panel('panel', { view: dynamic });
  assert.equal((await f.get()).view.text, 'FIRST');
  dynamic.text = 'SECOND';
  assert.equal((await f.get()).view.text, 'SECOND');
  off();
  assert.equal((await f.get()).view.text, 'STATIC');
});

test('missing, malformed, oversize and unnormalizable files keep their error paths', async t => {
  const f = await fixture(t, '{"type":"text","text":"OK"}');
  assert.equal((await f.get()).status, 200);
  unlinkSync(f.file);
  assert.equal((await f.get()).error.code, 'invalid-view');
  for (const text of ['{', '[]', '{"type":"text","text":"' + 'x'.repeat(33000) + '"}']) {
    f.write(text);
    const r = await f.get(); assert.equal(r.status, 500); assert.equal(r.error.code, 'invalid-view');
  }
  f.write('{"a":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}');
  for (let i = 0; i < 2; i++) {
    const r = await f.get(); assert.equal(r.status, 500); assert.equal(r.error.code, 'plugin-error');
    assert.equal(f.core.health.get('static-cache-test')?.total ?? 0, 0);
  }
  f.write('{"type":"text","text":"RECOVERED"}');
  assert.equal((await f.get()).view.text, 'RECOVERED');
});

test('static view byte budget includes number normalization, on cold and repeated reads', async t => {
  const raw = '{"type":"text","text":"Numeric metadata","values":[' + Array(1600).fill('1e20').join(',') + ']}';
  const rawBytes = Buffer.byteLength(raw), normalizedBytes = Buffer.byteLength(JSON.stringify(JSON.parse(raw)));
  assert(rawBytes < 32768); assert(normalizedBytes > 32768);
  const f = await fixture(t, raw);
  for (let i = 0; i < 2; i++) {
    const r = await f.get();
    t.diagnostic(JSON.stringify({ attempt: i, rawBytes, normalizedBytes, status: r.status, stats: r.stats, error: r.error }));
    assert.equal(r.status, 500, 'static views must obey the normalized JSON byte budget');
    assert.equal(r.error.code, 'invalid-view');
  }
  f.write('{"type":"text","text":"RECOVERED"}');
  assert.equal((await f.get()).view.text, 'RECOVERED');
});

test('static view accepts exactly the normalized byte limit', async t => {
  const base = '{"type":"text","text":"","values":[' + Array(1000).fill('1e20').join(',') + ']}';
  const padding = 32768 - Buffer.byteLength(JSON.stringify(JSON.parse(base)));
  assert(padding > 0);
  const raw = base.replace('"text":""', '"text":"' + 'x'.repeat(padding) + '"');
  const model = JSON.parse(raw);
  assert(Buffer.byteLength(raw) < 32768);
  assert.equal(Buffer.byteLength(JSON.stringify(model)), 32768);
  const f = await fixture(t, raw);
  for (let i = 0; i < 2; i++) {
    const r = await f.get();
    assert.equal(r.status, 200); assert.equal(r.stats.bytes, 32768); assert.deepEqual(r.view, model);
  }
});

test('static scientific numbers under both budgets preserve their JSON values', async t => {
  const raw = '{"type":"text","text":"Small numeric metadata","values":[1e20,1e-7,1e400,-0]}';
  const model = JSON.parse(JSON.stringify(JSON.parse(raw)));
  const bytes = Buffer.byteLength(JSON.stringify(model));
  assert(Buffer.byteLength(raw) < 32768); assert(bytes < 32768);
  const f = await fixture(t, raw);
  for (let i = 0; i < 2; i++) {
    const r = await f.get(); assert.equal(r.status, 200); assert.equal(r.stats.bytes, bytes); assert.deepEqual(r.view, model);
  }
});
