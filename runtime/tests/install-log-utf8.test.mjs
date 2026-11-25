import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = resolve(process.env.DSH_PREFIX);
const { PluginManager } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')));
for (const stream of ['stdout', 'stderr']) for (const cut of [1, 2, 4, 5, 6]) test(`real ${stream} split UTF-8 at byte ${cut} retains text in install-log`, { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'install-utf8-'));
  const events = [];
  let ack;
  const observed = new Promise(resolve => { ack = resolve; });
  const server = createServer(async (_req, res) => { await observed; res.end('continue'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test-profile', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const text = '汉😀 complete\n';
    const script = join(dir, 'process.mjs');
    await writeFile(script, `import {writeSync} from 'node:fs';import {get} from 'node:http';
      const bytes=Buffer.from(${JSON.stringify(text)});writeSync(${stream === 'stdout' ? 1 : 2},bytes.subarray(0,${cut}));
      await new Promise((resolve,reject)=>get('http://127.0.0.1:${server.address().port}/',r=>{r.resume();r.on('end',resolve)}).on('error',reject));
      writeSync(${stream === 'stdout' ? 1 : 2},bytes.subarray(${cut}));`);
    const manager = { profile: { dir, name: 'test', home: dir, cwd: dir, installAnchor: join(prefix, 'package.json'), packageManager: { command: process.execPath, args: [script] } }, abort: new AbortController(), ownerContext: { emit: (name, data) => { events.push({ name, data }); if (data.stream === stream && data.exitCode === undefined) ack(); } }, outputBytes: 4096, idleTimeoutMs: 3000, inspectTimeoutMs: 100, packageOperations: new Set() };
    const result = await PluginManager.prototype.runPnpm.call(manager, ['--version'], undefined, 'utf8');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, text, 'final buffered output is a complete control');
    assert.equal(await readFile(result.logPath, 'utf8'), text, 'disk log bytes are a complete control');
    assert.equal(events.filter(e => e.data.stream === stream && e.data.exitCode === undefined).map(e => e.data.text).join(''), text);
    assert.equal(manager.packageOperations.size, 0);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
