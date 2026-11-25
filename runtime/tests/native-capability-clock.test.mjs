// Real NativeCore/routes and public registrations. Only Loader identity, the plugin's
// producer and the two public clocks are controlled; all assertions observe callbacks/WS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { effectiveLimits } from '../bridge/dsh-go-bridge/lib/native/limits.js';
import { createNativeRoutes } from '../bridge/dsh-go-bridge/lib/native/routes.js';
import { encodeFrame } from '../bridge/dsh-go-bridge/lib/native/ws.js';

// The WS completion fence must keep a real deadline while production setTimeout is mocked.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pkg = 'capability-clock-test';

function clocks(t) {
  const clock = { wall: Date.now(), mono: 0 };
  t.mock.method(Date, 'now', () => clock.wall);
  t.mock.method(performance, 'now', () => clock.mono);
  return clock;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-capability-clock-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', dshGo: {
    v: 1, capabilities: ['voice', 'micro'], contributes: {
      'composer.actions': [{ id: 'go', label: 'Go' }], micro: [{ id: 'caption' }],
    },
  } }));
  await writeFile(join(dir, 'index.js'), '');
  const entry = { options: { name: pathToFileURL(join(dir, 'index.js')).href },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(dir + '/').href } } }, fiber: { uid: 7 } };
  const disposers = [], events = [], frames = [], queued = [], waiters = [];
  const core = new NativeCore({ get: n => n === 'loader' ? { entries: () => [entry] } : undefined,
    logger: { warn() {} } }, effectiveLimits({}), 'test');
  const routes = createNativeRoutes(core);
  const service = Object.assign(Object.create(core.service), { ctx: { fiber: { entry },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; } } });
  let emit, cleanups = 0;
  service.on('go', () => ({ type: 'voice', op: 'start', instance: 'voice' }));
  service.onCapability((scope, event) => events.push(event));
  service.micro('caption', { data(scope, publish) { emit = publish; return () => { cleanups++; }; } });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local'); void routes.handle(req, res, url.pathname, url);
  });
  server.on('upgrade', (req, socket, head) => routes.upgrade(req, socket, head));
  let socket, failure;
  const fail = error => {
    failure ??= error;
    for (const waiter of waiters.splice(0)) { realClearTimeout(waiter.timer); waiter.reject(failure); }
  };
  t.after(async () => {
    t.mock.reset();
    for (const waiter of waiters) realClearTimeout(waiter.timer);
    socket?.destroy(); routes.dispose(); core.dispose();
    for (const dispose of disposers.reverse()) dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const next = predicate => {
    if (failure) return Promise.reject(failure);
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = realSetTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('WS fixture response deadline'));
      }, 2000);
      waiters.push(waiter);
    });
  };
  const deliver = message => {
    frames.push(message);
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index < 0) queued.push(message);
    else {
      const [waiter] = waiters.splice(index, 1); realClearTimeout(waiter.timer); waiter.resolve(message);
    }
  };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  socket = connect(port, '127.0.0.1'); await once(socket, 'connect');
  socket.on('error', fail); socket.on('close', () => fail(new Error('WS fixture closed')));
  let buffer = Buffer.alloc(0), handshaken = false;
  socket.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        assert.match(buffer.subarray(0, end).toString(), /101 Switching/);
        buffer = buffer.subarray(end + 4); handshaken = true;
      }
      while (buffer.length >= 2) {
        const op = buffer[0] & 15; let size = buffer[1] & 127, offset = 2;
        assert.equal(buffer[0] & 128, 128, 'fixture expects complete small frames');
        assert.equal(buffer[1] & 128, 0, 'server frames must be unmasked');
        assert.notEqual(size, 127, 'fixture does not expect a large frame');
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + size) return;
        const payload = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
        if (op === 1) deliver(JSON.parse(payload.toString()));
        else if (op === 9) socket.write(encodeFrame(10, payload, { mask: true }));
        else if (op === 8) fail(new Error('WS fixture received close'));
      }
    } catch (error) { fail(error); }
  });
  socket.write('GET /dsh-go/v1/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  const send = message => socket.write(encodeFrame(1, JSON.stringify(message), { mask: true }));
  send({ t: 'hello', v: [1], features: ['voice', 'micro'] });
  const welcome = await next(message => message.t === 'welcome');
  assert.deepEqual(welcome.features, ['voice', 'micro']); assert.equal(typeof welcome.conn, 'string');
  let fenceId = 0;
  const fence = async () => { const at = ++fenceId; send({ t: 'ping', at }); await next(m => m.t === 'pong' && m.at === at); };
  const invoke = async () => {
    const body = JSON.stringify({ v: 1, pkg, id: 'go', surface: 'composer.actions',
      scope: { sessionId: 's1' }, stream: welcome.conn });
    const result = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/dsh-go/v1/invoke', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', error => { realClearTimeout(timer); reject(error); });
        res.on('end', () => {
          realClearTimeout(timer);
          try { resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      const timer = realSetTimeout(() => req.destroy(new Error('HTTP fixture response deadline')), 2000);
      req.on('error', error => { realClearTimeout(timer); reject(error); }); req.end(body);
    });
    assert.equal(result.status, 200, 'voice invoke preparation must succeed');
    assert.equal(result.effects?.length, 1, 'voice invoke must return exactly one start');
    assert.equal(result.effects[0].type, 'voice'); assert.equal(result.effects[0].op, 'start');
    assert.equal(typeof result.effects[0].lease, 'string'); assert.ok(result.effects[0].lease.length > 0);
    return result.effects[0].lease;
  };
  const subscribe = async () => {
    send({ t: 'micro.sub', sub: 'm', pkg, id: 'caption' }); await fence();
    assert.equal(typeof emit, 'function', 'actual registered micro producer must have started');
  };
  return { events, send, fence, invoke, subscribe, get emit() { return emit; },
    micro: () => frames.filter(m => m.t === 'micro.data' && m.sub === 'm'), cleanups: () => cleanups };
}

test('R1 capability edges survive wall clock rollback on a live lease', async t => {
  const f = await fixture(t), lease = await f.invoke(), clock = clocks(t);
  f.send({ t: 'cap.event', lease, seq: 1, event: 'voice.speechStart' }); await f.fence();
  assert.deepEqual(f.events.map(e => e.event), ['voice.speechStart'], 'START preparation guard');
  // 700 ms elapsed, then a 5 second wall correction; the monotonic axis never goes back.
  clock.mono = 700; clock.wall -= 4300;
  f.send({ t: 'cap.event', lease, seq: 2, event: 'voice.speechEnd' }); await f.fence();
  assert.deepEqual(f.events.map(e => e.event), ['voice.speechStart', 'voice.speechEnd'],
    'R1 semantic oracle: a wall correction must not consume the elapsed edge budget');
});

test('R2 micro sends the next value after elapsed time despite wall rollback', async t => {
  const f = await fixture(t); await f.subscribe(); const clock = clocks(t);
  f.emit({ text: 'first' }); await f.fence();
  assert.deepEqual(f.micro().map(m => m.data.text), ['first'], 'first micro preparation guard');
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  try {
    clock.mono = 100; clock.wall -= 4900; t.mock.timers.tick(100);
    f.emit({ text: 'second' }); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), ['first', 'second'],
      'R2 semantic oracle: elapsed 100 ms must not acquire a 5000 ms wall-clock wait');
  } finally { t.mock.timers.reset(); }
});

test('C1 first micro frame is immediate at monotonic zero', async t => {
  const f = await fixture(t); await f.subscribe(); clocks(t);
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  try {
    f.emit({ text: 'first' }); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), ['first'], 'first frame needs no timer tick');
  } finally { t.mock.timers.reset(); }
});

test('C2 ordinary edges, burst, refill and terminal revocation retain their behavior', async t => {
  const f = await fixture(t), clock = clocks(t), normal = await f.invoke();
  f.send({ t: 'cap.event', lease: normal, seq: 1, event: 'voice.speechStart' }); await f.fence();
  clock.mono = 700; clock.wall += 700;
  f.send({ t: 'cap.event', lease: normal, seq: 2, event: 'voice.speechEnd' }); await f.fence();
  assert.deepEqual(f.events.map(e => e.event), ['voice.speechStart', 'voice.speechEnd']);
  f.send({ t: 'cap.event', lease: normal, seq: 3, event: 'voice.stopped' }); await f.fence();
  assert.equal(f.events.at(-1).event, 'voice.stopped'); assert.equal(f.events[0].signal.aborted, true);
  // Both HTTP admissions stay on the same mocked monotonic clock.
  // No timer mock is active during either invoke.
  const burst = await f.invoke(); assert.notEqual(burst, normal); f.events.length = 0;
  for (let seq = 1; seq <= 5; seq++) f.send({ t: 'cap.event', lease: burst, seq,
    event: seq % 2 ? 'voice.speechStart' : 'voice.speechEnd' });
  await f.fence(); assert.deepEqual(f.events.map(e => e.seq), [1, 2, 3, 4]);
  clock.mono += 100; clock.wall += 100;
  f.send({ t: 'cap.event', lease: burst, seq: 6, event: 'voice.speechEnd' }); await f.fence();
  assert.deepEqual(f.events.map(e => e.seq), [1, 2, 3, 4, 6]); assert.equal(f.events[0].signal.aborted, false);
  f.send({ t: 'cap.event', lease: burst, seq: 7, event: 'voice.stopped' });
  f.send({ t: 'cap.event', lease: burst, seq: 8, event: 'voice.speechStart' });
  f.send({ t: 'cap.event', lease: burst, seq: 9, event: 'voice.error' }); await f.fence();
  assert.deepEqual(f.events.map(e => e.seq), [1, 2, 3, 4, 6, 7]);
  assert.equal(f.events.at(-1).event, 'voice.stopped'); assert.equal(f.events[0].signal.aborted, true);
});

test('C3 micro rounds waits up, coalesces, deduplicates and stays quiet after unsubscribe', async t => {
  const f = await fixture(t); await f.subscribe(); const clock = clocks(t), wall = clock.wall;
  f.emit({ text: 'first' }); await f.fence();
  assert.deepEqual(f.micro().map(m => m.data.text), ['first']);
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  try {
    clock.mono = 25.5; clock.wall = wall + 25; t.mock.timers.tick(25.5); f.emit({ text: 'queued' });
    clock.mono = 50.5; clock.wall = wall + 50; t.mock.timers.tick(25); f.emit({ text: 'latest' });
    clock.mono = 100; clock.wall = wall + 100; t.mock.timers.tick(49.5); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), ['first'], 'rounded wait has not reached its due time');
    clock.mono = 100.5; t.mock.timers.tick(0.5); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), ['first', 'latest']);
    assert.notEqual(f.micro()[0].rev, f.micro()[1].rev);
    const revisions = f.micro().map(m => m.rev);
    f.emit({ text: 'latest' });
    clock.mono = 200.5; clock.wall = wall + 200; t.mock.timers.tick(100); await f.fence();
    assert.deepEqual(f.micro().map(m => m.rev), revisions, 'duplicate produces no additional frame/revision');
    // Re-anchor at an actual distinct send: the duplicate did not update last-send time.
    f.emit({ text: 'before cancellation' }); await f.fence();
    const before = ['first', 'latest', 'before cancellation'];
    assert.deepEqual(f.micro().map(m => m.data.text), before);
    clock.mono = 225.5; clock.wall = wall + 225; t.mock.timers.tick(25);
    f.emit({ text: 'pending cancellation' }); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), before, 'different value is still pending');
    f.send({ t: 'micro.unsub', sub: 'm' }); await f.fence(); assert.equal(f.cleanups(), 1);
    clock.mono = 300.5; clock.wall = wall + 300; t.mock.timers.tick(75); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), before, 'no output at the cancelled value\'s former due time');
    f.emit({ text: 'late' }); await f.fence();
    assert.deepEqual(f.micro().map(m => m.data.text), before); assert.equal(f.cleanups(), 1);
  } finally { t.mock.timers.reset(); }
});
