import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.env.DSH_PREFIX, 'package.json'));
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const { foldSurface } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session/surface')));
const { createDeveloperMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const tools = n => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object' } }));
const additions = names => names.map(toolName => ({ type: 'tool-addition', toolName }));
function setup(definitions) {
  const s = Session.create('developer-header-cost');
  const headerSeq = s.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' }, ...(definitions.length ? { tools: definitions } : {}) } }).seq;
  return { s, headerSeq };
}
function data(headerSeq, names) {
  return { turn: 0, step: 1, message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: additions(names) }), ...(names.length ? { headerSeq } : {}) };
}
function append(s, headerSeq, names) { return s.append('developer/message', data(headerSeq, names), { surfaceOp: 'append' }); }
function filterCalls(action) {
  const original = Array.prototype.filter;
  let calls = 0;
  Array.prototype.filter = function(predicate, thisArg) {
    if (this[0]?.name !== 'tool_0') return Reflect.apply(original, this, [predicate, thisArg]);
    return Reflect.apply(original, this, [function(value, index, array) { calls++; return Reflect.apply(predicate, thisArg, [value, index, array]); }]);
  };
  try { return { value: action(), calls }; } finally { Array.prototype.filter = original; }
}
for (const entry of ['session', 'surface']) test(`${entry}: multiple additions eliminate repeated tool-filter predicates`, () => {
  const defs = tools(64), { s, headerSeq } = setup(defs), names = defs.map(t => t.name);
  let result;
  if (entry === 'session') result = filterCalls(() => append(s, headerSeq, names));
  else { append(s, headerSeq, names); result = filterCalls(() => foldSurface(s.snapshotEvents())); }
  assert.equal(result.calls, 0, 'count is old filter predicate calls, not all candidate comparisons');
  assert.deepEqual(s.toolHistory().updates.at(-1).additions, defs);
  assert.equal(s.seq, 2);
});
test('zero and single additions retain original filter count and surface', () => {
  for (const names of [[], ['tool_0'], ['tool_63']]) {
    const { s, headerSeq } = setup(tools(64));
    const observed = filterCalls(() => append(s, headerSeq, names));
    assert.equal(observed.calls, names.length ? 64 : 0);
    assert.deepEqual(s.toolHistory().updates.at(-1).additions.map(t => t.name), names);
    const replay = filterCalls(() => foldSurface(s.snapshotEvents()));
    assert.equal(replay.calls, names.length ? 64 : 0);
  }
});
test('repeated names and historical headers preserve exact admission and restore', () => {
  const defs = tools(3), { s, headerSeq } = setup(defs);
  append(s, headerSeq, ['tool_2', 'tool_0', 'tool_2']);
  s.append('request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm' }, tools: defs.map(t => ({ ...t, description: 'new' })) } });
  append(s, headerSeq, ['tool_1', 'tool_0']);
  const events = JSON.parse(JSON.stringify(s.snapshotEvents()));
  const restored = Session.fromRestore(s.id, events, JSON.parse(JSON.stringify(s.header)), 0, 'detached');
  assert.deepEqual(restored.toolHistory(), s.toolHistory());
  assert.equal(s.toolHistory().updates.at(-1).additions[0].description, 'Tool 1');
  assert.deepEqual(foldSurface(events).nodes, [1, 3]);
});
function rejected(defs, names, pattern) {
  const { s, headerSeq } = setup(defs), before = JSON.stringify(s.snapshotEvents()), seq = s.seq;
  const candidate = { seq: s.seq, timestamp: 0, type: 'developer/message', data: data(headerSeq, names), surfaceOp: 'append' };
  assert.throws(() => s.append(candidate.type, candidate.data, { surfaceOp: 'append' }), pattern);
  assert.equal(s.seq, seq);
  assert.equal(JSON.stringify(s.snapshotEvents()), before);
  assert.throws(() => foldSurface([...s.snapshotEvents(), candidate]), pattern);
}
test('missing and duplicate definitions reject the first referenced invalid name', () => {
  rejected([...tools(2), { ...tools(1)[0] }], ['tool_1', 'tool_0', 'missing'], /tool-addition "tool_0" must name exactly one/);
  rejected(tools(2), ['missing', 'tool_0'], /tool-addition "missing" must name exactly one/);
  rejected([], ['tool_0', 'tool_1'], /tool-addition "tool_0" must name exactly one/);
});
test('complete definition error precedes later missing name', () => {
  const defs = tools(2); delete defs[0].description;
  rejected(defs, ['tool_0', 'missing'], /tool-addition "tool_0" requires a complete tool definition/);
  defs[0].description = 'ok'; defs[0].parameters = [];
  rejected(defs, ['tool_0', 'missing'], /requires a complete tool definition/);
});
test('deferLoading stays true-only and unused incomplete definitions stay unexamined', () => {
  const defs = tools(3); defs[0].deferLoading = false;
  rejected(defs, ['tool_0', 'missing'], /deferLoading must be true/);
  defs[0].deferLoading = true; delete defs[2].description;
  const { s, headerSeq } = setup(defs);
  append(s, headerSeq, ['tool_0', 'tool_1']);
  assert.deepEqual(foldSurface(s.snapshotEvents()).nodes, [1]);
});
test('public surface revalidates changed header between independent calls', () => {
  const { s, headerSeq } = setup(tools(2)); append(s, headerSeq, ['tool_0', 'tool_1']);
  const events = JSON.parse(JSON.stringify(s.snapshotEvents()));
  assert.deepEqual(foldSurface(events).nodes, [1]);
  events[0].data.header.tools.push({ ...events[0].data.header.tools[0] });
  assert.throws(() => foldSurface(events), /tool-addition "tool_0" must name exactly one/);
});
test('public surface retains filter semantics for sparse definition arrays', () => {
  const { s, headerSeq } = setup(tools(3)); append(s, headerSeq, ['tool_0', 'tool_1']);
  const events = JSON.parse(JSON.stringify(s.snapshotEvents()));
  delete events[0].data.header.tools[2];
  assert.deepEqual(foldSurface(events).nodes, [1]);
});
