import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecallContexts } from '../bridge/dsh-go-bridge/lib/companion/recall-context.js';
import { apply as applyFullContext } from '../bridge/dsh-go-bridge/lib/companion/full-context.js';

test('a late old disposer cannot remove a successor in the same actual scope', () => {
  const registry = createRecallContexts(), scope = {}, systemPrompt = {};
  const ctx = { fiber: { state: 2, uid: 1 }, get: () => systemPrompt };
  const current = (owner = systemPrompt) => registry.current([scope], () => scope, owner, (value) => value);
  const oldDispose = registry.registerContext(ctx), old = current();
  assert(old);
  oldDispose();
  const newDispose = registry.registerContext(ctx), next = current();
  assert(next && next !== old);
  oldDispose();
  assert.equal(current(), next);
  assert.equal(current({}), undefined, 'a different actual prompt service is not this mount');
  newDispose();
  assert.equal(current(), undefined);
});

test('registry retirement and a non-live fiber cannot authorize another mount', () => {
  const registry = createRecallContexts(), scope = {}, owner = {};
  const ctx = { fiber: { state: 1, uid: 7 }, get: () => owner };
  registry.registerContext(ctx);
  const current = () => registry.current([scope], () => scope, owner, (value) => value);
  assert.equal(current(), undefined);
  ctx.fiber.state = 2;
  assert(current());
  registry.dispose();
  registry.registerContext(ctx);
  assert.equal(current(), undefined);
});

test('the existing full context still mounts without an available recall service', () => {
  const sections = [], contexts = [];
  applyFullContext({
    get: () => undefined,
    systemPrompt: {
      section: (value) => sections.push(value), context: (value) => contexts.push(value),
      getSectionOrder: () => 100, getContextOrder: () => 100,
    },
  });
  assert.deepEqual(sections.map(section => section.name), [
    'deployment:persona-prefix', 'deployment:persona-suffix', 'app:web-surface',
  ]);
  assert(sections[0].text().includes('鲸鱼女孩'));
  assert(sections[1].text.includes('应用固定规则'));
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, 'app:web-surface');
});
