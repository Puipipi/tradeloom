// Actual persisted logs, locked Host and its HTTP/WebSocket error boundary.
// Synthetic data only; no read policy or stored event is repaired by this test.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (!process.env.DSH_PREFIX) throw Error('Set DSH_PREFIX to the private fully patched locked prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const require = createRequire(join(prefix, 'node_modules/@deepseek-ai/dsh-api-gateway/package.json'));
const WebSocket = require('ws');
let root, child, exited, watchdog, model, base, cookie;
let hostText = '', modelRequests = 0, requestId = 0;
const logs = new Map();
const clean = text => text.replace(/token=[\w-]+/g, 'token=[REDACTED]');

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-format-error-'));
  const profile = join(root, 'profile'), workspace = join(root, 'workspace'), sessions = join(root, 'sessions');
  await mkdir(profile); await mkdir(workspace);
  const { Context } = await load('cordis'), { Session } = await load('dsh-session');
  const jsonl = await load('dsh-session-persistence-jsonl'), { createUserMessage } = await load('dsh-llm');
  const ctx = new Context();
  try {
    await jsonl.apply(ctx, { root: sessions, compression: 'none' });
    for (const id of ['unknown', 'marked', 'corrupt', 'valid']) {
      const session = Session.create(`synthetic-${id}`, undefined, {
        ...Session.create(`synthetic-${id}`).header, cwd: workspace,
      });
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Synthetic retained message' }],
        source: { kind: 'user', rpcId: `synthetic-${id}` },
      }), { surfaceOp: 'append' });
      const writer = await ctx.sessionPersistence.create(session.header);
      try { await writer.append(session.snapshotEvents()); await writer.flush(); }
      finally { await writer.close(); }
    }
  } finally { await ctx.fiber.dispose(); }
  for (const relative of await readdir(sessions, { recursive: true })) {
    if (!relative.endsWith('.jsonl')) continue;
    const path = join(sessions, relative), text = await readFile(path, 'utf8');
    const header = JSON.parse(text.split('\n', 1)[0]);
    const id = header.id.replace('synthetic-', '');
    let next = text;
    if (id === 'unknown' || id === 'marked') {
      const event = { type: 'permissionRules/decision', seq: 1, time: header.createdAt,
        data: { synthetic: true }, ...(id === 'marked' ? { ignorable: true } : {}) };
      next += JSON.stringify(event) + '\n';
    } else if (id === 'corrupt') {
      const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
      rows[1].data = null;
      next = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    }
    await writeFile(path, next);
    logs.set(id, { path, bytes: Buffer.from(next) });
  }
  assert.equal(logs.size, 4);
  model = createServer((_request, response) => {
    modelRequests++; response.writeHead(500).end('Unexpected synthetic model request');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel',
    'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web']
    .map(id => ({ id, disabled: true }));
  patch.push(
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: 'SYNTHETIC_UNUSED_KEY' } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
  );
  const patchPath = join(root, 'patch.json'); await writeFile(patchPath, JSON.stringify(patch));
  const inherited = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patchPath,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, env: { ...inherited, DSH_PREFIX: prefix, DSH_HOME: profile,
      DSH_TELEMETRY_DISABLED: '1', SYNTHETIC_UNUSED_KEY: 'synthetic-unused', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(child, 'close');
  const ready = Promise.withResolvers();
  const receive = chunk => {
    hostText += chunk;
    const found = hostText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
    if (found) ready.resolve(found[0]);
  };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  watchdog = setTimeout(() => child.kill('SIGKILL'), 45000);
  const launch = await Promise.race([ready.promise, exited.then(() => { throw Error('Private Host exited before ready: ' + clean(hostText)); })]);
  base = new URL(launch).origin;
  const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert(cookie, 'Expected authenticated loopback Host cookie');
}, { timeout: 45000 });

after(async () => {
  if (child) { child.kill('SIGTERM'); await exited; }
  clearTimeout(watchdog);
  if (model) { model.closeAllConnections(); await new Promise(done => model.close(done)); }
  try {
    for (const { path, bytes } of logs.values()) assert.deepEqual(await readFile(path), bytes, 'Reading never rewrites or drops log events');
    assert.equal(modelRequests, 0);
  } finally { if (root) await rm(root, { recursive: true, force: true }); }
});

function request(id) {
  return { request: { address: { kind: 'session', sessionId: `synthetic-${id}` } } };
}
async function page(id) {
  const response = await fetch(base + '/api/session/page', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: String(requestId++), method: 'session/page', payload: { args: request(id) } }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
async function follow(id) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { origin: base, cookie } });
  try {
    await once(ws, 'open');
    const incoming = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'open', streamId: 'synthetic-follow', endpoint: 'session/follow', payload: { args: request(id) } }));
    const [message] = await incoming;
    return JSON.parse(String(message));
  } finally { ws.close(); await once(ws, 'close'); }
}

test('unknown required history has a stable format error through HTTP', async () => {
  const result = await page('unknown');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'session/format-unsupported');
  assert.match(result.error.message, /permissionRules\/decision/);
});
test('unknown required history has the same format error on the real follow carrier', async () => {
  const frame = await follow('unknown');
  assert.equal(frame.type, 'error');
  assert.equal(frame.error.code, 'session/format-unsupported');
});
test('an explicitly ignorable extension remains readable through the same endpoints', async () => {
  const result = await page('marked');
  assert.equal(result.ok, true);
  assert.equal(result.value.cursor, 1);
  assert.equal((await follow('marked')).value.type, 'snapshot');
});
test('malformed known event data keeps its generic error instead of claiming a format upgrade', async () => {
  const result = await page('corrupt');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'gateway/internal');
});
test('valid history and a genuinely missing session keep their existing outcomes', async () => {
  assert.equal((await page('valid')).ok, true);
  const absent = await page('absent');
  assert.equal(absent.ok, false);
  assert.equal(absent.error.code, 'session/not-found');
});
