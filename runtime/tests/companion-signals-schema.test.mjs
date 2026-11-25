import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { projectRunResult } from '../bridge/dsh-go-bridge/lib/companion/signals-schema.js';

const generation = 'c7600000-0000-4000-8000-000000000001';
const record = () => ({ source: { sessionId: 'session', turn: 1, step: 1, callId: 'call', seq: 5 },
  metadata: { v: 1, runId: 'call', runKind: 'test', result: 'succeeded', exitCode: 0,
    durationMs: 50, passed: null, failed: null, skipped: null } });

test('private fact projection copies only the fixed metadata fields and has stable committed-result identity', () => {
  const input = record(), first = projectRunResult(input, generation), same = projectRunResult(record(), generation);
  assert(first); assert.equal(first.id, same.id); assert.equal(first.id.length, 43);
  input.source.callId = 'later'; input.metadata.result = 'failed';
  assert.equal(first.source.callId, 'call'); assert.equal(first.payload.result, 'succeeded');
  const next = record(); next.source.seq++;
  assert.notEqual(projectRunResult(next, generation).id, first.id);
  assert(Object.isFrozen(first.source)); assert(Object.isFrozen(first.payload));
});

test('schema rejects expanded bodies, untrusted counts, invalid enums and contradictory exit outcomes', () => {
  const changes = [
    (v) => { v.body = 'PRIVATE_BODY'; }, (v) => { v.source.title = 'PRIVATE_TITLE'; },
    (v) => { v.metadata.stdout = 'PRIVATE_STDOUT'; }, (v) => { v.metadata.v = 2; },
    (v) => { v.metadata.passed = 12; }, (v) => { v.metadata.runId = 'another-call'; },
    (v) => { v.metadata.runKind = 'unknown'; }, (v) => { v.metadata.result = 'pass'; },
    (v) => { v.metadata.exitCode = 1; }, (v) => { v.metadata.result = 'failed'; },
    (v) => { v.metadata.result = 'failed'; v.metadata.exitCode = null; },
    (v) => { v.metadata.runKind = 'command'; },
    (v) => { v.metadata.runKind = 'command'; v.metadata.result = 'failed'; v.metadata.exitCode = 1; },
    (v) => { v.metadata.durationMs = -1; }, (v) => { v.metadata.durationMs = 604800001; },
    (v) => { v.metadata.exitCode = 2147483648; }, (v) => { v.source.seq = -1; },
    (v) => { v.source.turn = 0; }, (v) => { v.source.step = 0; }, (v) => { v.source.seq = NaN; },
    (v) => { v.source.seq = Number.MAX_SAFE_INTEGER + 1; }, (v) => { v.source.turn = 1.5; },
  ];
  for (const change of changes) { const value = record(); change(value); assert.equal(projectRunResult(value, generation), null); }
});

test('IDs agree with the Dart boundary, UTF-8 lengths and whole-envelope byte budget', () => {
  for (const id of ['', 'a'.repeat(257), '界'.repeat(86), '\n', '\u0000', '\u007f', '\u0085', '\ud800', '\udfff']) {
    const value = record(); value.source.sessionId = id; assert.equal(projectRunResult(value, generation), null);
  }
  const unicode = record(); unicode.source.sessionId = '😀合法'; assert(projectRunResult(unicode, generation));
  const excessive = record(); excessive.source.sessionId = 's'.repeat(256);
  excessive.source.callId = excessive.metadata.runId = 'c'.repeat(256);
  assert.equal(projectRunResult(excessive, generation), null, 'Individually bounded IDs may still exceed the whole envelope');
  for (const invalid of ['', 'not-a-generation', generation.toUpperCase()]) assert.equal(projectRunResult(record(), invalid), null);
});

test('server and Dart decoder share the same fixed wire-schema acceptance fixture', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../packages/dsh_client/test/fixtures/companion_signal_results.json', import.meta.url), 'utf8'));
  assert.equal(fixture.v, 1);
  for (const { name, valid, source, metadata } of fixture.cases) {
    assert.equal(projectRunResult({ source, metadata }, fixture.generation) !== null, valid, name);
  }
});
