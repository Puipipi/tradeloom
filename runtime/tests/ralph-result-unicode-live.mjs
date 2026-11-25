import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const prefix = resolve(process.env.DSH_PREFIX);
const evidenceRoot = process.env.DSH_EVIDENCE_DIR && resolve(process.env.DSH_EVIDENCE_DIR);
async function runCase(caseName) {
  const evidence = evidenceRoot && join(evidenceRoot, caseName);
  const root = await mkdtemp(join(tmpdir(), 'own-ralph-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  const leading = 'Ralph worker reported completion after 1 round.\nFinal report:\n{\n  "status": "complete",\n  "summary": "';
  const report = { status: 'complete', summary: caseName === 'split-pair' ? 'a'.repeat(241 - leading.length) + '🙂tail' : 'a'.repeat(300), evidence: ['Own fixture result supplied'], nextSteps: [], blocker: '' };
  const requests = [];
  let serverError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: req.url, body });
      assert.equal(req.url, '/v1/messages');
      assert.ok(requests.length <= 3);
      const child = body.tools?.some(tool => tool.name === 'structured_output');
      const first = requests.length === 1;
      const useTool = first || child;
      const frames = [{ type: 'message_start', message: { id: `own-${requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
      if (useTool) {
        frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: first ? 'ralph-own' : 'report-own', name: first ? 'ralph' : 'structured_output', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(first ? { objective: 'Explicitly requested one-round Ralph fixture: return the prepared structured report without changing files.', maxRounds: 1 } : report) } },
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
      { insert: [{ id: 'own-ralph', name: '@deepseek-ai/dsh-tool-ralph', config: { maxRounds: 1, maxResultChars: 256 } }] });
    const patchFile = join(root, 'patch.json'); await writeFile(patchFile, JSON.stringify(patch));
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only' });
    const child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', patchFile, '--json', 'I explicitly request one Ralph fresh-agent iteration for this owned fixture. Use ralph with maxRounds 1, then report its result.'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    assert.equal(requests.length, 3);
    const results = requests[2].body.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result' && block.tool_use_id === 'ralph-own');
    assert.equal(results.length, 1); assert.equal(results[0].is_error, false);
    const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    console.log(JSON.stringify({ case: caseName, cliExit: code, modelRequests: requests.length, childStructuredSchema: requests[1].body.tools.find(tool => tool.name === 'structured_output'), text, textLength: text.length, wellFormed: text.isWellFormed() }, null, 2));
    assert.ok(text.length <= 256, 'complete rendered text respects configured UTF16 cap');
    assert.ok(text.endsWith('\n… [truncated]'), 'original marker is retained');
    if (caseName === 'ascii-control') assert.equal(text, leading + 'a'.repeat(242 - leading.length) + '\n… [truncated]');
    assert.ok(text.isWellFormed(), 'successful public Ralph result splits a legal surrogate pair');
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }

}
let failed = 0;
for (const caseName of ['split-pair', 'ascii-control']) {
  try {
    await runCase(caseName);
    console.log(JSON.stringify({ case: caseName, status: 'PASS' }));
  } catch (error) {
    failed++;
    console.error(JSON.stringify({ case: caseName, status: 'FAIL', error: String(error.stack) }));
  }
}
console.log(JSON.stringify({ cases: 2, passed: 2 - failed, failed }));
assert.equal(failed, 0, 'Ralph result Unicode live cases');
