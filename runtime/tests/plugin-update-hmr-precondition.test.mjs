import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX must name the prepared runtime');
assert.ok(process.env.PNPM_BIN, 'PNPM_BIN must name existing pnpm');
const probe = fileURLToPath(new URL('./fixtures/plugin-update-hmr-precondition-probe.mjs', import.meta.url));

for (const scenario of ['newer-update', 'removed', 'normal-update', 'explicit-replace']) {
  test(`real HMR update precondition: ${scenario}`, async () => {
    let result;
    try {
      result = await exec(process.execPath, [probe], {
        env: { ...process.env, SCENARIO: scenario },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      assert.fail(`${scenario}: (${error.code})\n${error.stdout}\n${error.stderr}`);
    }
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.result.hmr, true);
    assert.deepEqual(evidence.exit, [0, null]);
  });
}
