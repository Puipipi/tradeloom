import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX must name the patched runtime');
assert.ok(process.env.PNPM_BIN, 'PNPM_BIN must name existing pnpm');
for (const scenario of ['disable-during-check', 'enable-during-check', 'enabled-control', 'disabled-control', 'restore-disabled']) {
  test(`real HMR update selection: ${scenario}`, async () => {
    let result;
    try {
      result = await exec(process.execPath, [fileURLToPath(new URL('./fixtures/plugin-update-hmr-probe.mjs', import.meta.url))], {
        env: { ...process.env, SCENARIO: scenario }, timeout: 60000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      assert.fail(`${scenario}: (${error.code})\n${error.stdout}\n${error.stderr}`);
    }
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.result.hmr, true);
    assert.deepEqual(evidence.exit, [0, null]);
  });
}
