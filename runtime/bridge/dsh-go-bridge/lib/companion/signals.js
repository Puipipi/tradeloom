import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SIGNAL_EVENT_BYTES, projectRunResult } from './signals-schema.js';

const ROOT = '/dsh-go/v1/companion/signals';
const ORIGINAL = Symbol.for('cordis.original');
const MAX_STREAMS = 8;
const raw = (value) => value?.[ORIGINAL] ?? value;

async function loadEngine(ctx) {
  const anchor = ctx.get('profileContext')?.installAnchor;
  if (typeof anchor !== 'string' || !isAbsolute(anchor)) return null;
  const require = createRequire(anchor);
  const [tools, pipeline] = await Promise.all(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools/pipeline']
    .map((name) => import(pathToFileURL(require.resolve(name)).href)));
  if (tools.dshGoCompanionResultVersion !== 1 || pipeline.dshGoCompanionResultVersion !== 1
    || typeof tools.ToolsService !== 'function') return null;
  return { ToolsService: tools.ToolsService };
}

/** One bridge generation. No result listener, Session follow or history read is
 * installed until an authenticated caller explicitly opens the SSE route. */
export function createCompanionSignals(ctx) {
  const generation = randomUUID();
  const streams = new Set();
  let enginePromise, engine, closed = false, subscribed, unsubscribe, subscriptionToken;
  const ready = () => enginePromise ??= loadEngine(ctx).then((value) => { engine = value; }).catch(() => {});
  function current() {
    if (closed || !engine) return { reason: 'engine-unavailable' };
    try {
      const tools = ctx.get('tools'), owner = raw(tools), api = tools?.dshGoCompanionResults;
      if (!(owner instanceof engine.ToolsService) || owner.ctx.fiber.state !== 2 || api?.version !== 1
        || typeof api.subscribe !== 'function' || typeof api.hasProducer !== 'function') return { reason: 'engine-unavailable' };
      if (!api.hasProducer(tools.get('bash'))) return { reason: 'producer-unavailable' };
      return { api, reason: null };
    } catch { return { reason: 'engine-unavailable' }; }
  }
  function capability() {
    const { reason } = current();
    return { v: 1, generation, available: reason === null, reason,
      kinds: reason === null ? ['run.result'] : [], maxEventBytes: SIGNAL_EVENT_BYTES,
      replay: false, counts: false, devicePower: { available: false }, notifications: { available: false } };
  }
  function releaseSource() {
    if (streams.size !== 0) return;
    subscriptionToken = undefined;
    unsubscribe?.(); unsubscribe = undefined; subscribed = undefined;
  }
  function retireStreams(reason) {
    for (const stream of [...streams]) stream.close(reason);
    releaseSource();
  }
  function checkSource() {
    if (streams.size === 0) return;
    const source = current();
    if (source.reason !== null || source.api !== subscribed) retireStreams(source.reason ?? 'engine-unavailable');
  }
  const stopTools = ctx.on('tools/change', checkSource);
  const stopStatus = ctx.on('internal/status', checkSource);
  function onRecord(record) {
    checkSource();
    if (streams.size === 0) return;
    const event = projectRunResult(record, generation);
    if (!event) return;
    for (const stream of [...streams]) stream.write('companion/run-result', event, event.id);
  }
  function open(req, res, api) {
    const stream = {
      timer: undefined, closed: false,
      write(name, value, id) {
        if (stream.closed || res.destroyed) { stream.close(); return; }
        try {
          if (!res.write(`${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)) stream.close(undefined, true);
        } catch { stream.close(undefined, true); }
      },
      close(reason, destroy = false) {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(stream.timer);
        req.off('aborted', onClose); res.off('close', onClose); res.off('error', onClose);
        streams.delete(stream);
        try {
          if (destroy) res.destroy();
          if (!res.destroyed && reason && !res.write(`event: companion/unavailable\ndata: ${JSON.stringify({ v: 1, generation, reason })}\n\n`)) res.destroy();
          if (!res.destroyed) res.end();
        } catch { res.destroy(); }
        releaseSource();
      },
    };
    const onClose = () => stream.close();
    req.on('aborted', onClose); res.on('close', onClose); res.on('error', onClose);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'connection': 'keep-alive', 'x-accel-buffering': 'no' });
    streams.add(stream);
    if (!unsubscribe) {
      const token = {};
      subscribed = api; subscriptionToken = token;
      unsubscribe = api.subscribe((record) => {
        if (subscriptionToken === token && subscribed === api) onRecord(record);
      });
    }
    stream.write('companion/ready', { v: 1, generation });
    if (!stream.closed) {
      stream.timer = setInterval(() => {
        checkSource();
        if (!stream.closed) try { if (!res.write(': keepalive\n\n')) stream.close(undefined, true); } catch { stream.close(undefined, true); }
      }, 25000);
      stream.timer.unref?.();
    }
  }
  return {
    async capability() { await ready(); return capability(); },
    async handle(req, res, path, send) {
      if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return false;
      req.resume();
      const fail = (status, code, message) => send(res, status, { error: { code: `companion/signals-${code}`, message } });
      if (![ROOT, `${ROOT}/stream`].includes(path)) { fail(404, 'not-found', 'Signal route not found'); return true; }
      if (req.method !== 'GET') { fail(405, 'method', 'Method not allowed'); return true; }
      await ready();
      if (req.aborted || res.destroyed) return true;
      if (path === ROOT) { send(res, 200, capability()); return true; }
      const source = current();
      if (source.reason !== null) { fail(503, 'unavailable', 'Live run summaries are unavailable on this host'); return true; }
      checkSource();
      if (streams.size >= MAX_STREAMS) { fail(503, 'capacity', 'Too many live signal subscriptions'); return true; }
      open(req, res, source.api);
      return true;
    },
    dispose() {
      if (closed) return;
      closed = true;
      retireStreams('engine-unavailable');
      stopTools?.(); stopStatus?.();
    },
  };
}
