// Subprocess fixture for the public completed-video error contract.
// Real: config snapshot, provider adapter, media engine, downloader, filesystem,
// budget persistence, storage, installMedia/startVideo/get_media_result.
// Modeled: provider wire receipts and ctx services/job registry.
// Normal test execution imports the installed peer packages; research loaders are external.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import fs, {mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve, basename, sep} from 'node:path';
import {CATALOG, HARD_LIMITS} from '../../src/config.js';
import {createMediaClient} from '../../src/adapters.js';
import {createStreamStager} from '../../src/stream-staging.js';
import {createBudgetLedger} from '../../src/budget-ledger.js';
import {installMedia} from '../../src/index.js';

const scenario = process.argv[2];
const contractCode = process.argv[3] === 'done' ? undefined : process.argv[3];
const root = await mkdtemp(join(tmpdir(), 'media-5308-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const home = join(root, 'host-home');
const hostStateDir = join(home, 'media', 'dsh-media');
const originalOpen = fs.open, originalRename = fs.rename;
let indexWriteFailures = 0, stageRenameFailures = 0;
if (scenario === 'index-storage-failure') {
  fs.open = async function (path, ...args) {
    const handle = await originalOpen.call(this, path, ...args);
    if (String(path).startsWith(join(hostStateDir, 'works') + sep) && String(path).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => {
        await write(bytes.subarray(0, 5));
        assert.equal((await handle.stat()).size, 5);
        indexWriteFailures++;
        throw Object.assign(new Error('controlled index write ENOSPC'), {code: 'ENOSPC'});
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
let xfszSignals = 0;
process.on('SIGXFSZ', () => {xfszSignals++;});
const original = Buffer.from((await readFile(new URL('./video.base64', import.meta.url), 'utf8')).trim(), 'base64');
// A valid bounded top-level free box enlarges the existing project fixture.
// inspectVideo is real; no ffprobe or pixel decoding is claimed.
const padding = Buffer.alloc(65536);
padding.writeUInt32BE(padding.length, 0);
padding.write('free', 4, 'ascii');
const payload = Buffer.concat([original, padding]);
if (scenario === 'stage-rename-storage-failure') {
  fs.rename = async function(source, destination) {
    if (destination.startsWith(join(workspace, 'generated') + sep) && basename(destination) === '1.mp4') {
      assert.equal((await fs.stat(source)).size, payload.length);
      stageRenameFailures++;
      throw Object.assign(new Error('Synthetic stage directory ENOSPC'), {code: 'ENOSPC'});
    }
    return originalRename.call(this, source, destination);
  };
  syncBuiltinESMExports();
}
let downloadRequests = 0;
const sockets = new Set();
const server = createServer((_req, response) => {
  downloadRequests++;
  if (['local-download-timeout', 'overall-timeout-after-success'].includes(scenario)) return;
  response.writeHead(200, {'content-type': 'video/mp4', 'content-length': payload.length});
  response.end(payload);
});
server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;

const providerWires = [];
let providerState = scenario === 'confirmed-cancel' ? 'queued'
  : scenario === 'terminal-failed' ? 'failed' : 'succeeded';
const transport = async (url, options) => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'ark.cn-beijing.volces.com');
  providerWires.push({method: options.method, path: parsed.pathname, observedState: providerState});
  let status = 200, value;
  if (options.method === 'POST') value = {id: 'research-task-1'};
  else if (options.method === 'DELETE') {providerState = 'cancelled'; value = {};}
  else if (scenario === 'query-outage') {status = 503; value = {};}
  else value = {id: 'research-task-1', status: providerState,
    ...(providerState === 'succeeded' ? {content: {video_url: 'https://result.example/original.mp4'}} : {})};
  return {status, headers: {}, body: Buffer.from(JSON.stringify(value))};
};
const client = createMediaClient({transport});
const download = createStreamStager({allowLoopback: true});
let stageError, stageSignalAborted, foreignPath;
const stageDownload = async (url, options) => {
  assert.equal(url, 'https://result.example/original.mp4');
  stageSignalAborted = options.signal.aborted;
  if (scenario === 'cleanup-priority') {
    foreignPath = join(options.directory, 'unowned-control.txt');
    await writeFile(foreignPath, 'preserve this unrelated file');
  }
  try {return await download(origin + '/original.mp4', {
    ...options, ...(scenario === 'local-download-timeout' ? {timeoutMs: 20} : {}),
  });}
  catch (error) {
    stageError = {code: error.code, message: error.message};
    stageSignalAborted = options.signal.aborted;
    throw error;
  }
};

const registered = new Map();
const progress = [];
const wholeDeadline = new AbortController();
let hooks, outcome, installed;
const session = {id: 'research-session'};
const agent = {session, ctx: {fiber: {assertActive() {}}}};
const ctx = {
  fiber: {assertActive() {}},
  effect(callback) {return callback();},
  on() {return () => {};},
  jobs: {
    events: {subscribe() {return () => {}; }},
    start(spec) {
      assert.equal(spec.owner, session.id);
      hooks = spec.run({id: 'media-research-job', updateProgress(line) {
        progress.push(line);
        if ((scenario === 'cancel-after-success' && line === '正在保存视频原件')
          || (scenario === 'confirmed-cancel' && line === '视频正在排队')) hooks.cancel();
        if (scenario === 'overall-timeout-after-success' && line === '正在保存视频原件') {
          const deadline = AbortSignal.timeout(10);
          deadline.addEventListener('abort', () => wholeDeadline.abort(deadline.reason), {once: true});
        }
      }});
      return 'media-research-job';
    },
    get(id, owner) {
      assert.equal(id, 'media-research-job'); assert.equal(owner, session.id);
      return {id, owner, status: outcome?.status ?? 'running'};
    },
  },
  tools: {register(tool) {registered.set(tool.name, tool); return () => registered.delete(tool.name);}},
  systemPrompt: {section() {return () => {}; }},
  credentials: {
    async describe() {return {configured: true};},
    async resolve() {return {value: 'SYNTHETIC_5308_NOT_A_KEY'};},
  },
  approval: {async request() {return 'allowed-once';}},
  sandboxPolicy: {resolve() {return {mode: 'workspace-write', workspaceRoot: workspace};}},
  workingDirectory: {async ensure() {return workspace;}, get() {return workspace;}},
  fs: {
    async resolve(path, {signal} = {}) {signal?.throwIfAborted(); return {targetKey: await realpath(path)};},
    processPath(target) {return target.targetKey;},
    processPathFromHostPath(path) {return resolve(path);},
  },
};
const model = CATALOG.models.find(row => row.profile === 'ark-video');
const volatile = value => ({get: () => value});
const config = {dshHome: home, services: volatile([{id: 'research', enabled: true,
  keyRef: 'SYNTHETIC_MEDIA_REF', provider: 'ark', profile: 'ark-video',
  baseUrl: CATALOG.profiles['ark-video'].origin, models: model.id}]),
  defaults: volatile({}), limits: volatile({...HARD_LIMITS}),
  budget: volatile({dailyCny: '20', unknownPriceHoldCny: '20'})};
let record;
try {
  installed = installMedia(ctx, config, {engineOptions: {client, transport, stageDownload, pollMs: 1,
    ...(scenario === 'overall-timeout-after-success' ? {signal: wholeDeadline.signal} : {}),
  }});
  await installed.ready;
  assert.ok(registered.has('generate_video'));
  const exec = {agent, signal: new AbortController().signal, callId: 'research-call'};
  const initial = await registered.get('generate_video').execute({prompt: 'synthetic blue circle'}, exec);
  assert.equal(initial.meta.status, 'running');
  outcome = await hooks.done;
  const result = await registered.get('get_media_result').execute({job_id: initial.meta.job}, exec);
  const ledger = await createBudgetLedger(join(hostStateDir, 'budget')).snapshot();
  assert.equal(ledger.requests.length, 1);
  const saved = ledger.requests[0];
  const dated = join(workspace, 'generated', saved.outputDate);
  const names = await readdir(dated);
  const indexNames = await readdir(join(hostStateDir, 'works', saved.outputDate));
  const filesMatch = result.meta.status === 'done'
    ? Buffer.compare(await readFile(result.meta.items[0].path), payload) === 0 : undefined;
  const foreignPreserved = foreignPath ? await readFile(foreignPath, 'utf8') === 'preserve this unrelated file' : undefined;
  assert.equal(providerWires.filter(wire => wire.method === 'POST').length, 1);
  assert.equal(saved.providerTaskId, 'research-task-1');
  assert.notEqual(saved.state, 'released');
  if (result.meta.status === 'failed' && scenario !== 'cleanup-priority') {
    assert.deepEqual(names, []); assert.deepEqual(indexNames, []);
  }
  if (result.meta.status === 'done') assert.equal(filesMatch, true);
  record = {scenario, pid: process.pid, uid: process.getuid?.(),
    payloadBytes: payload.length, xfszSignals, providerWires, downloadRequests, indexWriteFailures, stageRenameFailures,
    progress, stageError, stageSignalAborted, wholeDeadlineAborted: wholeDeadline.signal.aborted,
    wholeDeadlineReason: wholeDeadline.signal.reason?.name, outcome, result,
    ledger: {state: saved.state, providerTaskId: saved.providerTaskId,
      estimateMicros: saved.estimateMicros, chargeMicros: saved.chargeMicros},
    generatedNames: names, indexNames, filesMatch, foreignPreserved,
    expectedErrorCode: contractCode ?? null, observedErrorCode: result.meta.error?.code ?? null,
    contractMatches: result.meta.error?.code === contractCode,
    limits: 'provider receipts/services/job registry modeled; no real provider or Host; whole deadline uses a 10ms native AbortSignal.timeout, not the production 30 minute elapsed duration',
  };
} finally {
  fs.open = originalOpen; fs.rename = originalRename;
  syncBuiltinESMExports();
  await installed?.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(root, {recursive: true, force: true});
}
console.log(JSON.stringify({...record, privateRootRemoved: true}));
assert.equal(record.observedErrorCode, contractCode ?? null,
  'the final media result must preserve the applicable documented failure class');
