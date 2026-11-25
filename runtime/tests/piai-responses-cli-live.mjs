import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Manual gate: DSH_PREFIX=/absolute/prepared-prefix node runtime/tests/piai-responses-cli-live.mjs
if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to a prepared DSH runtime prefix');
const prefix = resolve(process.env.DSH_PREFIX);
const root = await mkdtemp(join(tmpdir(), 'responses-cli63-'));
const evidence = process.env.DSH_EVIDENCE_DIR
  ? resolve(process.env.DSH_EVIDENCE_DIR)
  : join(root, 'evidence');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const requests = [];
const errors = [];
const input = { todos: [{ content: '检查中文🙂工具参数', status: 'completed' }] };
const args = JSON.stringify(input);
const finalText = '本地 Responses 工具完成🙂';
let child;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, body });
    assert.equal(req.url, '/v1/responses');
    assert(requests.length <= 2);
    const first = requests.length === 1;
    const id = `resp_own_${requests.length}`;
    const call = { type: 'function_call', id: 'fc_own_1', call_id: 'call_own_1', name: 'todo_write', arguments: args, status: 'completed' };
    const message = { type: 'message', id: 'msg_own_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: finalText, annotations: [] }] };
    const item = first ? call : message;
    const frames = [{ type: 'response.created', response: { id, status: 'in_progress', output: [] } }];
    frames.push({ type: 'response.output_item.added', output_index: 0, item: first ? { ...call, arguments: '', status: 'in_progress' } : { ...message, content: [], status: 'in_progress' } });
    if (first) {
      for (const delta of [args.slice(0, 20), args.slice(20)]) {
        frames.push({ type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta });
      }
      frames.push({ type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: args });
    } else {
      frames.push({ type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      frames.push({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: finalText });
      frames.push({ type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: finalText });
      frames.push({ type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
    }
    frames.push({ type: 'response.output_item.done', output_index: 0, item });
    frames.push({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map((frame, sequence_number) => `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number })}\n\n`).join(''));
  } catch (error) {
    errors.push(String(error.stack));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(home);
  await mkdir(workspace);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const patch = ['session-title-llm', 'llm-deepseek', 'llm-deepseek-account', 'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
  patch.push(
    { id: 'llm-pi-ai', config: { providers: { 'own-responses': { api: 'openai-responses', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'OWN_FIXTURE_KEY', models: [{ id: 'own-model', name: 'Own local fixture', contextWindow: 8192 }] } } } },
    { id: 'agent-default-model', config: { provider: 'own-responses', model: 'own-model' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'tool-executor-native', disabled: false },
    { id: 'tool-executor-ptc', disabled: true },
  );
  const patchPath = join(root, 'patch.json');
  await writeFile(patchPath, JSON.stringify(patch));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only' });
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', patchPath, '--json', '仅完成自有待办检查'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stdout.on('data', text => { stdout += text; });
  child.stderr.on('data', text => { stderr += text; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(watchdog);
  await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, 'stdout.log'), stdout);
  await writeFile(join(evidence, 'stderr.log'), stderr);
  assert.deepEqual(errors, []);
  assert.equal(code, 0, stderr + stdout);
  assert.equal(signal, null);
  assert.equal(stderr, '');
  assert.equal(requests.length, 2);
  assert(requests[0].body.tools.some(tool => tool.name === 'todo_write'));
  const call = requests[1].body.input.find(item => item.type === 'function_call');
  const result = requests[1].body.input.find(item => item.type === 'function_call_output');
  assert.equal(call.id, 'fc_own_1');
  assert.equal(call.call_id, 'call_own_1');
  assert.equal(call.name, 'todo_write');
  assert.deepEqual(JSON.parse(call.arguments), input);
  assert.equal(result.call_id, call.call_id);
  assert(JSON.stringify(result.output).includes('completed'));
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'tool_result').length, 1);
  const final = events.find(event => event.type === 'final');
  assert.deepEqual(final.reason, { kind: 'completed' });
  assert.equal(final.text, finalText);
  console.log(JSON.stringify({ prefix, requests: 2, toolResults: 1, argumentsExact: true, replayCallId: call.call_id, replayItemId: call.id, finalTextExact: true, finalReason: final.reason, code, stderrBytes: Buffer.byteLength(stderr), scope: 'real headless CLI/Agent/pi-ai Responses/native todo; local synthetic HTTP, no external model or Android' }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
