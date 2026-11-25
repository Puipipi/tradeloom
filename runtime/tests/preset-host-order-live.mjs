import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const prefix = resolve(process.env.DSH_PREFIX);
const dart = resolve(process.env.DART_BIN);
const source = resolve(process.env.DSH_SOURCE ?? fileURLToPath(new URL('../..', import.meta.url)));
const evidence = process.env.DSH_EVIDENCE_DIR ? resolve(process.env.DSH_EVIDENCE_DIR) : undefined;
if (evidence) await mkdir(evidence, {recursive:true});
const root = await mkdtemp(join(tmpdir(), 'own-activation-'));
const home = join(root, 'home'), workspace = join(root, 'workspace');
await mkdir(home); await mkdir(workspace);
let modelRequests = 0;
const model = createServer((_req, res) => { modelRequests++; res.statusCode = 500; res.end('Unexpected own model request'); });
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const patch = ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','desktop-product-telemetry','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web'].map(id => ({ id, disabled: true }));
patch.push({ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: 'OWN_UNUSED_KEY' } }, { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } }, { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } }, { id: 'permission', config: { defaultPreset: 'danger-full-access' } }, { id: 'fs-sandbox', config: { cwd: workspace } });
patch.push({insert: [
 {id:'own-low',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-low',order:1,plugins:[]}},
 {id:'own-fraction',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-fraction',order:0.5,plugins:[]}},
 {id:'own-tie-b',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-tie-b',order:2,plugins:[]}},
 {id:'own-tie-a',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-tie-a',order:2,plugins:[]}},
 {id:'own-high',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-high',order:1048577,plugins:[]}},
 {id:'own-unspecified',name:'@deepseek-ai/dsh-agent-preset',config:{id:'own-unspecified',plugins:[]}}
]});
const patchPath = join(root, 'patch.json'); await writeFile(patchPath, JSON.stringify(patch));
const inherited = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const env = { ...inherited, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', OWN_UNUSED_KEY: 'synthetic-unused', FLUTTER_SUPPRESS_ANALYTICS: 'true', DART_SUPPRESS_ANALYTICS: 'true', CI: 'true' };
const child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'close');
const ready = Promise.withResolvers();
let hostText = '';
const receive = chunk => {
  hostText += chunk;
  const found = hostText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
  if (found) ready.resolve(found[0]);
};
child.stdout.on('data', receive); child.stderr.on('data', receive);
const watchdog = setTimeout(() => child.kill('SIGKILL'), 45000);
try {
  const launch = await Promise.race([ready.promise, exited.then(() => { throw Error('Own Host exited before ready'); })]);
  const test = spawn(dart, ['--packages='+resolve(process.env.DSH_PACKAGE_CONFIG ?? join(source, 'packages/dsh_client/.dart_tool/package_config.json')), join(source, 'packages/dsh_client/tool/preset_host_order_live.dart')], { cwd: root, env: { ...env, OWN_LAUNCH: launch, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  test.stdout.on('data', c => output += c); test.stderr.on('data', c => output += c);
  const [code] = await once(test, 'close');
  const clean = output.replace(/token=[\w-]+/g, 'token=[REDACTED]');
  if (evidence) await writeFile(join(evidence, 'dart.log'), clean); console.log(clean);
  console.log(JSON.stringify({dartExit:code}));
  assert(!hostText.includes('did not activate'), 'Host has inactive required entries');
  assert.equal(modelRequests, 0);
  assert.equal(code, 0, 'Dart experiment failed');
  console.log(JSON.stringify({ modelRequests, hostEntriesActive: true }));
} finally {
  child.kill('SIGTERM'); await exited; clearTimeout(watchdog);
  if (evidence) await writeFile(join(evidence, 'host.log'), hostText.replace(/token=[\w-]+/g, 'token=[REDACTED]'));
  model.closeAllConnections(); await new Promise(r => model.close(r));
  await rm(root, { recursive: true, force: true });
}
