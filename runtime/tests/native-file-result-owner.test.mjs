// Real native HTTP/WS and selected-file callbacks, isolated so Node's default
// unhandled-rejection handling is observable. The Loader context is a fixture.
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
  'retired-valid-rejection',
  'retired-invalid-rejection',
  'timed-out-valid-rejection',
  'timed-out-invalid-rejection',
  'current-valid-rejection',
  'invalid-lazy-not-started',
  'normal-completion',
  'ordinary-rejection',
];

async function probe(mode, dir) {
  assert.ok(cases.includes(mode));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'file-owner-test', version: '1.0.0',
    dshGo: {v: 1, capabilities: ['files'], contributes: {'composer.actions': [
      {id: 'choose', label: 'Choose', requires: ['files']},
      {id: 'healthy', label: 'Healthy'},
    ]}},
  }));
  writeFileSync(join(dir, 'index.js'), '');
  const entry = {
    options: {name: pathToFileURL(join(dir, 'index.js')).href},
    parent: {tree: {ctx: {baseUrl: pathToFileURL(`${dir}/`).href}}},
    fiber: {uid: 7},
  };
  const disposers = [];
  const core = new NativeCore({
    get: name => name === 'loader' ? {entries: () => [entry]} : undefined,
    logger: {warn() {}},
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
    const request = async (path, body, contentType = 'application/json') => {
      const response = await fetch(`${origin}/dsh-go/v1/${path}`, {
        method: 'POST', headers: {'content-type': contentType},
        body: contentType === 'application/json' ? JSON.stringify(body) : body,
      });
      return {status: response.status, body: await response.json()};
    };
    let signal;
    let rejectWork;
    let functionCalls = 0;
    let callbackCalls = 0;
    let entered;
    let releaseOrigin;
    let outer;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { releaseOrigin = resolve; });
    service.on('choose', (_scope, event) => {
      if (event.action !== 'selected') return {type: 'pickFile', action: 'selected'};
      callbackCalls++;
      signal = event.signal;
      assert.equal(event.value.status, 'selected');
      assert.equal(service.readPickedFile(event.value.files[0].handle).toString(), 'abc');
      if (mode.startsWith('retired-') || mode.startsWith('timed-out-')) {
        outer = (async () => {
          entered();
          await held;
          return {
            pending: mode.includes('-invalid-') ? 'soon' : true,
            result: Promise.reject(new Error(`picked ${mode}`)),
          };
        })();
        return outer;
      }
      if (mode === 'normal-completion') return {toast: 'uploaded'};
      if (mode === 'ordinary-rejection') throw new Error('ordinary file callback failed');
      if (mode === 'invalid-lazy-not-started') {
        return {pending: false, result: () => { functionCalls++; throw new Error('must not start'); }};
      }
      if (mode === 'invalid-late-rejection') {
        return {pending: false, result: new Promise((_resolve, reject) => { rejectWork = reject; })};
      }
      return {
        pending: mode === 'current-valid-rejection' ? true : 'soon',
        result: Promise.reject(new Error(`picked ${mode}`)),
      };
    });
    service.on('healthy', () => ({toast: 'still serving'}));

    ws = new WebSocket(origin.replace('http:', 'ws:') + '/dsh-go/v1/stream');
    const welcome = new Promise((resolve, reject) => {
      ws.addEventListener('error', reject, {once: true});
      ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.t === 'welcome') resolve(message);
      });
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({t: 'hello', v: [1], features: ['files']}));
    const connection = (await welcome).conn;
    const invoke = id => request('invoke', {
      v: 1, pkg: 'file-owner-test', id, surface: 'composer.actions',
      stream: connection, userGesture: true,
    });
    const choice = await invoke('choose');
    assert.equal(choice.status, 200);
    const effect = choice.body.effects[0];
    assert.equal(effect.type, 'pickFile');
    const path = operation => `files/${effect.request}/${operation}?stream=${connection}`;
    const upload = await request(path('upload') + '&name=note.txt', 'abc', 'application/octet-stream');
    assert.equal(upload.status, 200);
    assert.equal(upload.body.file.bytes, 3);

    if (mode.startsWith('timed-out-')) {
      ({mock} = await import('node:test'));
      mock.timers.enable({apis: ['setTimeout']});
    }
    const completion = request(path('complete'), {status: 'selected'});
    if (mode.startsWith('retired-')) {
      await started;
      const revoked = once(signal, 'abort');
      service.on('choose', () => ({toast: 'replacement'}));
      await revoked;
      assert.equal(signal.aborted, true);
      releaseOrigin();
    } else if (mode.startsWith('timed-out-')) {
      await started;
      // Expire the real withTimeout deadline, without a real three-second wait.
      mock.timers.tick(core.limits.handlerTimeoutMs);
    }
    const response = await completion;
    const health = {...core.health.get('file-owner-test')};
    assert.equal(callbackCalls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(functionCalls, 0);
    if (mode.startsWith('retired-')) {
      assert.equal(response.status, 410);
      assert.equal(response.body.error.code, 'cancelled');
      assert.equal(health.consecutive ?? 0, 0);
    } else if (mode.startsWith('timed-out-')) {
      assert.equal(response.status, 504);
      assert.equal(response.body.error.code, 'timeout');
      assert.equal(health.consecutive, 1);
      releaseOrigin();
      await outer;
      mock.timers.reset();
      mock = undefined;
    } else if (mode === 'ordinary-rejection') {
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, 'plugin-error');
      assert.equal(health.consecutive, 1);
    } else {
      assert.equal(response.status, 200);
      if (mode === 'normal-completion') {
        assert.deepEqual(response.body.effects, [{type: 'toast', text: 'uploaded'}]);
        assert.equal(health.consecutive ?? 0, 0);
      } else {
        assert.deepEqual(response.body.effects, []);
        assert.equal(response.body.pending, undefined);
        assert.equal(response.body.issues[0].code, 'bad-effect');
        assert.equal(health.consecutive, 1);
      }
    }
    rejectWork?.(new Error('picked invalid-late-rejection'));
    // A real event turn exposes an unowned rejection to Node's default handler.
    await nextTurn();
    assert.equal((await request(path('complete'), {status: 'selected'})).status, 404);
    const healthy = await invoke('healthy');
    assert.equal(healthy.status, 200);
    assert.deepEqual(healthy.body.effects, [{type: 'toast', text: 'still serving'}]);
    console.log(JSON.stringify({mode, response, healthy, callbackCalls, functionCalls,
      aborted: signal.aborted, consecutive: health.consecutive ?? 0}));
  } finally {
    mock?.timers.reset();
    ws?.close();
    routes.dispose();
    core.dispose();
    for (const dispose of disposers.reverse()) dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[2] === '--probe') {
  await probe(process.argv[3], process.argv[4]);
} else {
  const {test} = await import('node:test');
  for (const mode of cases) test(`file callback result owner: ${mode}`, {timeout: 10000}, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-file-owner-'));
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
    assert.equal(code, 0, `child must keep serving after the file callback: ${stderr}`);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.mode, mode);
    assert.equal(result.healthy.status, 200);
  });
}
