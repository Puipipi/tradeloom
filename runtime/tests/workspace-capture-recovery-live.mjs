import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.platform, 'linux', 'This live probe needs Linux resource.prlimit.');
assert(process.env.DSH_PREFIX, 'Set DSH_PREFIX to a prepared runtime prefix.');
const prefix = resolve(process.env.DSH_PREFIX);
const evidenceRoot = process.env.DSH_EVIDENCE_DIR ? resolve(process.env.DSH_EVIDENCE_DIR) : await mkdtemp(join(tmpdir(), 'workspace-capture-evidence-'));

async function runCase(spec) {
const evidence = join(evidenceRoot, spec.name);
const original = Array.from({ length: spec.lines }, (_, i) => `before-line-${String(i).padStart(3, '0')}\n`).join('');
const after = 'after-line\n';
const root = await mkdtemp(join(tmpdir(), 'own-workspace-capture-'));
const home = join(root, 'home'), workspace = join(root, 'workspace'), ownTmp = join(root, 'tmp');
const requests = [], serverErrors = [], resourceFacts = [];
let child, closed, watchdog, oldLimit;
function setLimit(op) {
  const code = "import resource,sys,json\npid=int(sys.argv[1])\nold=resource.prlimit(pid,resource.RLIMIT_FSIZE)\nnew=((int(sys.argv[4]),old[1]) if sys.argv[4]!='none' else old) if sys.argv[2]=='set' else tuple(json.loads(sys.argv[3]))\nresource.prlimit(pid,resource.RLIMIT_FSIZE,new)\nprint(json.dumps({'old':old,'new':resource.prlimit(pid,resource.RLIMIT_FSIZE)}))\n";
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-c', code, String(child.pid), op, JSON.stringify(oldLimit ?? []), String(spec.limit ?? 'none')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const fact = JSON.parse(result.stdout);
  if (op === 'set') oldLimit = fact.old;
  resourceFacts.push({ op, ...fact });
  return fact;
}
const server = createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const bytes of req) parts.push(bytes);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push({ path: req.url, body });
    assert.equal(req.url, '/v1/messages');
    assert(requests.length <= 6, 'Exactly two ordinary read/write turns.');
    const n = requests.length;
    const name = n === 1 || n === 4 ? 'read' : n === 2 || n === 5 ? 'write' : undefined;
    const args = name === 'read' ? { file_path: 'own.txt' } : { file_path: 'own.txt', content: n === 2 ? original : after };
    const frames = [{ type: 'message_start', message: { id: `own-${n}`, type: 'message', role: 'assistant',
      model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
    if (name) frames.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `own-tool-${n}`, name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 0 });
    else frames.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } },
      { type: 'content_block_stop', index: 0 });
    frames.push({ type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  } catch (error) {
    serverErrors.push(String(error.stack));
    if (!res.headersSent) res.writeHead(500);
    res.end('own fixture failed');
  }
});
try {
  await mkdir(evidence, { recursive: true });
  for (const directory of [home, workspace, ownTmp]) await mkdir(directory);
  await writeFile(join(workspace, 'own.txt'), original);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel',
    'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
  patch.push({ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: 'OWN_FIXTURE_KEY', thinking: 'disabled', maxTokens: 4096 } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'tool-executor-native', disabled: false }, { id: 'tool-executor-ptc', disabled: true },
    { insert: [{ id: 'own-capture-observer', name: pathToFileURL(fileURLToPath(new URL('./fixtures/workspace-capture-observer.mjs', import.meta.url))).href }] });
  const patchFile = join(root, 'patch.json'); await writeFile(patchFile, JSON.stringify(patch));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, TMPDIR: ownTmp, DSH_TELEMETRY_DISABLED: '1',
    OWN_FIXTURE_KEY: 'synthetic-local-only', DSH_PREFIX: prefix });
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patchFile,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    stdout += text;
    if (!sent && stdout.includes('dsh web: ') && stdout.includes('?token=')) { sent = true; child.send({ kind: 'run' }); }
  });
  child.stderr.on('data', text => { stderr += text; });
  closed = once(child, 'close');
  watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const resultPromise = new Promise(resolve => child.on('message', message => {
    if (message?.kind === 'limit-request') {
      try { setLimit(message.op); child.send({ kind: 'limit-ack', ticket: message.ticket }); }
      catch (error) { child.send({ kind: 'limit-ack', ticket: message.ticket, error: String(error.stack) }); }
    }
    if (message?.kind === 'result') resolve(message);
  }));
  const result = await Promise.race([resultPromise, closed.then(exit => ({ earlyExit: exit }))]);
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ prefix, original, after, result, resourceFacts, serverErrors, requests }, null, 2));
  await writeFile(join(evidence, 'host.log'), stdout.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>') + '\nSTDERR\n' + stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.earlyExit, undefined);
  assert.deepEqual(serverErrors, []);
  assert.equal(requests.length, 6);
  assert.equal(result.injected, true);
  const containmentWarning = 'subprocess-local is using weaker process-tree containment because the current user-systemd scope or private bootstrap is unavailable; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()';
  const isCaptureFailure = item => item.type === 'warn' && item.name === 'workspace-changes'
    && item.args.length === 1 && /^workspace-changes: Error: EFBIG: file too large, write$/.test(item.args[0]);
  const isKnownStartup = item => item.type === 'warn' && item.name === 'local-subprocess-runtime'
    && item.args.length === 1 && item.args[0] === containmentWarning
    && item.phase === 'before-first-capture';
  assert(result.logs.every(item => isCaptureFailure(item) || isKnownStartup(item)),
    'Only the exact known pre-capture containment warning and expected capture EFBIG are allowed.');
  if (spec.expectFailure) {
    assert(result.signals > 0);
    assert(result.logs.some(isCaptureFailure), 'The real capture failure must be observed.');
  } else {
    assert.equal(result.signals, 0);
    assert.equal(result.logs.filter(isCaptureFailure).length, 0);
  }
  assert.equal(resourceFacts.length, 2);
  assert.equal(result.durableEventsEqualLive, true);
  assert(result.waits.every(wait => wait.reason === 'idle' && wait.state.running === false && wait.state.queue.length === 0), 'Both turns complete.');
  assert.deepEqual(resourceFacts[1].new, resourceFacts[0].old);
  assert.deepEqual(result.turnFiles, [original, after]);
  assert.equal(result.toolResults.length, 4);
  assert(result.toolResults.every(item => item.message?.isError === false), 'Every ordinary read/write succeeds.');
  const second = result.summaries.find(item => item.summary.turn === 2);
  assert(second, 'Second turn publishes a changed-file summary.');
  assert.equal(second.summary.files.length, 1);
  const deleted = second.diffs[0].hunks.flatMap(hunk => hunk.lines.filter(line => line.startsWith('-')).map(line => line.slice(1)));
  console.log(JSON.stringify({ modelRequests: requests.length, signals: result.signals, resourceFacts,
    partialCopies: result.captureFacts.map(item => ({ name: item.name, size: item.size })),
    case: spec.name, originalBytes: Buffer.byteLength(original), expectedDeletedLines: spec.lines, actualDeletedLines: deleted.length, summary: second.summary }, null, 2));
  assert.deepEqual(deleted, original.trimEnd().split('\n'), 'Public diff must retain the entire original file after failed capture recovery.');
  assert.deepEqual(result.finalCaptures.map(item => item.text).sort(), [original, after].sort(),
    'Final captures retain both complete source versions, not a partial copy.');
  if (spec.expectFailure) assert.deepEqual(result.captureFacts, [], 'Failed initial capture leaves no partial published file.');
  else assert.deepEqual(result.captureFacts.map(item => item.text), [original]);
} finally {
  clearTimeout(watchdog);
  if (child && child.exitCode === null && child.signalCode === null) {
    if (oldLimit && resourceFacts.at(-1)?.op !== 'restore') {
      try { setLimit('restore'); } catch {}
    }
    child.kill('SIGTERM');
  }
  if (closed) await closed;
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

}
const results = [];
try {
  for (const spec of [
    { name: 'capture-failure-recovery', lines: 128, limit: 256, expectFailure: true },
    { name: 'small-capture-success', lines: 8, limit: 256, expectFailure: false },
    { name: 'unlimited-capture-reuse', lines: 128, limit: null, expectFailure: false },
  ]) {
    try { await runCase(spec); results.push({ case: spec.name, status: 'pass' }); }
    catch (error) {
      results.push({ case: spec.name, status: 'fail', error: String(error.stack) });
      console.error(error.stack);
    }
  }
  await writeFile(join(evidenceRoot, 'cases.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ cases: results, evidence: evidenceRoot }));
  if (results.some(result => result.status === 'fail')) process.exitCode = 1;
} finally {
  if (!process.env.DSH_EVIDENCE_DIR) await rm(evidenceRoot, { recursive: true, force: true });
}
