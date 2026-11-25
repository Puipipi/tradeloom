import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const prefix = resolve(process.env.DSH_PREFIX);
const pluginPath = fileURLToPath(new URL('./fixtures/repeat-preview-document-tool.mjs', import.meta.url));
const evidenceRoot = process.env.DSH_EVIDENCE_DIR && resolve(process.env.DSH_EVIDENCE_DIR);
async function runCase(caseName) {
  const evidence = evidenceRoot && join(evidenceRoot, caseName);
  const root = await mkdtemp(join(tmpdir(), 'own-repeat-preview-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  const cap = caseName === 'minimum-cap' ? 1 : 500;
  const prefixLength = '{"document":{"label":"'.length;
  const value = caseName === 'untruncated' ? '短🙂' :
    caseName === 'minimum-cap' ? 'ascii' :
    caseName === 'ascii' ? 'a'.repeat(510) :
    'a'.repeat((caseName === 'split-pair' ? 499 : 498) - prefixLength) + '🙂tail';
  const document = { label: value };
  const canonical = JSON.stringify({ document });
  const kept = caseName === 'split-pair' ? 499 : cap;
  const expectedPreview = canonical.length <= cap ? canonical : canonical.slice(0, kept) + `… (+${canonical.length - kept} more chars)`;
  const requests = [];
  let serverError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: req.url, body });
      assert.equal(req.url, '/v1/messages');
      assert.ok(requests.length <= 4);
      const useTool = requests.length <= 3;
      const frames = [{ type: 'message_start', message: { id: `own-${requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
      if (useTool) {
        frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `doc-${requests.length}`, name: 'own_document_echo', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ document }) } },
          { type: 'content_block_stop', index: 0 });
      } else {
        frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } },
          { type: 'content_block_stop', index: 0 });
      }
      frames.push({ type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
    } catch (error) { serverError = error; res.writeHead(500); res.end('own fixture failure'); }
  });
  try {
    await mkdir(home); await mkdir(workspace); if (evidence) await mkdir(evidence, { recursive: true });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
    patch.push({ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'OWN_FIXTURE_KEY', thinking: 'disabled', maxTokens: 2048 } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
      { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
      { id: 'fs-sandbox', config: { cwd: workspace } },
      { id: 'tool-executor-native', disabled: false }, { id: 'tool-executor-ptc', disabled: true },
      { id: 'repeat-tool-reminder', config: { thresholds: [2, 3], argumentsPreviewChars: cap } },
      { insert: [{ id: 'own-document', name: pluginPath }] });
    const patchFile = join(root, 'patch.json'); await writeFile(patchFile, JSON.stringify(patch));
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only', DSH_PREFIX: prefix });
    const child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', patchFile, '--json', 'Read the three owned JSON documents with own_document_echo, then finish. Do not change files.'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
    const [code, signal] = await once(child, 'close'); clearTimeout(watchdog);
    if (evidence) {
      await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
      await writeFile(join(evidence, 'headless.log'), stdout + '\nSTDERR\n' + stderr);
    }
    if (serverError) throw serverError;
    assert.equal(code, 0, stderr); assert.equal(signal, null); assert.ok(!stderr.includes('did not activate'), stderr);
    assert.equal(requests.length, 4);
    const blocks = requests[3].body.messages.flatMap(message => message.content);
    const results = blocks.filter(block => block.type === 'tool_result' && /^doc-/.test(block.tool_use_id));
    assert.equal(results.length, 3);
    const documents = results.map(result => {
      assert.equal(result.is_error, false);
      return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    });
    const texts = blocks.filter(block => block.type === 'text').map(block => block.text);
    const reminders = texts.filter(text => text.includes('You are repeating the exact same tool call') || text.includes('consecutive_calls:'));
    console.log(JSON.stringify({ case: caseName, cliExit: code, modelRequests: requests.length, documents, reminders }, null, 2));
    for (const result of documents) {
      assert.deepEqual(result.keys, ['label']);
      assert.deepEqual(result.document, document);
    }
    assert.equal(reminders.length, 2);
    const detailed = reminders.find(text => text.includes('consecutive_calls:'));
    assert.ok(detailed);
    const argumentLine = detailed.split('\n').find(line => line.startsWith('- arguments: '));
    assert.equal(argumentLine, '- arguments: ' + expectedPreview, 'preview prefix and omitted count must match actual retained UTF16 length');
    assert.ok(detailed.isWellFormed(), 'detailed reminder must not split a legal pair');

  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }

}
let failed = 0;
for (const caseName of ['split-pair', 'ascii', 'complete-pair', 'untruncated', 'minimum-cap']) {
  try {
    await runCase(caseName);
    console.log(JSON.stringify({ case: caseName, status: 'PASS' }));
  } catch (error) {
    failed++;
    console.error(JSON.stringify({ case: caseName, status: 'FAIL', error: String(error.stack) }));
  }
}
console.log(JSON.stringify({ cases: 5, passed: 5 - failed, failed }));
assert.equal(failed, 0, 'repeat arguments preview live cases');
