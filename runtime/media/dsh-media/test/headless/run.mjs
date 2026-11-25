import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, realpath, writeFile, copyFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Config } from '../../src/config.js';
import { parseMediaUrl } from '../../src/http.js';
import { formatGenerationMessage, parseGenerationMessage } from '../../src/header.js';

const EXPECTED = {
  "src/generated-digests.js": "0a48104d1a4a8b64ba9ca2f22264372b5c5524403fc157aedace93b7da032aa0",
  "package.json": "32e0a1d4e5998d45148f57b1277cb3068cbdfeaa1e5531de47cc6c0eb84a1046",
  "data/models.json": "acd44a57d0232484c905daf95f77c2ffd1d69af14b50dfd1fb94e6d4106d0b0f",
  "src/index.js": "9314b074b66a6e323a7b468787b71c837261a94a23bf7f7aaa956d9dde6ae923",
  "src/config.js": "d8a8430aed22ff1b7169e766e4398ba45dcc913bc57404b7c338e2139a277aa8",
  "src/core.js": "970c82f299e258649611a0b31687d1eea402589772c97aaef0ec3e1cf3d435ed",
  "src/http.js": "627e9430f66cef1253d6b2688eaf63567d2b162b43e8085f8590bd6175f9fa1a",
  "src/storage.js": "e69b5ab9b8c0d902ff4e2ce75c8303a56c53d0fcf729eb8bbe67f1c9c704b240",
  "src/errors.js": "6fcbe3753e9e93c0a1067ff80db9c001962113c2c50867b5a9eb1f13d1cb6a69",
  "src/header.js": "8d86f332d1d986b17a038eaec33334d999c65d5be22fb09678f0385dadd3ae70",
  "src/base64.js": "0e762b9c1db1ce2839a133412ce4d34027d0c7649bdf7801c0bc11a30a390582"
};
const EXPECTED_ENGINE = {
  "@deepseek-ai/dsh/lib/bin.js": "80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f",
  "@deepseek-ai/dsh-headless/lib/index.js": "5402e990dd82d33bccee722e220b518e7f26f82acb79ed707bfebc8eb5c3bead",
  "@deepseek-ai/dsh-headless/cordis.patch.yml": "f4d5f53f070089a7fc5209bd47c9ae4e85b99d042cbe76be88ab1ed63dfb8fc8",
  "@deepseek-ai/dsh-session/lib/index.js": "2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf",
  "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js": "973dd78679b2661d6f492343bc22b124ae958aa597d3b36c698a2c650f909984",
  "@deepseek-ai/dsh-session-checkpoint-policy/lib/index.js": "80a4475de0594399bfdd3203e000cfe0bf1967af163f8747c45b9b80e9549f2a",
  "@deepseek-ai/dsh-tools/lib/index.js": "1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a",
  "@deepseek-ai/dsh-credentials/lib/index.js": "1b6afdb04e966285e0732eb766eb0a12f3f9c0821c8caacfd192ce1ac88bee7a",
  "@deepseek-ai/dsh-credentials-local/lib/index.js": "6b4926ef62bfeb95bc3d7687b85303d739a41e813fe05ac06de50111361da069",
  "@deepseek-ai/dsh-fs-local/lib/index.js": "63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f",
  "@deepseek-ai/dsh-working-directory/lib/index.js": "af5bb7f33c52efe018da19c39c54e07b5a3ac804fff83f8a68e341f411ecf703",
  "@deepseek-ai/dsh-sandbox-policy/lib/index.js": "772ca58f0f786d6cb4d839deb621634c31097c13228d81b14e3f3153d0524924",
  "@deepseek-ai/dsh-app-boot/lib/index.js": "5135179ac810e4f626f32ec3bdc3293dc7d2028e8aa92e5e0c006f1a33b78e76",
  "@deepseek-ai/cordis-plugin-loader/lib/index.js": "638b9ad360e01236120772323f80a65570c4f3f42f4cfc6243330241025b6d72",
  "@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js": "67f9cbc26ce0ea07009e0c36ee4a7cc058542cdf85b873549885922646cacd35",
  "@deepseek-ai/dsh-llm-mock-server/lib/index.js": "971e8bb0db89bce597223f5f30444c2ca79ebaf7a8b37d23614900c0b88b52c9"
};
const EXPECTED_TEST_LOCK = '8f1f2d0363e8c481ef1d163be1f263ba8089b378f9a2f99dd02707ce571fb68c';
const PRODUCT = fileURLToPath(new URL('../../', import.meta.url));
const PLUGIN = fileURLToPath(new URL('./plugin.mjs', import.meta.url));
const MODEL = 'gemini-2.5-flash-image';
const LABEL = 'Gemini 2.5 Flash Image';
const DRAW_PROMPT = '一个蓝色圆形。';
const IMAGE_KEY = 'HEADLESS_IMAGE_TEST_KEY_ONLY';
const LLM_KEY = 'HEADLESS_LLM_TEST_KEY_ONLY';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6sAAAAASUVORK5CYII=', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonl = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const json = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

function errorRecord(error, depth = 0) {
  const record = {
    name: String(error?.name ?? 'Error'),
    code: error?.code == null ? null : String(error.code),
    message: String(error?.message ?? error).slice(0, 8192),
  };
  if (depth < 3 && Array.isArray(error?.errors)) {
    record.errors = error.errors.slice(0, 16).map(item => errorRecord(item, depth + 1));
  }
  return record;
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function inside(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}

async function packageIdentity(entry, expectedName, mode) {
  const path = await realpath(entry);
  const entryBytes = await readFile(path);
  let directory = dirname(path);
  for (;;) {
    const packagePath = join(directory, 'package.json');
    let bytes;
    try { bytes = await readFile(packagePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (bytes) {
      const metadata = JSON.parse(bytes.toString('utf8'));
      if (metadata.name === expectedName) return {
        mode, path, bytes: entryBytes.length, sha256: sha(entryBytes),
        packageRoot: await realpath(directory), packagePath: await realpath(packagePath),
        packageName: metadata.name, packageVersion: metadata.version,
        packageBytes: bytes.length, packageSha256: sha(bytes),
      };
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, 'resolved entry has no matching package root: ' + expectedName);
    directory = parent;
  }
}

function samePackage(left, right, name) {
  assert.equal(left.packageRoot, right.packageRoot, 'duplicate package root: ' + name);
  assert.equal(left.packageSha256, right.packageSha256, 'package manifest changed: ' + name);
  assert.equal(left.packageName, name);
  assert.equal(right.packageName, name);
}

async function filesBelow(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'probe artifacts must not traverse symlinks');
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else result.push(path);
  }
  return result;
}

function environment(home, capture, imageOrigin) {
  // Do not inherit provider keys, proxy settings, NODE_OPTIONS, DSH overlays or
  // unrelated account credentials. HOME/CODEX_HOME are never reassigned.
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, TZ: 'Asia/Shanghai', DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
    DSH_MEDIA_HEADLESS_PROBE: '1',
    DSH_MEDIA_PROBE_CAPTURE_DIR: capture,
    DSH_MEDIA_PROBE_IMAGE_ORIGIN: imageOrigin,
    DSH_MEDIA_SLOT_1_API_KEY: IMAGE_KEY,
    DSH_MEDIA_PROBE_LLM_KEY: LLM_KEY,
  };
}

async function processRun(cli, args, options) {
  return new Promise(resolveRun => {
    let child;
    let stdout = '';
    let stderr = '';
    let forced;
    let stopped = false;
    let settled = false;
    let spawned = false;
    let exitSeen = false;
    let exitCode = null;
    let exitSignal = null;
    let timer;
    let hardTimer;
    let drainTimer;
    const errors = [];
    const killAttempts = [];
    const recordError = (stage, error) => {
      errors.push({
        stage, name: String(error?.name ?? 'Error'),
        code: error?.code == null ? null : String(error.code),
        syscall: error?.syscall == null ? null : String(error.syscall),
        message: String(error?.message ?? error).slice(0, 2048),
      });
    };
    const finish = (closure, code = null, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      clearTimeout(drainTimer);
      resolveRun({
        code, signal, forced, stdout, stderr, closure, closed: closure === 'close',
        pid: child?.pid ?? null, spawned, exitSeen, exitCode, exitSignal,
        errors: [...errors], killAttempts: [...killAttempts],
      });
    };
    const kill = signal => {
      if (settled || !child) return;
      const attempt = { signal, pid: child.pid ?? null, accepted: null, at: new Date().toISOString() };
      killAttempts.push(attempt);
      try { attempt.accepted = child.kill(signal); }
      catch (error) { recordError('kill:' + signal, error); attempt.threw = true; }
    };
    const stop = reason => {
      if (settled || stopped) return;
      stopped = true;
      forced = reason;
      // Establish both timers before kill: kill can synchronously emit error.
      hardTimer = setTimeout(() => kill('SIGKILL'), 5000);
      drainTimer = setTimeout(() => {
        if (settled) return;
        // Failure is explicit. A missing close can mean a live process or pipes
        // still held open. Never report this as drained or continue the next case.
        for (const label of ['stdout', 'stderr']) {
          try { child?.[label]?.destroy(); }
          catch (error) { recordError(label + ':detach', error); }
        }
        try { child?.unref(); }
        catch (error) { recordError('child:unref', error); }
        finish('close-timeout');
      }, 10000);
      kill('SIGTERM');
    };
    try {
      child = spawn(process.execPath, [cli, ...args], {
        cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      recordError('spawn-sync', error);
      finish('not-spawned');
      return;
    }
    // Register lifecycle listeners before touching streams. Keep error listening
    // after the first error: a later failed kill can emit another error.
    child.on('error', error => { recordError('child', error); stop('process error'); });
    child.once('spawn', () => { spawned = true; });
    child.once('exit', (code, signal) => {
      exitSeen = true; exitCode = code; exitSignal = signal;
    });
    child.once('close', (code, signal) => finish('close', code, signal));
    timer = setTimeout(() => stop('timeout'), 90000);
    const attach = (stream, label, maxBytes) => {
      if (!stream || typeof stream.on !== 'function') {
        recordError(label, new Error('requested pipe is unavailable'));
        stop('missing pipe');
        return;
      }
      stream.on('error', error => { recordError(label, error); stop('pipe error'); });
      try { stream.setEncoding('utf8'); }
      catch (error) { recordError(label + ':encoding', error); stop('pipe setup error'); return; }
      stream.on('data', text => {
        if (stopped || settled) return;
        if (label === 'stdout') stdout += text;
        else stderr += text;
        if (Buffer.byteLength(label === 'stdout' ? stdout : stderr, 'utf8') > maxBytes) {
          stop(label + ' overflow');
        }
      });
    };
    attach(child.stdout, 'stdout', 16 * 1024 * 1024);
    attach(child.stderr, 'stderr', 4 * 1024 * 1024);
  });
}

async function imageServer() {
  const requests = [];
  const failures = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/images/generations');
      assert.equal(request.headers.authorization, 'Bearer ' + IMAGE_KEY);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 16384);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      assert.deepEqual(body, { model: MODEL, prompt: DRAW_PROMPT, n: 1, response_format: 'b64_json' });
      const bytes = Buffer.from(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), 'utf8');
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
      response.end(bytes);
    })().catch(error => {
      failures.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', () => { server.off('error', no); yes(); });
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port, requests, failures,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    },
  };
}

function patches({ home, workspace, llmBase }) {
  const disabled = [
    'session-title-llm', 'llm-pi-ai', 'llm-deepseek-account',
    'session-telemetry-otel', 'web-search-deepseek', 'web-deepseek-api',
    'web-fetch-http', 'tool-web',
  ].map(id => ({ id, disabled: true }));
  return [
    ...disabled,
    { id: 'credentials', disabled: false, config: { path: join(home, '.credentials.yaml') } },
    { id: 'llm-deepseek', config: {
      baseURL: llmBase + '/v1', apiKeyEnv: 'DSH_MEDIA_PROBE_LLM_KEY',
      thinking: 'disabled', maxTokens: 2048, streamIdleTimeoutMs: 5000,
    } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'tools', config: { mode: 'native' } },
    { insert: [{
      id: 'media-headless-probe', name: PLUGIN, config: {
        dshHome: home,
        services: [{
          id: 'probe', enabled: true, provider: 'local-probe',
          baseUrl: 'https://media-probe.invalid/v1', profile: 'openai-compatible',
          responseFormat: 'b64_json', models: MODEL, keyRef: 'DSH_MEDIA_SLOT_1_API_KEY',
        }],
      },
    }] },
  ];
}

async function runCase(root, cli, name, task) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  for (const child of ['home', 'workspace', 'capture']) {
    await mkdir(join(directory, child), { mode: 0o700 });
  }
  const home = await realpath(join(directory, 'home'));
  const workspace = await realpath(join(directory, 'workspace'));
  const capture = await realpath(join(directory, 'capture'));
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(workspace), []);
  let images;
  let llm;
  let processResult;
  let primaryFailure;
  try {
    images = await imageServer();
    llm = await startMockLlmServer({
      host: '127.0.0.1', port: 0, apiKey: LLM_KEY, randomSeed: 1,
      sequence: ['tool_call_success', 'success'], repeatLast: false,
      toolName: 'generate_image',
      toolArguments: JSON.stringify({ prompt: DRAW_PROMPT, n: 1, serviceId: 'probe', modelId: MODEL }),
      successText: '已生成图像。',
    });
    const patch = join(directory, 'probe.patch.json');
    // JSON is accepted by the YAML parser used by the public --patch launcher.
    await json(patch, patches({ home, workspace, llmBase: llm.baseURL }));
    await writeFile(join(directory, 'input.txt'), task, { mode: 0o600 });
    const args = ['headless', '--patch', patch, '--json', task];
    const result = processResult = await processRun(cli, args, {
      cwd: workspace, env: environment(home, capture, images.origin),
    });
    await writeFile(join(directory, 'stdout.projection.jsonl'), result.stdout, { mode: 0o600 });
    await writeFile(join(directory, 'stderr.txt'), result.stderr, { mode: 0o600 });
    await json(join(directory, 'process.json'), {
      binary: process.execPath, cli, args, cwd: workspace, timezone: 'Asia/Shanghai',
      code: result.code, signal: result.signal, forced: result.forced ?? null,
      closure: result.closure, closed: result.closed, pid: result.pid, spawned: result.spawned,
      exitSeen: result.exitSeen, exitCode: result.exitCode, exitSignal: result.exitSignal,
      errors: result.errors, killAttempts: result.killAttempts,
    });
    await json(join(directory, 'wire-audit.json'), {
      imageRequests: images.requests,
      imageFailures: images.failures,
      llmRequests: llm.requests.map(row => ({
        path: row.path, body: row.body, behavior: row.behavior, outcome: row.outcome,
      })),
    });
    assert.equal(result.closed, true, 'child close was not observed; see process.json PID and kill diagnostics');
    assert.equal(result.spawned, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.forced, undefined);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.deepEqual(images.failures, []);
    assert.equal(images.requests.length, 1);
    assert.equal(llm.requests.length, 2);
    assert.deepEqual(llm.requests.map(row => row.behavior), ['tool_call_success', 'success']);
    for (const row of llm.requests) {
      assert.equal(row.path, '/v1/messages');
      assert.equal(row.outcome, 'completed');
    }
    const loaded = JSON.parse(await readFile(join(capture, 'loaded-modules.json'), 'utf8'));
    for (const [path, expected] of Object.entries(EXPECTED)) {
      assert.equal(loaded.loaded[path].sha256, expected);
      assert.equal(await realpath(fileURLToPath(loaded.loaded[path].url)),
        await realpath(join(PRODUCT, path)), 'child resolved another candidate file');
    }
    for (const [name, info] of Object.entries(sharedDependencies)) {
      const actual = await packageIdentity(fileURLToPath(loaded.dependencies[name]), name, 'import');
      samePackage(actual, info.import, name);
      assert.equal(actual.path, info.import.path, 'child import resolved a different entry: ' + name);
      assert.equal(actual.sha256, info.import.sha256, 'child import entry changed: ' + name);
    }
    const projected = jsonl(result.stdout);
    assert.equal(projected[0].type, 'session');
    assert.equal(projected.at(-1).type, 'final');
    assert.ok(projected.some(row => row.type === 'status'
      && row.phase === 'turn_end' && row.reason?.kind === 'completed'));
    const receipt = JSON.parse(await readFile(join(capture, 'capture-receipt.json'), 'utf8'));
    const rawText = await readFile(join(capture, 'session-events.jsonl'), 'utf8');
    const events = jsonl(rawText);
    assert.equal(receipt.sessionId, projected[0].sessionId);
    assert.equal(receipt.header.cwd, workspace);
    assert.equal(receipt.eventCount, events.length);
    assert.equal(receipt.throughSeqExclusive, events.length);
    assert.equal(receipt.eventBytes, Buffer.byteLength(rawText, 'utf8'));
    events.forEach((event, index) => assert.equal(event.seq, index));
    // rc4 also persists a user/message with source.kind=runtime-context.
    // Keep it in the untouched fixture; only the actual user-authored message
    // is counted as the test input and authorization source.
    const users = events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].data.source.kind, 'user');
    assert.equal(users[0].data.content.filter(block => block.type === 'text').map(block => block.text).join(''), task);
    const calls = events.filter(event => event.type === 'tool/call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.name, 'generate_image');
    assert.deepEqual(JSON.parse(calls[0].data.arguments),
      { prompt: DRAW_PROMPT, n: 1, serviceId: 'probe', modelId: MODEL });
    const results = events.filter(event => event.type === 'tool/result'
      && event.surfaceOp === 'append' && event.data.message.toolCallId === calls[0].data.callId);
    assert.equal(results.length, 1);
    assert.notEqual(results[0].data.message.isError, true);
    const meta = results[0].data.meta?.['dsh-go/media'];
    assert.ok(meta, 'CLI projection is insufficient; raw tool/result must carry media meta');
    assert.equal(meta.v, 1);
    assert.equal(meta.kind, 'image');
    assert.equal(meta.status, 'done');
    assert.equal(meta.prompt, DRAW_PROMPT);
    assert.equal(meta.request.n, 1);
    assert.equal(meta.request.model, MODEL);
    assert.equal(meta.items.length, 1);
    const image = meta.items[0];
    assert.equal(image.mime, 'image/png');
    assert.equal(image.width, 1);
    assert.equal(image.height, 1);
    assert.equal(image.bytes, PNG.length);
    assert.ok(inside(join(workspace, 'generated'), image.path));
    assert.equal(await realpath(image.path), image.path);
    assert.deepEqual(await readFile(image.path), PNG);
    assert.ok(strings(llm.requests[0].body).some(text => text.includes(task)));
    assert.ok(JSON.stringify(llm.requests[0].body).includes('generate_image'));
    assert.ok(strings(llm.requests[0].body).some(text => text.includes('"serviceId":"probe"')));
    assert.ok(strings(llm.requests[1].body).some(text => text.includes(image.path)));
    const indexes = (await filesBelow(join(home, 'media', 'dsh-media')))
      .filter(path => path.endsWith('.json'));
    assert.equal(indexes.length, 1);
    const index = JSON.parse(await readFile(indexes[0], 'utf8'));
    assert.equal(index.sessionId, receipt.sessionId);
    assert.equal(index.cwd, workspace);
    assert.deepEqual(index.media, meta);
    assert.deepEqual(index.contentDigests, [{ bytes: PNG.length, sha256: sha(await readFile(image.path)) }]);
    assert.deepEqual(Object.keys(image).sort(), ['bytes', 'height', 'mime', 'path', 'width']);
    assert.equal(JSON.stringify(meta).includes('contentDigests'), false);
    assert.equal(JSON.stringify(meta).includes('sha256'), false);
    await copyFile(indexes[0], join(directory, 'private-index.json'));
    await copyFile(image.path, join(directory, 'original.png'));
    for (const canary of [IMAGE_KEY, LLM_KEY]) {
      assert.equal(rawText.includes(canary), false);
      assert.equal(result.stdout.includes(canary), false);
      assert.equal(result.stderr.includes(canary), false);
      assert.equal(JSON.stringify(index).includes(canary), false);
    }
    const physical = (await filesBelow(join(home, 'sessions'))).filter(path => path.endsWith('.jsonl'));
    assert.equal(physical.length, 1, 'fresh home must contain one plaintext durable Session log');
    const persisted = await readFile(physical[0]);
    const durableRows = jsonl(persisted.toString('utf8'));
    assert.equal(durableRows[0].type, 'session');
    assert.equal(durableRows[0].version, 4);
    assert.equal(durableRows[0].id, receipt.sessionId);
    assert.deepEqual(durableRows.slice(1), events, 'logical capture and durable events differ');
    await copyFile(physical[0], join(directory, 'durable-session.v4.jsonl'));
    await json(join(directory, 'verified.json'), {
      status: 'passed-local-mock', realModel: false, paidProvider: false,
      sessionId: receipt.sessionId, logicalEventCount: events.length,
      logicalSha256: sha(Buffer.from(rawText, 'utf8')), durableSha256: sha(persisted),
      privateDigestVerified: true, externalItemKeys: Object.keys(image).sort(),
      imageSha256: sha(PNG), rid: meta.rid, imagePath: image.path,
      imageRequests: images.requests.length, llmRequests: llm.requests.length,
      excludes: ['production DNS/TLS/SSRF policy', 'real model instruction following',
        'paid provider behavior', 'App rendering', 'M1 budgeting and video'],
    });
    return {
      name, sessionId: receipt.sessionId, rid: meta.rid,
      logicalEventsPath: join(capture, 'session-events.jsonl'),
      durableEventsPath: join(directory, 'durable-session.v4.jsonl'),
      logicalSha256: sha(Buffer.from(rawText, 'utf8')),
      proposedFixtureName: name === 'header' ? 'live_image.jsonl' : 'live_image_plain.jsonl',
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    // Normal cleanup follows close. If close could not be observed, contain the
    // local mock network and record that the child may still require manual cleanup.
    const closed = await Promise.allSettled([llm?.close(), images?.close()]);
    const cleanupErrors = closed.filter(item => item.status === 'rejected').map(item => item.reason);
    try { await json(join(directory, 'cleanup.json'), {
      primaryFailure: primaryFailure ? errorRecord(primaryFailure) : null,
      childClosure: processResult?.closure ?? 'not-started',
      childCloseObserved: processResult?.closed ?? false,
      pid: processResult?.pid ?? null,
      note: processResult?.closure === 'close-timeout'
        ? 'FAILURE: child close not observed; mocks shut down for containment; inspect PID, not a drain guarantee.'
        : 'Mock shutdown after child close, or before a child was created.',
      mockServers: closed.map((item, index) => ({
        name: index === 0 ? 'llm' : 'image', status: item.status,
        error: item.status === 'rejected' ? String(item.reason?.message ?? item.reason) : null,
      })),
    });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors],
      'headless case/cleanup failure; inspect nested errors and process.json',
    );
  }
}

const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
assert.ok(values.out && isAbsolute(values.out), '--out must be a new absolute directory');
assert.equal(process.env.TZ, 'Asia/Shanghai', 'run with explicit TZ=Asia/Shanghai');
const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok((major === 22 && minor >= 19) || major >= 24, 'match fixed rc.4 Node engine requirement');
await mkdir(values.out, { mode: 0o700 });
const output = await realpath(values.out);
const identities = {};
for (const [path, expected] of Object.entries(EXPECTED)) {
  const bytes = await readFile(join(PRODUCT, path));
  identities[path] = { bytes: bytes.length, sha256: sha(bytes) };
  assert.equal(identities[path].sha256, expected, 'candidate changed; review and re-pin before running: ' + path);
}
const require = createRequire(join(PRODUCT, 'package.json'));
const cliPackage = require.resolve('@deepseek-ai/dsh/package.json');
const cliMeta = JSON.parse(await readFile(cliPackage, 'utf8'));
assert.equal(cliMeta.version, '0.2.1-rc.4');
const cli = join(dirname(cliPackage), cliMeta.bin.dsh);
const cliRequire = createRequire(cliPackage);
const enginePrefix = resolve(dirname(cliPackage), '../../..');
const testLockPath = join(enginePrefix, 'package-lock.json');
const testLockSha256 = sha(await readFile(testLockPath));
assert.equal(testLockSha256, EXPECTED_TEST_LOCK, 'use the reviewed additive rc4 test lock');
const engineFiles = {};
for (const [path, expected] of Object.entries(EXPECTED_ENGINE)) {
  const bytes = await readFile(join(enginePrefix, 'node_modules', path));
  const actual = sha(bytes);
  assert.equal(actual, expected, 'engine changed; review and re-pin: ' + path);
  engineFiles[path] = { bytes: bytes.length, sha256: actual };
}
const sharedDependencies = {};
for (const name of [
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-system-prompt',
]) {
  const importEntry = await packageIdentity(fileURLToPath(import.meta.resolve(name)), name, 'import');
  const requireEntry = await packageIdentity(require.resolve(name), name, 'require');
  const cliRequireEntry = await packageIdentity(cliRequire.resolve(name), name, 'require');
  samePackage(importEntry, requireEntry, name);
  samePackage(requireEntry, cliRequireEntry, name);
  assert.equal(requireEntry.path, cliRequireEntry.path, 'same-mode require entry differs: ' + name);
  sharedDependencies[name] = { import: importEntry, require: requireEntry, cliRequire: cliRequireEntry };
}
const mockPackage = require.resolve('@deepseek-ai/dsh-llm-mock-server/package.json');
const mockMeta = JSON.parse(await readFile(mockPackage, 'utf8'));
assert.equal(mockMeta.version, '0.2.1-rc.4');
const { startMockLlmServer } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-mock-server')).href);
assert.throws(() => parseMediaUrl('http://127.0.0.1:1/v1/images/generations'));
assert.throws(() => Config({ services: [{
  id: 'probe', enabled: true, provider: 'local-probe', baseUrl: 'http://127.0.0.1:1/v1',
  profile: 'openai-compatible', responseFormat: 'b64_json',
  models: MODEL, keyRef: 'DSH_MEDIA_SLOT_1_API_KEY',
}] }));
await json(join(output, 'source-identity.json'), {
  node: process.version, cliPackage, cliVersion: cliMeta.version, timezone: process.env.TZ,
  source: 'npm @deepseek-ai/dsh@0.2.1-rc.4; package-lock identity recorded; no git commit inferred',
  productBase: 'dsh-go/dsh-go-src@6b53cb1',
  sourceZipSha256: '1d4c9f438bdd2245e6a2cd98d37e62baae977db3a58856788becfd87a05c45dc',
  testLockPath, testLockSha256, engineFiles,
  enginePatches: [], candidates: identities, sharedDependencies,
  mockPackage, mockVersion: mockMeta.version, cliEntrySha256: sha(await readFile(cli)),
});
const header = formatGenerationMessage({
  kind: 'image', prompt: DRAW_PROMPT, n: 1,
  model: { label: LABEL, serviceId: 'probe', id: MODEL },
});
assert.equal(parseGenerationMessage(header).prompt, DRAW_PROMPT);
const plain = '请用 Gemini 2.5 Flash Image 生成 1 张图像：' + DRAW_PROMPT;
assert.equal(parseGenerationMessage(plain), null);
const records = [];
try {
  records.push(await runCase(output, cli, 'header', header));
  records.push(await runCase(output, cli, 'ordinary', plain));
  assert.notEqual(records[0].sessionId, records[1].sessionId, 'independent runs must remain separate sessions');
  await json(join(output, 'summary.json'), {
    status: 'passed-local-mock', completedAt: new Date().toISOString(), records,
    notice: 'Actual DSH events from scripted model and local synthetic image; not a real-model or paid-provider recording.',
  });
  process.stdout.write(JSON.stringify({ status: 'passed-local-mock', output, records }) + '\n');
} catch (error) {
  await json(join(output, 'failure.json'), {
    status: 'failed', completedAt: new Date().toISOString(), message: error.message,
    error: errorRecord(error), records,
  });
  throw error;
}
