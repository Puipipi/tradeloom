// Real pinned preset registry, MCP client, prompt and LLM transport. No model
// network or program execution: the existing fixture enforces that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture, requestSystemText } from './fixtures/companion-recall-engine.mjs';

const source = await readFile(new URL('../../app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/PhoneGuest.kt', import.meta.url), 'utf8');
function constant(name) {
  const marker = 'const val ' + name + ' = """';
  const start = source.indexOf(marker);
  assert(start >= 0, name + ' must be a production constant');
  const at = start + marker.length;
  return source.slice(at, source.indexOf('"""', at));
}

for (const rootExecutor of ['native', 'ptc']) test('automatic diagnostics excludes root MCP, future tools and ' + rootExecutor + ' transport', {
  skip: !process.env.DSH_PREFIX, timeout: 20000, concurrency: false,
}, async t => {
  const f = await createFixture({ rootExecutor, withRecall: false });
  t.after(() => f.dispose());
  const require = createRequire(join(f.engine.prefix, 'package.json'));
  const yaml = require('js-yaml');
  const row = yaml.load('- insert:\n' + constant('DIAGNOSTICS_PRESET_YAML'))[0].insert[0];
  const policyPath = join(f.home, 'diagnostics-policy.mjs');
  await writeFile(policyPath, constant('DIAGNOSTICS_POLICY_JS'));
  const plugins = row.config.plugins.map(plugin => ({
    ...plugin,
    name: plugin.id === 'diagnostics-policy' ? pathToFileURL(policyPath).href
      : pathToFileURL(join(f.engine.base, plugin.name.slice('@deepseek-ai/'.length), 'lib/index.js')).href,
  }));
  await f.ctx.plugin(await f.engine.load('dsh-mcp-client'), {
    serverName: 'phone', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/phone-caller-mcp.mjs', import.meta.url)), 'supported'],
    dshGoPhoneCaller: true, failOnStartupError: true, reconnect: { enabled: false },
  });
  assert(f.ctx.tools.schemas().some(tool => tool.name === 'mcp__phone__screen'));
  await f.ctx.agentPresets.register({ ...row.config, plugins });
  const { agent } = await f.createAgent('DIAGNOSTICS', { preset: row.config.id });
  const ordinary = (await f.createAgent('ORDINARY', { preset: 'ordinary' })).agent;
  let executions = 0;
  f.ctx.tools.register({ name: 'synthetic_future_global', description: 'Must not reach diagnostics',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => { executions++; return 'not allowed'; },
  });
  const signal = new AbortController().signal;
  const set = await f.ctx.tools.resolve({ agent, signal });
  t.after(() => set.dispose());
  await f.send(agent, 'Analyze these supplied failure facts only.');
  await f.send(ordinary, 'Synthetic ordinary request.');
  const diagnosticRequest = f.requests.find(request => request.sessionId === agent.id);
  const ordinaryRequest = f.requests.find(request => request.sessionId === ordinary.id);
  assert(diagnosticRequest, 'the actual transport must receive diagnostics');
  assert.equal((diagnosticRequest.body.tools ?? []).length, 0);
  assert(!requestSystemText(diagnosticRequest).includes('SYNTHETIC_RUNTIME_CONTEXT'));
  assert(!requestSystemText(diagnosticRequest).includes('run_code'));
  assert(ordinaryRequest.body.tools.some(tool => tool.name === (rootExecutor === 'ptc' ? 'run_code' : 'mcp__phone__screen')));
  const result = await f.ctx.tools.execute({ agent, toolSet: set, signal, calls: [{
    type: 'tool-call', id: 'hallucinated', name: 'synthetic_future_global', arguments: '{}',
  }] });
  assert.equal(executions, 0, 'a fabricated tool call must still be rejected server-side');
  assert.equal(result.results[0].result.isError, true);
});
