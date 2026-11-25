// Real public PluginManager, pnpm and a self-owned loopback registry. No external provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
assert.ok(process.env.DSH_PREFIX, 'DSH_PREFIX must name the patched runtime prefix');
assert.ok(process.env.PNPM_BIN, 'PNPM_BIN must name an existing pnpm executable');
for (const scenario of ['disable-during-check', 'disabled-control', 'enabled-control', 'enable-during-check', 'unsupported-enabled', 'unsupported-disabled']) {
  test(`in-place bundle update preserves selection: ${scenario}`, async () => {
    let result;
    try {
      result = await exec(process.execPath, [fileURLToPath(new URL('./fixtures/plugin-update-selection-probe.mjs', import.meta.url))], {
        env: { ...process.env, SCENARIO: scenario },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      assert.fail(`${scenario}: child failed (${error.code})\n${error.stdout}\n${error.stderr}`);
    }
    const evidence = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(evidence.scenario, scenario);
    assert.equal(evidence.facts.at(-1).result.result.packageResult.exitCode, 0);
    assert.equal(evidence.facts.at(-1).bundle.version, '2.0.0');
  });
}
