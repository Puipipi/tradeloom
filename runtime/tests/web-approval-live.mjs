// Real web login/cookie -> HTTP prompt -> mux approval -> model -> durable JSONL.
// DSH_PREFIX=<patched rc.1> DSH_MOCK_PREFIX=<rc.1 prefix with official mock> node this-file
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX is required');
const prefix = resolve(process.env.DSH_PREFIX);
const mockPrefix = resolve(process.env.DSH_MOCK_PREFIX ?? prefix);
const pkg = (name, base = prefix) => join(base, 'node_modules/@deepseek-ai', name);
assert.equal(JSON.parse(await readFile(join(pkg('dsh'), 'package.json'))).version, '0.2.2-rc.1');
assert.equal(JSON.parse(await readFile(join(pkg('dsh-llm-mock-server', mockPrefix), 'package.json'))).version, '0.2.2-rc.1');
const { startMockLlmServer } = await import(pathToFileURL(join(pkg('dsh-llm-mock-server', mockPrefix), 'lib/index.js')));
const { default: WebSocket } = await import(pathToFileURL(join(prefix, 'node_modules/ws/wrapper.mjs')));
const root = await mkdtemp(join(tmpdir(), 'dsh022-web-approval-'));
const results = [];
async function exists(file) { try { await readFile(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await ended; } finally { clearTimeout(timeout); }
}
try {
  for (const mode of ['native', 'ptc']) for (const decision of ['allowed-once', 'rejected', 'cancelled']) {
    const directory = join(root, mode + '-' + decision), home = join(directory, 'home'), work = join(directory, 'work');
    await mkdir(home, { recursive: true }); await mkdir(work);
    const marker = join(directory, 'marker.txt'), plugin = join(directory, 'fixture.mjs');
    await copyFile(new URL('./fixtures/web-approval-tool.mjs', import.meta.url), plugin);
    await symlink(join(prefix, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const apiKey = 'SYNTHETIC_WEB_APPROVAL_KEY';
    const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, apiKey, sequence: ['tool_call_success', 'success'],
      toolName: mode === 'native' ? 'web_approval_marker' : 'run_code',
      toolArguments: JSON.stringify(mode === 'native' ? { nonce: 'SYNTHETIC_FIXED_NONCE' } : {
        code: 'return await tools.web_approval_marker({nonce:"SYNTHETIC_FIXED_NONCE"})', description: 'Synthetic approval marker' }),
      successText: 'SYNTHETIC_WEB_TURN_FINISHED', repeatLast: false });
    const rows = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
    rows.push({ id: 'llm-deepseek', config: { baseURL: mock.baseURL + '/v1', apiKeyEnv: 'DSH_WEB_TEST_KEY', thinking: 'disabled', maxTokens: 2048 } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: work } },
      { id: 'approval', config: { policy: 'ask' } },
      { id: 'permission', config: { presets: { 'web-test-ask': { sandbox: 'danger-full-access', approval: 'ask' } }, defaultPreset: 'web-test-ask' } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'tool-executor-native', disabled: mode !== 'native' }, { id: 'tool-executor-ptc', disabled: mode !== 'ptc' },
      { id: 'ptc-runtime', config: { executionMode: 'per-call' } }, { insert: [{ id: 'web-approval-fixture', name: plugin }] });
    const patch = join(directory, 'patch.json'); await writeFile(patch, JSON.stringify(rows));
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(done => reservation.close(done));
    const origin = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, { HOME: home, DSH_HOME: join(home, 'dsh'), DSH_TELEMETRY_DISABLED: '1', DSH_WEB_TEST_KEY: apiKey, DSH_WEB_APPROVAL_MARKER: marker });
    const child = spawn(process.execPath, [join(pkg('dsh'), 'lib/bin.js'), 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let hostOutput = '', socket, token;
    const lifetime = AbortSignal.timeout(40000);
    try {
      token = await new Promise((done, fail) => {
        const aborted = () => fail(Error('Synthetic Host startup timed out'));
        lifetime.addEventListener('abort', aborted, { once: true });
        child.once('error', fail); child.once('exit', code => fail(Error(`Synthetic Host startup exited (${code})`)));
        const capture = chunk => { hostOutput += chunk; const match = hostOutput.match(/token=([\w-]+)/); if (match) { lifetime.removeEventListener('abort', aborted); done(match[1]); } };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
      });
      const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual', signal: lifetime });
      assert.equal(login.status, 303);
      const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '); assert.ok(cookie);
      const page = await fetch(origin + '/', { headers: { cookie }, signal: lifetime }); assert.equal(page.status, 200); await page.arrayBuffer();
      let sequence = 0, prompts = 0, replies = 0;
      async function rpc(method, args = {}) {
        if (method === 'session/prompt') prompts++;
        if (method === '$events/result') replies++;
        const res = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: `web-probe-${++sequence}`, method, payload: { args } }), signal: lifetime });
        assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.result.ok, true, JSON.stringify(body.result.error)); return body.result.value;
      }
      const messages = [], waiters = [];
      socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin } });
      socket.on('message', data => {
        const frame = JSON.parse(String(data)); if (frame.type !== 'item' || frame.streamId !== 'events') return;
        const i = waiters.findIndex(w => w.match(frame.value)); if (i < 0) messages.push(frame.value); else waiters.splice(i, 1)[0].resolve(frame.value);
      });
      function next(match) {
        const i = messages.findIndex(match); if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
        return new Promise((resolve, reject) => { waiters.push({ match, resolve }); lifetime.addEventListener('abort', () => reject(Error('Synthetic remote event timed out')), { once: true }); });
      }
      await once(socket, 'open'); socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }));
      const ready = await next(f => f.type === 'ready');
      const created = await rpc('session/create', { request: { cwd: work } }); const sessionId = created.sessionId;
      const receipt = await rpc('session/prompt', { request: { sessionId, requestId: 'web-approval-single-prompt', mode: 'queue', content: [{ type: 'text', text: 'Call the synthetic approval marker once.' }] } });
      assert.equal(receipt.accepted, true);
      const question = await next(f => f.type === 'waterfall' && f.event === 'approval/request');
      assert.equal(question.agentId, sessionId); assert.equal(question.request.toolName, 'web_approval_marker'); assert.ok(question.request.callId);
      assert.equal(await exists(marker), false, 'no marker while real approval is pending');
      assert.equal(mock.requests.length, 1, 'model is waiting on approval, not retried');
      const firstRequest = mock.requests[0].body;
      assert.ok(firstRequest.tools.some(tool => tool.name === (mode === 'native' ? 'web_approval_marker' : 'run_code')));
      if (mode === 'ptc') assert.ok(JSON.stringify(firstRequest).includes('web_approval_marker'), 'PTC SDK exposes the actual fixture tool');
      await rpc('$events/result', { clientId: ready.clientId, eventId: question.eventId, outcome: { kind: 'result', value: decision } });
      const finished = await rpc('session/wait', { request: { sessionId, timeoutMs: 15000 } });
      assert.equal(finished.reason, 'idle'); assert.ok(JSON.stringify(finished).includes('SYNTHETIC_WEB_TURN_FINISHED'));
      assert.equal(prompts, 1); assert.equal(replies, 1); assert.equal(mock.requests.length, 2);
      assert.ok(JSON.stringify(mock.requests[1].body).includes('SYNTHETIC_DECISION_' + decision), 'tool result reaches next actual model request');
      assert.equal(await exists(marker), decision === 'allowed-once');
      if (decision === 'allowed-once') assert.equal(await readFile(marker, 'utf8'), 'SYNTHETIC_MARKER\n');
      socket.terminate(); await stop(child);
      const files = (await readdir(join(home, 'sessions'), { recursive: true })).filter(f => f.endsWith('.jsonl'));
      const logs = await Promise.all(files.map(f => readFile(join(home, 'sessions', f), 'utf8')));
      const sessionLog = logs.find(raw => { try { return JSON.parse(raw.split('\n')[0]).id === sessionId; } catch { return false; } }); assert.ok(sessionLog);
      assert.ok(!sessionLog.includes(token)); assert.ok(!sessionLog.includes(apiKey));
      const events = sessionLog.trim().split('\n').map(line => JSON.parse(line));
      const asked = events.filter(e => e.type === 'approval/asked'), decided = events.filter(e => e.type === 'approval/decided');
      assert.equal(asked.length, 1); assert.equal(decided.length, 1); assert.equal(asked[0].data.id, decided[0].data.id);
      assert.equal(asked[0].data.callId, question.request.callId); assert.equal(decided[0].data.outcome, decision);
      const begin = events.findIndex(e => e.type === 'turn/start'), end = events.findIndex(e => e.type === 'turn/end');
      assert.ok(begin >= 0 && begin < events.indexOf(asked[0]) && events.indexOf(asked[0]) < events.indexOf(decided[0]) && events.indexOf(decided[0]) < end, 'audit pair stays inside the persisted turn');
      const accepted = events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted ?? []).filter(m => m.source?.kind === 'user');
      assert.equal(accepted.length, 1, 'one durable accepted user prompt');
      results.push({ mode, decision, prompts, replies, modelRequests: mock.requests.length, markerWrites: decision === 'allowed-once' ? 1 : 0, asked: asked.length, decided: decided.length, persistedTurnEnclosed: true });
    } catch (error) {
      // Never expose launch tokens, cookies, mock headers, or configured keys.
      throw Error(`${mode}/${decision}: ${String(error.message).replaceAll(token ?? 'NO_TOKEN', '<redacted>').replaceAll(apiKey, '<redacted>')}`);
    } finally { socket?.terminate(); await stop(child); await mock.close(); }
  }
  console.log(JSON.stringify({ status: 'PASS_REAL_WEB_APPROVAL', results, limits: ['cancelled is an explicit client approval outcome, not session/cancel', 'no Android UI or actual device action'] }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
