// Exercise the real native service and HTTP routes in an isolated Node process.
// The Loader context is a fixture; no unhandled-rejection listener is installed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {NativeCore} from '../bridge/dsh-go-bridge/lib/native/core.js';
import {effectiveLimits} from '../bridge/dsh-go-bridge/lib/native/limits.js';
import {createNativeRoutes} from '../bridge/dsh-go-bridge/lib/native/routes.js';

const cases = [
  'invalid-eager-rejection',
  'invalid-late-rejection',
  'retired-invalid-eager-rejection',
  'invalid-function-not-started',
  'invalid-missing-work',
  'valid-no-stream-rejection',
  'valid-stream-rejection',
  'valid-stream-success',
  'valid-stream-thenable-success',
  'valid-stream-limit-rejection',
  'timed-out-valid-rejection',
  'timed-out-invalid-rejection',
  'timed-out-later-rejection',
  'timed-out-lazy-not-started',
  'timed-out-plain-result',
  'timed-out-outer-rejection',
  'ordinary-handler-rejection',
];

async function probe(mode) {
  assert.ok(cases.includes(mode));
  const dir = process.argv[4] ?? mkdtempSync(join(tmpdir(), 'dsh-deferred-owner-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'deferred-owner-test', version: '1.0.0',
    dshGo: {v: 1, contributes: {'composer.actions': [
      {id: 'work', label: 'Work'}, {id: 'healthy', label: 'Healthy'},
    ]}},
  }));
  writeFileSync(join(dir, 'index.js'), '');
  const entry = {
    options: {name: pathToFileURL(join(dir, 'index.js')).href},
    parent: {tree: {ctx: {baseUrl: pathToFileURL(`${dir}/`).href}}},
    fiber: {uid: 7},
  };
  const disposers = [];
  const warnings = [];
  const core = new NativeCore({
    get: name => name === 'loader' ? {entries: () => [entry]} : undefined,
    logger: {warn(...args) { warnings.push(args); }},
  }, effectiveLimits({}), 'test');
  const routes = createNativeRoutes(core);
  const service = Object.assign(Object.create(core.service), {ctx: {
    fiber: {entry},
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
  }});
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    routes.handle(req, res, url.pathname, url);
  });
  server.on('upgrade', (req, socket, head) => routes.upgrade(req, socket, head));
  let ws;
  let mock;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    let signal;
    let rejectWork;
    let functionCalls = 0;
    let thenCalls = 0;
    let invocationCalls = 0;
    let entered;
    let releaseOrigin;
    let outer;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { releaseOrigin = resolve; });
    service.on('work', (_scope, event) => {
      signal = event.signal;
      invocationCalls++;
      if (mode === 'valid-stream-limit-rejection' && invocationCalls <= 2) {
        return {pending: true, result: () => new Promise(() => {})};
      }
      if (mode.startsWith('timed-out-')) {
        outer = (async () => {
          entered();
          await held;
          if (mode === 'timed-out-outer-rejection') throw new Error('late outer rejection');
          if (mode === 'timed-out-plain-result') return {toast: 'discard late effect'};
          if (mode === 'timed-out-lazy-not-started') return {pending: true, result: () => {
            functionCalls++; throw new Error('must not start late lazy work');
          }};
          return {pending: mode === 'timed-out-invalid-rejection' ? 'soon' : true,
            result: mode === 'timed-out-later-rejection'
              ? new Promise((_resolve, reject) => { rejectWork = reject; })
              : Promise.reject(new Error('late nested rejection'))};
        })();
        return outer;
      }
      switch (mode) {
        case 'ordinary-handler-rejection': throw new Error('ordinary handler failed');
        case 'invalid-eager-rejection':
          return {pending: 'soon', result: Promise.reject(new Error('eager work failed'))};
        case 'invalid-late-rejection':
          return {pending: false, result: new Promise((_resolve, reject) => { rejectWork = reject; })};
        case 'retired-invalid-eager-rejection':
          return (async () => {
            entered();
            await held;
            return {pending: 'soon', result: Promise.reject(new Error('retired work failed'))};
          })();
        case 'invalid-function-not-started':
          return {pending: 'soon', result: () => { functionCalls++; throw new Error('must not start'); }};
        case 'invalid-missing-work':
          return {pending: true};
        case 'valid-stream-thenable-success':
          return {pending: true, result: {then(resolve) {
            thenCalls++; resolve({toast: 'finished'});
          }}};
        case 'valid-stream-success':
          return {pending: true, result: Promise.resolve({toast: 'finished'})};
        default:
          return {pending: true, result: Promise.reject(new Error('valid work failed'))};
      }
    });
    service.on('healthy', () => ({toast: 'still serving'}));

    let connection;
    let next;
    if (mode.startsWith('valid-stream-')) {
      ws = new WebSocket(origin.replace('http:', 'ws:') + '/dsh-go/v1/stream');
      const queued = [];
      const waiters = [];
      ws.addEventListener('message', event => {
        const value = JSON.parse(event.data);
        const index = waiters.findIndex(w => w.predicate(value));
        if (index < 0) queued.push(value);
        else {
          const [waiter] = waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      });
      next = predicate => {
        const index = queued.findIndex(predicate);
        if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = {predicate, resolve};
          waiter.timer = setTimeout(() => reject(new Error('stream response deadline')), 3000);
          waiters.push(waiter);
        });
      };
      await once(ws, 'open');
      ws.send(JSON.stringify({t: 'hello', v: [1]}));
      connection = (await next(value => value.t === 'welcome')).conn;
    }
    const invoke = async id => {
      const response = await fetch(origin + '/dsh-go/v1/invoke', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({v: 1, pkg: 'deferred-owner-test', id,
          surface: 'composer.actions', ...(connection ? {stream: connection} : {})}),
      });
      return {status: response.status, body: await response.json()};
    };
    if (mode.startsWith('timed-out-')) {
      ({mock} = await import('node:test'));
      mock.timers.enable({apis: ['setTimeout']});
    }
    if (mode === 'valid-stream-limit-rejection') {
      for (let i = 0; i < 2; i++) {
        const heldPending = await invoke('work');
        assert.equal(heldPending.status, 200);
        assert.ok(heldPending.body.pending.id);
      }
    }
    const work = invoke('work');
    if (mode === 'retired-invalid-eager-rejection') {
      await started;
      service.on('work', () => ({toast: 'replacement'}));
      releaseOrigin();
    }
    if (mode.startsWith('timed-out-')) {
      await started;
      // Drive the production deadline without adding a real three-second CI wait.
      mock.timers.tick(core.limits.handlerTimeoutMs);
    }
    const response = await work;
    const health = {...core.health.get('deferred-owner-test')};
    if (mode.startsWith('timed-out-')) {
      assert.equal(response.status, 504);
      assert.equal(response.body.error.code, 'timeout');
      assert.equal(health.consecutive, 1);
      assert.equal(signal.aborted, true);
      releaseOrigin();
      if (mode === 'timed-out-outer-rejection') await assert.rejects(outer, /late outer rejection/);
      else await outer;
      mock.timers.reset();
      mock = undefined;
      assert.equal(functionCalls, 0);
      rejectWork?.(new Error('late nested work subsequently rejected'));
    } else if (mode === 'ordinary-handler-rejection') {
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'plugin-error');
      assert.equal(health.consecutive, 1);
      assert.equal(signal.aborted, true);
    } else if (mode === 'retired-invalid-eager-rejection') {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.effects, []);
      assert.equal(response.body.pending, undefined);
      assert.match(response.body.issues[0].message, /registration/);
      assert.equal(health.consecutive ?? 0, 0);
      assert.equal(signal.aborted, true);
    } else if (mode.startsWith('invalid-')) {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.effects, []);
      assert.equal(response.body.pending, undefined);
      assert.equal(response.body.issues[0].code, 'bad-effect');
      assert.equal(health.consecutive, 1);
      assert.equal(signal.aborted, true);
      assert.equal(functionCalls, 0);
      if (rejectWork) rejectWork(new Error('late work failed'));
    } else if (mode === 'valid-no-stream-rejection') {
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'no-stream');
      assert.equal(health.consecutive ?? 0, 0);
      assert.equal(signal.aborted, true);
    } else if (mode === 'valid-stream-limit-rejection') {
      assert.equal(response.status, 429);
      assert.equal(response.body.error.code, 'too-many-pending');
      assert.equal(response.body.pending, undefined);
      assert.equal(response.body.effects, undefined);
      assert.equal(signal.aborted, true);
      assert.equal(health.consecutive ?? 0, 0);
    } else {
      assert.equal(response.status, 200);
      assert.ok(response.body.pending.id);
      const result = await next(value => value.pending === response.body.pending.id);
      if (mode === 'valid-stream-success' || mode === 'valid-stream-thenable-success') {
        assert.equal(result.t, 'done');
        assert.deepEqual(result.effects, [{type: 'toast', text: 'finished'}]);
        assert.equal(signal.aborted, false);
      } else {
        assert.equal(result.t, 'void');
        assert.equal(result.reason, 'error');
        assert.equal(signal.aborted, true);
        assert.equal(warnings.length, 1);
      }
      assert.equal(core.health.get('deferred-owner-test')?.consecutive ?? 0, 0);
    }
    if (mode === 'valid-stream-thenable-success') assert.equal(thenCalls, 1);
    // An actual event turn lets a forgotten rejection reach Node's default handling.
    await nextTurn();
    const healthy = await invoke('healthy');
    assert.equal(healthy.status, 200);
    assert.deepEqual(healthy.body.effects, [{type: 'toast', text: 'still serving'}]);
    console.log(JSON.stringify({mode, response, healthy, functionCalls, aborted: signal.aborted}));
  } finally {
    mock?.timers.reset();
    ws?.close();
    routes.dispose();
    core.dispose();
    for (const dispose of disposers.reverse()) dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
}

if (process.argv[2] === '--probe') {
  await probe(process.argv[3]);
} else {
  const {test} = await import('node:test');
  for (const mode of cases) test(`deferred result owner: ${mode}`, {timeout: 10000}, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deferred-owner-'));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--probe', mode, dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { child.kill(); rmSync(dir, {recursive: true, force: true}); });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, `child must keep serving after the local result: ${stderr}`);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.mode, mode);
    assert.equal(result.healthy.status, 200);
  });
}
