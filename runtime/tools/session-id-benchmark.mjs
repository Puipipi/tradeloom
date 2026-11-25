import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { load, createCorpus, filtersFor } from './session-id-fixture.mjs';
const [prefix, label, scenario, phase] = process.argv.slice(2);
const cases = { tiny:[8,2], medium:[1000,32], large:[5000,128], many:[5000,512], single:[5000,1], 'empty-ids':[5000,0], 'empty-rows':[0,512] };
const [count, idCount] = cases[scenario];
assert(['query','pure'].includes(phase));
const api = await load(prefix); const f = createCorpus(api, count);
const records = await f.query.listSessions(); const filters = filtersFor(f.ids, idCount);
const wanted = new Set(filters[0].values);
const expected = records.filter(row => wanted.has(row.header.id) && row.header.cwd === '/workspace');
const expectedIds = expected.map(row => row.header.id);
const iterations = count < 20 ? (phase === 'pure' ? 2000 : 200) : (phase === 'pure' ? 32 : 8);
try {
  for (let sample = -3; sample < 9; sample++) {
    let result; const begin = performance.now();
    if (phase === 'query') {
      for (let i=0; i<iterations; i++) result = await f.query.filterSessions(filters);
    } else {
      for (let i=0; i<iterations; i++) result = api.filterSessionResults(records, filters);
    }
    const elapsedMs = (performance.now() - begin) / iterations;
    assert.deepEqual(result.map(row => row.header.id), expectedIds);
    assert(result.every(row => row.header.cwd === '/workspace'));
    if (phase === 'pure') for (let i=0; i<result.length; i++) assert.equal(result[i], expected[i]);
    if (sample >= 0) console.log(JSON.stringify({label,scenario,phase,sample,count,idCount,iterations,elapsedMs,matched:result.length}));
  }
} finally { await f.ctx.fiber.dispose(); }
