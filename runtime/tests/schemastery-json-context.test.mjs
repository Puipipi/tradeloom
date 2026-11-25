// Real fixed rc4 Schemastery; no replacement of production serialization methods.
// DSH_PREFIX=/path/to/b4-patched-prefix node --test runtime/tests/schemastery-json-context.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPluginConfig } from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import { withSources } from './plugin-config-source-fixture.mjs';

assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX must select the fixed package tree');
const directory = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai/schemastery');
assert.equal(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version, '3.19.0');
const { default: esm } = await import(pathToFileURL(join(directory, 'lib/index.mjs')));
const cjs = createRequire(import.meta.url)(join(directory, 'lib/index.cjs'));
const modules = [['ESM', esm], ['CJS', cjs]];

function isolate(t) {
  globalThis.__schemastery_refs__ = undefined;
  t.after(() => { globalThis.__schemastery_refs__ = undefined; });
}
function cyclicSchema(z) {
  const cycle = {};
  cycle.self = cycle;
  return z.string().extra('cycle', cycle);
}
function graphOf(schema) {
  const graph = schema.toJSON();
  assert.equal(typeof graph, 'object', 'a fresh root must return a graph, not a stale nested UID');
  assert.equal(graph.uid, schema.uid);
  assert.ok(graph.refs && Object.hasOwn(graph.refs, schema.uid));
  return graph;
}

for (const [name, z] of modules) {
  test(`${name}: cyclic metadata failure does not poison the next healthy root`, t => {
    isolate(t);
    assert.throws(() => cyclicSchema(z).toJSON(), TypeError);
    const healthy = z.object({ visible: z.string() });
    const graph = graphOf(healthy);
    assert.equal(graph.refs[graph.uid].type, 'object');
    assert.equal(graph.refs[graph.refs[graph.uid].dict.visible].type, 'string');
    assert.equal(globalThis.__schemastery_refs__, undefined);
  });

  test(`${name}: nested cyclic schema unwinds the owning root context`, t => {
    isolate(t);
    const root = z.object({ broken: cyclicSchema(z), after: z.number() });
    assert.throws(() => root.toJSON(), TypeError);
    assert.equal(globalThis.__schemastery_refs__, undefined);
    graphOf(z.object({ healthy: z.boolean() }));
  });

  test(`${name}: metadata serialization preserves the exact thrown error`, t => {
    isolate(t);
    const sentinel = new Error('SYNTHETIC_METADATA_FAILURE');
    const schema = z.string().extra('sample', { toJSON() { throw sentinel; } });
    let caught;
    try { schema.toJSON(); } catch (error) { caught = error; }
    assert.equal(caught, sentinel);
    assert.equal(globalThis.__schemastery_refs__, undefined);
    graphOf(z.string());
  });

  test(`${name}: successful shared nodes keep their original UID graph`, t => {
    isolate(t);
    const shared = z.string();
    const root = z.object({ first: shared, second: shared });
    const graph = graphOf(root);
    assert.deepEqual(graph.refs[root.uid].dict, { first: shared.uid, second: shared.uid });
    assert.equal(graph.refs[shared.uid].type, 'string');
    assert.deepEqual(Object.keys(graph.refs).sort(), [String(root.uid), String(shared.uid)].sort());
    assert.equal(globalThis.__schemastery_refs__, undefined);
  });
}

for (const [name, outer, inner] of [['ESM/CJS', esm, cjs], ['CJS/ESM', cjs, esm]]) {
  test(`${name}: mixed-module nested graphs keep the outer owner and shared nodes`, t => {
    isolate(t);
    const shared = inner.string();
    const child = inner.object({ first: shared, second: shared });
    const local = outer.number();
    const root = outer.object({ child, local });
    const graph = graphOf(root);
    assert.deepEqual(graph.refs[root.uid].dict, { child: child.uid, local: local.uid });
    assert.deepEqual(graph.refs[child.uid].dict, { first: shared.uid, second: shared.uid });
    assert.equal(graph.refs[shared.uid].type, 'string');
    assert.equal(graph.refs[local.uid].type, 'number');
    assert.equal(Object.keys(graph.refs).length, 4);
    assert.equal(globalThis.__schemastery_refs__, undefined);
  });

  test(`${name}: caught nested failure does not retire the still-running outer context`, t => {
    isolate(t);
    const broken = cyclicSchema(inner);
    const sentinelValue = 'handled';
    const root = outer.string().extra('probe', {
      toJSON() {
        const owner = globalThis.__schemastery_refs__;
        assert.throws(() => broken.toJSON(), TypeError);
        assert.equal(globalThis.__schemastery_refs__, owner, 'nested call must not clear the parent-owned graph');
        return sentinelValue;
      },
    });
    const graph = graphOf(root);
    assert.equal(graph.refs[root.uid].meta.probe, sentinelValue);
    assert.equal(globalThis.__schemastery_refs__, undefined);
  });
}

for (const [name, z] of modules) {
  test(`${name}: plugin-config isolates a broken plugin and still reads a healthy plugin`, async t => {
    isolate(t);
    const broken = z.object({ visible: cyclicSchema(z) });
    const healthy = z.object({ visible: z.string() });
    const entries = [['broken', broken], ['healthy', healthy]].map(([id, schema]) => ({
      options: { id, name: 'fixture-plugin', config: { visible: id } },
      fiber: { state: 2, runtime: { Config: schema, callback() {} }, config: { visible: id } },
    }));
    const editor = {
      canWrite: () => true,
      entries: () => entries,
      configuration: () => entries.map(entry => ({ entry, inherited: {}, override: entry.options.config })),
    };
    const ctx = { get: key => key === 'configEditor' ? editor : key === 'loader' ? { entries: () => entries } : undefined };
    withSources(ctx, entries);
    let response;
    const api = createPluginConfig(ctx, {
      send(_res, status, body) { response = { status, body }; },
      readBody() { throw Error('GET only'); },
    });
    await api.handle({ method: 'GET' }, {}, '/dsh-go/v1/plugin-config/broken');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'entry-unavailable');
    // No test-side cleanup between the failed and successful public operations.
    await api.handle({ method: 'GET' }, {}, '/dsh-go/v1/plugin-config/healthy');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.value, { visible: 'healthy' });
    assert.ok(response.body.schema.refs);
    assert.equal(globalThis.__schemastery_refs__, undefined);
  });
}
