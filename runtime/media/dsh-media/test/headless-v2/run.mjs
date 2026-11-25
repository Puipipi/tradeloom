import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { formatGenerationMessage } from '../../src/header.js';
const PRODUCT = fileURLToPath(new URL('../../', import.meta.url));
const PLUGIN = fileURLToPath(new URL('./plugin.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const cliPackage = require.resolve('@deepseek-ai/dsh/package.json');
const dshVersion = JSON.parse(await readFile(cliPackage)).version;
assert.ok(['0.2.1-rc.4', '0.2.2-rc.1'].includes(dshVersion), 'unsupported test DSH version');
const cli = join(dirname(cliPackage), 'lib/bin.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ6sAAAAASUVORK5CYII=', 'base64');
const MP4 = Buffer.from((await readFile(new URL('../fixtures/video.base64', import.meta.url), 'utf8')).trim(), 'base64');
const KEY = 'SYNTHETIC_MEDIA_KEY_NOT_REAL', LLMKEY = 'SYNTHETIC_LLM_KEY_NOT_REAL';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const jsonl = bytes => bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function runProcess(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
    const hard = setTimeout(() => child.kill('SIGKILL'), 65_000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(hard); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(hard); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
}
async function runCase(root, kind) {
  const directory = join(root, kind); await mkdir(directory, { mode: 0o700 });
  for (const part of ['home', 'workspace', 'capture']) await mkdir(join(directory, part), { mode: 0o700 });
  const home = join(directory, 'home'), workspace = join(directory, 'workspace'), capture = join(directory, 'capture');
  const providerCalls = [], llmCalls = [], mocks = []; let queries = 0, downloaded = false, failure;
  const model = kind === 'image' ? 'gpt-image-2.5-flare' : 'doubao-seedance-2-5-260628';
  const provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      providerCalls.push({ method: req.method, path: req.url, body });
      if (req.url === '/video.mp4') { assert.equal(req.headers.authorization, undefined); res.end(MP4); downloaded = true; return; }
      assert.equal(req.headers.authorization, 'Bearer ' + KEY);
      res.setHeader('content-type', 'application/json');
      if (kind === 'image') { assert.equal(req.url, '/v1/images/generations'); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })); }
      else if (req.method === 'POST') { assert.equal(req.url, '/api/v3/contents/generations/tasks'); res.end('{"id":"headless-task-1"}'); }
      else { assert.equal(req.url, '/api/v3/contents/generations/tasks/headless-task-1'); queries++; res.end(JSON.stringify({ id: 'headless-task-1', status: queries === 1 ? 'queued' : 'succeeded', content: { video_url: 'https://result.example/video.mp4' } })); }
    } catch (error) { failure ??= error; res.writeHead(500); res.end('{}'); }
  });
  const providerOrigin = await listen(provider);
  const llm = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/messages');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); llmCalls.push(body);
      let behavior = 'success', toolName, toolArguments;
      if (llmCalls.length === 1) {
        behavior = 'tool_call_success'; toolName = 'generate_' + kind;
        toolArguments = JSON.stringify({ prompt: '一个蓝色圆形。', serviceId: 'probe', modelId: model, n: 1 });
      } else if (kind === 'video' && llmCalls.length === 2) {
        // rc4 headless is one-shot and does not keep generic jobs alive after idle.
        // Hold the next LLM response while the real job settles; never jobs.wait,
        // which would suppress tool-jobs completion delivery as already awaited.
        let settled;
        for (let i = 0; i < 1000 && !settled; i++) {
          try { settled = JSON.parse(await readFile(join(capture, 'job-settled.json'))); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!settled) await sleep(10);
        }
        assert.equal(downloaded, true);
        assert.equal(settled?.status, 'completed');
        const jobId = JSON.stringify(body).match(/media-[a-f0-9-]+/)?.[0]; assert.ok(jobId);
        assert.equal(settled.id, jobId);
        behavior = 'tool_call_success'; toolName = 'get_media_result'; toolArguments = JSON.stringify({ job_id: jobId });
      }
      const mock = await startMockLlmServer({ host: '127.0.0.1', port: 0, apiKey: LLMKEY, sequence: [behavior], repeatLast: false,
        toolName, toolArguments, successText: '已保存，验证结束。' }); mocks.push(mock);
      const response = await fetch(mock.baseURL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': LLMKEY }, body: JSON.stringify(body) });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') });
      for await (const bytes of response.body) res.write(bytes); res.end();
    } catch (error) { failure ??= error; if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  const llmOrigin = await listen(llm);
  try {
    const disabled = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map(id => ({ id, disabled: true }));
    const patch = [...disabled,
      { id: 'credentials', disabled: false, config: { path: join(home, '.credentials.yaml') } },
      { id: 'approval', config: { policy: 'ask' } },
      { id: 'llm-deepseek', config: { baseURL: llmOrigin + '/v1', apiKeyEnv: 'DSH_MEDIA_PROBE_LLM_KEY', thinking: 'disabled', maxTokens: 2048, streamIdleTimeoutMs: 10000 } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
      { id: 'fs-sandbox', config: { cwd: workspace } },
      ...(dshVersion === '0.2.1-rc.4' ? [{ id: 'tools', config: { mode: 'native' } }]
        : [{ id: 'tool-executor-native', disabled: false }, { id: 'tool-executor-ptc', disabled: true }]),
      { insert: [{ id: 'media-v2-headless-probe', name: PLUGIN, config: { dshHome: home, services: [{ id: 'probe', enabled: true, provider: 'test-only',
        baseUrl: kind === 'image' ? 'https://api.openai.com/v1' : 'https://ark.cn-beijing.volces.com', profile: kind === 'image' ? 'openai-gpt-image' : 'ark-video', models: model, keyRef: 'DSH_MEDIA_SLOT_1_API_KEY' }] } }] },
    ];
    const patchPath = join(directory, 'probe.patch.json'); await json(patchPath, patch);
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, { TZ: 'Asia/Shanghai', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...(dshVersion === '0.2.1-rc.4' ? { DSH_TOOLS_MODE: 'native' } : {}), DSH_MEDIA_HEADLESS_PROBE: '1', DSH_MEDIA_PROBE_CAPTURE_DIR: capture,
      DSH_MEDIA_PROBE_IMAGE_ORIGIN: providerOrigin, DSH_MEDIA_SLOT_1_API_KEY: KEY, DSH_MEDIA_PROBE_LLM_KEY: LLMKEY });
    const task = formatGenerationMessage({ kind, prompt: '一个蓝色圆形。', ...(kind === 'image' ? { n: 1 } : {}), model: { label: kind === 'image' ? 'GPT Image 2.5 Flare' : 'Seedance 2.5', serviceId: 'probe', id: model } });
    const processResult = await runProcess(['headless', '--patch', patchPath, '--json', task], workspace, env);
    await writeFile(join(directory, 'stdout.jsonl'), processResult.stdout); await writeFile(join(directory, 'stderr.txt'), processResult.stderr);
    await json(join(directory, 'wire-audit.json'), { providerCalls, llmCalls });
    assert.ifError(failure); assert.equal(processResult.timedOut, false); assert.equal(processResult.code, 0, processResult.stderr);
    const raw = await readFile(join(capture, 'session-events.jsonl')); const events = jsonl(raw);
    events.forEach((event, i) => assert.equal(event.seq, i));
    assert.equal(events.filter(e => e.type === 'approval/asked').length, 1);
    assert.equal(events.find(e => e.type === 'approval/decided').data.outcome, 'allowed-once');
    const media = events.filter(e => e.type === 'tool/result' && e.data.meta?.['dsh-go/media']).map(e => e.data.meta['dsh-go/media']);
    const done = media.find(m => m.status === 'done'); assert.ok(done); assert.equal(done.kind, kind);
    assert.deepEqual(await readFile(done.items[0].path), kind === 'image' ? PNG : MP4);
    if (kind === 'video') {
      assert.ok(media.some(m => m.status === 'running' && m.rid === done.rid));
      assert.ok(events.some(e => e.type === 'job/registered'));
      const settlement = events.find(e => e.type === 'job/settled'); assert.equal(settlement.data.status, 'completed'); assert.equal(settlement.data.cause, 'producer');
      assert.ok(events.some(e => e.type === 'user/message' && e.data.source?.kind === 'tool-jobs'), 'real completion notice must reach the agent');
      assert.ok(events.some(e => e.type === 'tool/call' && e.data.name === 'get_media_result'));
    }
    const ledger = JSON.parse(await readFile(join(home, 'media/dsh-media/budget/ledger-v1.json')));
    assert.equal(ledger.requests.length, 1); assert.equal(ledger.requests[0].state, 'settled');
    assert.equal(providerCalls.filter(c => c.method === 'POST').length, 1);
    for (const secret of [KEY, LLMKEY]) { assert.ok(!raw.includes(secret)); assert.ok(!processResult.stdout.includes(secret)); assert.ok(!processResult.stderr.includes(secret)); }
    const files = await readdir(join(home, 'sessions'), { recursive: true }); const durable = files.filter(f => f.endsWith('.jsonl')); assert.equal(durable.length, 1);
    const durableRows = jsonl(await readFile(join(home, 'sessions', durable[0]))); assert.deepEqual(durableRows.slice(1), events);
    const result = { status: 'passed-local-mock', kind, sessionId: durableRows[0].id, events: events.length, providerCreates: 1, llmRequests: llmCalls.length, media: done, logicalSha256: sha(raw), paidProvider: false };
    await json(join(directory, 'verified.json'), result); return result;
  } finally { await close(llm); await close(provider); await Promise.all(mocks.map(mock => mock.close())); }
}
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(isAbsolute(values.out ?? '')); assert.equal(process.env.TZ, 'Asia/Shanghai');
await mkdir(values.out, { mode: 0o700 });
const files = (await readdir(join(PRODUCT, 'src'))).filter(name => name.endsWith('.js'));
const hashes = {};
for (const file of ['package.json', 'data/models.json', ...files.map(name => 'src/' + name)]) hashes[file] = sha(await readFile(join(PRODUCT, file)));
await json(join(values.out, 'identity.json'), { node: process.version, dsh: dshVersion, cliSha256: sha(await readFile(cli)), files: hashes, testLockSha256: sha(await readFile(join(dirname(cliPackage), '../../../package-lock.json'))) });
const records = [];
for (const kind of ['image', 'video']) records.push(await runCase(values.out, kind));
await json(join(values.out, 'summary.json'), { status: 'passed-local-mock', records, limits: ['scripted local LLM', 'no paid provider request', 'one-shot headless keeps LLM response open while job finishes; no registry wait'] });
console.log(JSON.stringify({ status: 'passed-local-mock', output: values.out, records: records.map(r => ({ kind: r.kind, events: r.events, llmRequests: r.llmRequests })) }));
