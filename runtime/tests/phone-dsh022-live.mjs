// Real rc.1 loader, PhoneGuest overlay/relay, scoped native/PTC dispatch.
// The TCP peer is synthetic: Android approval UI and real actions need a device.
// DSH_PREFIX=/absolute/test-prefix node runtime/tests/phone-dsh022-live.mjs
// Test prefix also needs @deepseek-ai/dsh-llm-mock-server@0.2.2-rc.1.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const prefix = resolve(process.env.DSH_PREFIX);
const pkg = name => join(prefix, 'node_modules/@deepseek-ai', name);
assert.equal(JSON.parse(await readFile(join(pkg('dsh'), 'package.json'))).version, '0.2.2-rc.1');
const { startMockLlmServer } = await import(pathToFileURL(join(pkg('dsh-llm-mock-server'), 'lib/index.js')));
const source = await readFile(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/PhoneGuest.kt', import.meta.url), 'utf8');
const relay = source.match(/const val RELAY_JS = """([\s\S]*?)"""/)?.[1];
const overlay = source.match(/val PATCH_YAML = """([\s\S]*?)"""/)?.[1];
assert.ok(relay); assert.ok(overlay);
assert.match(source, /const val SERVER_NAME = "phone"/);
const timeout = source.match(/const val TOOL_CALL_TIMEOUT_MS = ([0-9_]+)L/)?.[1].replaceAll('_', '');
assert.ok(timeout);
assert.match(overlay, /name: '@deepseek-ai\/dsh-mcp-client'/);
assert.match(overlay, /serverName: \$SERVER_NAME/);
const root = await mkdtemp(join(tmpdir(), 'dsh022-phone-'));
const records = [];
try {
  for (const mode of ['native', 'ptc']) for (const decision of ['allowed', 'denied']) {
    const directory = join(root, mode + '-' + decision); await mkdir(directory);
    const home = join(directory, 'home'); await mkdir(home);
    const workspace = join(directory, 'workspace'); await mkdir(workspace);
    const relayFile = join(directory, 'relay.cjs'), configFile = join(directory, 'bridge.json');
    await writeFile(relayFile, relay);
    let calls = 0, actions = 0, hello = 0;
    const sockets = new Set();
    const peer = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let authenticated = false;
      const lines = createInterface({ input: socket });
      lines.on('line', line => {
        const request = JSON.parse(line);
        if (!authenticated) {
          assert.deepEqual(request, { dshPhone: 1, token: 'synthetic-phone-token' });
          authenticated = true; hello++; return;
        }
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-app-phone-synthetic', version: '1' } };
        else if (request.method === 'tools/list') result = { tools: [{ name: 'tap', description: 'Synthetic approval-gated phone tap', inputSchema: { type: 'object', properties: { element: { type: 'integer' } }, required: ['element'] } }] };
        else if (request.method === 'ping') result = {};
        else if (request.method === 'tools/call') {
          assert.equal(request.params.name, 'tap'); assert.deepEqual(request.params.arguments, { element: 1 });
          calls++;
          if (decision === 'allowed') actions++;
          result = { content: [{ type: 'text', text: decision === 'allowed' ? 'SYNTHETIC_PHONE_ACTION_DONE' : 'SYNTHETIC_PHONE_APPROVAL_DENIED' }], isError: decision === 'denied' };
        } else { socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      });
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    await writeFile(configFile, JSON.stringify({ v: 1, abstract: null, tcpPort: peer.address().port, token: 'synthetic-phone-token' }), { mode: 0o600 });
    const phonePatch = join(directory, 'phone.patch.yml');
    await writeFile(phonePatch, overlay.replaceAll('$SERVER_NAME', 'phone').replaceAll('$RELAY', relayFile).replaceAll('$CONFIG', configFile).replaceAll('$TOOL_CALL_TIMEOUT_MS', timeout));
    const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, apiKey: 'SYNTHETIC_LLM_KEY', sequence: ['tool_call_success', 'success'], repeatLast: false,
      toolName: mode === 'native' ? 'mcp__phone__tap' : 'run_code',
      toolArguments: JSON.stringify(mode === 'native' ? { element: 1 } : { code: 'return await tools.mcp__phone__tap({element: 1})', description: 'Synthetic phone test' }), successText: 'Done' });
    try {
      const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
      patch.push({ id: 'llm-deepseek', config: { baseURL: mock.baseURL + '/v1', apiKeyEnv: 'PHONE_TEST_LLM_KEY', thinking: 'disabled', maxTokens: 2048 } },
        { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
        { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
        { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
        { id: 'fs-sandbox', config: { cwd: workspace } },
        { id: 'tool-executor-native', disabled: mode !== 'native' }, { id: 'tool-executor-ptc', disabled: mode !== 'ptc' },
        { id: 'ptc-runtime', config: { executionMode: 'per-call' } });
      const patchFile = join(directory, 'test.patch.json'); await writeFile(patchFile, JSON.stringify(patch));
      const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', PHONE_TEST_LLM_KEY: 'SYNTHETIC_LLM_KEY' });
      const child = spawn(process.execPath, [join(pkg('dsh'), 'lib/bin.js'), 'headless', '--patch', patchFile, '--patch', phonePatch, '--json', 'Run the synthetic phone tap once.'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
      const [code] = await once(child, 'close'); clearTimeout(timer);
      assert.equal(code, 0, stderr); assert.doesNotMatch(stderr, /did not activate/, stderr); assert.equal(calls, 1, stdout + stderr); assert.equal(actions, decision === 'allowed' ? 1 : 0); assert.ok(hello >= 1);
      assert.equal(mock.requests.length, 2);
      const first = mock.requests[0].body;
      if (mode === 'native') assert.ok(first.tools.some(tool => tool.name === 'mcp__phone__tap'));
      else { assert.ok(first.tools.some(tool => tool.name === 'run_code')); assert.ok(JSON.stringify(first).includes('mcp__phone__tap')); }
      assert.ok(JSON.stringify(mock.requests[1].body).includes(decision === 'allowed' ? 'SYNTHETIC_PHONE_ACTION_DONE' : 'SYNTHETIC_PHONE_APPROVAL_DENIED'));
      records.push({ mode, decision, calls, actions, authenticatedConnections: hello, llmRequests: mock.requests.length });
    } finally { await mock.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => peer.close(resolve)); }
  }
  console.log(JSON.stringify({ status: 'passed-real-engine-synthetic-phone', records, limits: ['Android approval UI not exercised', 'no real phone action', 'PhoneGuest paths relocated to temporary host directory'] }));
} finally { await rm(root, { recursive: true, force: true }); }
