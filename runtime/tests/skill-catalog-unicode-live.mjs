import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// DSH_PREFIX=/absolute/prepared-prefix node runtime/tests/skill-catalog-unicode-live.mjs
const prefix = resolve(process.env.DSH_PREFIX);
const evidence = process.env.DSH_EVIDENCE_DIR ? resolve(process.env.DSH_EVIDENCE_DIR) : undefined;
if (evidence) await mkdir(evidence, { recursive: true });
const cases = [
  ['boundary', 'a'.repeat(496) + '🙂tail', 'a'.repeat(496) + '...'],
  ['pair-before', 'a'.repeat(495) + '🙂tail', 'a'.repeat(495) + '🙂...'],
  ['pair-after', 'a'.repeat(497) + '🙂tail', 'a'.repeat(497) + '...'],
  ['pair-exact', 'a'.repeat(498) + '🙂', 'a'.repeat(498) + '🙂'],
  ['ascii', 'a'.repeat(501), 'a'.repeat(497) + '...'],
  ['whitespace', '  ordinary\t\n🙂  description  ', 'ordinary 🙂 description'],
  ['normalized-boundary', ' \t' + 'a'.repeat(496) + '🙂tail  ', 'a'.repeat(496) + '...'],
];
const root = await mkdtemp(join(tmpdir(), 'skill-description-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const skills = join(root, 'skills');
let child;
let timer;
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ path: request.url, body });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frames = [
    { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
});
try {
  for (const path of [home, workspace, skills]) await mkdir(path, { recursive: true });
  for (const [name, description] of cases) {
    await writeFile(join(skills, name + '.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nOrdinary synthetic fixture instructions.\n`);
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
  patch.push(
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'OWN_FIXTURE_KEY', thinking: 'disabled', maxTokens: 1024 } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    { id: 'fs-sandbox', config: { cwd: workspace } },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: [skills], watch: false } },
    { id: 'tool-executor-native', disabled: false },
    { id: 'tool-executor-ptc', disabled: true },
  );
  const patchPath = join(root, 'patch.json');
  await writeFile(patchPath, JSON.stringify(patch));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_FIXTURE_KEY: 'synthetic-local-only' });
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', patchPath, '--json', 'Reply done.'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stdout.on('data', text => stdout += text);
  child.stderr.on('data', text => stderr += text);
  timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timer);
  if (evidence) {
    await writeFile(join(evidence, 'headless.log'), stdout + '\nSTDERR\n' + stderr);
    await writeFile(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  }
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(stderr, '');
  assert.equal(requests.length, 1);
  const blocks = requests[0].body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  const catalog = blocks.find(block => block.type === 'text' && block.text.includes('<available_skills>') && block.text.includes('boundary'));
  assert.ok(catalog, 'real filesystem skill catalog reaches provider request');
  const actual = catalog.text.split('\n').filter(line => line.startsWith('- `'));
  const expected = cases.map(([name, , description]) => `- \`${name}\`: ${description}`).sort();
  console.log(JSON.stringify({ phase: 'observation', code, signal, requests: requests.length,
    cases: cases.length, sourceWellFormed: cases.every(([, text]) => text.isWellFormed()),
    catalogWellFormed: catalog.text.isWellFormed() }));
  assert.deepEqual(actual.sort(), expected);
  assert.equal(catalog.text.isWellFormed(), true);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(event => event.type === 'final').text, 'done');
  assert.deepEqual(events.find(event => event.type === 'final').reason, { kind: 'completed' });
  console.log(JSON.stringify({ status: 'PASS', scope: 'one real CLI turn, seven filesystem skill descriptions, one local model request' }));

} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
