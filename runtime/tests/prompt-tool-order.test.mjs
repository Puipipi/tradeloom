import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base, 'cordis/lib/index.js')));
const { SystemPrompt, TOOL_ORDER_REST: REST } = await import(pathToFileURL(join(base, 'dsh-system-prompt/lib/index.js')));
const { createScope } = await import(pathToFileURL(join(base, 'dsh-scope/lib/index.js')));
const schema = (name, description = name) => ({ name, description, parameters: { type: 'object', properties: {} } });
async function fixture(t, order, schemas, knownNames) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, { toolOrder: order });
  let current = { schemas, ...(knownNames === undefined ? {} : { knownNames }) };
  ctx.systemPrompt.tools(() => current);
  return { ctx, run: () => ctx.systemPrompt.assemble(), set: value => { current = value; } };
}
async function counted(run) {
  const original = Array.prototype.filter;
  let visits = 0;
  Array.prototype.filter = function(callback, thisArg) {
    const toolRows = this.length > 0 && typeof this[0]?.name === 'string' && this[0].name.startsWith('order-fixture-') && this[0].parameters !== undefined;
    return original.call(this, toolRows ? function(value, index, array) { visits++; return callback.call(this, value, index, array); } : callback, thisArg);
  };
  try { return { result: await run(), visits }; }
  finally { Array.prototype.filter = original; }
}

for (const count of [2, 200, 2000]) test(`public assemble orders ${count} explicit schemas without repeated full filtering`, async t => {
  const schemas = Array.from({ length: count }, (_, i) => schema(`order-fixture-${i}`));
  const order = [...schemas.map(x => x.name).reverse(), REST];
  const f = await fixture(t, order, schemas);
  const observed = await counted(f.run);
  assert.deepEqual(observed.result.tools.map(x => x.name), order.slice(0, -1));
  assert.deepEqual(schemas.map(x => x.name), [...order.slice(0, -1)].reverse());
  t.diagnostic(`schemas=${count} explicit=${count} filter-visits=${observed.visits}`);
  assert.equal(observed.visits, 0);
});

test('default, rest-only, empty and single explicit orders retain the original simple path', async t => {
  const schemas = ['z', 'a', 'b'].map(x => schema(`order-fixture-${x}`));
  for (const [order, expected, visits] of [
    [undefined, ['a', 'b', 'z'], 0],
    [[REST], ['a', 'b', 'z'], 3],
    [['order-fixture-z', REST], ['z', 'a', 'b'], 6],
    [[REST, 'order-fixture-a'], ['b', 'z', 'a'], 6],
  ]) {
    const f = await fixture(t, order, schemas);
    const observed = await counted(f.run);
    assert.deepEqual(observed.result.tools.map(x => x.name), expected.map(x => `order-fixture-${x}`));
    assert.equal(observed.visits, visits);
  }
  const f = await fixture(t, [REST], []);
  assert.deepEqual((await f.run()).tools, []);
});

test('duplicate schema names preserve provider order, rest position and detached parameters', async t => {
  const a = 'order-fixture-a', b = 'order-fixture-b', z = 'order-fixture-z';
  const first = schema(a, 'first'), second = schema(a, 'second');
  first.parameters.properties.key = { type: 'string' };
  const f = await fixture(t, [b, REST, a], [first, schema(z), second, schema(b)]);
  const result = await f.run();
  assert.deepEqual(result.tools.map(x => [x.name, x.description]), [[b, b], [z, z], [a, 'first'], [a, 'second']]);
  result.tools[2].parameters.properties.key.type = 'number';
  assert.equal(first.parameters.properties.key.type, 'string');
  f.set({ schemas: [schema(b), schema(a, 'replacement')] });
  assert.deepEqual((await f.run()).tools.map(x => x.description), [b, 'replacement']);
});

test('known but restricted tools stay absent; reserved and unknown errors keep precedence', async t => {
  const a = 'order-fixture-a', b = 'order-fixture-b';
  const f = await fixture(t, [a, REST, b], [schema(b)], [a, b]);
  assert.deepEqual((await f.run()).tools.map(x => x.name), [b]);
  f.set({ schemas: [schema(REST)], knownNames: [] });
  await assert.rejects(f.run(), /reserved tool name/);
  f.set({ schemas: [schema(b)] });
  await assert.rejects(f.run(), /toolOrder lists unregistered tool "order-fixture-a"/);
});

test('assembly waterfall controls text while tool declarations remain provider-owned', async t => {
  const a = 'order-fixture-a', b = 'order-fixture-b';
  const f = await fixture(t, [a, b, REST], [schema(b), schema(a)]);
  f.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const value = await next();
    assert.equal(value.tools, undefined);
    return { ...value, tools: [schema('not-a-provider-tool')], sections: [{ name: 'fixture', text: 'transformed' }] };
  });
  const result = await f.run();
  assert.deepEqual(result.tools.map(x => x.name), [a, b]);
  assert.deepEqual(result.sections, [{ name: 'fixture', text: 'transformed' }]);
});

test('scoped providers append same-name schemas without losing the global contribution', async t => {
  const a = 'order-fixture-a', b = 'order-fixture-b', key = {};
  const f = await fixture(t, [a, b, REST], [schema(a, 'global'), schema(b)]);
  await f.ctx.inject(['systemPrompt'], inner => {
    const scoped = createScope(inner, key);
    scoped.ctx.systemPrompt.tools(() => ({ schemas: [schema(a, 'scoped')] }));
  });
  assert.deepEqual((await f.ctx.systemPrompt.assemble({ scope: key })).tools.map(x => x.description), ['global', 'scoped', b]);
  assert.deepEqual((await f.run()).tools.map(x => x.description), ['global', b]);
});

test('duplicate configured toolOrder names still fail during construction', t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  assert.throws(() => new SystemPrompt(ctx, { toolOrder: ['same', 'same', REST] }), /more than once/);
});
