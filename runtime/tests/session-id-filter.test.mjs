import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, createCorpus, filtersFor, countIncludes } from '../tools/session-id-fixture.mjs';
const api = await load(process.env.DSH_PREFIX);
const idsOf = rows => rows.map(row => row.header.id);
const f = createCorpus(api, 128);
const all = await f.query.listSessions();
function expected(filters) {
  return all.filter(row => filters[0].values.includes(row.header.id) && row.header.cwd === '/workspace');
}
test('real filterSessions multi-id removes repeated includes while preserving cwd authorization and newest order', async () => {
  const filters = filtersFor(f.ids, 64);
  const result = await countIncludes(() => f.query.filterSessions(filters));
  assert.deepEqual(result.value, expected(filters));
  assert.equal(result.value.some(row => row.header.cwd !== '/workspace'), false);
  assert.equal(result.calls, 0, 'old multi-id Array.includes calls, not total comparisons');
});
test('public pure filter retains duplicate IDs, record identity and input order', () => {
  const rows = all.slice(0, 8).reverse();
  const filters = [{ kind: 'id', values: [rows[0].header.id, rows[0].header.id, rows[3].header.id] }];
  const result = api.filterSessionResults(rows, filters);
  assert.deepEqual(result, [rows[0], rows[3]]);
  assert.equal(result[0], rows[0]); assert.equal(result[1], rows[3]);
  assert.equal(rows.length, 8); assert.equal(filters[0].values.length, 3);
});
test('empty and single ID controls, no filters and empty records preserve results', async () => {
  for (const values of [[], [f.ids[1]], ['missing']]) {
    const filters = [{ kind: 'id', values }];
    assert.deepEqual(idsOf(await f.query.filterSessions(filters)), idsOf(all.filter(row => values.includes(row.header.id))));
  }
  assert.deepEqual(await f.query.filterSessions([]), all);
  assert.deepEqual(api.filterSessionResults([], filtersFor(f.ids, 64)), []);
});
test('caller mutation affects a later pure call, never a cross-call ID cache', () => {
  const values = [f.ids[1], f.ids[2]];
  const first = api.filterSessionResults(all, [{ kind: 'id', values }]);
  values.splice(0, 2, f.ids[3], f.ids[4]);
  const second = api.filterSessionResults(all, [{ kind: 'id', values }]);
  assert.deepEqual(idsOf(first), [f.ids[2], f.ids[1]]);
  assert.deepEqual(idsOf(second), [f.ids[4], f.ids[3]]);
});
test('Engine materializes before its corpus await and later calls observe fresh input', async () => {
  const filters = [{ kind: 'id', values: [f.ids[1], f.ids[2]] }];
  const pending = f.query.filterSessions(filters);
  filters[0].values.splice(0, 2, f.ids[3], f.ids[4]);
  assert.deepEqual(idsOf(await pending), [f.ids[2], f.ids[1]]);
  assert.deepEqual(idsOf(await f.query.filterSessions(filters)), [f.ids[4], f.ids[3]]);
});
test('unknown filters, invalid values, cancellation and other clauses keep admission', async () => {
  await assert.rejects(f.query.filterSessions([{ kind: 'unknown' }]), /unknown filter/);
  await assert.rejects(f.query.filterSessions([{ kind: 'id', values: [1] }]), /array of strings/);
  const c = new AbortController(); const reason = new Error('cancel fixture'); c.abort(reason);
  await assert.rejects(f.query.filterSessions(filtersFor(f.ids, 64), c.signal), error => error === reason);
  assert.deepEqual(await f.query.filterSessions([{ kind: 'parent', values: [null] }, { kind: 'availability', values: ['live'] }]), all);
  assert.equal(api.filterSessionResults(all, [{ kind: 'created-at', from: 1000, to: 1002 }]).length, 3);
});
test.after(async () => { await f.ctx.fiber.dispose(); });
