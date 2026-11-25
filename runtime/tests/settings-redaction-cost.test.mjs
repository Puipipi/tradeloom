import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const { boot } = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')));
const { SettingsForms } = await import(pathToFileURL(join(base, 'dsh-settings/lib/index.js')));
const { ConfigEditor } = await import(pathToFileURL(join(base, 'dsh-config-editor/lib/index.js')));

async function fixture(t, count, rootSecret = false) {
  const root = await mkdtemp(join(tmpdir(), 'settings-redaction-cost-'));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, 'home'), dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  const patchPath = join(dir, 'cordis.patch.yml'), main = join(dir, 'cordis.yml');
  const module = pathToFileURL(join(dir, 'fixture.mjs')).href;
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'settings-fixture', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  await writeFile(main, '[]\n');
  await writeFile(new URL(module), `import z from ${JSON.stringify(pathToFileURL(join(base, 'schemastery/lib/index.mjs')).href)};
export const Config = z.object({
  records: z.array(z.object({ label: z.string(), token: z.string().role('secret').default('synthetic-row-default-574') })).default([])${rootSecret ? '' : '.volatile()'},
  credential: z.string().role('secret').default('synthetic-default-574')${rootSecret ? '' : '.volatile()'},
  mode: z.string().default('normal')${rootSecret ? '' : '.volatile()'},
  ordinary: z.string().default('ordinary-preserved'),
})${rootSecret ? ".volatile().role('secret')" : ''};
export function apply() {}
`);
  const inherited = { records: [{ label: 'base', token: 'synthetic-base-token-574' }], credential: 'synthetic-base-credential-574', mode: 'base' };
  const override = {
    records: Array.from({ length: count }, (_, i) => ({ label: `item-${i}`, token: `synthetic-token-574-${i}` })),
    credential: 'synthetic-override-credential-574', mode: 'override',
  };
  const rows = [{ insert: [
    { id: 'editor', name: pathToFileURL(join(base, 'dsh-config-editor/lib/index.js')).href },
    { id: 'settings', name: pathToFileURL(join(base, 'dsh-settings/lib/index.js')).href },
    { id: 'fixture', name: module, config: inherited },
  ] }, { id: 'fixture', config: override }];
  await writeFile(patchPath, JSON.stringify(rows));
  const profile = { dir, home, installAnchor: join(base, 'dsh/package.json'), patchPath, overlays: [], startedBundles: [], telemetryDisabledEnv: '1' };
  ctx = await boot('dsh', main, rows, async c => { c.provide('profileContext', profile); });
  assert.ok(ctx.settings instanceof SettingsForms);
  assert.ok(ctx.configEditor instanceof ConfigEditor);
  return { ctx, inherited, override, patchPath };
}

function observeSecretPaths(run) {
  const original = JSON.stringify;
  let paths = 0;
  JSON.stringify = function (value, ...rest) {
    // The production redactor serializes these paths for duplicate-sidecar
    // merging. Always delegate; do not count its distinct schema-default work.
    if (Array.isArray(value) && value.length === 3 && value[0] === 'records'
      && /^\d+$/.test(value[1]) && value[2] === 'token') paths++;
    return original.call(this, value, ...rest);
  };
  try { return { value: run(), paths: () => paths }; }
  finally { JSON.stringify = original; }
}

function row(result) {
  assert.equal(result.length, 1);
  assert.equal(result[0].ns, 'fixture');
  return result[0];
}

for (const [count, options] of [[1, undefined], [200, { redactSecrets: false }], [2000, undefined]]) {
  test(`local describe does no unused record-secret sidecar work for ${count} rows`, async t => {
    const { ctx, inherited, override, patchPath } = await fixture(t, count);
    const before = await readFile(patchPath, 'utf8');
    const observation = observeSecretPaths(() => ctx.settings.describe(options));
    const actual = row(observation.value);
    assert.deepEqual(actual.value, override);
    assert.deepEqual(actual.user, override);
    assert.deepEqual(actual.base, inherited);
    assert.equal(Object.hasOwn(actual, 'secrets'), false);
    assert.equal(await readFile(patchPath, 'utf8'), before);
    t.diagnostic(`record-rows=${count} unused-record-secret-path-serializations=${observation.paths()}`);
    assert.equal(observation.paths(), 0);
  });
}

test('explicit redaction strips all three values, preserves ordered sidecars, and removes schema secret defaults', async t => {
  const { ctx } = await fixture(t, 4);
  const observation = observeSecretPaths(() => ctx.settings.describe({ redactSecrets: true }));
  const actual = row(observation.value);
  const expectedRows = Array.from({ length: 4 }, (_, i) => ({ label: `item-${i}` }));
  assert.deepEqual(actual.value, { records: expectedRows, mode: 'override' });
  assert.deepEqual(actual.user, { records: expectedRows, mode: 'override' });
  assert.deepEqual(actual.base, { records: [{ label: 'base' }], mode: 'base' });
  assert.deepEqual(actual.secrets, [
    ...Array.from({ length: 4 }, (_, i) => ({ path: ['records', String(i), 'token'], set: true })),
    { path: ['credential'], set: true },
  ]);
  assert.equal(observation.paths(), 9, 'four current + one inherited + four override paths remain redacted');
  assert.equal(JSON.stringify(actual).includes('synthetic-'), false);
  const local = row(ctx.settings.describe());
  assert.equal(JSON.stringify(local.schema).includes('synthetic-'), false, 'secret schema defaults are stripped even for local reads');
});

test('switching local and redacted reads preserves revisions, events, ownership, and later real updates', async t => {
  const { ctx, override } = await fixture(t, 2);
  const updates = [];
  ctx.on('settings/document-updated', (ns, revision) => { updates.push({ ns, revision }); });
  const first = row(ctx.settings.describe());
  assert.equal(first.revision, 0);
  assert.deepEqual(updates, [{ ns: 'fixture', revision: 0 }]);
  const redacted = row(ctx.settings.describe({ redactSecrets: true }));
  assert.equal(redacted.revision, first.revision);
  first.value.records[0].token = 'caller-mutation';
  assert.equal(row(ctx.settings.describe({ redactSecrets: false })).value.records[0].token, override.records[0].token);
  assert.equal(updates.length, 1);
  await ctx.settings.update('fixture', { mode: 'changed' }, first.revision);
  const current = row(ctx.settings.describe());
  assert.equal(current.value.mode, 'changed');
  assert.equal(current.value.records[0].token, override.records[0].token);
  assert.equal(current.revision, 1);
  assert.deepEqual(updates, [{ ns: 'fixture', revision: 0 }, { ns: 'fixture', revision: 1 }]);
  assert.equal(row(ctx.settings.describe({ redactSecrets: true })).revision, 1);
});

test('empty record arrays preserve the declared root-secret slot and local values', async t => {
  const { ctx, override } = await fixture(t, 0);
  const local = observeSecretPaths(() => ctx.settings.describe({ redactSecrets: false }));
  assert.equal(local.paths(), 0);
  assert.deepEqual(row(local.value).value, override);
  const actual = row(ctx.settings.describe({ redactSecrets: true }));
  assert.deepEqual(actual.value.records, []);
  assert.deepEqual(actual.secrets, [{ path: ['credential'], set: true }]);
});

test('a wholly secret form keeps undefined redacted values and its root sidecar', async t => {
  const { ctx, override } = await fixture(t, 1, true);
  const local = row(ctx.settings.describe());
  assert.equal(local.value.credential, override.credential);
  const actual = row(ctx.settings.describe({ redactSecrets: true }));
  assert.equal(actual.value, undefined);
  assert.equal(actual.base, undefined);
  assert.equal(actual.user, undefined);
  assert.deepEqual(actual.secrets, [{ path: [], set: true }]);
  assert.equal(JSON.stringify(actual).includes('synthetic-'), false);
});
