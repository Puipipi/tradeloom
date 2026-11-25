// Test-only routes. Session creation uses the real production RPC and controller.
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'dsh-direct-nonroot-test';

export function apply(ctx) {
  ctx.inject(['webServer', 'agents', 'sessionController'], (probe) => {
    async function preflight() {
      if (process.geteuid() === 0) throw new Error('probe requires a non-root effective UID');
      const root = process.env.DSH_GO_DIRECT_ROOTFS;
      const hostRoot = await stat('/root');
      let hostRootWritable = true;
      try { await access('/root', constants.W_OK | constants.X_OK); }
      catch { hostRootWritable = false; }
      const status = await readFile('/proc/self/status', 'utf8');
      const controller = await readFile(`${root}/opt/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`);
      return {
        uid: process.getuid(), euid: process.geteuid(),
        gid: process.getgid(), egid: process.getegid(), groups: process.getgroups(),
        capabilities: status.split('\n').filter((line) => /^Cap(?:Inh|Prm|Eff|Bnd|Amb):/u.test(line)),
        hostRoot: { uid: hostRoot.uid, gid: hostRoot.gid, mode: hostRoot.mode & 0o777, writable: hostRootWritable },
        runtimeRoot: root,
        mappedWorkspace: globalThis[Symbol.for('dsh.go.direct')].toHost('/root/workspace'),
        controllerSha256: createHash('sha256').update(controller).digest('hex'),
        nodeVersion: process.version,
      };
    }

    async function files(agent) {
      if (process.geteuid() === 0) throw new Error('probe requires a non-root effective UID');
      const root = process.env.DSH_GO_DIRECT_ROOTFS;
      const cwd = await agent.ctx.get('workingDirectory').ensure(agent, AbortSignal.timeout(5000));
      if (cwd !== `${root}/root/workspace`) throw new Error(`unexpected writable fixture cwd: ${cwd}`);
      const tools = agent.ctx.get('tools');
      const id = randomUUID();
      const filename = `/root/workspace/nonroot-${id}.txt`;
      const content = `Direct non-root tool round trip: ${id}\n`;
      const write = await tools.execute({ callId: `${id}:write`, name: 'write', agent,
        arguments: { file_path: filename, content }, signal: AbortSignal.timeout(5000) });
      const read = await tools.execute({ callId: `${id}:read`, name: 'read', agent,
        arguments: { file_path: filename }, signal: AbortSignal.timeout(5000) });
      return { sessionId: agent.id, headerCwd: agent.session.header.cwd, effectiveCwd: cwd,
        uid: process.getuid(), euid: process.geteuid(), filename,
        physicalFilename: `${root}${filename}`, content, write, read };
    }

    probe.effect(() => probe.webServer.register({
      kind: 'prefix', path: '/direct-nonroot-test', handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const action = url.pathname.split('/').at(-1);
          let result;
          if (action === 'preflight') {
            result = await preflight();
          } else if (action === 'files') {
            const found = await probe.sessionController.resolveAgent(url.searchParams.get('sessionId'));
            if ('error' in found) throw found.error;
            result = await files(found.agent);
          } else {
            throw new Error('unknown test action');
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error), stack: error?.stack }));
        }
      },
    }), 'direct-nonroot-test route');
  });
}
