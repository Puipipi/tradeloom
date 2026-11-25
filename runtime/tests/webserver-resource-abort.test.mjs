// Real pinned WebServer and ClientModuleRegistry, loopback sockets and file I/O.
// Loader metadata and availability of the admission service are fixture inputs;
// route dispatch, resource creation, cancellation and file cleanup are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { get, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a patched runtime');
const require = createRequire(join(resolve(prefix), 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const [{ Context }, { WebServer }, { ClientModuleRegistry }] = await Promise.all([
  load('cordis'), load('dsh-host-webserver'), load('dsh-client-modules'),
]);
const admitted = { requestRejection() {} };
// Returning the Node async iterator may emit its expected AbortError before close.
const sourceClosed = stream => stream.closed ? Promise.resolve()
  : new Promise(resolve => stream.once('close', resolve));

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, ready = true) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'web-resource-abort-'));
  const streams = [], sockets = [], exchanges = [];
  const ctx = new Context();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const socket of sockets) socket.destroy();
    const closed = streams.map(sourceClosed);
    for (const stream of streams) stream.destroy();
    try { await ctx.fiber.dispose(); await Promise.all(closed); }
    finally { await fsp.rm(root, { recursive: true, force: true }); }
  });
  await fsp.mkdir(join(root, 'assets'));
  const small = await fsp.readFile(new URL('./fixtures/native-static/assets/img/dot.png', import.meta.url));
  await fsp.writeFile(join(root, 'assets', 'small.png'), small);
  const large = await fsp.open(join(root, 'assets', 'large.png'), 'wx');
  try { await large.write(small); await large.truncate(16 * 1024 * 1024); }
  finally { await large.close(); }
  await fsp.writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'resource-abort-fixture', dsh: { client: { platform: 'web' } },
    exports: { './client': './client.js', './assets/*': './assets/*' },
  }));
  await fsp.writeFile(join(root, 'index.js'), '');
  await fsp.writeFile(join(root, 'client.js'), 'globalThis.__resourceAbortFixture = true;');
  const entry = { options: { name: pathToFileURL(join(root, 'index.js')).href }, fiber: {},
    parent: { tree: { ctx: { baseUrl: pathToFileURL(root + '/').href } } } };
  ctx.provide('loader', { entries: () => [entry] });
  if (ready) ctx.provide('connection', admitted);

  const readStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = readStream(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const serve = WebServer.prototype.serveResource;
  const entered = Promise.withResolvers();
  t.mock.method(WebServer.prototype, 'serveResource', function (req, res, ...args) {
    const row = { aborted: req.aborted, destroyed: res.destroyed };
    row.done = serve.call(this, req, res, ...args);
    exchanges.push(row);
    entered.resolve(row);
    return row.done;
  });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' }).await();
  await ctx.plugin(ClientModuleRegistry).await();
  const web = ctx.webServer;
  const origin = web.getOrigin();
  const path = '/plugins/resource-abort-fixture/assets/';
  return { ctx, web, origin, path, small, streams, exchanges, entered: entered.promise,
    async open() {
      const arrived = once(web.server, 'request');
      const socket = connect(web.port, '127.0.0.1'); sockets.push(socket);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(`GET ${path}large.png HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      const [req, res] = await arrived;
      return { socket, req, res };
    },
  };
}

test('resource is not opened when the client closes during Connection startup', { timeout: 5000 }, async t => {
  const f = await fixture(t, false);
  const { socket, req, res } = await f.open();
  const closed = once(res, 'close'); socket.destroy(); await closed;
  assert.equal(req.aborted, true); assert.equal(res.destroyed, true);
  f.ctx.provide('connection', admitted);
  const exchange = await within(f.entered, 'guard did not dispatch after Connection became available');
  assert.equal(exchange.aborted, true); assert.equal(exchange.destroyed, true);
  await within(exchange.done, 'closed response still waits for resource drain');
  assert.equal(f.streams.length, 0, 'a closed client must not open the package asset');
});

test('disconnect during a live file response still destroys its source', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const { socket } = await f.open();
  await once(socket, 'data');
  assert.equal(f.streams.length, 1);
  const source = f.streams[0], closed = sourceClosed(source);
  socket.destroy();
  await within(closed, 'source did not close after the peer disconnected');
  await within((await f.entered).done, 'cancelled resource did not settle');
  assert.equal(source.destroyed, true); assert.equal(source.closed, true);
});

test('live GET keeps exact bytes and HEAD does not open a file stream', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  async function read(method) {
    return new Promise((resolve, reject) => {
      const options = { method, agent: false };
      const req = (method === 'GET' ? get : request)(f.origin + f.path + 'small.png', options, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
      });
      req.on('error', reject);
      if (method !== 'GET') req.end();
    });
  }
  const got = await read('GET');
  assert.equal(got.status, 200); assert.equal(got.type, 'image/png'); assert.deepEqual(got.body, f.small);
  assert.equal(f.streams.length, 1);
  const head = await read('HEAD');
  assert.equal(head.status, 200); assert.equal(head.type, got.type); assert.equal(head.body.length, 0);
  assert.equal(f.streams.length, 1, 'HEAD must not open another source');
});
