import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Actual CLI and verbatim helper only. No model, server fixture, or executable substitute.
const prefix = resolve(process.env.DSH_PREFIX ?? '');
assert.ok(process.env.DSH_PREFIX, 'set DSH_PREFIX to the fully patched matching runtime');
const candidateFile = new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt', import.meta.url);
const baselineFile = process.env.SAFE_MODE_BASELINE_SOURCE;
assert.ok(baselineFile, 'set SAFE_MODE_BASELINE_SOURCE to the original SafeMode.kt');
const evidence = resolve(process.env.EVIDENCE_DIR ?? './safe-home-trial-evidence');
mkdirSync(evidence, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'safe-home-trial-'));
const redact = text => String(text ?? '').replace(/token=[A-Za-z0-9._~%-]+/g, 'token=***');
const results = [];
try {
  const original = join(dir, 'original');
  const rescue = join(dir, 'rescue');
  const work = join(dir, 'workspace');
  for (const path of [original, rescue, work]) mkdirSync(path);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DSH_|DS_|DEEPSEEK_|OPENAI_|ANTHROPIC_|MODEL_|LLM_|AWS_|GOOGLE_|AZURE_)/.test(key)));
  const env = { ...inherited, HOME: dir, DSH_HOME: rescue, DSH_APP_ORIGINAL_HOME: original,
    DSH_APP_SAFE_MODE: '1', DSH_AGENTS_HOME: join(dir, 'safe-agents'), DSH_APP_SAFE_DIR: dir,
    DSH_APP_PATCH: join(dir, 'absent-app.patch.yml'), DSH_TELEMETRY_DISABLED: '1',
    TRIAL_HOLD: '0', TRIAL_LIMIT: '20',
    PATH: [join(prefix, 'node_modules/.bin'), dirname(process.execPath), process.env.PATH].join(':') };
  const helpers = {};
  for (const [name, file] of [['original', baselineFile], ['candidate', candidateFile]]) {
    helpers[name] = join(dir, name + '.cjs');
    const text = readFileSync(file, 'utf8').match(/const val PLUGINS_SCRIPT = """([\s\S]*?)"""/)[1];
    writeFileSync(helpers[name], text);
  }
  function run(name, command, label) {
    const r = spawnSync(process.execPath, [helpers[name], command], { cwd: work, env,
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const record = { label, helper: name, command, status: r.status, signal: r.signal,
      error: r.error?.message, stdout: redact(r.stdout), stderr: redact(r.stderr) };
    results.push(record);
    writeFileSync(join(evidence, label + '.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(label + ': exit=' + r.status + ' ' + record.stdout.split('\n')[0]);
    assert.equal(r.error, undefined, record.error);
    return record;
  }
  const bad = join(original, 'cordis.patch.yml');
  const badBytes = '- id: malformed-original\n  config: [unterminated\n';
  writeFileSync(bad, badBytes);
  const oldBlame = run('original', 'blame', 'original-helper-bad-original-blame');
  assert.equal(oldBlame.status, 0, oldBlame.stderr);
  const oldTrial = run('original', 'trial', 'original-helper-bad-original-trial');
  assert.equal(oldTrial.status, 0, oldTrial.stdout + oldTrial.stderr);
  assert.match(oldTrial.stdout, /PASS:/);
  const newBlame = run('candidate', 'blame', 'candidate-bad-original-blame');
  assert.equal(newBlame.status, 1);
  assert.match(newBlame.stdout + newBlame.stderr, /malformed-original|unterminated|flow collection|YAML/i);
  const newTrial = run('candidate', 'trial', 'candidate-bad-original-trial');
  assert.equal(newTrial.status, 1);
  assert.match(newTrial.stdout, /FAIL:/);
  assert.match(newTrial.stdout + newTrial.stderr, /malformed-original|unterminated|flow collection|YAML/i);
  assert.equal(readFileSync(bad, 'utf8'), badBytes);
  // Controlled fixture repair only; no product data is touched.
  rmSync(bad);
  const healthyBlame = run('candidate', 'blame', 'candidate-healthy-original-blame');
  assert.equal(healthyBlame.status, 0, healthyBlame.stderr);
  const healthyTrial = run('candidate', 'trial', 'candidate-healthy-original-trial');
  assert.equal(healthyTrial.status, 0, healthyTrial.stdout + healthyTrial.stderr);
  assert.match(healthyTrial.stdout, /PASS:/);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ pass: true, prefix, cases: results.length }, null, 2) + '\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
