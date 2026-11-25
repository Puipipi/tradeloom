// Real bridge HTTP admission; fake Loader identity and public clock mocks only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { createNativeRoutes } from '../bridge/dsh-go-bridge/lib/native/routes.js';
import { effectiveLimits } from '../bridge/dsh-go-bridge/lib/native/limits.js';

const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
const WATCHDOG_MS = 5000; // Does not replace the production handler's real 3000 ms deadline.
const A = 'invoke-clock-a', B = 'invoke-clock-b';
const copy = () => ({ copy: 'ok' });
const copied = { status: 200, body: { v: 1, effects: [{ type: 'copy', text: 'ok' }], issues: [] }, retryAfter: null };
const limited = { status: 429, body: { v: 1, error: { code: 'rate-limited', message: 'too many invokes' } }, retryAfter: '1' };
const projection = r => ({ status: r.status, body: r.body, retryAfter: r.retryAfter });
class FixtureError extends Error {
  constructor(message, cause) { super(message, { cause }); this.code = 'INVOKE_CLOCK_FIXTURE'; }
}
function guard(actual, expected, label) {
  try { assert.deepEqual(actual, expected); }
  catch (error) { throw new FixtureError(label, error); }
}
function observed(promise) { promise.then(undefined, () => {}); return promise; }
function deferred() {
  let resolve, reject;
  const promise = observed(new Promise((a, b) => { resolve = a; reject = b; }));
  return { promise, resolve, reject };
}
function deadline(promise, label) {
  return observed(new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new FixtureError(`${label}: real watchdog`)), WATCHDOG_MS);
    promise.then(value => { realClearTimeout(timer); resolve(value); }, error => { realClearTimeout(timer); reject(error); });
  }));
}
function candidateResponse(r, label) {
  // Only a complete lawful copy or a real rate rejection reaches a semantic oracle.
  // In particular, the unchanged handler deadline's 504 is a fixture blocker.
  if (r.status === 200) guard(projection(r), copied, `${label}: copy response`);
  else {
    guard(r.status, 429, `${label}: unexpected HTTP status`);
    guard(r.body, limited.body, `${label}: rate response body`);
    guard(typeof r.retryAfter === 'string' && /^[1-9][0-9]*$/.test(r.retryAfter), true, `${label}: Retry-After`);
  }
}

async function fixture(t) {
  let dir, core, routes, server, port, closing = false;
  const wallOrigin = Date.now(), clock = { wall: wallOrigin, mono: 0 };
  const mocks = [], disposers = [], gates = [], clientWork = [], serverWork = [], failures = [], trace = [], warnings = [];
  const requests = new Set(), sockets = new Set();
  const counts = new Map([[A, 0], [B, 0]]), queues = new Map([[A, []], [B, []]]);
  t.after(async () => {
    closing = true;
    const errors = [];
    const attempt = fn => { try { fn(); } catch (error) { errors.push(error); } };
    try {
      for (const gate of gates) { gate.release(); gate.enter.reject(new FixtureError('cleanup before handler entry')); }
      for (const req of requests) req.destroy();
      try { await deadline(Promise.allSettled([...clientWork, ...serverWork]), 'HTTP cleanup'); }
      catch (error) { errors.push(error); }
      while (disposers.length) attempt(disposers.pop());
      attempt(() => routes?.dispose());
      attempt(() => core?.dispose());
      for (const socket of sockets) socket.destroy();
      if (server) {
        attempt(() => server.closeAllConnections());
        try {
          await deadline(new Promise((resolve, reject) => server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
          })), 'server close');
        } catch (error) { errors.push(error); }
      }
    } catch (error) { errors.push(error); } finally {
      while (mocks.length) attempt(() => mocks.pop().mock.restore());
      if (dir) attempt(() => rmSync(dir, { recursive: true, force: true }));
      const fixtureFailures = [...failures, ...errors].map(error => ({ name: error?.name, code: error?.code, message: String(error?.message ?? error) }));
      t.diagnostic(`INVOKE_CLOCK_TRACE ${JSON.stringify({ requests: trace, warnings, fixtureFailures })}`);
    }
    if (failures.length || errors.length) throw new FixtureError('fixture asynchronous work or cleanup failed', new AggregateError([...failures, ...errors]));
  });
  try {
    mocks.push(t.mock.method(Date, 'now', () => clock.wall));
    mocks.push(t.mock.method(performance, 'now', () => clock.mono));
    dir = mkdtempSync(join(tmpdir(), 'native-invoke-clock-'));
    const entries = [A, B].map((pkg, index) => {
      const folder = join(dir, pkg); mkdirSync(folder);
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', dshGo: { v: 1, contributes: { panels: [{ id: 'panel', title: 'Panel' }] } } }));
      writeFileSync(join(folder, 'index.js'), '');
      return { options: { name: pathToFileURL(join(folder, 'index.js')).href }, parent: { tree: { ctx: { baseUrl: pathToFileURL(folder + '/').href } } }, fiber: { uid: index + 1 } };
    });
    const limits = effectiveLimits({}); guard(limits.handlerTimeoutMs, 3000, 'unchanged handler deadline');
    core = new NativeCore({ get: name => name === 'loader' ? { entries: () => entries } : undefined, logger: { warn: (...args) => warnings.push(args.map(String)) } }, limits, 'test');
    routes = createNativeRoutes(core);
    for (const [index, pkg] of [A, B].entries()) {
      const service = Object.assign(Object.create(core.service), { ctx: { fiber: { entry: entries[index] }, effect(fn) { const off = fn(); disposers.push(off); return off; } } });
      service.panel('panel', { view: { type: 'text', text: 'Copy' }, actions: { copy() {
        counts.set(pkg, counts.get(pkg) + 1);
        const gate = queues.get(pkg).shift();
        if (gate) { gate.enter.resolve(); return gate.result.promise; }
        return copy();
      } } });
    }
    server = createServer((req, res) => {
      req.on('error', () => {}); res.on('error', () => {}); // Client completion/error guards own transport failures.
      if (closing) { req.resume(); res.destroy(); return; }
      const url = new URL(req.url, 'http://local');
      const work = routes.handle(req, res, url.pathname, url); serverWork.push(work);
      work.then(handled => {
        if (!handled) { failures.push(new FixtureError('route was not handled')); res.destroy(); }
      }, error => { failures.push(new FixtureError('route rejected outside dispatch', error)); res.destroy(); });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
    server.on('error', error => { if (!closing) failures.push(new FixtureError('HTTP server error', error)); });
    await deadline(new Promise((resolve, reject) => {
      const failed = error => reject(new FixtureError('listen failed', error));
      server.once('error', failed);
      server.once('listening', () => { server.off('error', failed); resolve(); });
      server.listen(0, '127.0.0.1');
    }), 'listen');
    port = server.address().port;
  } catch (error) {
    throw error instanceof FixtureError ? error : new FixtureError('fixture setup failed', error);
  }

  function invoke(pkg = A) {
    const at = { pkg, mono: clock.mono, wallOffset: clock.wall - wallOrigin };
    const wire = JSON.stringify({ v: 1, pkg, id: 'panel', surface: 'panel', action: 'copy', scope: { sessionId: 's' }, userGesture: true });
    const work = observed(new Promise((resolve, reject) => {
      let req, timer, settled = false, responseSeen = false;
      const fail = (label, cause) => {
        if (settled) return;
        settled = true; realClearTimeout(timer); requests.delete(req);
        const error = new FixtureError(label, cause); trace.push({ ...at, error: label, entered: counts.get(pkg) });
        reject(error); req?.destroy();
      };
      req = request({ host: '127.0.0.1', port, path: '/dsh-go/v1/invoke', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire), connection: 'close' } }, res => {
        responseSeen = true; const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('aborted', () => fail('response aborted'));
        res.on('error', error => fail('response error', error));
        res.on('close', () => { if (!settled) fail('response closed before end'); });
        res.on('end', () => {
          if (settled) return;
          if (!res.complete) { fail('response was incomplete'); return; }
          const rawBody = Buffer.concat(chunks).toString('utf8'); let body;
          try { body = JSON.parse(rawBody); } catch (error) { fail('response was not JSON', error); return; }
          const value = { status: res.statusCode, body, retryAfter: res.headers['retry-after'] ?? null };
          settled = true; realClearTimeout(timer); requests.delete(req);
          trace.push({ ...at, ...value, rawBody, headers: res.headers, entered: counts.get(pkg), complete: res.complete });
          resolve(value);
        });
      });
      requests.add(req);
      req.on('error', error => fail('request error', error));
      req.on('close', () => { if (!settled && !responseSeen) fail('request closed without a response'); });
      timer = realSetTimeout(() => fail('HTTP real watchdog'), WATCHDOG_MS);
      req.end(wire);
    }).catch(error => { throw error instanceof FixtureError ? error : new FixtureError('request setup failed', error); }));
    clientWork.push(work); return work;
  }
  return {
    invoke,
    at(mono, wallOffset) { clock.mono = mono; clock.wall = wallOrigin + wallOffset; },
    count: pkg => counts.get(pkg),
    hold(pkg = A) {
      const enter = deferred(), result = deferred();
      const gate = { enter, result, release: () => result.resolve(copy()) };
      gates.push(gate); queues.get(pkg).push(gate);
      return { entered: deadline(enter.promise, 'handler entry'), release: gate.release };
    },
  };
}

test('R1 invoke accepts a fresh copy after elapsed time despite wall rollback', { concurrency: false }, async t => {
  const f = await fixture(t);
  guard(projection(await f.invoke()), copied, 'R1 first copy'); guard(f.count(A), 1, 'R1 first handler entry');
  f.at(1000, -59000);
  const response = await f.invoke(); candidateResponse(response, 'R1 second copy');
  assert.deepEqual({ ...projection(response), entered: f.count(A) }, { ...copied, entered: 2 }, 'R1 semantic oracle: rollback must not reject the next lawful copy');
});

test('R2 invoke does not refill a spent burst on a wall clock jump', { concurrency: false }, async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 8; i++) {
    guard(projection(await f.invoke()), copied, `R2 initial copy ${i}`); guard(f.count(A), i, `R2 handler entry ${i}`);
  }
  f.at(100, 60100);
  const response = await f.invoke(); candidateResponse(response, 'R2 ninth copy');
  assert.deepEqual({ ...projection(response), entered: f.count(A) }, { ...limited, entered: 8 }, 'R2 semantic oracle: a wall jump must not replenish the relative budget');
});

test('C1 invoke starts at monotonic zero and retains burst and elapsed refill', { concurrency: false }, async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 8; i++) {
    guard(projection(await f.invoke()), copied, `C1 initial copy ${i}`); guard(f.count(A), i, `C1 handler entry ${i}`);
  }
  guard(projection(await f.invoke()), limited, 'C1 exhausted burst'); guard(f.count(A), 8, 'C1 rejected request did not enter');
  f.at(250, 250);
  guard(projection(await f.invoke()), copied, 'C1 elapsed refill'); guard(f.count(A), 9, 'C1 refill handler entry');
  guard(projection(await f.invoke()), limited, 'C1 one refill is spent'); guard(f.count(A), 9, 'C1 second rejection did not enter');
});

test('C2 invoke keeps concurrency, release and package buckets independent', { concurrency: false }, async t => {
  const f = await fixture(t), pending = [];
  for (let i = 1; i <= 4; i++) {
    const gate = f.hold(), work = f.invoke(); pending.push({ gate, work });
    await gate.entered; guard(f.count(A), i, `C2 held handler ${i}`);
  }
  guard(projection(await f.invoke()), limited, 'C2 concurrency limit'); guard(f.count(A), 4, 'C2 concurrent rejection did not enter');
  guard(projection(await f.invoke(B)), copied, 'C2 other package while A is full'); guard(f.count(B), 1, 'C2 other handler entry');
  pending[0].gate.release(); guard(projection(await pending[0].work), copied, 'C2 first release completes');
  for (let i = 5; i <= 8; i++) {
    guard(projection(await f.invoke()), copied, `C2 released slot copy ${i}`); guard(f.count(A), i, `C2 released slot entry ${i}`);
  }
  guard(projection(await f.invoke()), limited, 'C2 burst exhausted with only three held'); guard(f.count(A), 8, 'C2 spent burst did not enter');
  guard(projection(await f.invoke(B)), copied, 'C2 other package after A budget is spent'); guard(f.count(B), 2, 'C2 independent second entry');
  for (const { gate } of pending.slice(1)) gate.release();
  for (const { work } of pending.slice(1)) guard(projection(await work), copied, 'C2 remaining held copy completes');
});
