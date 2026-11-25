// Local test-only gates around the real Host deletion hook, never a replacement seam.
export const inject = ['sessionPersistence', 'webServer', 'agents', 'sessions'];
export function apply(ctx) {
  const storage = ctx.sessionPersistence;
  const seam = storage.dshGoDeletion;
  const original = seam.delete;
  const create = storage.create;
  storage.create = async function (...args) {
    const writer = await create.apply(this, args);
    // Hold the existing batching window, so the first deletion is deterministically pre-durable.
    // drainLive/flush/close are the original methods and still perform every real write.
    writer.drainPaused = true;
    return writer;
  };
  const attempts = new Map();
  const gates = new Map();
  const snapshot = (id) => {
    const writer = storage.tracker.writers.get(id);
    const agent = ctx.agents.get(id);
    return {pending: seam.pending.has(id), deleted: seam.deleted(id), agent: !!agent,
      deleting: agent?.dshGoDeleting === true, session: !!ctx.sessions.get(id), writer: !!writer,
      buffered: writer?.buffered.length ?? 0, materialized: writer?.state.materialized ?? false};
  };
  seam.delete = async (id, hooks) => {
    const gate = gates.get(id);
    const before = snapshot(id);
    const writer = storage.tracker.writers.get(id);
    const agent = ctx.agents.get(id);
    try {
      return await original.call(seam, id, {...hooks, dispose: async (sessionId, options) => {
        // Gate the real disposal point: the fence is already held and no agent is torn down yet.
        if (gate) {
          gate.entered = true;
          await gate.promise;
          if (gate.fail) throw new Error('synthetic dispose failure');
        }
        await hooks.dispose(sessionId, options);
      }});
    } finally {
      attempts.set(id, {before, after: snapshot(id), capturedWriter: writer && {
        buffered: writer.buffered.length, materialized: writer.state.materialized, closing: !!writer.closing,
      }, capturedAgent: agent && {deleting: agent.dshGoDeleting === true, phase: agent.phase.kind}});
      gates.delete(id);
    }
  };
  ctx.effect(() => ctx.webServer.register({kind: 'prefix', path: '/local-deletion-test', handler: async (req, res) => {
    const u = new URL(req.url, 'http://localhost'); const id = u.searchParams.get('id');
    let value;
    try {
      switch (u.pathname.split('/').at(-1)) {
        case 'snapshot': value = {current: snapshot(id), attempt: attempts.get(id)}; break;
        case 'flush': await storage.flush(); value = {flushed: true}; break;
        case 'arm': {
          let release; const promise = new Promise((resolve) => { release = resolve; });
          gates.set(id, {promise, release, entered: false, fail: u.searchParams.has('fail')});
          value = {armed: true}; break;
        }
        case 'entered': value = {entered: gates.get(id)?.entered === true}; break;
        case 'release': gates.get(id).release(); value = {released: true}; break;
        case 'open': await storage.open(id, 'write'); value = {opened: true}; break;
        case 'clone-create': {
          const header = {...storage.tracker.writers.get(id).header};
          await storage.create(header); value = {created: true}; break;
        }
        default: throw new Error('unknown test action');
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({name: e.name, message: e.message})); }
  }}));
}
