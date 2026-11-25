import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStageReplay, defaultStageSha256, historicalPins, loadPinnedCorpus,
  replayCorpus, sha256, validateCorpus } from './replay-model-corpus.mjs';

const stagePath = fileURLToPath(new URL('../../app/assets/companion/stage.js', import.meta.url));
const cliPath = fileURLToPath(new URL('./replay-model-corpus.mjs', import.meta.url));
const stageSource = readFileSync(stagePath, 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const param = (id, min, max, def = min) => ({ id, min, max, default: def });

test('the complete historical corpus keeps all 24 raw hashes and 18 source families', () => {
  const { facts, sources } = loadPinnedCorpus();
  assert.equal(facts.models.length, 24);
  assert.equal(new Set(facts.models.map((row) => row.moc)).size, 24);
  assert.equal(new Set(facts.models.map((row) => row.identity)).size, 18);
  assert.equal(facts.core.sha256, sources.core.core.sha256);
  assert.equal(facts.core.version, '6.0.1');
  assert.deepEqual([...new Set(facts.models.map((row) => row.mocVersion))].sort(), [1, 2, 3, 4, 5, 6]);
  assert.match(sources.core.runtimeMatch.status, /not verified/);
  assert.equal(sha256(stageSource), defaultStageSha256);
});

test('current c76 rules replay all measured parameters without granting effects or claiming pixels', () => {
  const before = readFileSync(stagePath);
  const report = replayCorpus();
  assert.equal(report.format, 'dsh-go/current-stage-metadata-replay-v1');
  assert.equal(report.summary.mapped, 356);
  assert.equal(report.summary.possibleBindings, 432);
  assert.equal(report.summary.unknownMappedIds, 0);
  assert.equal(report.summary.verifiedEffectCount, 0);
  assert.equal(report.currentReplay.stageSha256, defaultStageSha256);
  for (const key of ['currentCoreMeasured', 'installedRuntimeDigestVerified', 'geometryReplayed',
    'frameworkResourcesLoaded', 'rendererStarted', 'appSourceModified']) assert.equal(report.currentReplay[key], false);
  for (const key of ['visualAccuracy', 'frameRate', 'aiRequests', 'aiTokens']) assert.equal(report.summary[key], null);
  const { facts } = loadPinnedCorpus();
  for (const row of report.rows) {
    const fact = facts.models.find((model) => model.moc === row.rawMocSha256);
    const ids = new Set(fact.probe.parameters.map((parameter) => parameter.id));
    assert.equal(Object.keys(row.bindings).length + row.missing.length, report.vocabulary.length);
    assert.ok(Object.values(row.bindings).every((binding) => binding.targets.every(({ id }) => ids.has(id))));
    assert.deepEqual(row.verifiedEffects, { expressions: {}, motions: {} });
    assert.equal(row.frameworkResourcesLoaded, false);
    assert.equal(Object.hasOwn(row, 'adapter'), false);
  }
  // The historical models do list resources. Empty authorization is not a
  // claim that those resources are absent or were observed to be harmless.
  assert.ok(facts.models.some((row) => row.model3.FileReferences?.Expressions?.length > 0));
  assert.deepEqual(readFileSync(stagePath), before);
});

test('actual fit/set/add methods retain affine offsets and zero-delta semantics', () => {
  const stage = createStageReplay(stageSource);
  const result = stage.replay([
    param('PARAM_ANGLE_X', 100, 200, 150),
    param('BlinkL', 0, 1, 1), param('BlinkR', 0, 1, 1),
    param('ParamEyeLSmile', 0, 1), param('ParamEyeRSmile', 0, 1),
    param('MouthCustom', 0, 10),
  ], { Groups: [
    { Target: 'Parameter', Name: 'EyeBlink', Ids: ['BlinkL', 'BlinkR'] },
    { Target: 'Parameter', Name: 'LipSync', Ids: ['MouthCustom'] },
  ] });
  const angle = result.bindings.ParamAngleX;
  assert.equal(angle.callsAtLow[0].value, 100);
  assert.equal(angle.callsAtHigh[0].value, 200);
  assert.deepEqual(angle.callsAtZeroDelta, [{ operation: 'add', id: 'PARAM_ANGLE_X', value: 0 }]);
  assert.deepEqual(result.bindings.ParamEyeSmile.targets.map(({ id }) => id), ['ParamEyeLSmile', 'ParamEyeRSmile']);
  assert.equal(result.bindings.ParamEyeSmile.callsAtZeroDelta.length, 2);
  assert.deepEqual(result.bindings.ParamEyeLOpen.targets.map(({ id }) => id), ['BlinkL']);
  assert.deepEqual(result.bindings.ParamEyeROpen.targets.map(({ id }) => id), ['BlinkR']);
  assert.equal(result.bindings.ParamMouthOpenY.callsAtHigh[0].value, 10);
  assert.ok(result.missing.includes('ParamAngleY'));
});

test('capture reports native call arguments and does not simulate Core clamping', () => {
  const result = createStageReplay(stageSource).replay([param('ParamMouthForm', -0.5, 0.5, 0)]);
  const mouth = result.bindings.ParamMouthForm;
  assert.deepEqual(mouth.targets[0].measuredRange, [-0.5, 0.5, 0]);
  // Current stage leaves close-enough domains alone; actual Core would own
  // its subsequent behavior. This harness only records the stage's call.
  assert.equal(mouth.callsAtLow[0].value, -1);
  assert.equal(mouth.callsAtHigh[0].value, 1);
});

test('source SHA drift fails closed; an explicit revised pin executes the revised source', () => {
  const modified = stageSource.replace('ratio < 0.2 || ratio > 5', 'ratio < 0.9 || ratio > 1.1');
  assert.notEqual(modified, stageSource);
  assert.throws(() => createStageReplay(modified), /Stage SHA differs/);
  const old = createStageReplay(stageSource).replay([param('ParamAngleX', -10, 10, 0)]);
  const revised = createStageReplay(modified, 'explicit-test-stage.js', sha256(modified))
    .replay([param('ParamAngleX', -10, 10, 0)]);
  assert.equal(old.bindings.ParamAngleX.callsAtHigh[0].value, 30);
  assert.equal(revised.bindings.ParamAngleX.callsAtHigh[0].value, 10);
});

test('missing or ambiguous source boundaries are rejected even with a supplied hash', () => {
  const marker = "  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');";
  for (const source of [stageSource.replace(marker, ''), `${stageSource}\n${marker}`,
    stageSource.replace('  const STANDARD = {', '  const OTHER = {')]) {
    assert.throws(() => createStageReplay(source, 'changed.js', sha256(source)), /Stage source boundary changed/);
  }
});

test('corpus rejects mismatched provenance, duplicate raw hashes and invented resource loading', () => {
  const original = loadPinnedCorpus();
  for (const mutate of [
    ({ facts }) => { facts.models[1].moc = facts.models[0].moc; },
    ({ facts }) => { facts.models[0].metadataFacts.originalModel3Sha256 = '0'.repeat(64); },
    ({ facts }) => { facts.models[0].probe.frameworkResourcesLoaded = true; },
    ({ sources }) => { sources.models[0].sourceId = 'unknown'; },
    ({ facts }) => { facts.models[0].probe.parameters[0].min = Number.NaN; },
    ({ facts }) => { facts.models[0].probe.parameters[1].id = facts.models[0].probe.parameters[0].id; },
  ]) {
    const changed = copy(original); mutate(changed);
    assert.throws(() => validateCorpus(changed.facts, changed.sources));
  }
});

test('historical metadata bytes cannot drift silently even when JSON stays equivalent', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-corpus-pin-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'facts.json');
  const original = readFileSync(new URL('./fixtures/live2d-core-facts-v1.json', import.meta.url));
  assert.equal(sha256(original), historicalPins.factsSha256);
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
  assert.throws(() => loadPinnedCorpus({ factsPath: path }), /facts bytes differ/);
});

test('CLI writes one report, preserves existing files and refuses unreviewed stage drift', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-corpus-cli-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const output = join(folder, 'report.json');
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  const good = run('--out', output);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).modelFingerprints, 24);
  const before = readFileSync(output);
  const again = run('--out', output);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /EEXIST/);
  assert.deepEqual(readFileSync(output), before);
  const changedStage = join(folder, 'stage.js');
  writeFileSync(changedStage, `${stageSource}\n// unreviewed byte change\n`);
  const rejected = run('--stage', changedStage);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Stage SHA differs/);
  assert.notEqual(run('--adapter-output', output).status, 0);
  assert.equal(sha256(readFileSync(stagePath)), defaultStageSha256);
});
