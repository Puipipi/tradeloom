// Actual pinned Tools/Session/bash execution and real loopback HTTP/SSE routes.
// The outer connection credential is a controlled transport boundary; this is
// not a full Web Host, Android boot, OS sandbox, or real model invocation.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { createSignalsFixture } from './fixtures/companion-signals-engine.mjs';
import { createCompanionRoutes } from '../bridge/dsh-go-bridge/lib/companion/routes.js';
import { createCompanionSignals } from '../bridge/dsh-go-bridge/lib/companion/signals.js';
import { apply as applyBridge } from '../bridge/dsh-go-bridge/lib/index.js';

const ROOT = '/dsh-go/v1/companion/signals';
const AUTH = 'Bearer synthetic-c760-http';
const integration = (name, run) => test(name, { skip: !process.env.DSH_PREFIX, timeout: 20000, concurrency: false }, run);
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function fixture(t) { const f = await createSignalsFixture(); t.after(() => f.dispose()); return f; }
async function until(check) {
  const deadline = performance.now() + 3000;
  while (!check()) { if (performance.now() >= deadline) assert.fail('Expected lifecycle transition'); await new Promise(setImmediate); }
}

function countSubscriptions(f) {
  const actual = f.ctx.tools.dshGoCompanionResults;
  const state = { started: 0, stopped: 0, callbacks: [] };
  // Instrument subscription ownership only; all capture/finalize/commit and
  // published values still use the real registry's private WeakMaps.
  f.ctx.tools.dshGoCompanionResults = Object.freeze({ ...actual, subscribe(callback) {
    state.started++; state.callbacks.push(callback);
    const stop = actual.subscribe(callback);
    return () => { state.stopped++; stop(); };
  } });
  return state;
}

async function server(t, f) {
  const routes = createCompanionRoutes({ store: f.store, signals: f.signals, send });
  const http = createServer((req, res) => {
    if (req.headers.authorization !== AUTH) { req.resume(); send(res, 401, { error: 'synthetic-connection-denied' }); return; }
    void routes.handle(req, res, new URL(req.url, 'http://fixture.invalid').pathname)
      .catch(() => { if (!res.destroyed) send(res, 500, { error: 'fixture-route-failed' }); });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); });
  const options = (path, method = 'GET', authorization = AUTH) => ({ hostname: '127.0.0.1',
    port: http.address().port, path, method, headers: { authorization } });
  async function json(path = ROOT, method, authorization) {
    return new Promise((resolve, reject) => {
      const req = request(options(path, method, authorization), (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end();
    });
  }
  async function stream() {
    return new Promise((resolve, reject) => {
      const req = request(options(`${ROOT}/stream`), (res) => {
        const events = new EventEmitter(), frames = [];
        let buffer = '', text = '';
        const closed = new Promise((resolveClose) => res.once('close', resolveClose));
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk; buffer += chunk;
          for (let index; (index = buffer.indexOf('\n\n')) >= 0;) {
            const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            if (raw.startsWith(':')) continue;
            const event = raw.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
            const id = raw.split('\n').find((line) => line.startsWith('id: '))?.slice(4);
            const data = raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
            if (event && data) { const frame = { event, id, data: JSON.parse(data) }; frames.push(frame); events.emit('frame', frame); }
          }
        });
        res.on('error', () => {});
        const value = { req, res, frames, closed, get text() { return text; },
          async next(name, index = 0) {
            const current = frames.filter((frame) => frame.event === name)[index];
            if (current) return current;
            return new Promise((resolveFrame, rejectFrame) => {
              const timeout = setTimeout(() => { events.off('frame', listener); rejectFrame(new Error(`Missing ${name}`)); }, 5000);
              const listener = () => { const found = frames.filter((frame) => frame.event === name)[index]; if (!found) return;
                clearTimeout(timeout); events.off('frame', listener); resolveFrame(found); };
              events.on('frame', listener);
            });
          }, close() { req.destroy(); res.destroy(); },
        };
        t.after(() => value.close()); resolve(value);
      });
      req.on('error', reject); req.end();
    });
  }
  return { json, stream };
}

integration('capability does not subscribe; explicit actual HTTP SSE publishes only committed metadata', async (t) => {
  const f = await fixture(t), subscriptions = countSubscriptions(f), http = await server(t, f);
  const cap = await http.json();
  assert.equal(cap.status, 200); assert.equal(cap.body.available, true);
  assert.equal(cap.body.maxEventBytes, 1024); assert.equal(cap.body.replay, false);
  assert.equal(subscriptions.started, 0);
  assert.equal((await http.json(ROOT, 'POST')).body.error.code, 'companion/signals-method');
  assert.equal((await http.json(`${ROOT}/unknown`)).body.error.code, 'companion/signals-not-found');
  assert.equal((await http.json(ROOT, 'GET', 'Bearer unapproved')).status, 401);
  await f.execute('node --test success.test.mjs');
  assert.equal(subscriptions.started, 0, 'A run without consent does not attach the Host observer');
  // No route needs to scan Session history to project a new committed result.
  f.agent.session.snapshotEvents = () => { throw new Error('A live summary must not read Session history'); };
  const stream = await http.stream();
  assert.deepEqual((await stream.next('companion/ready')).data, { v: 1, generation: cap.body.generation });
  assert.equal(stream.frames.length, 1, 'The pre-subscription result is not replayed');
  const executed = await f.execute('node --test failed.test.mjs');
  const frame = await stream.next('companion/run-result');
  assert.equal(frame.id, frame.data.id); assert.equal(frame.data.generation, cap.body.generation);
  assert.equal(frame.data.payload.result, 'failed'); assert.equal(frame.data.payload.exitCode, 1);
  assert.equal(frame.data.source.callId, executed.callId); assert.equal(frame.data.source.seq, f.records.at(-1).source.seq);
  assert(Buffer.byteLength(JSON.stringify(frame.data)) <= 1024);
  assert(!stream.text.match(/PRIVATE_|stdout|stderr|cwd|failed\.test|node --test/));
  stream.close(); await stream.closed; await until(() => subscriptions.stopped === 1);
});

integration('unsubscribe retires the captured publisher callback and reconnect has no replay', async (t) => {
  const f = await fixture(t), subscriptions = countSubscriptions(f), http = await server(t, f);
  const first = await http.stream(); await first.next('companion/ready');
  await f.execute('node --test success.test.mjs'); await first.next('companion/run-result');
  const oldCallback = subscriptions.callbacks[0], oldRecord = f.records[0];
  first.close(); await first.closed; await until(() => subscriptions.stopped === 1);
  const second = await http.stream(); await second.next('companion/ready');
  oldCallback(oldRecord); await new Promise(setImmediate);
  assert.equal(second.frames.length, 1, 'Retired callback cannot deliver into a new subscription');
  assert.equal(subscriptions.started, 2);
  await f.execute('node --test success.test.mjs');
  const current = await second.next('companion/run-result');
  assert.notEqual(current.data.source.seq, oldRecord.source.seq);
  f.signals.dispose();
  assert.equal((await second.next('companion/unavailable')).data.reason, 'engine-unavailable');
  await second.closed;
  assert.equal(subscriptions.stopped, 2);
  const replacement = createCompanionSignals(f.ctx); t.after(() => replacement.dispose());
  assert.notEqual((await replacement.capability()).generation, current.data.generation);
});

integration('removing the actual producer closes all live streams and advertises unavailable', async (t) => {
  const f = await fixture(t), subscriptions = countSubscriptions(f), http = await server(t, f);
  const stream = await http.stream(); await stream.next('companion/ready');
  await f.bash.dispose();
  assert.equal((await stream.next('companion/unavailable')).data.reason, 'producer-unavailable');
  await stream.closed;
  const cap = await http.json();
  assert.equal(cap.body.available, false); assert.deepEqual(cap.body.kinds, []);
  assert.equal((await http.json(`${ROOT}/stream`)).body.error.code, 'companion/signals-unavailable');
  assert.equal(subscriptions.stopped, 1);
});

function fakeExchange(backpressure = false) {
  const req = new EventEmitter(); Object.assign(req, { method: 'GET', aborted: false, resume() {} });
  const res = new EventEmitter(); Object.assign(res, { destroyed: false, destroys: 0, text: '', status: undefined,
    writeHead(status) { this.status = status; },
    write(value) { this.text += value; return !backpressure; },
    end(value = '') { this.text += value; this.emit('close'); },
    destroy() { if (this.destroyed) return; this.destroyed = true; this.destroys++; this.emit('close'); },
  });
  return { req, res };
}

integration('controlled transport backpressure destroys the socket and releases the bounded subscription slot', async (t) => {
  const f = await fixture(t), subscriptions = countSubscriptions(f);
  const blocked = fakeExchange(true);
  await f.signals.handle(blocked.req, blocked.res, `${ROOT}/stream`, send);
  assert.equal(blocked.res.destroys, 1); assert.equal(subscriptions.started, 1); assert.equal(subscriptions.stopped, 1);
  const open = [];
  for (let i = 0; i < 8; i++) { const value = fakeExchange(); open.push(value); await f.signals.handle(value.req, value.res, `${ROOT}/stream`, send); }
  const overflow = fakeExchange(); await f.signals.handle(overflow.req, overflow.res, `${ROOT}/stream`, send);
  assert.equal(overflow.res.status, 503); assert.equal(JSON.parse(overflow.res.text).error.code, 'companion/signals-capacity');
  assert.equal(subscriptions.started, 2, 'Multiple consumers share one publisher listener');
  for (const value of open) value.req.emit('aborted');
  assert.equal(subscriptions.stopped, 2);
});

test('an old or absent engine has an explicit non-collecting unavailable capability', async () => {
  let subscriptions = 0;
  const ctx = { get: () => undefined, on() { subscriptions++; return () => {}; } };
  const signals = createCompanionSignals(ctx);
  try {
    const cap = await signals.capability();
    assert.equal(cap.available, false); assert.equal(cap.reason, 'engine-unavailable');
    assert.deepEqual(cap.kinds, []); assert.deepEqual(cap.devicePower, { available: false });
    assert.deepEqual(cap.notifications, { available: false });
    assert.equal(subscriptions, 2, 'Only service/definition lifecycle listeners exist; there is no result or Session source');
    const value = fakeExchange(); await signals.handle(value.req, value.res, `${ROOT}/stream`, send);
    assert.equal(value.res.status, 503); assert.equal(JSON.parse(value.res.text).error.code, 'companion/signals-unavailable');
  } finally { signals.dispose(); }
});

test('actual bridge registration keeps both new routes behind its existing connection rejection guard', async (t) => {
  const routes = [], disposals = [], guarded = [];
  let connected = true;
  const ctx = { logger: { warn() {} },
    get(name) { if (name === 'connection' && connected) return { requestRejection(req) {
      guarded.push(req.url); return req.headers.authorization === AUTH ? undefined : 401;
    } }; },
    on() { return () => {}; }, provide() {}, inject(_deps, callback) { callback(ctx); },
    effect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') disposals.push(cleanup); },
    webServer: { tapIndex() { return () => {}; }, register(route) { routes.push(route); return () => {}; }, registerUpgrade() { return () => {}; } },
  };
  applyBridge(ctx, { persist: false, guardRoutes: false });
  t.after(() => { for (const dispose of disposals.reverse()) dispose(); });
  for (const path of [ROOT, `${ROOT}/stream`]) {
    const route = routes.find((candidate) => candidate.kind === 'prefix' && path.startsWith(candidate.path));
    assert(route);
    const denied = fakeExchange(); Object.assign(denied.req, { url: path, headers: {} });
    await route.handler(denied.req, denied.res);
    assert.equal(denied.res.status, 401);
    connected = false;
    const missing = fakeExchange(); Object.assign(missing.req, { url: path, headers: { authorization: AUTH } });
    await route.handler(missing.req, missing.res);
    assert.equal(missing.res.status, 503);
    connected = true;
    const allowed = fakeExchange(); Object.assign(allowed.req, { url: path, headers: { authorization: AUTH } });
    await route.handler(allowed.req, allowed.res);
    assert.equal(allowed.res.status, path === ROOT ? 200 : 503);
    if (path === ROOT) assert.equal(JSON.parse(allowed.res.text).available, false);
  }
  assert.deepEqual(guarded, [ROOT, ROOT, `${ROOT}/stream`, `${ROOT}/stream`]);
});
