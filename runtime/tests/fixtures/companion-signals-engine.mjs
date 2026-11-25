// Real pinned bash tool, native pipeline, LocalBashExecutor and
// LocalSubprocessRuntime. Only the Session cwd lookup is a controlled fixture
// boundary. The subprocess spawn hook removes Node's parent test-runner marker
// so nested `node --test` runs use their normal exit contract; it still delegates
// to the real child_process.spawn. No process result is stubbed; no model calls.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture } from './companion-recall-engine.mjs';
import { createCompanionSignals } from '../../bridge/dsh-go-bridge/lib/companion/signals.js';

export async function createSignalsFixture(options = {}) {
  // Under `node --test` this process carries NODE_TEST_CONTEXT, and a nested
  // `node --test` that inherits it reports to a parent instead of exiting
  // non-zero on failure: the fixture's failing test would read as a success.
  // Not every spawn path the bash tool takes goes through the hook below, so
  // it goes from this process's environment too. Deleted here, inside a
  // running test, and not at module load: by now this process's own
  // reporting mode is fixed.
  delete process.env.NODE_TEST_CONTEXT;
  const f = await createFixture({ prefix: process.env.DSH_PREFIX, withRecall: false });
  try {
    if (options.sandbox) {
      // Exercise the actual SandboxBashExecutor/classifier while the OS
      // confinement boundary deliberately passes through the harmless argv.
      f.ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) });
      f.ctx.provide('sandbox', { confine: async (argv) => ({ argv, enforcement: 'synthetic-pass-through',
        denialSignatures: ['permission denied'], runnerFailureRules: [] }) });
    }
    for (const name of ['dsh-subprocess-local', options.sandbox ? 'dsh-bash-sandbox' : 'dsh-bash-local', 'dsh-shell-env']) {
      const module = await f.engine.load(name);
      await f.ctx.plugin(module.default ?? module, { cwd: f.home, timeoutMs: 5000, graceMs: 50 }).await();
    }
    f.ctx.subprocess.internals.spawn = (program, args, options) => {
      const env = { ...options.env };
      delete env.NODE_TEST_CONTEXT;
      return spawn(program, args, { ...options, env });
    };
    f.ctx.provide('workingDirectory', { ensure: async () => f.home });
    if (options.jobs) {
      const { default: LocalJobRegistry } = await f.engine.load('dsh-jobs-local');
      await f.ctx.plugin(LocalJobRegistry, { pumpPollMs: 10 }).await();
      f.ctx.jobs.attachController('c760-fixture');
    }
    const bash = f.ctx.plugin(await f.engine.load('dsh-tool-bash'), {
      enableRunInBackground: Boolean(options.jobs), promoteOnTimeout: Boolean(options.jobs),
    });
    await bash.await();
    const signals = createCompanionSignals(f.ctx);
    const { agent } = await f.createAgent(`c760-${randomUUID()}`, { preset: 'ordinary' });
    await writeFile(join(f.home, 'success.test.mjs'), "import test from 'node:test'; test('PRIVATE_OUTPUT_SENTINEL',()=>{});\n");
    await writeFile(join(f.home, 'failed.test.mjs'), "import test from 'node:test'; test('PRIVATE_FAILURE_SENTINEL',()=>{throw new Error('PRIVATE_ERROR_BODY')});\n");
    await writeFile(join(f.home, 'slow.test.mjs'), "import test from 'node:test'; test('slow',async()=>{await new Promise(r=>setTimeout(r,2000))});\n");
    const records = [], stop = f.ctx.tools.dshGoCompanionResults.subscribe((record) => records.push(record));
    let turn = 0;
    async function execute(command, { signal = new AbortController().signal, name = 'bash', args, callId = randomUUID(), ...extra } = {}) {
      const position = { turn: ++turn, step: 1 };
      const session = agent.session;
      session.append('turn/start', { turn });
      session.append('step/start', position);
      try {
        const result = await f.ctx.tools.execute({ agent, signal, log: position, calls: [{
          type: 'tool-call', id: callId, name,
          arguments: JSON.stringify(args ?? { command, description: 'Execute a synthetic verification command', ...extra }),
        }] });
        return { result: result.results[0].result, position, callId };
      } finally {
        // A Session-swap adversarial test restores the original before return.
        session.append('step/end', position);
        session.append('turn/end', { turn, reason: { kind: 'completed' } });
      }
    }
    const dispose = f.dispose;
    return { ...f, agent, signals, records, bash, execute,
      async dispose() { stop(); signals.dispose(); await dispose(); } };
  } catch (error) { await f.dispose(); throw error; }
}
