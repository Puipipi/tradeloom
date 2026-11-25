// Test-only route. Runs inside each real released `dsh web` process.
export const name = 'profile-upgrade-observer';
export const inject = ['credentials', 'workspaceRegistry', 'configEditor', 'webServer', 'connection'];

export function apply(ctx) {
  const entry = () => ctx.configEditor.entries().find(row => row.options.id === 'profile-upgrade-fixture');
  async function snapshot() {
    const target = entry();
    const config = target.fiber.effectiveConfig ?? target.fiber.config;
    const reference = await ctx.credentials.resolve('W17_UPGRADE_SYNTHETIC');
    const record = await ctx.credentials.readRecord('wave17/account');
    return {
      credentialPreserved: reference?.value === '00012345',
      continuedCredential: (await ctx.credentials.resolve('W17_CONTINUED_SYNTHETIC'))?.value === '009876',
      record,
      plugin: { ordinary: config.ordinary, live: config.live.get() },
      workspaces: ctx.workspaceRegistry.list().map(workspace => ({
        id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds,
      })),
    };
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/profile-upgrade-observer', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { res.writeHead(rejection.status); res.end(); return; }
    try {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        if (request.operation === 'seed') {
          await ctx.credentials.set('W17_UPGRADE_SYNTHETIC', '00012345');
          await ctx.credentials.modifyRecord('wave17/account', () => ({ kind: 'grant', payload: { count: 7, enabled: true } }));
          const workspace = await ctx.workspaceRegistry.create(request.project, '旧版工作区');
          await workspace.attachSession(request.sessionId);
          await ctx.configEditor.edit(entry(), current => ({ ...current, ordinary: 'persisted-by-rc4', live: 'old-live-value' }));
        } else if (request.operation === 'continue') {
          await ctx.credentials.set('W17_CONTINUED_SYNTHETIC', '009876');
          await ctx.credentials.modifyRecord('wave17/account', current => ({ ...current, payload: { ...current.payload, count: 8 } }));
          await ctx.workspaceRegistry.get(request.workspaceId).setTitle('新版继续使用');
          await ctx.configEditor.edit(entry(), current => ({ ...current, ordinary: 'continued-by-rc1', live: 'new-live-value' }));
        } else throw new Error('Unknown test operation');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await snapshot()));
    } catch (error) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  } }));
}
