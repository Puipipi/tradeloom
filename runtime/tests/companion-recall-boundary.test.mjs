// C907 regressions: real marker I/O, real Cordis service lifetimes and the
// pinned direct provider. Only the model peer and explicit fixture seams are
// controlled; these tests do not boot Android or contact a model service.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as io from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTask } from 'node:timers/promises';
import { createRecallMarkers } from '../bridge/dsh-go-bridge/lib/companion/recall-markers.js';
import { createRecallContexts } from '../bridge/dsh-go-bridge/lib/companion/recall-context.js';
import * as fullContext from '../bridge/dsh-go-bridge/lib/companion/full-context.js';
import { createFixture, loadEngine } from './fixtures/companion-recall-engine.mjs';

test('a failed marker capability probe retries after storage recovery and shares in-flight work', async (t) => {
  const home = await io.mkdtemp(join(tmpdir(), 'c907-marker-retry-'));
  t.after(() => io.rm(home, { recursive: true, force: true }));
  let unavailable = true, links = 0;
  const markers = createRecallMarkers({ directory: home, io: { ...io,
    async link(...args) {
      links++;
      if (unavailable) throw new Error('Synthetic temporary storage failure');
      return io.link(...args);
    },
  } });
  assert.deepEqual(await Promise.all([markers.available(), markers.available(), markers.available()]), [false, false, false]);
  assert.equal(links, 1);
  unavailable = false;
  assert.equal(await markers.available(), true);
  assert.equal(links, 2);
  assert.equal(await markers.available(), true);
  assert.equal(links, 2, 'a successful probe stays cached; marker writes still have their own checks');
  assert.deepEqual(await io.readdir(home), []);
});

const integration = (name, body) => test(name, {
  skip: !process.env.DSH_PREFIX && 'Set DSH_PREFIX to the actual patched engine',
  concurrency: false, timeout: 15000,
}, body);

for (const operation of ['revoke', 'clear-memory']) {
  integration(`a queued ${operation} after physical admission prevents the actual provider POST`, async (t) => {
    const f = await createFixture();
    t.after(() => f.dispose());
    await f.saveMemory('C907_SYNTHETIC_PRIVATE_RECALL_SENTINEL');
    const { agent } = await f.createAgent(`C907-${operation}`);
    const binding = await f.bind(agent.id);
    const snapshot = await f.store.getSnapshot();
    const reached = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const read = f.store.getRecallContext;
    let reads = 0;
    f.store.getRecallContext = async () => {
      const value = await read();
      // One prepare, one logical admission, then the physical admission.
      if (++reads === 3) { reached.resolve(); await release.promise; }
      return value;
    };
    agent.followup(f.input('Synthetic owner message.'));
    await reached.promise;
    const mutation = operation === 'revoke'
      ? f.coordinator.revoke({ v: 1, operationId: randomUUID(), bindingId: binding.bindingId, reason: 'user-off' })
      : f.coordinator.mutateMemory('clearMemories', { storeId: snapshot.storeId, expectedRevision: snapshot.revision });
    // Queue through the real coordinator while its actual store read waits.
    // No mock of beforeFetch/admit and no artificial cancellation interception.
    release.resolve();
    await mutation;
    await agent.whenIdle();
    assert.equal(reads, 3);
    assert.equal((await f.coordinator.status(binding.bindingId)).status, 'retired');
    assert.equal(f.requests.length, 0, 'retired recall must not reach the physical fetch boundary');
  });
}

integration('a surviving full context re-registers with a replacement recall service', async (t) => {
  const engine = await loadEngine(), ctx = new engine.cordis.Context();
  t.after(() => ctx.fiber.dispose());
  const scope = {}, sections = [], promptContexts = [];
  const prompt = {
    section: value => { sections.push(value); }, context: value => { promptContexts.push(value); },
    getSectionOrder: () => 100, getContextOrder: () => 100,
  };
  ctx.provide('systemPrompt', prompt);
  const raw = value => value?.[engine.cordis.symbols.original] ?? value;
  const current = registry => registry.current([scope], () => scope, prompt, raw);
  const first = createRecallContexts();
  const removeFirst = ctx.provide('dshGoCompanionRecall', { registerContext: first.registerContext });
  const fiber = ctx.plugin(fullContext);
  await fiber;
  for (let n = 0; n < 20 && !current(first); n++) await nextTask();
  assert(current(first));
  const initialSections = sections.length, initialContexts = promptContexts.length;
  await removeFirst();
  first.dispose();
  assert.equal(fiber.state, 2, 'ordinary full-mode context remains mounted during bridge replacement');
  const successor = createRecallContexts();
  const removeSuccessor = ctx.provide('dshGoCompanionRecall', { registerContext: successor.registerContext });
  for (let n = 0; n < 20 && !current(successor); n++) await nextTask();
  assert(current(successor), 'new coordinator must see the surviving actual context');
  assert.equal(sections.length, initialSections, 'service recovery must not duplicate persona sections');
  assert.equal(promptContexts.length, initialContexts);
  await removeFirst();
  assert(current(successor), 'late old service disposal cannot unregister the new mount');
  await removeSuccessor();
  assert.equal(current(successor), undefined);
});
