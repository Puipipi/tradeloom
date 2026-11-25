// Test-only DSH plugin. It is copied into the host fixture and never shipped.
// Runs the registered tools/provider contracts, including normal policy hooks.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-app-direct-host-probe';
export function apply(ctx) {
  ctx.inject(['webServer', 'agents', 'sessionController'], (probe) => {
    async function files(agent) {
      const tools = agent.ctx.get('tools');
      if (!tools) throw new Error('session tools provider absent');
      const id = randomUUID();
      const filename = process.env.DSH_GO_HOST_PROBE_FILE ?? `/root/workspace/direct-probe-${id}.txt`;
      const content = `direct-tool-write-read:${id}\n`;
      // The timed operation updates an existing observed file in both modes.
      // New-file creation with PRoot link2symlink is covered separately: its
      // directory-entry/identity mismatch must not be hidden in a timing test.
      const observed = process.env.DSH_GO_HOST_PROBE_FILE ? await tools.execute({ callId: `${id}:observe`, name: 'read', agent,
        arguments: { file_path: filename }, signal: AbortSignal.timeout(5000) }) : null;
      const start = performance.now();
      const write = await tools.execute({ callId: `${id}:write`, name: 'write', agent,
        arguments: { file_path: filename, content }, signal: AbortSignal.timeout(5000) });
      const written = performance.now();
      const read = await tools.execute({ callId: `${id}:read`, name: 'read', agent,
        arguments: { file_path: filename }, signal: AbortSignal.timeout(5000) });
      const done = performance.now();
      const denied = await tools.execute({ callId: `${id}:deny`, name: 'write', agent,
        arguments: { file_path: `/root/direct-probe-denied-${id}.txt`, content }, signal: AbortSignal.timeout(5000) });
      return { requested: filename, expected: content.trim(), observed, write, read,
        denied, writeMs: written - start, readMs: done - written, totalMs: done - start };
    }
    async function terminal(agent) {
      const start = performance.now();
      const subprocess = agent.ctx.get('subprocess');
      if (!subprocess) throw new Error('session subprocess provider absent');
      const handle = await subprocess.spawnTerminal({
        argv: ['/bin/bash', '-c', 'printf "direct-pty-ok\\n"; printf "cwd="; pwd -P; python3 -c "print(6*7)"'],
        cwd: '/root/workspace', rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 1000,
      });
      let output = '';
      const drained = (async () => { for await (const bytes of handle.output) output += bytes.toString(); })();
      try {
        const outcome = await handle.done;
        await drained;
        return { output, outcome, totalMs: performance.now() - start };
      } finally { await handle.terminate(); }
    }
    async function instructions(agent) {
      const { loadBaselineInstructions } = await import('/opt/dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js');
      const cwd = await agent.ctx.get('workingDirectory').ensure(agent, AbortSignal.timeout(5000));
      return { cwd, result: await loadBaselineInstructions({ cwd, dshHome: process.env.DSH_HOME,
        maxBytes: 65536, signal: AbortSignal.timeout(5000) }, agent.ctx.get('fs')) };
    }
    async function identity(agent) {
      return { sessionId: agent.id, headerCwd: agent.session.header.cwd,
        effectiveCwd: await agent.ctx.get('workingDirectory').ensure(agent, AbortSignal.timeout(5000)),
        dshHome: process.env.DSH_HOME };
    }
    const actions = { files, terminal, instructions, identity };
    probe.effect(() => probe.webServer.register({ kind: 'prefix', path: '/direct-host-probe', handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const action = url.pathname.split('/').at(-1);
      try {
        if (!Object.hasOwn(actions, action)) throw new Error('unknown probe');
        const sessionId = url.searchParams.get('sessionId');
        let agent = probe.agents.get(sessionId);
        if (!agent) {
          const found = await probe.sessionController.resolveAgent(sessionId);
          if ('error' in found) throw found.error;
          agent = found.agent;
        }
        const result = await actions[action](agent);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error), stack: error?.stack }));
      }
    } }), 'direct-host-probe route');
  });
}
