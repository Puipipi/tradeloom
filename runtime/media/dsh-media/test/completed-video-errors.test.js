import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/completed-video-child.mjs', import.meta.url));
const python = process.env.PYTHON ?? 'python3';
const limited = [
  'import os,resource,sys',
  'resource.setrlimit(resource.RLIMIT_FSIZE,(8192,8192))',
  'os.execv(sys.argv[1],sys.argv[1:])',
].join(';');

for (const [scenario, fileLimit, expected] of [
  ['normal', null, 'done'],
  ['local-storage-failure', 8192, 'storage'],
  ['index-storage-failure', null, 'storage'],
  ['stage-rename-storage-failure', null, 'storage'],
  ['query-outage', null, 'remote_may_continue'],
  ['terminal-failed', null, 'generation_failed'],
  ['cancel-after-success', null, 'remote_may_continue'],
  ['local-download-timeout', null, 'timeout'],
  ['overall-timeout-after-success', null, 'remote_may_continue'],
  ['confirmed-cancel', null, 'cancelled'],
  ['cleanup-priority', 8192, 'cleanup_failed'],
]) {
  test(`completed video: ${scenario} preserves the public failure contract`, {
    skip: process.platform !== 'linux' ? 'requires Linux filesystem and RLIMIT_FSIZE' : false,
  }, () => {
    const args = [child, scenario, expected];
    const run = fileLimit === null
      ? spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 })
      : spawnSync(python, ['-c', limited, process.execPath, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null, run.stderr);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const value = JSON.parse(run.stdout);
    assert.equal(value.observedErrorCode, expected === 'done' ? null : expected);
    assert.equal(value.privateRootRemoved, true);
    assert.equal(value.ledger.state, expected === 'done' || scenario === 'index-storage-failure' ? 'settled' : 'submitted');
    assert.equal(value.providerWires.filter(wire => wire.method === 'POST').length, 1);
    if (scenario === 'index-storage-failure') {
      assert.equal(value.indexWriteFailures, 1);
      assert.equal(value.downloadRequests, 1);
    }
    if (scenario === 'stage-rename-storage-failure') {
      assert.equal(value.stageRenameFailures, 1);
      assert.equal(value.downloadRequests, 1);
    }
    if (fileLimit !== null) {
      assert.ok(value.payloadBytes > fileLimit);
      assert.ok(value.xfszSignals > 0);
      assert.equal(value.stageError.code, 'storage');
      assert.equal(value.stageSignalAborted, false);
    }
    if (scenario === 'local-download-timeout') {
      assert.equal(value.stageError.code, 'timeout');
      assert.equal(value.stageSignalAborted, false);
    }
    if (scenario === 'overall-timeout-after-success') {
      assert.equal(value.wholeDeadlineAborted, true);
      assert.equal(value.wholeDeadlineReason, 'TimeoutError');
      assert.equal(value.stageSignalAborted, true);
    }
    if (scenario === 'cleanup-priority') assert.equal(value.foreignPreserved, true);
  });
}
