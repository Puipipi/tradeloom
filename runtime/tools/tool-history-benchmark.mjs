// Real Session admission and toolHistory; preparation/oracles excluded from measured intervals.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const [prefix, label, scenario, phase] = process.argv.slice(2);
const require = createRequire(resolve(prefix, 'package.json'));
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const { createDeveloperMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const n = scenario === 'tiny' ? 1 : 128;
const definitions = Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`,
  parameters: { type: 'object', properties: { value: { type: 'string' } } } }));
const names = scenario === 'none' ? [] : scenario === 'first' || scenario === 'tiny' ? ['tool_0'] : scenario === 'last' ? [`tool_${n-1}`] : definitions.map(x => x.name);
if (scenario === 'reverse') names.reverse();
const initial = definitions.filter(x => !names.includes(x.name));
const blocks = names.length ? names.map(toolName => ({ type: 'tool-addition', toolName })) : [{ type: 'text', text: 'metadata' }];
function prepare() {
  const s = Session.create('benchmark');
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' }, ...(initial.length ? { tools: initial } : {}) } });
  s.toolHistory();
  const headerSeq = s.append('request/header', { reason: 'change', header: { config: { provider: 'p', model: 'm' }, tools: definitions } }).seq;
  s.toolHistory();
  const message = createDeveloperMessage({ source: { kind: 'tool-registry' }, content: blocks });
  const data = { turn: 0, step: 1, message, ...(names.length ? { headerSeq } : {}) };
  if (phase === 'fold') s.append('developer/message', data, { surfaceOp: 'append' });
  return { s, data, message, result: undefined };
}
function run(entry) {
  if (phase === 'full') entry.s.append('developer/message', entry.data, { surfaceOp: 'append' });
  entry.result = entry.s.toolHistory();
}
function oracle(entry) {
  assert.equal(entry.s.seq, 3);
  assert.deepEqual(entry.result.tools, initial);
  assert.equal(entry.result.updates.length, 1);
  assert.equal(entry.result.updates[0].messageId, entry.message.id);
  assert.deepEqual(entry.result.updates[0].additions.map(x => x.name), names);
  assert.deepEqual(entry.result.updates[0].additions, names.map(name => definitions.find(x => x.name === name)));
  assert.ok(Object.isFrozen(entry.result.updates[0].additions));
  assert.equal(entry.s.toolHistory(), entry.result);
}
const batch = scenario === 'tiny' ? 200 : 50;
for (let sample = -3; sample < 9; sample++) {
  const entries = Array.from({ length: batch }, prepare);
  const start = performance.now();
  for (const entry of entries) run(entry);
  const elapsedMs = performance.now() - start;
  for (const entry of entries) oracle(entry);
  if (sample >= 0) console.log(JSON.stringify({ label, scenario, phase, definitions: n, additions: names.length,
    sample, batch, elapsedMs, usPerOperation: elapsedMs * 1000 / batch }));
}
