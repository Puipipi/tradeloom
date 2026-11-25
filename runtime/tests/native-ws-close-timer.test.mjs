import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WsConnection, encodeFrame } from '../bridge/dsh-go-bridge/lib/native/ws.js';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { LIMITS } from '../bridge/dsh-go-bridge/lib/native/limits.js';
import { createNativeRoutes } from '../bridge/dsh-go-bridge/lib/native/routes.js';

function timers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const active = new Set();
  let scheduled = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    let timer;
    timer = set(() => { active.delete(timer); fn(...args); }, ms);
    if (ms === 1000) { scheduled++; active.add(timer); }
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { active.delete(timer); return clear(timer); });
  return { active, scheduled: () => scheduled };
}

for (const initiator of ['server', 'client', 'tcp-fin']) test(`ws ${initiator} close retires the destroy deadline after a real TCP close`, async t => {
  const tracked = timers(t);
  const server = createServer();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = createConnection(server.address().port, '127.0.0.1');
  sockets.push(client);
  client.resume();
  const [socket] = await accepted;
  sockets.push(socket);
  const ws = new WsConnection(socket, Buffer.alloc(0), 4096);
  const closed = once(socket, 'close');
  if (initiator === 'server') ws.close();
  else if (initiator === 'client') client.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]), { mask: true }));
  else client.end();
  await closed;
  assert.equal(ws.closed, true);
  assert.equal(socket.destroyed, true);
  assert.equal(tracked.scheduled(), 1);
  t.diagnostic(`actual TCP close: pending destroy timers=${tracked.active.size}`);
  const destroy = t.mock.method(socket, 'destroy');
  t.mock.timers.tick(1000);
  assert.equal(destroy.mock.callCount(), 0, 'completed socket must not be destroyed again by a stale deadline');
  assert.equal(tracked.active.size, 0);
});

for (const initiator of ['server', 'client', 'tcp-fin']) test(`ws ${initiator} logical close retains its deadline until the socket actually closes`, t => {
  const tracked = timers(t);
  const socket = new EventEmitter();
  socket.write = () => {};
  socket.end = () => {};
  let destroyed = 0;
  socket.destroy = () => { destroyed++; socket.emit('close'); };
  const ws = new WsConnection(socket, Buffer.alloc(0), 4096);
  if (initiator === 'server') ws.close();
  else if (initiator === 'client') socket.emit('data', encodeFrame(0x8, Buffer.from([0x03, 0xe8]), { mask: true }));
  else socket.emit('end');
  assert.equal(ws.closed, true);
  assert.equal(tracked.active.size, 1);
  t.mock.timers.tick(500);
  if (initiator !== 'tcp-fin') socket.emit('end');
  assert.equal(tracked.scheduled(), 1, 'a later TCP FIN must not replace the existing deadline');
  t.mock.timers.tick(499);
  assert.equal(destroyed, 0);
  t.mock.timers.tick(1);
  assert.equal(destroyed, 1);
  assert.equal(tracked.active.size, 0);
});

for (const before of ['peer-fin', 'peer-reset', 'live']) {
  test(`ws upgrade after guard wait with ${before} preserves connection ownership`, {timeout: 5000}, async t => {
    const core = new NativeCore({get: name => name === 'loader' ? {entries: () => []} : undefined,
      logger: {warn() {}}}, LIMITS, 'test');
    const routes = createNativeRoutes(core), arrived = Promise.withResolvers(), sockets = [];
    const server = createHttpServer();
    t.after(async () => {
      routes.dispose(); core.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    // Peer for the awaited Connection guard. HTTP parsing, FIN/RST, socket
    // terminal state, native upgrade and connection accounting are real.
    server.on('upgrade', (req, socket, head) => {
      sockets.push(socket);
      socket.on('error', () => socket.destroy()); // Existing WebServer ownership.
      arrived.resolve({req, socket, head});
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = createConnection(server.address().port, '127.0.0.1'); sockets.push(client);
    const received = [];
    client.on('data', chunk => received.push(chunk)); client.on('error', () => {});
    await once(client, 'connect');
    client.write('GET /dsh-go/v1/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const {req, socket, head} = await arrived.promise;
    assert.equal(req.complete, true, 'a normal upgrade already has complete HTTP headers');
    if (before === 'peer-fin') {
      const ended = once(socket, 'end'); client.end(); await ended;
      assert.equal(socket.readableEnded, true); assert.equal(socket.destroyed, false);
      assert.equal(req.aborted, false, 'HTTP aborted does not describe an upgraded socket');
    } else if (before === 'peer-reset') {
      const closed = new Promise(resolve => socket.once('close', resolve));
      client.resetAndDestroy(); await closed;
      assert.equal(socket.destroyed, true);
    } else {
      assert.equal(socket.readableEnded, false); assert.equal(socket.destroyed, false);
    }
    routes.upgrade(req, socket, head);
    if (before === 'live') {
      assert.equal(routes.connections(), 1);
      const closed = once(socket, 'close'), ended = once(client, 'end');
      client.end(); await closed; await ended;
      assert.match(Buffer.concat(received).toString(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
      assert.equal(routes.connections(), 0, 'post-upgrade FIN still releases the existing owner');
    } else {
      assert.equal(routes.connections(), 0, 'a terminal socket must not occupy a slot until the heartbeat');
      assert.equal(socket.destroyed, true, 'the pre-upgrade half-open socket is closed now');
    }
  });
}
