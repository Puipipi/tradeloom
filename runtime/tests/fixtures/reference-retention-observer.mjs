import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = join(process.env.DSH_PREFIX, 'node_modules/@deepseek-ai');
const { Session } = await import(pathToFileURL(join(base, 'dsh-session/lib/index.js')));
const { createUserMessage } = await import(pathToFileURL(join(base, 'dsh-llm/lib/index.js')));
const { formatSessionReferenceMention } = await import(pathToFileURL(join(base, 'dsh-session-reference/lib/index.js')));
export const inject = ['sessionController', 'sessions', 'sessionPersistence', 'sessionQuery'];
export function apply(ctx) {
  let sessionId, sourceId, size, started;
  const signal = new AbortController().signal;
  const reads = [], snapshots = [], claims = [];
  let readOpens = 0;
  const query = ctx.sessionQuery;
  const persistence = ctx.sessionPersistence;
  const originalRead = query.readSurface.bind(query);
  query.readSurface = async function (id) {
    const begin = performance.now();
    const value = await originalRead(id);
    if (id === sourceId) {
      reads.push({ elapsedMs: performance.now() - begin, capturedThroughSeq: value.capturedThroughSeq,
        eventCount: value.events.length });
      snapshots.push(value);
    }
    return value;
  };
  const originalOpen = persistence.open.bind(persistence);
  persistence.open = function (id, access, ...rest) {
    if (id === sourceId && access === 'read') readOpens++;
    return originalOpen(id, access, ...rest);
  };
  ctx.on('agent/pre-step', async ({agent, messages}, next) => {
    if (agent.session.id === sessionId) claims.push(messages.filter(m => m.source.kind === 'user').map(m => m.content));
    return next();
  });
  process.on('message', async message => {
    try {
      if (message?.kind === 'run') {
        size = message.size;
        sourceId = `own-reference-${size}`;
        const source = Session.create(sourceId, [], { id: sourceId, version: 4, isSeeded: false, cwd: process.cwd(), createdAt: Date.now() });
        source.append('user/message', createUserMessage({ source: {kind:'user'}, content: [{type:'text',text:'x'.repeat(size)}] }), {surfaceOp:'append'});
        const handle = await persistence.create(source.header);
        try { await handle.append(source.snapshotEvents()); await handle.flush(); }
        finally { await handle.close(); }
        assert.equal(ctx.sessions.get(sourceId), undefined);
        ({ sessionId } = await ctx.sessionController.create({ cwd: process.cwd() }));
        await ctx.sessionController.prompt({sessionId,requestId:'own-start',content:[{type:'text',text:'Start this ordinary turn.'}]},signal);
      }
      if (message?.kind === 'queue') {
        const mention = formatSessionReferenceMention({sessionId:sourceId,label:'own source'});
        for (let i=0;i<2;i++) await ctx.sessionController.prompt({sessionId,mode:'steer',requestId:`own-queued-${i}`,content:[{type:'text',text:`Reference ${i}: ${mention}`}]},signal);
        started = performance.now();
        process.send?.({kind:'queued'});
        const waited = await ctx.sessionController.wait({sessionId,timeoutMs:30000},signal);
        process.send?.({kind:'result', waited, elapsedMs:performance.now()-started, sourceCold:ctx.sessions.get(sourceId)===undefined,
          reads, readOpens, snapshotsIndependent:snapshots.length===2 && snapshots[0]!==snapshots[1] && snapshots[0].events!==snapshots[1].events, claims});
      }
    } catch(error) { process.send?.({kind:'result',error:String(error.stack)}); }
  });
}
