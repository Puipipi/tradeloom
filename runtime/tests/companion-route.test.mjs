import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apply } from '../bridge/dsh-go-bridge/lib/index.js';

const ROOT = '/dsh-go/v1/companion';
const AUTH = 'Bearer synthetic-companion-test';
async function fixture(t, { connection = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-go-companion-route-'));
  const path = join(home, 'companion', 'state.json');
  const routes = [], disposals = [], guarded = [];
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'connection' && connection) return {
        requestRejection(req) {
          guarded.push(req.url);
          return req.headers.authorization === AUTH ? undefined : 401;
        },
      };
    },
    on() {}, provide() {},
    inject(_deps, fn) { fn(ctx); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposals.push(dispose); },
    webServer: {
      tapIndex() { return () => {}; },
      register(route) { routes.push(route); return () => {}; },
      registerUpgrade() { return () => {}; },
    },
  };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { apply(ctx, { persist: false, guardRoutes: false }); }
  finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
  const server = createServer((req, res) => {
    const route = routes.find((r) => r.kind === 'prefix' && req.url.startsWith(r.path));
    if (!route) { res.writeHead(404); res.end(); return; }
    void Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500); res.end('Unexpected test harness failure');
      t.diagnostic(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    disposals.reverse().forEach((dispose) => dispose());
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  async function request(pathname = ROOT, { method = 'GET', body, auth = true, contentType = 'application/json' } = {}) {
    const headers = {};
    if (auth) headers.authorization = AUTH;
    if (body !== undefined) headers['content-type'] = contentType;
    const response = await fetch(`${origin}${pathname}`, { method, headers,
      ...(body === undefined ? {} : { body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers,
      body: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
  }
  return { home, path, origin, guarded, request };
}
const version = (snapshot) => ({ storeId: snapshot.storeId, expectedRevision: snapshot.revision });
const memory = () => ({ id: randomUUID(), kind: 'preference', text: '工作日不喝咖啡，周末偶尔喝。',
  keywords: ['咖啡'], pinned: false, source: { kind: 'manual' }, expiresAt: null });

test('existing connection guard rejects every companion route before any storage access', async (t) => {
  const f = await fixture(t);
  for (const [path, method] of [[ROOT, 'GET'], [`${ROOT}/memories`, 'GET'], [`${ROOT}/memories`, 'POST'],
    [`${ROOT}/events`, 'POST'], [`${ROOT}/context`, 'POST'], [`${ROOT}/export`, 'GET'],
    [`${ROOT}/memories/delete`, 'POST'], [`${ROOT}/memories/clear`, 'POST'],
    [`${ROOT}/recall`, 'GET'], [`${ROOT}/recall/bind`, 'POST'],
    [`${ROOT}/recall/revoke`, 'POST'], [`${ROOT}/recall/bindings/${randomUUID()}`, 'GET']]) {
    const result = await f.request(path, { method, auth: false, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.guarded.length, 12);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  const absent = await fixture(t, { connection: false });
  assert.equal((await absent.request()).status, 503);
  await assert.rejects(stat(absent.path), { code: 'ENOENT' });
});

test('an unadapted Host keeps recall explicitly unsupported and basic companion routes usable', async (t) => {
  const f = await fixture(t);
  const result = await f.request(`${ROOT}/recall`);
  assert.equal(result.status, 200);
  assert.equal(result.body.supported, false);
  assert.equal(typeof result.body.reason, 'string');
  assert.equal(result.body.busy, false);
  assert.equal(result.body.activeBindingId, null);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  assert.equal((await f.request()).status, 200);
});

test('HTTP lifecycle preserves memory across reads and removes it from every public surface', async (t) => {
  const f = await fixture(t);
  const initial = await f.request();
  assert.equal(initial.status, 200);
  assert.equal(initial.body.capabilities.automaticRecall, false);
  assert.equal(initial.body.capabilities.persistence, 'host');
  assert.equal(initial.headers.get('x-content-type-options'), 'nosniff');
  const item = memory();
  const saved = await f.request(`${ROOT}/memories`, { method: 'POST', body: { ...version(initial.body), memory: item } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.memory.text, item.text);
  assert.equal(saved.body.memoryRevision, 1);
  const context = await f.request(`${ROOT}/context`, { method: 'POST', body: { query: '今天喝咖啡吗' } });
  assert.deepEqual(context.body.memories.map((m) => m.id), [item.id]);
  assert.equal(context.body.textCodePoints, [...item.text].length);
  const conflict = await f.request(`${ROOT}/events`, { method: 'POST', body: { ...version(initial.body), type: 'pet' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'companion/conflict');
  const removed = await f.request(`${ROOT}/memories/delete`, { method: 'POST', body: { ...version(saved.body), id: item.id } });
  assert.equal(removed.body.deleted, true);
  for (const [path, options] of [[`${ROOT}/memories`, {}], [`${ROOT}/context`, { method: 'POST', body: { query: '咖啡' } }], [`${ROOT}/export`, {}]]) {
    const result = await f.request(path, options);
    assert.equal(result.status, 200);
    assert(!JSON.stringify(result.body).includes(item.text));
    assert(!JSON.stringify(result.body).includes(item.id));
  }
  assert(!(await readFile(f.path, 'utf8')).includes(item.text));
});

test('malformed requests are bounded and do not initialize or mutate a store', async (t) => {
  const f = await fixture(t);
  const bad = [
    [`${ROOT}/context`, { method: 'POST', body: '{}', contentType: 'text/plain' }, 415],
    [`${ROOT}/context`, { method: 'POST', body: '{' }, 400],
    [`${ROOT}/context`, { method: 'POST', body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }, 400],
    [`${ROOT}/context`, { method: 'POST', body: ' '.repeat(16 * 1024 + 1) }, 413],
    [`${ROOT}/context`, { method: 'POST', body: { query: '🙂'.repeat(257) } }, 400],
    [`${ROOT}/context`, { method: 'POST', body: { limit: 13 } }, 400],
    [`${ROOT}/events`, { method: 'POST', body: { storeId: randomUUID(), expectedRevision: 0, type: 'arbitrary' } }, 400],
    [`${ROOT}/events`, { method: 'GET' }, 405],
    [`${ROOT}/unknown`, {}, 404],
    [`${ROOT}/memories`, { method: 'DELETE' }, 405],
  ];
  for (const [path, options, status] of bad) {
    const result = await f.request(path, options);
    assert.equal(result.status, status);
    assert(result.body.error.code.startsWith('companion/'));
    assert(!JSON.stringify(result.body).includes(f.home));
  }
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  const first = (await f.request()).body;
  const bytes = await readFile(f.path);
  const extra = await f.request(`${ROOT}/events`, { method: 'POST', body: { ...version(first), type: 'pet', approved: true } });
  assert.equal(extra.status, 400);
  assert.deepEqual(await readFile(f.path), bytes);
});

test('corrupt files remain unchanged and errors do not disclose content or paths', async (t) => {
  const f = await fixture(t);
  const first = (await f.request()).body;
  const damaged = 'SYNTHETIC_PRIVATE_MEMORY broken JSON';
  await writeFile(f.path, damaged);
  for (const [path, options] of [[ROOT, {}], [`${ROOT}/events`, { method: 'POST', body: { ...version(first), type: 'pet' } }]]) {
    const result = await f.request(path, options);
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'companion/corrupt-store');
    assert(!JSON.stringify(result.body).includes('SYNTHETIC_PRIVATE_MEMORY'));
    assert(!JSON.stringify(result.body).includes(f.home));
  }
  assert.equal(await readFile(f.path, 'utf8'), damaged);
});

test('aborting a partial JSON request does not write or kill the HTTP server', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => {
    const req = httpRequest(`${f.origin}${ROOT}/memories`, { method: 'POST',
      headers: { authorization: AUTH, 'content-type': 'application/json', 'content-length': '1000' } });
    req.on('error', () => resolve());
    req.on('socket', (socket) => socket.once('connect', () => {
      req.write('{"memory":');
      setImmediate(() => req.destroy());
    }));
  });
  // The next request also makes any pending abort event observable to the server loop.
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 0);
  assert.deepEqual((await f.request(`${ROOT}/memories`)).body.memories, []);
});
