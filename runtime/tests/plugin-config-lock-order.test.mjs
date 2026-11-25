import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
assert(process.env.DSH_PREFIX, 'DSH_PREFIX must name a prepared runtime');
for (const scenario of ['install-save','ordinary-contention','no-hmr']) {
  test(`plugin config lock order: ${scenario}`, {timeout:15000}, async () => {
    let result;
    try {
      result = await exec(process.execPath, ['--expose-internals', fileURLToPath(new URL(
        './fixtures/plugin-config-lock-order-probe.mjs', import.meta.url,
      ))], {env:{...process.env, SCENARIO:scenario}, timeout:10000});
    } catch (error) {
      assert.fail(`${scenario}: ${error.code}\n${error.stdout}\n${error.stderr}`);
    }
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).scenario, scenario);
  });
}
