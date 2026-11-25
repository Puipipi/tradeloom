// DART_BIN=/path/to/dart node --test tooling/companion/replay-adapt-replacement.test.mjs
// No model, Core, browser, API, GPU or visual claim: exact stage source and the
// real pure Dart checker are joined through the same serialized probe contract.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256 } from './replay-model-corpus.mjs';
import { createReplacementReplay } from './replay-adapt-replacement.mjs';

const stagePath = fileURLToPath(new URL('../../app/assets/companion/stage.js', import.meta.url));
const checkerPath = fileURLToPath(new URL('./adapt-dry-run.dart', import.meta.url));
const contractPath = fileURLToPath(new URL('../../app/lib/companion/companion_adapt_contract.dart', import.meta.url));
const contractSha256 = sha256(readFileSync(contractPath));
const stage = createReplacementReplay(readFileSync(stagePath, 'utf8'), stagePath);
const folder = mkdtempSync(join(tmpdir(), 'dsh-c906-replacement-'));
const records = [];
const physical = (id, min = -1, max = 1, def = 0, extra = {}) => ({ id, min, max, def, ...extra });
const face = (value = 0.5) => ({ emotions: { happy: { face: { ParamMouthForm: value } } } });
const mapping = (id, scale, offset) => ({ params: { ParamMouthForm: { id, scale, offset } } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-14,
  `${actual} != ${expected}`);

function check(name, model, candidate, changedProbe) {
  const probe = changedProbe ?? model.probe();
  writeFileSync(join(folder, 'probe.json'), JSON.stringify(probe));
  writeFileSync(join(folder, 'candidate.json'), JSON.stringify(candidate));
  const command = [checkerPath, join(folder, 'probe.json'), join(folder, 'candidate.json')];
  const result = spawnSync(process.env.DART_BIN ?? 'dart', command,
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, CI: 'true' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${name}: actual Dart checker failed\n${result.stderr}\n${result.stdout}`);
  const checked = JSON.parse(result.stdout);
  records.push({ name, ruleSource: model.ruleSource, probe, candidate, checked });
  return checked;
}

function routed(model, checked, expectedIds, setValue, addValue) {
  assert.equal(checked.empty, false);
  model.replace(checked.adapter);
  const set = model.call('set', 'ParamMouthForm', 0.5);
  const add = model.call('add', 'ParamMouthForm', 0.5);
  for (const [calls, expected] of [[set, setValue], [add, addValue]]) {
    assert.deepEqual(calls.map((call) => call.id), expectedIds);
    for (const call of calls) {
      assert.equal(call.physical, true);
      assert.equal(Number.isFinite(call.value), true);
      close(call.value, expected);
    }
  }
  records.at(-1).nativeArguments = { set, add };
}

after(() => {
  try {
    assert.equal(sha256(readFileSync(contractPath)), contractSha256, 'Checker source changed during replay');
    if (process.env.C906_REPLAY_OUTPUT) writeFileSync(process.env.C906_REPLAY_OUTPUT,
      JSON.stringify({ format: 'dsh-go/adapter-replacement-source-replay-v1',
        stageSha256: stage.stageSha256, methodsSha256: stage.methodsSha256, probeSha256: stage.probeSha256,
        checkerContractSha256: contractSha256, nodeVersion: process.version,
        scope: 'Native call arguments before Core; no rendering, resource effects, API or device execution', records }, null, 2) + '\n',
      { flag: 'wx' });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('C900 old adapter-only alias cannot certify the face in its own full replacement', () => {
  const current = { adapter: 1, params: { ParamMouthForm: { id: 'SmileShape' } } };
  const model = stage.model({ parameters: [physical('SmileShape')], oldAdapter: current });
  const probe = model.probe();
  assert.deepEqual(probe.linked.ParamMouthForm, ['SmileShape']);
  assert.deepEqual(probe.ruleAliases, {});
  const checked = check('C900 exact face-only replacement', model, face());
  assert.equal(checked.empty, true);
  assert.deepEqual(checked.dropped, ['emotions.happy.face.ParamMouthForm']);
  // Rejecting a proposal has not changed the old model. The caller must keep it.
  assert.equal(model.aliases().ParamMouthForm.scale, 1);
  assert.equal(model.aliases().ParamMouthForm.offset, 0);
  const oldCall = model.call('add', 'ParamMouthForm', 0.5);
  assert.deepEqual(oldCall, [{ operation: 'add', id: 'SmileShape', value: 0.5, physical: true }]);
  // A control bypasses the checker to expose the exact former failure mode.
  model.replace(face());
  const bypass = model.call('add', 'ParamMouthForm', 0.5);
  assert.deepEqual(bypass, [{ operation: 'add', id: 'ParamMouthForm', value: 0.5, physical: false }]);
  records.at(-1).control = { oldCall, bypass };
});

test('explicitly retaining an old affine mapping preserves both set and add semantics', () => {
  const current = mapping('SmileShape', -2, 0.3);
  const model = stage.model({ parameters: [physical('SmileShape')], oldAdapter: current });
  const checked = check('retained affine override', model, { ...current, ...face() });
  assert.deepEqual(checked.adapter.params, current.params);
  assert.deepEqual(checked.dropped, []);
  routed(model, checked, ['SmileShape'], -0.7, -1);
});

test('omitting the old override restores the exact actual fit rule and its offset', () => {
  const model = stage.model({ parameters: [physical('PARAM_MOUTH_FORM', -0.01115, 0.01517), physical('SmileShape')],
    oldAdapter: mapping('SmileShape', -7, 0.9) });
  const probe = model.probe();
  assert.equal(probe.ruleAliasVersion, 1);
  assert.deepEqual(probe.ruleAliases.ParamMouthForm.ids, ['PARAM_MOUTH_FORM']);
  close(probe.ruleAliases.ParamMouthForm.scale, 0.01316);
  close(probe.ruleAliases.ParamMouthForm.offset, 0.00201);
  assert.deepEqual(probe.linked.ParamMouthForm, ['SmileShape']);
  const checked = check('actual fit survives replacement', model, face());
  assert.equal(Object.hasOwn(checked.adapter, 'params'), false);
  routed(model, checked, ['PARAM_MOUTH_FORM'], 0.00859, 0.00658);
  assert.deepEqual(model.probe().ruleAliases, probe.ruleAliases);
});

test('probe does not round a tiny valid physical range to zero width', () => {
  const model = stage.model({ parameters: [physical('ParamMouthForm', -0.00004, 0.00004)] });
  const probe = model.probe();
  assert.equal(probe.params[0].min, -0.00004);
  assert.equal(probe.params[0].max, 0.00004);
  assert.equal(probe.ruleAliases.ParamMouthForm.scale, 0.00004);
  const checked = check('tiny precise native range', model, face());
  routed(model, checked, ['ParamMouthForm'], 0.00002, 0.00002);
});

test('known empty rules permit a physical identity after removing an old override', () => {
  const model = stage.model({ parameters: [physical('ParamMouthForm'), physical('SmileShape')],
    oldAdapter: mapping('SmileShape', -2, 0.3) });
  assert.deepEqual(model.probe().ruleAliases, {});
  const checked = check('known absent rule identity', model, face());
  routed(model, checked, ['ParamMouthForm'], 0.5, 0.5);
});

test('original rule order, duplicates and nonunit affine coefficients reach the native receiver', () => {
  const model = stage.model({ parameters: [physical('SmileL'), physical('SmileR')], rules: {
    ParamMouthForm: { ids: ['SmileL', 'SmileR', 'SmileL'], scale: -0.37, offset: 0.125 },
  } });
  const probe = model.probe();
  assert.deepEqual(probe.ruleAliases.ParamMouthForm.ids, ['SmileL', 'SmileR', 'SmileL']);
  const checked = check('complete multi-target rule', model, face());
  routed(model, checked, ['SmileL', 'SmileR', 'SmileL'], -0.06, -0.185);
});

test('rule targets are physical one-hop destinations even when their names are standard keys', () => {
  const model = stage.model({ parameters: [physical('ParamBrowLY'), physical('Other')], rules: {
    ParamMouthForm: { ids: ['ParamBrowLY'], scale: -0.37, offset: 0.125 },
    ParamBrowLY: { ids: ['Other'], scale: 9, offset: 11 },
  } });
  const checked = check('one-hop physical target', model, face());
  routed(model, checked, ['ParamBrowLY'], -0.06, -0.185);
});

test('a rule target outside the real 800-position report cannot fall through to a shadowed identity', () => {
  const model = stage.model({ parameters: [physical('ParamMouthForm'),
    ...Array.from({ length: 799 }, (_, i) => physical(`Filler${i}`)), physical('Outside')], rules: {
    ParamMouthForm: { ids: ['Outside'], scale: 2, offset: 3 },
  } });
  const probe = model.probe();
  assert.equal(probe.parameterCount, 801);
  assert.equal(probe.params.length, 800);
  assert.ok(probe.params.some((p) => p.id === 'ParamMouthForm'));
  assert.ok(!probe.params.some((p) => p.id === 'Outside'));
  const checked = check('truncated rule target shadows identity', model, face());
  assert.equal(checked.empty, true);
  assert.deepEqual(checked.dropped, ['emotions.happy.face.ParamMouthForm']);
});

test('protected targets reject the whole rule; a validated replacement may override it', () => {
  const model = stage.model({ parameters: [physical('SmileShape'),
    physical('Switch', 0, 1, 1, { name: 'Watermark' })], rules: {
    ParamMouthForm: { ids: ['SmileShape', 'Switch'], scale: 1, offset: 0 },
  } });
  assert.equal(check('protected target in rule', model, face()).empty, true);
  const checked = check('explicit permitted override', model, { ...mapping('SmileShape', -0.37, 0.125), ...face() });
  routed(model, checked, ['SmileShape'], -0.06, -0.185);
});

test('dropping an invalid candidate uses exactly the surviving rule, or rejects without one', () => {
  const bad = { ...mapping('missing', 0, 0), ...face() };
  const known = stage.model({ parameters: [physical('PARAM_MOUTH_FORM', -0.01115, 0.01517)] });
  const checked = check('bad override leaves actual rule', known, bad);
  assert.deepEqual(checked.dropped, ['params.ParamMouthForm']);
  assert.equal(Object.hasOwn(checked.adapter, 'params'), false);
  routed(known, checked, ['PARAM_MOUTH_FORM'], 0.00859, 0.00658);
  const absent = stage.model({ parameters: [physical('SmileShape')], oldAdapter: mapping('SmileShape', 2, 0.1) });
  const rejected = check('bad override leaves no rule', absent, bad);
  assert.equal(rejected.empty, true);
  assert.deepEqual(rejected.dropped, ['params.ParamMouthForm', 'emotions.happy.face.ParamMouthForm']);
});

test('legacy or malformed rule evidence never guesses identity or accepts candidate rule facts', () => {
  const model = stage.model({ parameters: [physical('ParamMouthForm')] });
  const legacy = model.probe();
  delete legacy.ruleAliasVersion;
  delete legacy.ruleAliases;
  const forged = { ...face(), ruleAliasVersion: 1, ruleAliases: {} };
  const rejected = check('legacy report and forged candidate evidence', model, forged, legacy);
  assert.equal(rejected.empty, true);
  assert.ok(rejected.dropped.includes('emotions.happy.face.ParamMouthForm'));
  const malformed = { ...model.probe(), ruleAliases: {
    ParamAngleX: { ids: ['ParamMouthForm'], scale: 1 },
  } };
  assert.equal(check('partially malformed rule map', model, face(), malformed).empty, true);
  const checked = check('legacy report with explicit mapping', model,
    { ...mapping('ParamMouthForm', -0.37, 0.125), ...face() }, legacy);
  routed(model, checked, ['ParamMouthForm'], -0.06, -0.185);
});

test('large existing rule coefficients are preserved without copying them into capped candidate params', () => {
  const model = stage.model({ parameters: [physical('SmileShape', -50000, 50000)], rules: {
    ParamMouthForm: { ids: ['SmileShape'], scale: 5000, offset: 15000 },
  } });
  const checked = check('large trusted rule coefficients', model, face());
  assert.equal(Object.hasOwn(checked.adapter, 'params'), false);
  routed(model, checked, ['SmileShape'], 17500, 2500);
  const capped = check('candidate cap remains distinct', model,
    { ...mapping('SmileShape', 5000, 15000), ...face() });
  assert.deepEqual(capped.dropped, ['params.ParamMouthForm']);
  routed(model, capped, ['SmileShape'], 17500, 2500);
});
