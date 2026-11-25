import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert(process.env.DSH_PREFIX, 'Set DSH_PREFIX to a prepared runtime');
const prefix = resolve(process.env.DSH_PREFIX);
const keepEvidence = Boolean(process.env.DSH_EVIDENCE_DIR);
const evidence = keepEvidence ? resolve(process.env.DSH_EVIDENCE_DIR) : await mkdtemp(join(tmpdir(), 'reference-retention-evidence-'));
const runs = 2;
const size = Number(process.env.OWN_REFERENCE_BYTES ?? 1048576);
let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
const root = await mkdtemp(join(tmpdir(), 'own-outline-'));
const home = join(root, 'home'), workspace = join(root, 'workspace');
const requests = [], errors = [];
let child, closed, watchdog;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, body });
    if (requests.length === 1) { child.send({ kind: 'queue' }); await firstGate; }
    assert.equal(req.url, '/v1/responses');
    assert(requests.length <= runs);
    const id = `resp_own_${requests.length}`;
    const message = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'own completed', annotations: [] }] };
    const item = message;
    const frames = [{ type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0,
        item: { ...message, content: [], status: 'in_progress' } }];
      frames.push({ type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'own completed' },
      { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: 'own completed' },
      { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
    frames.push({ type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item],
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
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
  await mkdir(home); await mkdir(workspace);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const patch = ['session-title-llm', 'llm-deepseek', 'llm-deepseek-account', 'session-telemetry-otel',
    'desktop-product-telemetry', 'spill-local', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
  patch.push({ id: 'llm-pi-ai', config: { providers: { 'own-responses': { api: 'openai-responses',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'OWN_FIXTURE_KEY',
    models: [{ id: 'own-model', name: 'Own fixture', contextWindow: 65536 }] } } } },
  { id: 'agent-default-model', config: { provider: 'own-responses', model: 'own-model' } },
  { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
  { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
  { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
  { id: 'fs-sandbox', config: { cwd: workspace } },
  { id: 'tool-executor-native', disabled: false }, { id: 'tool-executor-ptc', disabled: true },
  { insert: [{ id: 'reference-retention-observer', name: pathToFileURL(fileURLToPath(new URL('./fixtures/reference-retention-observer.mjs', import.meta.url))).href }] });
  const patchFile = join(root, 'patch.json'); await writeFile(patchFile, JSON.stringify(patch));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only', DSH_PREFIX: prefix });
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patchFile,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
    if (!sent && stdout.includes('dsh web: ') && stdout.includes('?token=')) { sent = true; child.send({ kind: 'run', size }); }
  });
  child.stderr.on('data', text => { stderr += text; });
  closed = once(child, 'close');
  watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const resultMessage = new Promise(resolve => child.on('message', value => {
    if (value?.kind === 'queued') releaseFirst();
    if (value?.kind === 'result') resolve(value);
  }));
  const result = await Promise.race([resultMessage, closed.then(exit => ({ earlyExit: exit }))]);
  const report = { prefix, runs, result, requests, errors, stderr };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, 'host.log'), stdout.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>') + '\nSTDERR\n' + stderr);
  assert.equal(stderr, '');
  assert.deepEqual(errors, []); assert.equal(result.error, undefined); assert.equal(result.earlyExit, undefined);
  assert.equal(requests.length, runs);
  assert.equal(result.sourceCold, true);
  assert.equal(result.reads.length, 2);
  assert.equal(result.claims.some(row => row.length === 2), true);
  assert.equal(result.readOpens, 2);
  assert.equal(result.snapshotsIndependent, true);
  console.log(JSON.stringify({size, ...result, modelRequests: requests.length}, null, 2));

} finally {
  clearTimeout(watchdog);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (closed) await closed;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  if (!keepEvidence) await rm(evidence, { recursive: true, force: true });
}
