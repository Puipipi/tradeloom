import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const { readColdSessionLog } = await import(pathToFileURL(join(process.env.DSH_PREFIX,
  'node_modules/@deepseek-ai/dsh-session-query/lib/index.js')));

export const inject = ['sessionController', 'sessions', 'sessionPersistence', 'workspaceChanges', 'fs'];
export function apply(ctx) {
  let ticket = 0, injected = false, signals = 0;
  const acknowledgements = new Map();
  const signal = new AbortController().signal;
  const captureFacts = [];
  const logs = [];
  let phase = 'before-first-capture';
  ctx.logger.exporter({ levels: { default: 3 }, export: ({ ts, name, type, args }) => {
    if (type === 'warn' || type === 'error') logs.push({ ts, name, type, phase,
      args: args.map(value => typeof value === 'string' ? value : String(value)) });
  } });
  const onSignal = () => { signals++; };
  process.on('SIGXFSZ', onSignal);
  ctx.effect(() => () => process.off('SIGXFSZ', onSignal));
  function limit(op) {
    return new Promise((resolve, reject) => {
      const id = ++ticket;
      acknowledgements.set(id, { resolve, reject });
      process.send({ kind: 'limit-request', ticket: id, op });
    });
  }
  async function captureFiles() {
    const results = [];
    for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('dsh-workspace-changes-')) continue;
      const directory = join(tmpdir(), entry.name, 'captures');
      let files;
      try { files = await readdir(directory); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of files) {
        const path = join(directory, name);
        results.push({ name, size: (await stat(path)).size, text: await readFile(path, 'utf8') });
      }
    }
    return results;
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    if (injected || ctx.fs.processPath(target) !== join(process.cwd(), 'own.txt')) return next();
    injected = true;
    phase = 'capture';
    await limit('set');
    try { return await next(); }
    finally {
      await limit('restore');
      captureFacts.push(...await captureFiles());
    }
  }, { prepend: true });
  process.on('message', async message => {
    if (message?.kind === 'limit-ack') {
      const pending = acknowledgements.get(message.ticket);
      acknowledgements.delete(message.ticket);
      if (pending) message.error ? pending.reject(new Error(message.error)) : pending.resolve();
      return;
    }
    if (message?.kind !== 'run') return;
    try {
      const { sessionId } = await ctx.sessionController.create({ cwd: process.cwd() });
      const turnFiles = [], waits = [];
      for (let turn = 1; turn <= 2; turn++) {
        await ctx.sessionController.prompt({ sessionId, requestId: `own-capture-${turn}`,
          content: [{ type: 'text', text: `Read own.txt, then perform the provided ordinary write for turn ${turn}, and finish.` }] }, signal);
        waits.push(await ctx.sessionController.wait({ sessionId, timeoutMs: 30000 }, signal));
        turnFiles.push(await readFile(join(process.cwd(), 'own.txt'), 'utf8'));
      }
      const session = ctx.sessions.get(sessionId);
      await ctx.sessions.flush(session);
      const events = session.snapshotEvents();
      const durable = await readColdSessionLog(ctx.sessionPersistence, sessionId, signal);
      assert.deepEqual(durable.events, events, 'The actual validated persisted log equals the live log after both turns.');
      const toolResults = events.filter(event => event.type === 'tool/result').map(event => event.data);
      const summaries = [];
      for (const event of events.filter(event => event.type === 'workspace/changes')) {
        const summary = ctx.workspaceChanges.summary(sessionId, event.seq);
        const diffs = [];
        for (let index = 0; index < summary.files.length; index++) {
          diffs.push(await ctx.workspaceChanges.diff(sessionId, event.seq, index, signal));
        }
        summaries.push({ seq: event.seq, summary, diffs });
      }
      assert.equal(acknowledgements.size, 0);
      process.send({ kind: 'result', injected, signals, logs, captureFacts, turnFiles, waits, toolResults, summaries,
        durableEventCount: durable.events.length, durableEventsEqualLive: true,
        finalCaptures: await captureFiles(), events: events.map(event => ({ seq: event.seq, type: event.type })) });
    } catch (error) { process.send({ kind: 'result', error: String(error.stack) }); }
  });
}
