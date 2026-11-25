import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/plugin-log-short-child.mjs', import.meta.url));
for (const entry of ['service', 'operations']) for (const limit of [4096, 32768]) {
  test(`public ${entry} diagnostic log at real RLIMIT_FSIZE=${limit}`, { skip: process.platform !== 'linux', timeout: 15000 }, t => {
    assert(process.env.DSH_PREFIX, 'set DSH_PREFIX to the private candidate prefix');
    const launcher = 'import os,resource,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[1]),int(sys.argv[1])));os.execv(sys.argv[2],sys.argv[2:])';
    const child = spawnSync('python3', ['-c', launcher, String(limit), process.execPath, fixture, entry], {
      env: { PATH: process.env.PATH, DSH_PREFIX: process.env.DSH_PREFIX, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 12000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.equal(child.signal, null);
    const observed = JSON.parse(child.stdout.trim());
    t.diagnostic(JSON.stringify(observed));
    assert.deepEqual(observed.ownOpenLogFds, [], 'the existing completion path closes its diagnostic file');
    assert.equal(observed.installedModuleRemains, true, 'a log failure cannot promise to undo completed package-manager side effects');
    if (limit === 4096) {
      assert.equal(observed.hasPackageResult, false, 'a partial log must not be returned as an unabridged diagnostic result');
      assert.equal(observed.diskBytes, 4096);
      if (entry === 'service') {
        assert.equal(observed.application, 'failed');
        assert.equal(observed.managementError.code, 'operation-error');
        assert.match(observed.managementError.diagnostic, /EFBIG/);
      } else assert.equal(observed.error.code, 'EFBIG');
    } else {
      assert.equal(observed.hasPackageResult, true);
      assert.equal(observed.packageExit, 0);
      assert.equal(observed.returnedBytes, 8192);
      assert.equal(observed.eventBytes, 8192);
      assert.equal(observed.diskExact, true);
      assert.equal(observed.truncated, false);
      if (entry === 'service') assert.equal(observed.application, 'restart-required');
    }
  });
}
