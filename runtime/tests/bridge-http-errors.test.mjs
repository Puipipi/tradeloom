// Real bridge HTTP dispatch with modeled Cordis/Connection services; no DSH prefix.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {test} from 'node:test';
import {apply} from '../bridge/dsh-go-bridge/lib/index.js';
import {withSources} from './plugin-config-source-fixture.mjs';

async function fixture(t, {connection = true, guardRoutes = false, rejection, graph, entries} = {}) {
  const dispose = [];
  const editor = {canWrite: () => true, entries: () => entries};
  const webServer = {
    exact: new Map(), prefixes: new Map(), upgrades: new Map(),
    tapIndex() { return () => {}; },
    register(route) {
      const table = route.kind === 'exact' ? this.exact : this.prefixes;
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    registerUpgrade(route) { this.upgrades.set(route.path, route); return () => this.upgrades.delete(route.path); },
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
  };
  webServer.register({kind: 'exact', path: '/fixture-route', handler(_req, res) { res.end('fixture'); }});
  const ctx = {
    webServer, logger: {warn() {}}, on() {}, provide() {},
    get(name) {
      if (name === 'connection' && connection) return {requestRejection: () => rejection};
      if (name === 'clientModules' && graph) return {graph};
      if (name === 'configEditor' && entries) return editor;
      if (name === 'loader' && entries) return {entries: () => entries};
    },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') dispose.push(stop); },
    inject(_deps, fn) { fn(ctx); },
  };
  if (entries) withSources(ctx, entries);
  apply(ctx, {persist: false, guardRoutes});
  let routeGate;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://dsh-go.invalid').pathname;
    const gate = routeGate?.path === path ? routeGate : undefined;
    if (gate) {
      routeGate = undefined;
      gate.arrived.resolve({req, res}); await gate.resume.promise;
    }
    const route = webServer.exact.get(path) ?? [...webServer.prefixes.values()].find(r => path.startsWith(r.path));
    if (route) await route.handler(req, res);
    else { res.writeHead(404); res.end(); }
    gate?.done.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    dispose.reverse().forEach(stop => stop());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = async (path, init = {}) => {
    const response = await fetch(`${webServer.getOrigin()}${path}`, init);
    const text = await response.text();
    return {status: response.status, headers: response.headers, text, body: text.startsWith('{') ? JSON.parse(text) : text};
  };
  return Object.assign(request, {port: server.address().port, holdNextRoute(path) {
    const gate = {path, arrived: Promise.withResolvers(), resume: Promise.withResolvers(), done: Promise.withResolvers()};
    routeGate = gate;
    return {arrived: gate.arrived.promise, resume: gate.resume.resolve, done: gate.done.promise};
  }});
}

const until = async (predicate, label) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(label);
    await new Promise(resolve => setImmediate(resolve));
  }
};

for (const route of ['occupancy', 'plugin-config']) for (const timing of ['before dispatch', 'while reading']) {
  test(`shared body ${route} interrupted ${timing} settles and permits retry`, async t => {
    const schema = Object.assign(value => value, {toJSON: () => ({uid: 1,
      refs: {1: {type: 'object', dict: {count: 2}}, 2: {type: 'number'}}})});
    const entry = {options: {id: 'sample', name: 'sample-package', config: {count: 0}},
      fiber: {state: 2, runtime: {Config: schema}, config: {count: 0}}};
    const request = await fixture(t, route === 'plugin-config' ? {entries: [entry]} : {});
    const path = `/dsh-go/v1/${route}${route === 'plugin-config' ? '/sample' : ''}`;
    // Peer for the production WebServer's wait while Connection is absent.
    // Partial HTTP input, abort, bridge dispatch and subsequent retry are real.
    const gate = request.holdNextRoute(path); t.after(gate.resume);
    const socket = connect(request.port, '127.0.0.1'); t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    const {req, res} = await gate.arrived;
    let settled = false; gate.done.then(() => { settled = true; });
    if (timing === 'while reading') {
      gate.resume();
      await until(() => req.listenerCount('data') > 0, 'body reader did not start');
    }
    const closed = once(res, 'close'); socket.destroy(); await closed;
    assert.equal(req.aborted, true); assert.equal(req.destroyed, true);
    const listeners = ['data', 'end', 'error'].map(event => req.listenerCount(event));
    if (timing === 'before dispatch') gate.resume();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'a closed IncomingMessage cannot supply later body events');
    if (timing === 'before dispatch') {
      assert.deepEqual(['data', 'end', 'error'].map(event => req.listenerCount(event)), listeners,
        'an already closed request must not retain new body listeners');
    }
    const response = await request(path, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(route === 'occupancy' ? {bootRev: 'b1', slots: {}} : {})});
    assert.equal(response.status, route === 'occupancy' ? 204 : 400);
    if (route === 'plugin-config') assert.equal(response.body.error.code, 'invalid-operation');
    assert.deepEqual(entry.options.config, {count: 0});
  });
}

test('shared body accepts a complete but unread IncomingMessage', async t => {
  const request = await fixture(t), path = '/dsh-go/v1/occupancy';
  const gate = request.holdNextRoute(path); t.after(gate.resume);
  const response = request(path, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({bootRev: 'b1', slots: {}})});
  const {req} = await gate.arrived;
  await until(() => req.complete, 'HTTP parser did not complete the request');
  assert.equal(req.readableEnded, false);
  assert.equal(req.aborted, false); assert.equal(req.destroyed, false);
  gate.resume();
  assert.equal((await response).status, 204);
  await gate.done;
});

test('bridge business errors share a nested shape and retain HTTP status', async t => {
  const request = await fixture(t);
  const occupancy = '/dsh-go/v1/occupancy';
  const post = body => ({method: 'POST', headers: {'content-type': 'application/json'}, body});
  for (const [path, init, status, code] of [
    ['/dsh-go/v1/inventory', {method: 'POST'}, 405, 'method-not-allowed'],
    [occupancy, {}, 405, 'method-not-allowed'],
    [occupancy, {method: 'POST', body: '{}'}, 415, 'unsupported-media-type'],
    [occupancy, post('invalid JSON'), 400, 'bad-request'],
    [occupancy, post('{}'), 400, 'bad-request'],
    [occupancy, post(' '.repeat(512 * 1024 + 1)), 413, 'too-large'],
    [occupancy, post(JSON.stringify({bootRev: 'b1', slots: Object.fromEntries(Array.from({length: 401}, (_, i) => [`slot-${i}`, []]))})), 413, 'too-large'],
    ['/dsh-go/v1/unknown', {}, 404, 'route-not-found'],
    ['/dsh-go/v1/plugin-config', {method: 'DELETE'}, 405, 'invalid-operation'],
    ['/dsh-go/v1/plugin-config/item', {method: 'DELETE'}, 405, 'invalid-operation'],
    ['/dsh-go/v1/plugin-config', {}, 503, 'host-unavailable'],
    ['/dsh-go/v1/sessions/deletion', {method: 'POST'}, 405, 'unavailable'],
  ]) {
    const response = await request(path, init);
    assert.equal(response.status, status, `${init.method ?? 'GET'} ${path}`);
    assert.equal(response.body.error.code, code);
    assert.equal(typeof response.body.error.message, 'string');
    assert.ok(response.body.error.message.length > 0);
    assert.equal('code' in response.body, false);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const accepted = await request(occupancy, post(JSON.stringify({bootRev: 'b1', slots: {}})));
  assert.equal(accepted.status, 204);
  assert.equal(accepted.text, '');
});

test('inventory marks an earlier page report stale until the current graph reports', async t => {
  let currentRev = 'g1';
  const request = await fixture(t, {graph: () => ({rev: currentRev, entries: [{id: 'sample-plugin', rev: currentRev}]})});
  const slots = {'settings.section': [{package: 'sample-plugin', cell: 'sample', order: 0, active: true}]};
  const report = async bootRev => {
    const response = await request('/dsh-go/v1/occupancy', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({bootRev, slots}),
    });
    assert.equal(response.status, 204);
  };
  const snapshot = async () => {
    const response = await request('/dsh-go/v1/inventory');
    assert.equal(response.status, 200);
    return response.body;
  };

  const absent = await snapshot();
  assert.equal(absent.currentRev, 'g1');
  assert.equal(absent.slots, null);
  assert.equal(absent.occupancy, null);

  await report('g1');
  const first = await snapshot();
  assert.equal(first.bootRev, 'g1');
  assert.equal(first.currentRev, 'g1');
  assert.equal(first.occupancy.stale, false);

  // A plugin change replaces the graph before another page reports its slots.
  currentRev = 'g2';
  const stale = await snapshot();
  assert.equal(stale.bootRev, 'g1');
  assert.equal(stale.currentRev, 'g2');
  assert.equal(stale.occupancy.stale, true);
  assert.deepEqual(stale.slots, first.slots, 'the stale table remains available for the consumer to judge');

  await report('g2');
  const refreshed = await snapshot();
  assert.equal(refreshed.bootRev, 'g2');
  assert.equal(refreshed.currentRev, 'g2');
  assert.equal(refreshed.occupancy.stale, false);

  // An already open g1 page may still post after the g2 page.
  await report('g1');
  const earlierPage = await snapshot();
  assert.equal(earlierPage.bootRev, 'g1');
  assert.equal(earlierPage.currentRev, 'g2');
  assert.equal(earlierPage.occupancy.stale, true);
});

test('capabilities advertise implemented families independently of service availability', async t => {
  const request = await fixture(t);
  const response = await request('/dsh-go/v1/capabilities');
  const version = JSON.parse(readFileSync(new URL('../bridge/dsh-go-bridge/package.json', import.meta.url))).version;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {v: 1, bridge: version, capabilities: [
    'inventory', 'occupancy', 'native-ui', 'native-stream', 'native-media', 'native-files',
    'plugin-config', 'session-deletion', 'companion', 'companion-prompt-context', 'companion-recall', 'companion-signals',
    'speech',
  ]});
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const deletion = await request('/dsh-go/v1/sessions/deletion');
  assert.equal(deletion.status, 200);
  assert.equal(deletion.body.supported, false, 'implemented route does not grant deletion authority');
  const wrongMethod = await request('/dsh-go/v1/capabilities', {method: 'POST'});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error.code, 'method-not-allowed');
});

test('capabilities HEAD returns GET metadata without a response body', async t => {
  const request = await fixture(t);
  const get = await request('/dsh-go/v1/capabilities');
  const head = await request('/dsh-go/v1/capabilities', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  for (const name of ['content-type', 'content-length', 'cache-control', 'x-content-type-options']) {
    assert.equal(head.headers.get(name), get.headers.get(name), name);
  }
});

for (const guardRoutes of [false, true]) for (const status of [401, 403, 503]) {
  test(`capabilities respect Connection verdict ${status}, fallback=${guardRoutes}`, async t => {
    const request = await fixture(t, {connection: status !== 503, rejection: status, guardRoutes});
    for (const method of ['GET', 'HEAD']) {
      const response = await request('/dsh-go/v1/capabilities', {method});
      assert.equal(response.status, status);
      assert.equal(response.text.includes('capabilities'), false);
      if (method === 'HEAD') assert.equal(response.text, '');
      if (guardRoutes) assert.equal(response.headers.get('x-dsh-go-guard'), 'reject');
    }
  });
}

for (const guardRoutes of [false, true]) test(`missing Connection preserves route-specific failures, fallback=${guardRoutes}`, async t => {
  const request = await fixture(t, {connection: false, guardRoutes});
  for (const path of ['/dsh-go/v1/plugin-config', '/dsh-go/v1/plugin-config/item']) {
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal(response.body.v, 1);
    assert.equal(response.body.error.code, 'host-unavailable');
    assert.equal('code' in response.body, false);
    const head = await request(path, {method: 'HEAD'});
    assert.equal(head.status, 503);
    assert.equal(head.text, '');
    assert.match(head.headers.get('content-type'), /^application\/json/);
  }
  const deletion = await request('/dsh-go/v1/sessions/delete', {method: 'POST'});
  assert.equal(deletion.status, 503);
  assert.equal(deletion.body.error.code, 'unavailable');
  const ordinary = await request('/dsh-go/v1/inventory');
  assert.equal(ordinary.status, 503);
  assert.equal(ordinary.text, 'Service Unavailable\n');
  if (guardRoutes) {
    assert.equal(ordinary.headers.get('x-dsh-go-guard'), 'reject');
    const external = await request('/fixture-route');
    assert.equal(external.status, 503);
    assert.equal(external.text, 'Service Unavailable\n');
  }
});
