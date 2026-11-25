import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the real public operation, process, pipes, log and error handling. The
// spawn observer only exposes the real pipe so its read can fail at a known
// boundary. Each chunk has already reached onOutput (and disk) before that
// pipe is destroyed. No private collector is extracted or replaced.
const cases = [
  { stream: 'stdout', fault: 'pipe' },
  { stream: 'stderr', fault: 'pipe' },
  { stream: 'stdout', fault: 'pipe', flushThrows: true },
  { stream: 'stderr', fault: 'pipe', flushThrows: true },
  { stream: 'stdout', fault: 'eof', flushThrows: true },
  { stream: 'stdout', fault: 'pipe', complete: true },
  { stream: 'stdout', fault: 'callback', thrown: undefined },
  { stream: 'stderr', fault: 'callback', thrown: null },
];

for (const scenario of cases) {
  const { stream, fault, flushThrows = false, complete = false } = scenario;
  const name = `${stream} ${fault}${flushThrows ? ' plus tail callback error' : ''}${complete ? ' after complete text' : ''}`;
  test(`public operations finalizes UTF-8 on ${name}`, { timeout: 10000, concurrency: false }, async t => {
    assert.ok(process.env.DSH_PREFIX, 'set DSH_PREFIX to the fully patched runtime');
    const prefix = resolve(process.env.DSH_PREFIX);
    const require = createRequire(join(prefix, 'package.json'));
    const dir = await mkdtemp(join(tmpdir(), 'operations-utf8-error-'));
    const script = join(dir, 'held-output.mjs');
    const bytes = complete ? Buffer.from([0xe4, 0xb8, 0xad]) : Buffer.from([0xe4, 0xb8]);
    const fd = stream === 'stdout' ? 1 : 2;
    const manifest = JSON.stringify({ name: 'utf8-error-profile', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } });
    await writeFile(join(dir, 'package.json'), manifest);
    // A local listening handle keeps the process alive until the operation's
    // own cancellation ends it. In the EOF case only the selected descriptor
    // closes; the process and the other pipe stay alive. This checks that a
    // tail callback failure still goes through the existing cancellation path.
    await writeFile(script, `import {createServer} from 'node:net';
import {writeSync,closeSync} from 'node:fs';
const hold=createServer();
hold.listen(0,'127.0.0.1',()=>{writeSync(${fd},Buffer.from(${JSON.stringify([...bytes])}));${fault === 'eof' ? `closeSync(${fd});` : ''}});
`);
    const nativeSpawn = childProcess.spawn;
    let observedChild;
    childProcess.spawn = function (command, args, options) {
      const child = nativeSpawn.call(this, command, args, options);
      if (args.includes(script)) observedChild = child;
      return child;
    };
    syncBuiltinESMExports();
    const primary = fault === 'callback'
      ? scenario.thrown
      : Object.assign(new Error('controlled pipe read failure'), { code: 'ECONTROLLED_PIPE' });
    const secondary = Object.assign(new Error('controlled tail callback failure'), { code: 'ECONTROLLED_TAIL' });
    const events = [];
    let firstChunk = false;
    let rejected = false;
    let rejection;
    try {
      const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')));
      try {
        await runPluginCommand({ profile: 'web', dir, home: dir, cwd: dir, installAnchor: join(prefix, 'package.json') }, ['--version'], {
          command: process.execPath,
          args: [script],
          execution: 'service',
          outputBytes: 4096,
          activateNewBundles: false,
          signal: t.signal,
          onOutput(text, kind) {
            events.push({ text, kind });
            if (kind !== stream) return;
            if (text === '\ufffd' && flushThrows) throw secondary;
            if (firstChunk) return;
            firstChunk = true;
            assert.ok(observedChild, 'the configured child was observed through the native spawn boundary');
            if (fault === 'pipe') observedChild[stream].destroy(primary);
            else if (fault === 'callback') throw primary;
          },
        });
      } catch (error) {
        rejected = true;
        rejection = error;
      }
      assert.equal(firstChunk, true, 'the error occurs after the original bytes reached the collector');
      assert.equal(rejected, true, 'a decoding tail must not turn a failed operation into success');
      assert.equal(rejection, fault === 'eof' ? secondary : primary, 'preserve the original rejection value, even if tail notification also throws');
      assert.ok(observedChild.exitCode !== null || observedChild.signalCode !== null, 'the existing failure path terminates the held process');
      const logsRoot = join(dir, '.plugin-manager/logs');
      const logs = (await readdir(logsRoot)).filter(name => name.startsWith('operation-'));
      assert.equal(logs.length, 1);
      const disk = await readFile(join(logsRoot, logs[0], 'pnpm.log'));
      assert.deepEqual(disk, bytes, 'persist only the original bytes, not a synthetic replacement character');
      assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), manifest, 'a failed read does not reconcile the profile');
      const text = events.filter(event => event.kind === stream).map(event => event.text).join('');
      assert.equal(text, complete ? '中' : '\ufffd', 'flush the pending incomplete sequence exactly once');
      assert.equal(events.filter(event => event.kind !== stream).length, 0, 'do not publish the tail on the other stream');
      t.diagnostic(JSON.stringify({ stream, fault, flushThrows, complete, diskBytes: disk.length, text, originalErrorPreserved: true }));
    } finally {
      childProcess.spawn = nativeSpawn;
      syncBuiltinESMExports();
      if (observedChild && observedChild.exitCode === null && observedChild.signalCode === null) {
        const exited = new Promise(resolve => observedChild.once('exit', resolve));
        observedChild.kill('SIGKILL');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
