// Controlled catch-priority checks on the production controller constructor.
// Loaded only by session-preset-resume-errors.test.mjs in its private Host.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const protocol = join(process.env.DSH_PREFIX, 'node_modules/@deepseek-ai/dsh-typert-protocol/lib');
const { RemoteError } = await import(pathToFileURL(join(protocol, 'index.js')));
const { RemoteError: OtherRemoteError } = await import(pathToFileURL(join(protocol, 'types/remote-error.js')));
export const inject = ['sessionController', 'webServer', 'connection'];

async function check(ctx, mode) {
  const id = 'synthetic-controlled-resume';
  let live, attached, calls = 0;
  const Controller = ctx.sessionController.agents.constructor;
  const controller = new Controller({
    agents: { get: () => live, isOwnedBy: () => false },
    sessions: { get: () => attached },
  });
  const details = { agentPreset: 'synthetic-removed', available: ['standard'] };
  const presetError = new RemoteError('agent-preset/not-found', 'Synthetic missing preset', details);
  controller.resume = async () => {
    calls++;
    if (mode === 'generic') throw new Error('Synthetic read failure');
    if (mode === 'unrelated') throw new RemoteError('synthetic/unrelated', 'Synthetic other failure', { private: true });
    if (mode === 'foreign') throw new OtherRemoteError(presetError.code, presetError.message, details);
    if (mode === 'writer') {
      const error = new Error('Synthetic writer already held');
      error.name = 'SessionAlreadyOwnedError';
      throw error;
    }
    if (mode === 'live') live = { id, session: { header: { id } } };
    else if (mode === 'subagent') attached = { header: { id, origin: 'subagent' } };
    else throw new Error('Unexpected synthetic mode');
    throw presetError;
  };
  const result = await controller.resolveAgent(id);
  return {
    code: result.error?.code ?? null,
    details: result.error?.details ?? null,
    agentMatches: live !== undefined && result.agent === live,
    calls,
    separateBundleClass: OtherRemoteError !== RemoteError,
  };
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/synthetic-preset-resume-controls',
    handler: async (req, res) => {
      const rejected = ctx.connection.requestRejection(req);
      if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
      const mode = new URL(req.url, 'http://localhost').searchParams.get('mode');
      if (!['generic', 'unrelated', 'foreign', 'writer', 'live', 'subagent'].includes(mode)) {
        res.writeHead(400); res.end(); return;
      }
      const result = await check(ctx, mode);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    },
  }));
}
