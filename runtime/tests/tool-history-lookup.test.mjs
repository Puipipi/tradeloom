import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = process.env.DSH_PREFIX;
if (!prefix) throw Error('Set DSH_PREFIX to the b4-patched rc.4 runtime');
const require = createRequire(resolve(prefix, 'package.json'));
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const { createDeveloperMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const tools = n => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } }));
function setup(definitions, addedNames = definitions.map(x => x.name)) {
  const s = Session.create('tool-history-lookup');
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' }, ...(definitions.some(x => !addedNames.includes(x.name)) ? { tools: definitions.filter(x => !addedNames.includes(x.name)) } : {}) } });
  s.toolHistory();
  const headerSeq = s.append('request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm' }, ...(definitions.length ? { tools: definitions } : {}) } }).seq;
  s.toolHistory();
  return { s, headerSeq };
}
function message(s, headerSeq, blocks) {
  const m = createDeveloperMessage({ source: { kind: 'tool-registry' }, content: blocks });
  s.append('developer/message', { turn: 0, step: 1, message: m, ...(blocks.some(x => x.type === 'tool-addition') ? { headerSeq } : {}) }, { surfaceOp: 'append' });
  return m;
}
const additions = names => names.map(toolName => ({ type: 'tool-addition', toolName }));
function comparisons(t, action) {
  const original = Array.prototype.find;
  let comparisons = 0;
  Array.prototype.find = function(predicate, thisArg) {
    return Reflect.apply(original, this, [function(value, index, array) { comparisons++; return Reflect.apply(predicate, thisArg, [value, index, array]); }]);
  };
  let value;
  try { value = action(); } finally { Array.prototype.find = original; }
  return { value, comparisons };
}

test('one message resolves many additions without repeated linear searches', t => {
  const defs = tools(64), names = defs.map(x => x.name);
  const { s, headerSeq } = setup(defs);
  const m = message(s, headerSeq, additions(names));
  const result = comparisons(t, () => s.toolHistory());
  assert.deepEqual(result.value.updates.at(-1), { messageId: m.id, additions: defs });
  assert.equal(result.comparisons, 0, 'multi-addition lookup no longer repeats Array.find predicates');
});

test('single first/last addition and text/removal-only keep exact history', t => {
  for (const name of ['tool_0', 'tool_63']) {
    const defs = tools(64), { s, headerSeq } = setup(defs, [name]);
    const m = message(s, headerSeq, [{ type: 'text', text: 'context' }, ...additions([name])]);
    const result = comparisons(t, () => s.toolHistory());
    assert.deepEqual(result.value.updates.at(-1), { messageId: m.id, additions: [defs.find(x => x.name === name)] });
    assert.equal(result.comparisons, name === 'tool_0' ? 1 : 64);
    message(s, headerSeq, [{ type: 'text', text: 'context' }, { type: 'tool-removal', toolName: name }]);
    const removal = comparisons(t, () => s.toolHistory());
    assert.equal(removal.comparisons, 0);
    assert.deepEqual(removal.value.tools, defs); // existing fallback while active/available disagree.
  }
});

test('repeated additions preserve content order and do not mutate prior snapshots', () => {
  const defs = tools(3), { s, headerSeq } = setup(defs);
  message(s, headerSeq, additions(['tool_2','tool_0','tool_2','tool_1']));
  const first = s.toolHistory();
  assert.deepEqual(first.updates.at(-1).additions, [defs[2],defs[0],defs[2],defs[1]]);
  message(s, headerSeq, additions(['tool_0']));
  const second = s.toolHistory();
  assert.equal(first.updates.length, 1);
  assert.equal(second.updates.length, 2);
  assert.ok(Object.isFrozen(first.updates[0].additions));
});

test('historical headers retain their own definitions across later replacement', () => {
  const defs = tools(2), { s, headerSeq } = setup(defs);
  message(s, headerSeq, additions(defs.map(x => x.name)));
  s.toolHistory();
  const changed = defs.map(x => ({ ...x, description: 'replacement' }));
  s.append('request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm' }, tools: changed } });
  s.toolHistory();
  message(s, headerSeq, additions(['tool_1']));
  assert.equal(s.toolHistory().updates.at(-1).additions[0].description, 'Tool 1');
});

test('missing and duplicate definitions are rejected by real Session admission', () => {
  for (const defs of [[], [...tools(1), ...tools(1)]]) {
    const { s, headerSeq } = setup(defs);
    const seq = s.seq, before = s.toolHistory();
    assert.throws(() => message(s, headerSeq, additions(['tool_0'])), /exactly one tool/);
    assert.equal(s.seq, seq);
    assert.deepEqual(s.toolHistory(), before);
  }
});

test('restored multiple messages and empty content retain the same fold', () => {
  const defs = tools(4), { s, headerSeq } = setup(defs);
  message(s, headerSeq, additions(['tool_0','tool_1']));
  message(s, headerSeq, additions(['tool_3','tool_2']));
  message(s, headerSeq, []);
  const expected = s.toolHistory();
  const restored = Session.fromRestore(s.id, JSON.parse(JSON.stringify(s.snapshotEvents())), JSON.parse(JSON.stringify(s.header)), 0, 'detached');
  assert.deepEqual(restored.toolHistory(), expected);
  assert.equal(expected.updates.length, 3);
  assert.deepEqual(expected.updates.at(-1).additions, []);
});
