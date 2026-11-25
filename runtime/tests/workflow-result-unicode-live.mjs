import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const prefix = resolve(process.env.DSH_PREFIX);
const evidence = process.env.DSH_EVIDENCE_DIR && resolve(process.env.DSH_EVIDENCE_DIR);
const cases = [
  { id: 'split', script: 'return "a".repeat(49998) + "🙂尾";',
    json: '"' + 'a'.repeat(49998), omitted: 4 },
  { id: 'pair-fits', script: 'return "a".repeat(49997) + "🙂尾";',
    json: '"' + 'a'.repeat(49997) + '🙂', omitted: 2 },
  { id: 'ascii-clipped', script: 'return "a".repeat(50001);',
    json: '"' + 'a'.repeat(49999), omitted: 3 },
  { id: 'exact-cap', script: 'return "a".repeat(49998);',
    json: '"' + 'a'.repeat(49998) + '"', omitted: 0 },
  { id: 'small-string', script: 'return "中文🙂";',
    json: '"中文🙂"', omitted: 0 },
  { id: 'small-object', script: 'return {text:"中文🙂", items:[1,null,true]};',
    json: JSON.stringify({ text: '中文🙂', items: [1, null, true] }, null, 2), omitted: 0 },
];
const root = await mkdtemp(join(tmpdir(), 'workflow-unicode-'));
const home = join(root, 'home'), workspace = join(root, 'workspace');
const requests = [];
let serverError;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, body });
    assert.equal(req.url, '/v1/messages');
    assert.ok(requests.length <= 2);
    const frames = [{ type: 'message_start', message: {
      id: 'own-' + requests.length, type: 'message', role: 'assistant',
      model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 },
    } }];
    if (requests.length === 1) {
      for (const [index, entry] of cases.entries()) {
        frames.push(
          { type: 'content_block_start', index, content_block: {
            type: 'tool_use', id: entry.id, name: 'workflow', input: {},
          } },
          { type: 'content_block_delta', index, delta: {
            type: 'input_json_delta', partial_json: JSON.stringify({
              meta: { name: entry.id, description: 'Own local Unicode result fixture' },
              script: entry.script,
            }),
          } },
          { type: 'content_block_stop', index },
        );
      }
    } else {
      frames.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成🙂' } },
        { type: 'content_block_stop', index: 0 },
      );
    }
    frames.push(
      { type: 'message_delta', delta: { stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  } catch (error) {
    serverError = error;
    res.writeHead(500);
    res.end(JSON.stringify({ error: { message: 'own fixture failure' } }));
  }
});
try {
  await mkdir(home);
  await mkdir(workspace);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account',
    'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek',
    'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
  patch.push(
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'OWN_FIXTURE_KEY', thinking: 'disabled', maxTokens: 2048 } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'tool-executor-native', disabled: false },
    { id: 'tool-executor-ptc', disabled: true },
    // Keep the complete rendered workflow text visible to the assertions.
    // The workflow's own default maxResultChars=50000 remains untouched.
    { id: 'spill-policy', config: { maxInlineTokens: 1000000 } },
  );
  const file = join(root, 'patch.json');
  await writeFile(file, JSON.stringify(patch));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only' });
  const child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'headless', '--patch', file, '--json', '仅执行自有workflow返回值检查'],
  { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => stdout += text);
  child.stderr.on('data', text => stderr += text);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(watchdog);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
    await writeFile(join(evidence, 'headless.log'), stdout + '\nSTDERR\n' + stderr);
  }
  if (serverError) throw serverError;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(requests.length, 2);
  assert.ok(!stderr.includes('did not activate'), stderr);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.find(event => event.type === 'final').reason, { kind: 'completed' });
  assert.equal(events.filter(event => event.type === 'tool_result').length, cases.length);
  const results = requests[1].body.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result');
  assert.equal(results.length, cases.length);
  let failed = 0;
  for (const entry of cases) {
    try {
      const result = results.find(block => block.tool_use_id === entry.id);
      assert.ok(result);
      assert.equal(result.is_error, false);
      const suffix = entry.omitted === 0 ? '' : `\n… [truncated: ${entry.omitted} more characters]`;
      const expected = `workflow "${entry.id}" completed (0 agents).\nReturn value:\n${entry.json}${suffix}`;
      assert.equal(result.content[0].text.isWellFormed(), true, 'valid input must remain well-formed');
      assert.equal(result.content[0].text, expected);
      console.log(JSON.stringify({ case: entry.id, status: 'PASS', omitted: entry.omitted }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ case: entry.id, status: 'FAIL', reason: error.message.slice(0, 300) }));
    }
  }
  console.log(JSON.stringify({ cases: cases.length, passed: cases.length - failed, failed, requests: requests.length, cliExit: code }));
  assert.equal(failed, 0);
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
