// Developer-only receiver for the actual stage's probe and replacement methods.
// It records native-call arguments; it does not implement Core, clamp, render,
// infer model semantics, load resources, or grant an adapter permission.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { defaultStageSha256, sha256 } from './replay-model-corpus.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));

export function createReplacementReplay(source, filename, expectedSha256 = defaultStageSha256) {
  assert.equal(sha256(source), expectedSha256, 'Stage SHA differs from the explicit reviewed pin');
  const slice = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end);
    assert.ok(a >= 0 && b > a && source.indexOf(start, a + start.length) === -1
      && source.indexOf(end, b + end.length) === -1, 'Stage source boundary changed');
    return source.slice(a, b);
  };
  const methods = slice('  const STANDARD = {',
    "  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');");
  const probe = slice('  function probeReport() {', '  let zones = DEFAULT_ZONES;');
  const handles = new Map();
  const manager = { getId(id) {
    if (!handles.has(id)) handles.set(id, Object.freeze({ getString: () => id }));
    return handles.get(id);
  } };
  const context = vm.createContext({
    Fw: { CubismUserModel: class {}, CubismFramework: { getIdManager: () => manager } },
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    model: null, character: {}, adapter: null, zones: [], zonesFrom: 'default',
  });
  new vm.Script(`'use strict';\n${methods}\n${probe}\nglobalThis.replacementSource = { StageModel, probeReport };`,
    { filename }).runInContext(context, { timeout: 1000 });
  const { StageModel, probeReport } = context.replacementSource;

  function model({ parameters, oldAdapter = null, rules, groups = [] }) {
    const ids = parameters.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'Fixture parameter ids must be unique');
    const raw = { count: ids.length, ids,
      minimumValues: parameters.map((p) => p.min),
      maximumValues: parameters.map((p) => p.max),
      defaultValues: parameters.map((p) => p.def) };
    const calls = [];
    let resetCount = 0, saveCount = 0;
    const capture = (operation, handle, value, weight) => calls.push({
      operation, id: handle.getString(), value,
      physical: ids.includes(handle.getString()),
      ...(weight === undefined ? {} : { weight }),
    });
    const current = new StageModel();
    current._model = {
      getModel: () => ({ parameters: raw, parts: { count: 0, ids: [] }, drawables: { count: 0 } }),
      getParameterCount: () => ids.length,
      getParameterIndex: (handle) => {
        const index = ids.indexOf(handle.getString());
        return index < 0 ? ids.length : index;
      },
      setParameterValueById: (handle, value, weight) => capture('set', handle, value, weight),
      addParameterValueById: (handle, value) => capture('add', handle, value),
      // adapt performs these administrative native calls. Count them without
      // pretending to reproduce native state, clamping, or pixel effects.
      setParameterValueByIndex: () => { resetCount++; },
      saveParameters: () => { saveCount++; },
    };
    current.display = { Parameters: parameters.map((p) => ({
      Id: p.id, Name: p.name ?? null, GroupId: p.group ?? null,
    })), ParameterGroups: [...new Set(parameters.map((p) => p.group).filter(Boolean))]
      .map((name) => ({ Id: name, Name: name })) };
    const group = (name) => groups.filter((g) => g.Target === 'Parameter' && g.Name === name)
      .flatMap((g) => g.Ids);
    const blink = group('EyeBlink'), lip = group('LipSync');
    current.fitParams({
      getEyeBlinkParameterCount: () => blink.length,
      getEyeBlinkParameterId: (i) => manager.getId(blink[i]),
      getLipSyncParameterCount: () => lip.length,
      getLipSyncParameterId: (i) => manager.getId(lip[i]),
    });
    if (rules !== undefined) {
      // Deliberate boundary fixtures can supply a rule table. This is labeled
      // separately from the normal path, which runs actual fitParams above.
      current.ruleAlias = new Map(Object.entries(copy(rules)));
    }
    let currentAdapter = oldAdapter;
    current.adapt({}, currentAdapter);
    context.model = current;
    context.adapter = oldAdapter;
    calls.length = 0;
    return Object.freeze({
      probe: () => {
        context.model = current;
        context.adapter = currentAdapter;
        return copy(probeReport());
      },
      aliases: () => copy(Object.fromEntries(current.alias)),
      replace: (replacement) => {
        currentAdapter = replacement;
        context.model = current;
        context.adapter = replacement;
        current.adapt({}, replacement);
        calls.length = 0;
      },
      call: (operation, name, value, weight = 1) => {
        assert.ok(operation === 'set' || operation === 'add');
        calls.length = 0;
        if (operation === 'set') current.set(name, value, weight);
        else current.add(name, value);
        return copy(calls);
      },
      administrativeCalls: () => ({ resetCount, saveCount }),
      ruleSource: rules === undefined ? 'actual fitParams' : 'explicit boundary fixture',
    });
  }
  return Object.freeze({ model, stageSha256: sha256(source),
    methodsSha256: sha256(methods), probeSha256: sha256(probe) });
}
