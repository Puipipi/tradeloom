import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX must name the prepared runtime prefix');
assert.ok(process.env.PNPM_BIN, 'PNPM_BIN must name an existing pnpm executable');

for (const scenario of ['newer-install', 'removed', 'normal-update', 'explicit-downgrade', 'incompatible-target']) {
  test(`non-HMR update precondition: ${scenario}`, async () => {
    let result;
    try {
      result = await exec(process.execPath, [fileURLToPath(new URL(
        './fixtures/plugin-update-precondition-probe.mjs', import.meta.url,
      ))], { env: { ...process.env, SCENARIO: scenario }, timeout: 60000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      assert.fail(`${scenario}: child failed (${error.code})\n${error.stdout}\n${error.stderr}`);
    }
    const evidence = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(evidence.scenario, scenario);
    assert.equal(evidence.facts.at(-1).stage, 'finished');
  });
}
