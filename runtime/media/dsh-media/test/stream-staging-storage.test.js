import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/staging-storage-child.mjs', import.meta.url));
const python = process.env.PYTHON ?? 'python3';
const limited = [
  'import os,resource,sys',
  'resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024))',
  'os.execv(sys.argv[1],sys.argv[1:])',
].join(';');

for (const [name, size, limit, errorCode] of [
  ['real write failure is storage and removes only the owned temporary file', 8192, true, 'storage'],
  ['small download succeeds under the same file-size limit', 512, true, undefined],
  ['large download succeeds without the file-size limit', 8192, false, undefined],
]) {
  test(name, { skip: process.platform !== 'linux' ? 'requires Linux RLIMIT_FSIZE' : false }, () => {
    const command = limit ? python : process.execPath;
    const args = limit ? ['-c', limited, process.execPath, child, String(size)] : [child, String(size)];
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.requests, 1);
    assert.equal(value.errorCode, errorCode);
    assert.equal(value.receipt, errorCode === undefined);
    assert.equal(value.existingPreserved, true);
    assert.equal(value.temporaryFilesRemoved, true);
  });
}
