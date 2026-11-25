// Real pinned WebServer, ClientModuleRegistry and HMR route with loopback HTTP.
// Loader entries and admission-service availability are the fixture inputs;
// SSE registration, graph changes and closed-response removal are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { get } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a patched runtime');
const require = createRequire(join(resolve(prefix), 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const [{ Context }, { WebServer }, { ClientModuleRegistry }, hmr] = await Promise.all([
  load('cordis'), load('dsh-host-webserver'), load('dsh-client-modules'), load('dsh-client-hmr'),
]);
const admitted = { requestRejection() {} };

async function until(predicate, message) {
  const limit = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= limit) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, ready = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hmr-closed-response-'));
  const ctx = new Context(), sockets = [], responses = [];
  t.after(async () => {
    t.mock.restoreAll();
    for (const socket of sockets) socket.destroy();
    try { await ctx.fiber.dispose(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await fs.writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'hmr-response-fixture', dsh: { client: { platform: 'web' } },
    exports: { './client': './client.js' },
  }));
  await fs.writeFile(join(root, 'index.js'), '');
  const client = join(root, 'client.js');
  await fs.writeFile(client, 'globalThis.__hmrResponseFixture = true;');
  const entry = { options: { name: pathToFileURL(join(root, 'index.js')).href }, fiber: {},
    parent: { tree: { ctx: { baseUrl: pathToFileURL(root + '/').href } } } };
  ctx.provide('loader', { entries: () => [entry] });
  if (ready) ctx.provide('connection', admitted);
  let dispatched = false;
  const register = WebServer.prototype.register;
  t.mock.method(WebServer.prototype, 'register', function (route) {
    if (route.path === hmr.EVENTS_ENDPOINT) {
      const handler = route.handler;
      route = { ...route, handler(req, res) {
        const result = handler(req, res);
        dispatched = true;
        return result;
      } };
    }
    return register.call(this, route);
  });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await();
  await ctx.plugin(ClientModuleRegistry).await();
  await ctx.plugin(hmr, { pollIntervalMs: 500 }).await();
  const web = ctx.webServer;
  web.server.prependListener('request', (req, res) => {
    const writes = [], write = res.write;
    res.write = function (chunk, ...args) { writes.push(String(chunk)); return write.call(this, chunk, ...args); };
    responses.push({ req, res, writes });
  });
  return { ctx, web, responses, dispatched: () => dispatched,
    async change() {
      const previous = ctx.clientModules.graph().rev;
      await fs.appendFile(client, '\n// completed build generation\n');
      ctx.clientModules.rebuilt('hmr-response-fixture');
      const next = ctx.clientModules.graph().rev;
      assert.notEqual(next, previous);
      return next;
    },
    async openBeforeReady() {
      const arrived = once(web.server, 'request');
      const socket = connect(web.port, '127.0.0.1'); sockets.push(socket);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(`GET ${hmr.EVENTS_ENDPOINT} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      await arrived;
      return { socket, response: responses.at(-1) };
    },
    async openLive() {
      const frames = [];
      const response = await new Promise((resolve, reject) => {
        const request = get(web.getOrigin() + hmr.EVENTS_ENDPOINT, { agent: false }, resolve);
        request.on('error', reject);
        request.on('socket', socket => sockets.push(socket));
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'text/event-stream');
      let pending = '';
      response.setEncoding('utf8');
      response.on('data', text => {
        pending += text;
        for (let end; (end = pending.indexOf('\n\n')) >= 0;) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
        }
      });
      return { response, frames, server: responses.at(-1) };
    },
  };
}

test('SSE closed during Connection startup is never retained for graph broadcasts', { timeout: 5000 }, async t => {
  const f = await fixture(t, false);
  const { socket, response } = await f.openBeforeReady();
  const closed = once(response.res, 'close'); socket.destroy(); await closed;
  assert.equal(response.res.destroyed, true);
  f.ctx.provide('connection', admitted);
  await until(f.dispatched, 'guard did not dispatch after Connection became available');
  await f.change();
  assert.deepEqual(response.writes, [], 'already-closed SSE must receive neither its initial frames nor later broadcasts');
});

test('live SSE receives graph changes and normal close releases the subscriber', { timeout: 5000 }, async t => {
  const f = await fixture(t), live = await f.openLive();
  await until(() => live.frames.some(frame => frame.type === 'graph'), 'initial graph did not arrive');
  const changed = await f.change();
  await until(() => live.frames.some(frame => frame.type === 'graph' && frame.graph.rev === changed), 'changed graph did not reach the live SSE');
  assert.ok(live.frames.some(frame => frame.type === 'rebuilt' && frame.id === 'hmr-response-fixture'));
  const closed = once(live.server.res, 'close'); live.response.destroy(); await closed;
  const writes = live.server.writes.length;
  await f.change();
  assert.equal(live.server.writes.length, writes, 'normally closed SSE must leave the broadcast collection');
});
