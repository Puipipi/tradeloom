import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
let serial = 0;

async function fixture(t, texts = ['alpha'], finalText = '') {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm',
    'dsh-tools', 'dsh-system-prompt', 'dsh-typert-registry', 'dsh-jobs-local']) {
    await ctx.plugin((await load(name)).default);
  }
  await ctx.plugin((await load('dsh-api-job-controller')).JobController, {
    observeFlushMs: 1, observeMaxFrameBytes: 5,
  });
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
  const owner = await ctx.agents.create({ sessionId: `job-follow-${++serial}` });
  ctx.jobs.attachController('fixture');
  const producerDone = Promise.withResolvers();
  let removed, cancels = 0;
  let id;
  ctx.jobs.events.subscribe({ owner: owner.agent.id }, event => {
    if (event.type === 'removed' && event.job.id === id) removed = event.job;
  });
  id = ctx.jobs.start({
    kind: 'fixture', label: 'fixture', owner: owner.agent.id,
    run(handle) {
      for (const text of texts) handle.append(text);
      return {
        done: producerDone.promise,
        cancel(reason) {
          cancels++;
          if (finalText) handle.append(finalText);
          producerDone.resolve({ status: 'killed', detail: reason });
        },
      };
    },
  });
  const abort = new AbortController();
  const iterator = ctx.jobController.follow({ jobId: id, sessionId: owner.agent.id }, abort.signal);
  t.after(() => iterator.return());
  return { ctx, owner, id, abort, iterator, removed: () => removed, cancels: () => cancels,
    async settle() {
      producerDone.resolve({ status: 'completed', result: 'producer-result' });
      return ctx.jobs.wait(id, 10000, owner.agent.id);
    },
  };
}

async function opened(f) {
  const step = await f.iterator.next();
  assert.equal(step.done, false);
  assert.equal(step.value.type, 'opened');
  assert.equal(step.value.job.id, f.id);
  return step.value;
}

test('owner removal during a yielded output frame ends with its terminal projection', async t => {
  const f = await fixture(t);
  await opened(f);
  const output = await f.iterator.next();
  assert.equal(output.value.type, 'output');
  assert.deepEqual(output.value.chunks, [{ at: 0, text: 'alpha' }]);
  await f.owner.dispose();
  assert.equal(f.abort.signal.aborted, false);
  assert.equal(f.cancels(), 1);
  assert.equal(f.ctx.jobs.list().length, 0);
  const status = await f.iterator.next();
  assert.deepEqual(status, { value: { type: 'status', job: f.removed() }, done: false });
  assert.equal(status.value.job.status, 'killed');
  assert.equal(status.value.job.detail, 'owner disposed');
  assert.deepEqual(await f.iterator.next(), { value: undefined, done: true });
});

test('removal drains the already-read frame snapshot without rereading a dropped record', async t => {
  const f = await fixture(t, ['alpha', 'βeta', 'gamma'], 'tail');
  await opened(f);
  const first = await f.iterator.next();
  assert.equal(first.value.type, 'output');
  assert.equal(first.value.next, 5);
  await f.owner.dispose();
  const remaining = [];
  for await (const value of f.iterator) remaining.push(value);
  assert.deepEqual(remaining.slice(0, 2), [
    { type: 'output', chunks: [{ at: 5, text: 'βeta' }], next: 10 },
    { type: 'output', chunks: [{ at: 10, text: 'gamma' }], next: 15 },
  ]);
  assert.deepEqual(remaining[2], { type: 'status', job: f.removed() });
  assert.equal(remaining.length, 3);
  assert.equal(f.removed().output.total, 19, 'teardown can append after the retained read snapshot');
});

test('removal while the opened anchor is yielded keeps the existing terminal path', async t => {
  const f = await fixture(t);
  await opened(f);
  await f.owner.dispose();
  assert.deepEqual(await f.iterator.next(), { value: { type: 'status', job: f.removed() }, done: false });
  assert.deepEqual(await f.iterator.next(), { value: undefined, done: true });
});

test('normal completed output remains non-consuming and includes one final status', async t => {
  const f = await fixture(t, ['alpha', 'βeta']);
  await f.settle();
  const frames = [];
  for await (const value of f.iterator) frames.push(value);
  assert.deepEqual(frames.map(value => value.type), ['opened', 'output', 'output', 'status']);
  assert.equal(frames.at(-1).job.status, 'completed');
  const modelRead = f.ctx.jobs.read(f.id, f.owner.agent.id);
  assert.equal(modelRead.chunks.map(value => value.text).join(''), 'alphaβeta');
  assert.equal(modelRead.result, 'producer-result');
  assert.equal(f.ctx.jobs.read(f.id, f.owner.agent.id).chunks.length, 0);
  assert.equal(f.cancels(), 0);
});

test('cancellation combined with owner removal ends without a deleted-record lookup', async t => {
  const f = await fixture(t);
  await opened(f);
  assert.equal((await f.iterator.next()).value.type, 'output');
  f.abort.abort(new Error('observer cancelled'));
  await f.owner.dispose();
  assert.deepEqual(await f.iterator.next(), { value: undefined, done: true });
});

test('cancelling the observer alone leaves its running producer and owner intact', async t => {
  const f = await fixture(t);
  await opened(f);
  assert.equal((await f.iterator.next()).value.type, 'output');
  f.abort.abort(new Error('observer cancelled'));
  assert.deepEqual(await f.iterator.next(), { value: undefined, done: true });
  assert.equal(f.ctx.jobs.get(f.id, f.owner.agent.id).status, 'running');
  assert.equal(f.cancels(), 0);
});

test('unknown, foreign, invalid-offset, and pre-aborted observations keep their errors', async t => {
  const f = await fixture(t);
  const foreign = await f.ctx.agents.create({ sessionId: `job-follow-${++serial}` });
  for (const [request, expected] of [
    [{ jobId: 'fixture-missing', sessionId: f.owner.agent.id }, /unknown job/],
    [{ jobId: f.id, sessionId: foreign.agent.id }, /belongs to another session/],
    [{ jobId: f.id, sessionId: f.owner.agent.id, from: -1 }, /invalid observe offset/],
  ]) {
    const iterator = f.ctx.jobController.follow(request, new AbortController().signal);
    await assert.rejects(iterator.next(), expected);
  }
  const reason = new Error('already aborted');
  const iterator = f.ctx.jobController.follow({ jobId: f.id, sessionId: f.owner.agent.id }, AbortSignal.abort(reason));
  await assert.rejects(iterator.next(), error => error === reason);
  assert.equal(f.ctx.jobs.get(f.id, f.owner.agent.id).status, 'running');
});

test('an explicit iterator return closes before later owner teardown', async t => {
  const f = await fixture(t);
  await opened(f);
  assert.equal((await f.iterator.next()).value.type, 'output');
  assert.deepEqual(await f.iterator.return(), { value: undefined, done: true });
  await f.owner.dispose();
  assert.deepEqual(await f.iterator.next(), { value: undefined, done: true });
});
