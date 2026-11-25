import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, access, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, HARD_LIMITS } from '../src/config.js';
import { admitGeneration } from '../src/budget.js';
import { createBudgetLedger } from '../src/budget-ledger.js';
import { generateMedia } from '../src/media-engine.js';
import { installMedia } from '../src/index.js';
import { MediaError } from '../src/errors.js';

const brokenLedger = '{"incomplete":';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'media-release-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const request = {
    prompt: 'synthetic circle', n: 1, refs: [],
    service: { id: 'probe', provider: 'openai', profile: 'openai-gpt-image', baseUrl: 'https://api.openai.com/v1' },
    model: CATALOG.models.find(row => row.profile === 'openai-gpt-image' && !row.editOnly),
  };
  let creates = 0;
  const context = {
    hostStateDir: join(directory, 'host-state'), sessionId: 'session-1', keyRef: 'TEST_MEDIA_KEY',
    signal: new AbortController().signal, limits: { ...HARD_LIMITS },
    budget: { dailyMicros: 20_000_000, unknownHoldMicros: 20_000_000 },
    approve: async () => 'allowed-once',
    authorizeWorkspace: async () => ({ cwd: workspace, workspaceRoot: workspace, mode: 'workspace-write' }),
    resolveCredential: async () => 'synthetic-not-a-real-key',
    client: { async create() { creates++; throw new MediaError('provider'); } },
  };
  context.admission = await admitGeneration(request, context);
  const dateDirectory = join(workspace, 'generated', context.admission.outputDate);
  const ledgerPath = join(context.hostStateDir, 'budget', 'ledger-v1.json');
  return {
    context, request, directory, workspace, dateDirectory, ledgerPath,
    get creates() { return creates; },
    async preparedStage() {
      const names = await readdir(dateDirectory);
      assert.equal(names.length, 1, 'real storage preparation must already own one staging directory');
      assert.ok(names[0].startsWith('.' + context.admission.rid + '-'));
      assert.ok(names[0].endsWith('.pending'));
      return join(dateDirectory, names[0]);
    },
    async ledger() { return createBudgetLedger(join(context.hostStateDir, 'budget')).snapshot(); },
  };
}

test('real budget release failure still removes the prepared staging directory', async t => {
  const f = await fixture(t);
  let stage;
  f.context.resolveCredential = async () => {
    stage = await f.preparedStage();
    await writeFile(f.ledgerPath, brokenLedger);
    return '';
  };
  await assert.rejects(generateMedia(f.request, f.context), { code: 'budget' });
  assert.ok(stage);
  assert.deepEqual(await readdir(f.dateDirectory), []);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), brokenLedger, 'cleanup does not repair or refund the broken ledger');
  assert.equal(f.creates, 0);
});

test('unremovable unowned contents still surface cleanup_failed when budget release also fails', async t => {
  const f = await fixture(t);
  let foreign;
  f.context.resolveCredential = async () => {
    const stage = await f.preparedStage();
    foreign = join(stage, 'untracked.txt');
    await writeFile(foreign, 'unowned synthetic bytes');
    await writeFile(f.ledgerPath, brokenLedger);
    return '';
  };
  await assert.rejects(generateMedia(f.request, f.context), { code: 'cleanup_failed' });
  assert.equal(await readFile(foreign, 'utf8'), 'unowned synthetic bytes');
  assert.equal(await readFile(f.ledgerPath, 'utf8'), brokenLedger);
  assert.equal(f.creates, 0);
});

test('successful unsent release retains the original error and clears the stage', async t => {
  const f = await fixture(t);
  f.context.resolveCredential = async () => {
    await f.preparedStage();
    return '';
  };
  await assert.rejects(generateMedia(f.request, f.context), { code: 'credential' });
  assert.deepEqual(await readdir(f.dateDirectory), []);
  assert.equal((await f.ledger()).requests[0].state, 'released');
  assert.equal(f.creates, 0);
});

test('a submitted failure keeps its hold and never attempts an unsent release', async t => {
  const f = await fixture(t);
  let releases = 0;
  const release = f.context.admission.releaseUnsent;
  f.context.admission.releaseUnsent = async () => { releases++; return release(); };
  await assert.rejects(generateMedia(f.request, f.context), { code: 'provider' });
  assert.equal(f.creates, 1);
  assert.equal(releases, 0);
  assert.equal((await f.ledger()).requests[0].state, 'submission_unknown');
  assert.deepEqual(await readdir(f.dateDirectory), []);
});

test('a failed prepare with no store still retains a real release error', async t => {
  const f = await fixture(t);
  await writeFile(f.ledgerPath, brokenLedger);
  f.context.authorizeWorkspace = async () => { throw new MediaError('permission'); };
  await assert.rejects(generateMedia(f.request, f.context), { code: 'budget' });
  await assert.rejects(access(join(f.workspace, 'generated')), { code: 'ENOENT' });
  assert.equal(f.creates, 0);
});


// Keep the actual admission/core/store from fixture; only host registration is local.
async function imageTool(t, f) {
  const registered = new Map();
  const ctx = {
    fiber: { assertActive() {} }, effect() {}, on() {},
    jobs: { events: { subscribe: () => () => {} } },
    credentials: { describe: async () => ({ configured: true }) },
    tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } },
    systemPrompt: { section: () => () => {} },
  };
  const config = {
    dshHome: f.directory,
    services: { get: () => [{ ...f.request.service, enabled: true, models: f.request.model.id, keyRef: f.context.keyRef, responseFormat: '' }] },
    defaults: { get: () => ({}) }, limits: { get: () => ({ ...f.context.limits }) },
  };
  let releases = 0;
  const release = f.context.admission.releaseUnsent;
  f.context.admission.releaseUnsent = async () => { releases++; return release(); };
  const installed = installMedia(ctx, config, {
    admit: async () => f.context.admission, engineOptions: f.context,
  });
  t.after(() => installed.dispose());
  await installed.ready;
  const tool = registered.get('generate_image');
  assert.ok(tool);
  return {
    execute: () => tool.execute({ prompt: f.request.prompt }, {
      agent: { session: { id: f.context.sessionId } }, signal: f.context.signal, callId: 'release-cleanup-fixture',
    }),
    get releases() { return releases; },
  };
}

test('image tool preserves cleanup_failed when its second unsent release fails', {
  skip: process.platform !== 'linux' || process.geteuid?.() === 0 ? 'requires ordinary Linux UID permissions' : false,
}, async t => {
  const f = await fixture(t);
  const tool = await imageTool(t, f);
  let stage;
  f.context.resolveCredential = async () => {
    stage = await f.preparedStage();
    // Both real ledger access and real store cleanup fail at this shared parent.
    await chmod(f.directory, 0o000);
    return 'synthetic-not-a-real-key';
  };
  try {
    await assert.rejects(tool.execute(), { code: 'cleanup_failed' });
  } finally {
    await chmod(f.directory, 0o700);
  }
  assert.equal(tool.releases, 2, 'outer release is still attempted');
  assert.deepEqual(await readdir(stage), [], 'failed cleanup leaves the actual private directory');
  assert.equal((await f.ledger()).requests[0].state, 'reserved');
  assert.equal(f.creates, 0);
});

test('image tool keeps budget failure priority when store cleanup succeeds', async t => {
  const f = await fixture(t);
  const tool = await imageTool(t, f);
  f.context.resolveCredential = async () => {
    await f.preparedStage();
    await writeFile(f.ledgerPath, brokenLedger);
    return '';
  };
  await assert.rejects(tool.execute(), { code: 'budget' });
  assert.equal(tool.releases, 2);
  assert.deepEqual(await readdir(f.dateDirectory), []);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), brokenLedger);
  assert.equal(f.creates, 0);
});

test('image tool keeps the original failure when both unsent releases succeed', async t => {
  const f = await fixture(t);
  const tool = await imageTool(t, f);
  f.context.resolveCredential = async () => { await f.preparedStage(); return ''; };
  await assert.rejects(tool.execute(), { code: 'credential' });
  assert.equal(tool.releases, 2);
  assert.deepEqual(await readdir(f.dateDirectory), []);
  assert.equal((await f.ledger()).requests[0].state, 'released');
  assert.equal(f.creates, 0);
});
