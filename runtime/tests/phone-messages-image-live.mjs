import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Manual live gate: DSH_PREFIX=/path/to/patched-prefix node runtime/tests/phone-messages-image-live.mjs
// All model/phone peers are synthetic and local. No Android or remote inference claim.
assert.ok(process.env.DSH_PREFIX, 'set DSH_PREFIX to a private patched rc.1 prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const source = process.env.DSH_SOURCE ? resolve(process.env.DSH_SOURCE) : fileURLToPath(new URL('../../', import.meta.url));
const evidence = process.env.DSH_EVIDENCE_DIR ? resolve(process.env.DSH_EVIDENCE_DIR) : undefined;
if (evidence) await mkdir(evidence, { recursive: true });
const require = createRequire(join(prefix, 'package.json'));
assert.equal(JSON.parse(await readFile(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.2.2-rc.1');
const sharp = require('sharp');
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 100, g: 120, b: 140 } } })
  .png().toBuffer();
const guest = await readFile(join(source, 'app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/PhoneGuest.kt'), 'utf8');
const relay = guest.match(/const val RELAY_JS = """([\s\S]*?)"""/)?.[1];
const overlay = guest.match(/val PATCH_YAML = """([\s\S]*?)"""/)?.[1];
const timeout = guest.match(/const val TOOL_CALL_TIMEOUT_MS = ([0-9_]+)L/)?.[1].replaceAll('_', '');
assert.ok(relay && overlay && timeout);
const root = await mkdtemp(join(tmpdir(), 'phone-messages-image-'));
const records = [];

function imageBlocks(value, out = []) {
  if (Array.isArray(value)) for (const item of value) imageBlocks(item, out);
  else if (value !== null && typeof value === 'object') {
    if (value.type === 'image' && value.source) out.push(value);
    for (const item of Object.values(value)) imageBlocks(item, out);
  }
  return out;
}

try {
  for (const [mode, filesAvailable] of [['native', true], ['ptc', true], ['native', false]]) {
    const label = `${mode}-${filesAvailable ? 'files' : 'inline-fallback'}`;
    const directory = join(root, label), home = join(directory, 'home'), workspace = join(directory, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace);
    const relayFile = join(directory, 'relay.cjs'), configFile = join(directory, 'bridge.json');
    await writeFile(relayFile, relay);
    const sockets = new Set();
    let phoneCalls = 0;
    const peer = createTcpServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let hello = false;
      createInterface({ input: socket }).on('line', line => {
        const request = JSON.parse(line);
        if (!hello) {
          assert.deepEqual(request, { dshPhone: 1, token: 'own-fixture-phone-token' });
          hello = true;
          return;
        }
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') {
          result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'own-fixture-phone', version: '1' } };
        } else if (request.method === 'tools/list') {
          result = { tools: [{ name: 'screen', description: 'Return a synthetic 2x2 screen image',
            inputSchema: { type: 'object', properties: {} } }] };
        } else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/call') {
          assert.equal(request.params.name, 'screen');
          assert.deepEqual(request.params.arguments, {});
          phoneCalls++;
          result = { content: [{ type: 'text', text: 'OWN_SCREEN_IMAGE 中文🙂' },
            { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
        } else {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
          return;
        }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      });
    });
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    await writeFile(configFile, JSON.stringify({ v: 1, abstract: null, tcpPort: peer.address().port, token: 'own-fixture-phone-token' }), { mode: 0o600 });
    const phonePatch = join(directory, 'phone.patch.yml');
    await writeFile(phonePatch, overlay.replaceAll('$SERVER_NAME', 'phone').replaceAll('$RELAY', relayFile)
      .replaceAll('$CONFIG', configFile).replaceAll('$TOOL_CALL_TIMEOUT_MS', timeout));

    const messages = [], uploads = [], handlerErrors = [];
    const model = createHttpServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        if (req.url === '/v1/files' && req.method === 'POST') {
          assert.match(req.headers['anthropic-beta'], /files-api-2025-04-14/);
          const form = await new Request('http://own-fixture/v1/files', { method: 'POST', headers: req.headers, body: bytes }).formData();
          const file = form.get('file');
          assert.ok(file instanceof File);
          const data = Buffer.from(await file.arrayBuffer());
          const meta = await sharp(data).metadata();
          assert.equal(meta.width, 2);
          assert.equal(meta.height, 2);
          assert.equal(form.get('expires_after[anchor]'), 'created_at');
          assert.ok(Number(form.get('expires_after[seconds]')) >= 3600);
          uploads.push({ filename: file.name, mimeType: file.type, bytes: data.length, width: meta.width, height: meta.height });
          res.writeHead(filesAvailable ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(filesAvailable ? { id: 'own-image-file', type: 'file', mime_type: file.type,
            size_bytes: data.length, filename: file.name, created_at: new Date().toISOString() }
            : { error: { type: 'not_found_error', message: 'Own synthetic endpoint has no Files API' } }));
          return;
        }
        assert.equal(req.url, '/v1/messages');
        const body = JSON.parse(bytes.toString('utf8'));
        messages.push({ body, beta: req.headers['anthropic-beta'] ?? null });
        assert.ok(messages.length <= 2);
        const first = messages.length === 1;
        const frames = [{ type: 'message_start', message: { id: `own-${messages.length}`, type: 'message', role: 'assistant',
          model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
        if (first) {
          const name = mode === 'native' ? 'mcp__phone__screen' : 'run_code';
          assert.ok(body.tools.some(tool => tool.name === name));
          const input = mode === 'native' ? {} : { code: 'return await tools.mcp__phone__screen({});', description: 'Read own synthetic screen' };
          frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'own-screen-call', name, input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        } else {
          const images = imageBlocks(body.messages);
          assert.equal(images.length, 1, 'one actual image must reach the second provider request');
          if (filesAvailable) {
            assert.deepEqual(images[0].source, { type: 'file', file_id: 'own-image-file' });
            assert.match(req.headers['anthropic-beta'], /files-api-2025-04-14/);
          } else {
            assert.equal(images[0].source.type, 'base64');
            const inline = await sharp(Buffer.from(images[0].source.data, 'base64')).metadata();
            assert.equal(inline.width, 2);
            assert.equal(inline.height, 2);
          }
          frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已收到自有截图🙂' } });
        }
        frames.push({ type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: 'message_stop' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
      } catch (error) {
        handlerErrors.push(error.stack);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } }));
      }
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    let child, closed, guard;
    try {
      const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel',
        'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web']
        .map(id => ({ id, disabled: true }));
      patch.push({ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${model.address().port}/v1`,
        apiKeyEnv: 'OWN_MODEL_FIXTURE_KEY', thinking: 'disabled', maxTokens: 2048 } },
        { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
        { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
        { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
        { id: 'fs-sandbox', config: { cwd: workspace } },
        { id: 'tool-executor-native', disabled: mode !== 'native' },
        { id: 'tool-executor-ptc', disabled: mode !== 'ptc' },
        { id: 'ptc-runtime', config: { executionMode: 'per-call' } });
      const patchFile = join(directory, 'test.patch.json');
      await writeFile(patchFile, JSON.stringify(patch));
      const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_MODEL_FIXTURE_KEY: 'synthetic-local-only' });
      child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless',
        '--patch', patchFile, '--patch', phonePatch, '--json', '读取自有测试截图一次。'],
        { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', text => stdout += text);
      child.stderr.on('data', text => stderr += text);
      closed = once(child, 'close');
      guard = setTimeout(() => child.kill('SIGKILL'), 60000);
      const [code, signal] = await closed;
      clearTimeout(guard);
      if (evidence) {
        await writeFile(join(evidence, `${label}-messages.json`), JSON.stringify({ messages, uploads, handlerErrors }, null, 2));
        await writeFile(join(evidence, `${label}-headless.log`), stdout + '\nSTDERR\n' + stderr);
      }
      assert.deepEqual(handlerErrors, []);
      assert.equal(code, 0, stderr + '\n' + stdout);
      assert.equal(signal, null);
      assert.ok(!stderr.includes('did not activate'), stderr);
      assert.equal(phoneCalls, 1);
      assert.equal(messages.length, 2);
      assert.equal(uploads.length, 1);
      assert.equal(imageBlocks(messages[0].body.messages).length, 0);
      const blocks = messages[1].body.messages.flatMap(message => message.content);
      const calls = blocks.filter(block => block.type === 'tool_use' && block.id === 'own-screen-call');
      const results = blocks.filter(block => block.type === 'tool_result' && block.tool_use_id === 'own-screen-call');
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0].is_error, false);
      assert.deepEqual(calls[0].input, mode === 'native' ? {} : {
        code: 'return await tools.mcp__phone__screen({});', description: 'Read own synthetic screen',
      });
      // PTC publishes captured image observations separately from its JSON return.
      // Both must still belong to this same next provider request.
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.find(event => event.type === 'final').text, '已收到自有截图🙂');
      assert.deepEqual(events.find(event => event.type === 'final').reason, { kind: 'completed' });
      records.push({ label, phoneCalls, messages: messages.length, uploads: uploads.length,
        imageSource: imageBlocks(messages[1].body.messages)[0].source.type, exitCode: code });
    } finally {
      clearTimeout(guard);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (closed) await closed;
      for (const socket of sockets) socket.destroy();
      await new Promise(done => peer.close(done));
      await new Promise(done => model.close(done));
    }
  }
  console.log(JSON.stringify({ records, scope: 'actual CLI, PhoneGuest relay, MCP, scoped tool executor, attachment/image pipeline and native Messages provider; own synthetic phone and model peers, no remote model or Android' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
