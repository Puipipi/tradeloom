import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

// Uses the locked, fully patched runtime and its public export, with a real
// configurable package-manager child. No network registry or model requests.
test('public operations streams split UTF-8 independently and flushes incomplete EOF', { timeout: 10000 }, async t => {
  assert.ok(process.env.DSH_PREFIX, 'set DSH_PREFIX to the fully patched runtime');
  const prefix = resolve(process.env.DSH_PREFIX);
  const require = createRequire(join(prefix, 'package.json'));
  const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')));
  const dir = await mkdtemp(join(tmpdir(), 'plugin-operations-utf8-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = JSON.stringify({ name: 'utf8-profile', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } });
  await writeFile(join(dir, 'package.json'), manifest);
  // Each emitted chunk waits for onOutput acknowledgement, so OS coalescing
  // cannot hide a split sequence; stdout and stderr alternate on purpose.
  const chunks = [[1, [240, 159]], [2, [228]], [1, [152, 128]], [2, [184, 173]], [1, [228, 184]]];
  let socket;
  const server = createServer(client => { socket = client; client.write('n'); });
  t.after(() => { socket?.destroy(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = join(dir, 'package-manager.mjs');
  await writeFile(child, `import {connect} from 'node:net'; import {writeSync} from 'node:fs';
const chunks=${JSON.stringify(chunks)};let index=0;
const socket=connect(${server.address().port},'127.0.0.1');
socket.on('data',()=>{if(index===chunks.length){socket.end();return;}const [fd,bytes]=chunks[index++];writeSync(fd,Buffer.from(bytes));});`);
  const streamed = { stdout: '', stderr: '' };
  let callbacks = 0;
  const result = await runPluginCommand({ profile: 'web', dir, home: dir, cwd: dir, installAnchor: join(prefix, 'package.json') }, ['--version'], {
    command: process.execPath, args: [child], execution: 'service', outputBytes: 4096,
    activateNewBundles: false,
    onOutput(text, kind) {
      streamed[kind] += text;
      if (++callbacks <= chunks.length) socket.write('n');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(await readFile(result.logPath), Buffer.from(chunks.flatMap(([, bytes]) => bytes)), 'raw log bytes remain exact');
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), manifest);
  assert.equal(streamed.stderr, '中', 'stderr has its own decoder');
  assert.equal(streamed.stdout, '😀�', 'split emoji survives and only incomplete EOF becomes U+FFFD');
});
