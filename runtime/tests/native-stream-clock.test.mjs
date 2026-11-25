// Real NativeCore/routes and HTTP/WS frames. Only the two public clocks and the
// interval scheduler are controlled; no connection fields or deadlines are injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { effectiveLimits } from '../bridge/dsh-go-bridge/lib/native/limits.js';
import { createNativeRoutes, STREAM_PATH } from '../bridge/dsh-go-bridge/lib/native/routes.js';
import { encodeFrame } from '../bridge/dsh-go-bridge/lib/native/ws.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const WATCHDOG_MS = 5000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING = { type: 'ping', payload: '' };
const IDLE = { type: 'close', code: 1001, reason: 'idle' };

class FixtureError extends Error {
  constructor(phase, cause) {
    super(`stream clock fixture: ${phase}`, cause === undefined ? undefined : { cause });
    this.code = 'STREAM_CLOCK_FIXTURE';
  }
}

function requireFixture(condition, phase) {
  if (!condition) throw new FixtureError(phase);
}

async function fixture(t, { hello = true } = {}) {
  let core, routes, server, socket, upgradeRequest, clock, wallOrigin;
  let failure, receivedClose = false, cleaning = false;
  const sockets = new Set(), watchdogs = new Set(), waiters = [], queued = [];
  const steps = [], received = [], sent = [];

  const watchdog = (phase, timeout) => {
    const timer = realSetTimeout(() => {
      watchdogs.delete(timer);
      timeout(new FixtureError(`${phase}: real watchdog expired`));
    }, WATCHDOG_MS);
    watchdogs.add(timer);
    return () => { realClearTimeout(timer); watchdogs.delete(timer); };
  };
  const bounded = (promise, phase) => new Promise((resolve, reject) => {
    const cancel = watchdog(phase, reject);
    Promise.resolve(promise).then(value => { cancel(); resolve(value); }, error => {
      cancel(); reject(error instanceof FixtureError ? error : new FixtureError(phase, error));
    });
  });
  const fail = (phase, cause) => {
    // A parsed, legal Close is the result. Later transport events cannot replace it.
    if (cleaning || receivedClose) return;
    failure ??= cause instanceof FixtureError ? cause : new FixtureError(phase, cause);
    for (const waiter of waiters.splice(0)) { waiter.cancel(); waiter.reject(failure); }
  };
  const next = phase => {
    // Earlier transport failure is still a fixture error. Events after a parsed
    // Close were ignored by fail(), so they cannot hide its queued frame.
    if (failure) return Promise.reject(failure);
    if (queued.length) return Promise.resolve(queued.shift());
    if (receivedClose) return Promise.reject(new FixtureError(`${phase}: no frame after Close`));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.cancel = watchdog(phase, error => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        failure ??= error;
        reject(error);
      });
      waiters.push(waiter);
    });
  };
  const deliver = frame => {
    const trace = frame.type === 'message'
      ? { type: 'message', t: frame.message.t, ...(frame.message.t === 'welcome'
        ? { v: frame.message.v, hb: frame.message.hb } : { at: frame.message.at }) }
      : frame;
    received.push({ mono: clock.mono, wallOffset: clock.wall - wallOrigin, frame: trace });
    const waiter = waiters.shift();
    if (waiter) { waiter.cancel(); waiter.resolve(frame); }
    else queued.push(frame);
  };

  // Registered before any resource or mock is created, including preparation failures.
  t.after(async () => {
    cleaning = true;
    t.diagnostic(JSON.stringify({ steps, sent, received, receivedClose,
      ...(failure ? { fixtureFailure: failure.message } : {}) }));
    const errors = [];
    const attempt = fn => { try { fn(); } catch (error) { errors.push(error); } };
    // Routes owns only post-mock heartbeat handles. Clear those before restoring APIs.
    attempt(() => routes?.dispose());
    attempt(() => upgradeRequest?.destroy());
    for (const owned of sockets) attempt(() => owned.destroy());
    attempt(() => core?.dispose());
    for (const waiter of waiters.splice(0)) {
      waiter.cancel(); waiter.reject(new FixtureError('cleanup with an unfinished frame wait'));
    }
    for (const timer of watchdogs) realClearTimeout(timer);
    watchdogs.clear();
    attempt(() => t.mock.reset());
    // HTTP's own real handles must not be passed to the mocked clearInterval.
    if (server) {
      attempt(() => server.closeAllConnections());
      try {
        await bounded(new Promise((resolve, reject) => server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        })), 'HTTP server cleanup');
      } catch (error) { errors.push(error); }
    }
    for (const timer of watchdogs) realClearTimeout(timer);
    watchdogs.clear();
    if (errors.length) throw new AggregateError(errors, 'stream clock fixture cleanup failed');
  });

  const limits = effectiveLimits({});
  requireFixture(limits.heartbeatSeconds === 25 && limits.idleTimeoutSeconds === 60,
    'default heartbeat and idle limits');
  core = new NativeCore({ get: name => name === 'loader' ? { entries: () => [] } : undefined,
    logger: { warn() {} } }, limits, 'test');
  routes = createNativeRoutes(core);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    void routes.handle(req, res, url.pathname, url);
  });
  server.on('connection', accepted => {
    sockets.add(accepted);
    accepted.on('error', error => fail('server socket error', error));
  });
  server.on('upgrade', (req, accepted, head) => routes.upgrade(req, accepted, head));
  server.on('error', error => fail('HTTP server error', error));
  await bounded(new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }), 'HTTP server listen');

  // Both connection timestamps must be born in this domain, at monotonic zero.
  clock = { wall: Date.now(), mono: 0 }; wallOrigin = clock.wall;
  t.mock.method(Date, 'now', () => clock.wall);
  t.mock.method(performance, 'now', () => clock.mono);
  t.mock.timers.enable({ apis: ['setInterval'], now: 0 });

  let buffer = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parse = () => {
    if (cleaning || receivedClose) return;
    try {
      while (buffer.length >= 2 && !receivedClose) {
        const opcode = buffer[0] & 15;
        requireFixture((buffer[0] & 0xf0) === 0x80, 'complete server frame without reserved bits');
        requireFixture((buffer[1] & 0x80) === 0, 'server frames must be unmasked');
        let length = buffer[1] & 127, offset = 2;
        requireFixture(length !== 127, 'unexpected large server frame');
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2); offset = 4;
        }
        requireFixture(opcode < 8 || length <= 125, 'bounded control frame');
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 1) {
          const message = JSON.parse(decoder.decode(payload));
          requireFixture(message !== null && !Array.isArray(message)
            && typeof message === 'object' && typeof message.t === 'string', 'JSON message shape');
          deliver({ type: 'message', message });
        } else if (opcode === 9) {
          // Deliberately do not auto-pong: the test owns its explicit inbound frames.
          deliver({ type: 'ping', payload: payload.toString('hex') });
        } else if (opcode === 8) {
          requireFixture(payload.length >= 2, 'server Close contains a status');
          const code = payload.readUInt16BE(0);
          requireFixture((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code))
            || (code >= 3000 && code < 5000), 'legal server Close status');
          const reason = decoder.decode(payload.subarray(2));
          receivedClose = true;
          deliver({ type: 'close', code, reason });
          socket.end();
        } else throw new FixtureError(`unexpected server opcode ${opcode}`);
      }
    } catch (error) { fail('WS frame parsing', error); }
  };
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  await bounded(new Promise((resolve, reject) => {
    upgradeRequest = request({ host: '127.0.0.1', port: server.address().port,
      path: STREAM_PATH, agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': key } });
    upgradeRequest.on('error', error => { fail('HTTP upgrade request', error); reject(error); });
    upgradeRequest.once('response', response => {
      response.resume(); reject(new FixtureError(`HTTP upgrade returned ${response.statusCode}`));
    });
    upgradeRequest.once('upgrade', (response, upgraded, head) => {
      socket = upgraded; sockets.add(socket);
      socket.on('error', error => fail('client socket error', error));
      socket.on('end', () => fail('TCP end before a legal Close'));
      socket.on('close', () => fail('TCP close before a legal Close'));
      socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); parse(); });
      try {
        requireFixture(response.statusCode === 101, 'HTTP 101 upgrade');
        requireFixture(String(response.headers.upgrade).toLowerCase() === 'websocket', 'Upgrade response header');
        requireFixture(String(response.headers.connection).toLowerCase().split(/\s*,\s*/).includes('upgrade'),
          'Connection response header');
        requireFixture(response.headers['sec-websocket-accept'] === accept, 'WebSocket accept');
        buffer = head; parse();
        if (failure) throw failure;
        resolve();
      } catch (error) { fail('HTTP upgrade validation', error); reject(error); }
    });
    upgradeRequest.end();
  }), 'HTTP upgrade');

  const send = message => {
    requireFixture(!failure && !receivedClose && !socket.destroyed, 'sending on the live stream');
    sent.push({ mono: clock.mono, wallOffset: clock.wall - wallOrigin, message });
    socket.write(encodeFrame(1, JSON.stringify(message), { mask: true }));
  };
  if (hello) {
    send({ t: 'hello', v: [1] });
    const welcome = await next('welcome');
    if (failure) throw failure;
    requireFixture(welcome.type === 'message' && welcome.message.t === 'welcome'
      && welcome.message.v === 1 && welcome.message.hb === 25
      && typeof welcome.message.conn === 'string' && welcome.message.conn.length > 0, 'welcome');
  }
  return {
    advance(delta, wallOffset) {
      clock.mono += delta; clock.wall = wallOrigin + wallOffset;
      steps.push({ delta, mono: clock.mono, wallOffset });
      t.mock.timers.tick(delta);
    },
    async heartbeat() {
      const frame = await next('heartbeat ping or Close');
      if (failure) throw failure;
      requireFixture(frame.type === 'ping' || frame.type === 'close', 'heartbeat control-frame completion');
      return frame;
    },
    async refresh() {
      send({ t: 'ping', at: 1 });
      const pong = await next('activity refresh pong');
      if (failure) throw failure;
      requireFixture(pong.type === 'message' && pong.message.t === 'pong'
        && pong.message.at === 1, 'same-connection refresh pong');
    },
  };
}

test('R1 stream survives a forward wall correction before its first heartbeat', async t => {
  const f = await fixture(t);
  f.advance(25000, 85000);
  const frame = await f.heartbeat();
  assert.deepEqual(frame, PING, 'R1 semantic oracle: 25 elapsed seconds must not exhaust the idle budget');
});

test('R2 an unresponsive stream still expires after wall clock rollback', async t => {
  const f = await fixture(t), frames = [];
  f.advance(25000, -35000); frames.push(await f.heartbeat());
  assert.deepEqual(frames, [PING], 'R2 first heartbeat preparation');
  f.advance(25000, -10000); frames.push(await f.heartbeat());
  assert.deepEqual(frames, [PING, PING], 'R2 second heartbeat preparation');
  f.advance(25000, 15000); frames.push(await f.heartbeat());
  assert.deepEqual(frames, [PING, PING, IDLE],
    'R2 semantic oracle: 75 elapsed seconds without inbound frames must expire the stream');
});

test('C1 ordinary unresponsive streams retain the default idle behavior', async t => {
  const f = await fixture(t);
  f.advance(25000, 25000); assert.deepEqual(await f.heartbeat(), PING);
  f.advance(25000, 50000); assert.deepEqual(await f.heartbeat(), PING);
  f.advance(25000, 75000); assert.deepEqual(await f.heartbeat(), IDLE);
});

test('C2 inbound activity after a correction refreshes idle with a strict boundary', async t => {
  const f = await fixture(t);
  f.advance(15000, 75000); await f.refresh();
  f.advance(10000, 85000); assert.deepEqual(await f.heartbeat(), PING);
  f.advance(25000, 110000); assert.deepEqual(await f.heartbeat(), PING);
  f.advance(25000, 135000);
  assert.deepEqual(await f.heartbeat(), PING, 'exactly 60 seconds since the refresh is not greater than 60');
  f.advance(25000, 160000); assert.deepEqual(await f.heartbeat(), IDLE);
});

test('C3 a stream opened at monotonic zero still requires hello at the first heartbeat', async t => {
  const f = await fixture(t, { hello: false });
  f.advance(25000, 25000);
  assert.deepEqual(await f.heartbeat(), { type: 'close', code: 1008, reason: 'hello expected' });
});
