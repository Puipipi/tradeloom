import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateImage } from '../src/core.js';
import { createHttpTransport, isPublicAddress } from '../src/http.js';

// Synthetic one-pixel PNG fixture; not a live DSH or paid-provider recording.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6sAAAAASUVORK5CYII=', 'base64');
const KEY = 'MOCK_ONLY_SECRET_7d195a891b';
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function filesBelow(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(child));
    else found.push(child);
  }
  return found;
}

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-media-test-'));
  const cwd = join(root, 'work');
  const hostStateDir = join(root, 'state');
  await mkdir(cwd);
  const sockets = new Set();
  const failures = [];
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const controller = new AbortController();
  const context = {
    hostStateDir, sessionId: 'media-test-session', signal: controller.signal,
    resolveCredential: async () => KEY,
    authorizeWorkspace: async () => ({ cwd, workspaceRoot: cwd, mode: 'workspace-write' }),
    transport: createHttpTransport({ allowLoopback: true }),
  };
  const request = {
    prompt: '一只猫', n: 1, aspect: '1:1',
    service: { id: 'mock', provider: 'mock', baseUrl: origin + '/v1', profile: 'openai-gpt-image' },
    model: { id: 'mock-image', label: 'Mock image', sizes: ['1024x1024'], aspectSizes: { '1:1': '1024x1024' } },
  };
  return { root, cwd, hostStateDir, origin, context, request, controller };
}

test('base64 bytes, actual dimensions, v1 meta, private index and safe output', { timeout: 10000 }, async t => {
  let sent;
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/images/generations');
    assert.equal(req.headers.authorization, 'Bearer ' + KEY);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    json(res, { data: [{ b64_json: PNG.toString('base64'), revised_prompt: '猫 ' + KEY + ' https://signed.invalid/a?secret=x' }] });
  });
  const result = await generateImage(f.request, f.context);
  assert.deepEqual(sent, { model: 'mock-image', prompt: '一只猫', n: 1, size: '1024x1024' });
  assert.equal(result.meta.v, 1);
  assert.equal(result.meta.status, 'done');
  assert.equal(result.meta.items[0].width, 1);
  assert.equal(result.meta.items[0].height, 1);
  assert.deepEqual(await readFile(result.meta.items[0].path), PNG);
  assert.equal(result.meta.cost, undefined);
  assert.equal(result.meta.provenance, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify({ 'dsh-go/media': result.meta })) <= 8192);
  const indexFiles = (await filesBelow(f.hostStateDir)).filter(path => path.endsWith('.json'));
  assert.equal(indexFiles.length, 1);
  const index = await readFile(indexFiles[0], 'utf8');
  assert.deepEqual(JSON.parse(index).media, result.meta);
  assert.deepEqual(JSON.parse(index).contentDigests, [{ bytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex') }]);
  assert.deepEqual(Object.keys(result.meta.items[0]).sort(), ['bytes', 'height', 'mime', 'path', 'width']);
  assert.equal(JSON.stringify(result).includes('contentDigests'), false);
  assert.equal(JSON.stringify(result).includes('sha256'), false);
  for (const text of [index, result.text, JSON.stringify(result.meta)]) {
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes('signed.invalid'), false);
  }
});

test('temporary URL redirects never receive generation authorization', { timeout: 10000 }, async t => {
  let origin;
  const downloads = [];
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/images/generations') {
      json(res, { data: [{ url: origin + '/redirect?signed=canary' }] });
    } else {
      downloads.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.startsWith('/redirect')) {
        res.writeHead(302, { location: '/image?token=do-not-persist' }); res.end();
      } else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }
    }
  });
  origin = f.origin;
  const value = await generateImage(f.request, f.context);
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(item => item.auth === undefined));
  const persisted = await readFile((await filesBelow(f.hostStateDir)).find(path => path.endsWith('.json')), 'utf8');
  assert.equal(persisted.includes('canary'), false);
  assert.equal(persisted.includes('do-not-persist'), false);
  assert.deepEqual(await readFile(value.meta.items[0].path), PNG);
});

test('second invalid image rolls back earlier staged bytes without a public index', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_req, res) => json(res, { data: [
    { b64_json: PNG.toString('base64') }, { b64_json: 'not-an-image' },
  ] }));
  await assert.rejects(generateImage({ ...f.request, n: 2 }, f.context), { code: 'response' });
  assert.deepEqual(await filesBelow(f.cwd), []);
  assert.deepEqual(await filesBelow(f.hostStateDir), []);
});

test('read-only denies before both filesystem writes and HTTP', { timeout: 10000 }, async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits += 1; json(res, {}); });
  f.context.authorizeWorkspace = async () => ({ cwd: f.cwd, workspaceRoot: f.cwd, mode: 'read-only' });
  await assert.rejects(generateImage(f.request, f.context), { code: 'permission' });
  assert.equal(hits, 0);
  assert.deepEqual(await readdir(f.cwd), []);
});

test('an unusable index destination fails before a billable request', { timeout: 10000 }, async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits += 1; json(res, {}); });
  await writeFile(f.hostStateDir, 'occupied');
  await assert.rejects(generateImage(f.request, f.context), { code: 'storage' });
  assert.equal(hits, 0);
  assert.equal(await readFile(f.hostStateDir, 'utf8'), 'occupied');
});

test('plain error responses do not expose credential or provider diagnostics', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(401); res.end('provider echo ' + KEY); });
  await assert.rejects(generateImage(f.request, f.context), error => {
    assert.equal(error.code, 'authentication');
    assert.equal(String(error).includes(KEY), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('unsupported aspect is rejected instead of silently approximated', { timeout: 10000 }, async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits += 1; json(res, {}); });
  await assert.rejects(generateImage({ ...f.request, aspect: '3:4' }, f.context), { code: 'invalid_request' });
  assert.equal(hits, 0);
});

test('abort during a pending HTTP response settles and leaves no files', { timeout: 10000 }, async t => {
  let started;
  const received = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, () => { started(); });
  const running = generateImage(f.request, f.context);
  await received;
  f.controller.abort();
  await assert.rejects(running, { code: 'cancelled' });
  assert.deepEqual(await filesBelow(f.cwd), []);
  assert.deepEqual(await filesBelow(f.hostStateDir), []);
});

test('101 upgrade is rejected without leaving a pending client Promise', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(101, { connection: 'Upgrade', upgrade: 'mock-protocol' });
    res.flushHeaders();
  });
  await assert.rejects(f.context.transport(f.origin, { maxBytes: 1024 }), { code: 'response' });
});

test('response bytes are bounded even with chunked transfer', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200); res.write(Buffer.alloc(1024)); res.end(Buffer.alloc(1024));
  });
  await assert.rejects(f.context.transport(f.origin, { maxBytes: 100 }), { code: 'too_large' });
});

test('private address and Host override fail closed before networking', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:2::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const transport = createHttpTransport({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(transport('https://example.invalid/image', { maxBytes: 100 }), { code: 'unsafe_url' });
  await assert.rejects(transport('https://example.invalid/image', {
    maxBytes: 100, headers: { Host: 'another.invalid' },
  }), { code: 'invalid_request' });
});

test('Content-Length response completes with exact bytes', { timeout: 10000 }, async t => {
  const body = Buffer.from('length-body');
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) }); res.end(body);
  });
  assert.deepEqual((await f.context.transport(f.origin, { maxBytes: 1024 })).body, body);
});

test('chunked response completes with exact bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.write('chunk'); res.end('ed');
  });
  assert.equal((await f.context.transport(f.origin, { maxBytes: 1024 })).body.toString('utf8'), 'chunked');
});

test('EOF-delimited response completes after the final body bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t, (req, _res) => {
    req.socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\neof-body');
  });
  assert.equal((await f.context.transport(f.origin, { maxBytes: 1024 })).body.toString('utf8'), 'eof-body');
});

test('a truncated Content-Length response is rejected', { timeout: 10000 }, async t => {
  const f = await fixture(t, (req, _res) => {
    req.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc');
  });
  await assert.rejects(f.context.transport(f.origin, { maxBytes: 1024 }), { code: 'network' });
});

for (const canary of ['MOCK_ONLY_KEY_"_QUOTE', 'MOCK_ONLY_KEY_\\_SLASH']) {
  test('secret-bearing prompt is rejected before billing even when JSON escapes it: ' + canary.slice(-5),
    { timeout: 10000 }, async t => {
      let hits = 0;
      const f = await fixture(t, (_req, res) => { hits += 1; json(res, {}); });
      f.context.resolveCredential = async () => canary;
      await assert.rejects(generateImage({ ...f.request, prompt: 'draw ' + canary }, f.context),
        { code: 'credential' });
      assert.equal(hits, 0);
      assert.deepEqual(await filesBelow(f.hostStateDir), []);
    });

  test('session identity is included in secret-output preflight: ' + canary.slice(-5),
    { timeout: 10000 }, async t => {
      let hits = 0;
      const f = await fixture(t, (_req, res) => { hits += 1; json(res, {}); });
      f.context.resolveCredential = async () => canary;
      f.context.sessionId = 'session-' + canary;
      await assert.rejects(generateImage(f.request, f.context), { code: 'credential' });
      assert.equal(hits, 0);
      assert.deepEqual(await filesBelow(f.hostStateDir), []);
    });
}

test('documented Gemini-compatible request uses its exact prefix and base64 response shape',
  { timeout: 10000 }, async t => {
    let sent;
    const f = await fixture(t, async (req, res) => {
      assert.equal(req.url, '/v1beta/openai/images/generations');
      assert.equal(req.headers.authorization, 'Bearer ' + KEY);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      json(res, { data: [{ b64_json: PNG.toString('base64') }] });
    });
    const result = await generateImage({
      prompt: '一只猫', n: 1,
      service: {
        id: 'google_fixture', provider: 'google',
        baseUrl: f.origin + '/v1beta/openai', profile: 'openai-compatible',
        responseFormat: 'b64_json',
      },
      model: { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image',
        sizes: [], qualities: [], aspectSizes: {} },
    }, f.context);
    assert.deepEqual(sent, {
      model: 'gemini-2.5-flash-image', prompt: '一只猫', n: 1, response_format: 'b64_json',
    });
    assert.deepEqual(await readFile(result.meta.items[0].path), PNG);
    assert.equal(result.meta.request.model, 'gemini-2.5-flash-image');
    assert.equal(result.meta.request.n, 1);
  });
