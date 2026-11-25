// v1.3 selected files: authenticated same-host uploads, scoped to one tapped action.
// These are read-only snapshots, not a sandbox for same-process Node plugins.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { FILE_LIMITS as L, PICKER_TYPES } from './capabilities.js';
import { normalize, splitPending } from './effects.js';
import { PROTOCOL } from './limits.js';
import { call, cleanLine, errorText, isPlainObject, truncateChars, withTimeout } from './util.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

export class FilePickerRuntime {
  constructor(core, { fail, sendJson, readJsonBody }) {
    this.core = core;
    this.fail = fail;
    this.sendJson = sendJson;
    this.readJsonBody = readJsonBody;
    this.requests = new Map();
    this.cacheBytes = 0;
    this.delivery = new AsyncLocalStorage();
    this.read = (pkg, handle) => {
      const e = this.delivery.getStore();
      const file = e?.files.find(f => f.handle === handle);
      if (!e || e.pkg !== pkg || !e.delivering || !this.alive(e) || !file) throw new Error('picked file is no longer readable');
      return Buffer.from(file.buffer.subarray(0, file.bytes));
    };
    core.pickedFileRead = this.read;
    this.off = core.onChanged(() => {
      for (const e of [...this.requests.values()]) if (!this.alive(e)) this.revoke(e);
    });
  }

  captureInvocation(rec, { kind, registration, panel, handler }) {
    const actions = panel?.def.actions;
    return {
      origin: { uid: rec.uid, stamp: rec.stamp, kind, token: registration.token },
      // Copy own functions before calling the action. A mutable actions object
      // must not change the callback selected by an already running invocation.
      panel: panel && { token: panel.token, actions: new Map(Object.getOwnPropertyNames(actions ?? {}).map(k => [k, actions[k]])) },
      handler: handler && { token: handler.token, fn: handler.def },
    };
  }

  originAlive(pkg, id, origin) {
    const rec = this.core.plugin(pkg);
    return origin && rec && this.core.stateOf(rec) === 'ok'
      && rec.uid === origin.uid && rec.stamp === origin.stamp
      && this.core.registration(pkg, origin.kind, id)?.token === origin.token;
  }

  alive(e) {
    return this.requests.get(e.request) === e && !e.controller.signal.aborted
      && e.conn.helloed && !e.conn.ws.closed && e.conn.features?.includes('files')
      && this.originAlive(e.pkg, e.id, e.origin)
      && this.core.registration(e.pkg, e.kind, e.id)?.token === e.token;
  }

  bind(effects, rec, conn, scope, locale, source, issues, invocation) {
    return effects.filter(effect => {
      if (!PICKER_TYPES.includes(effect.type)) return true;
      const reject = message => { issues.push({ path: '/runtime/effects', code: 'bad-effect', severity: 'warn', message }); return false; };
      if (!this.originAlive(rec.pkg, source.id, invocation?.origin)) return reject('file selection action registration was unloaded or changed');
      if (!conn?.helloed || conn.ws.closed || !conn.features?.includes('files')) return reject('file selection needs a live files stream');
      if (this.requests.size >= L.requests || [...this.requests.values()].some(e => e.conn === conn)) return reject('a file selection is already active or the host is busy');
      let kind = 'panels', reg = invocation.panel;
      let fn = reg?.actions.get(effect.action);
      if (typeof fn !== 'function') { kind = 'handlers'; reg = invocation.handler; fn = reg?.fn; }
      if (typeof fn !== 'function') return reject('file selection callback was not registered at invocation');
      if (this.core.registration(rec.pkg, kind, source.id)?.token !== reg.token) return reject('file selection callback registration was unloaded or changed');
      const request = randomBytes(24).toString('base64url');
      const e = { request, pkg: rec.pkg, origin: invocation.origin, conn, scope, locale,
        surface: source.surface, id: source.id, action: effect.action, kind, token: reg.token, fn,
        maxFiles: effect.maxFiles, files: [], bytes: 0, controller: new AbortController() };
      this.requests.set(request, e);
      if (!this.alive(e)) { this.revoke(e); return reject('file selection callback was unloaded'); }
      e.timer = setTimeout(() => this.revoke(e), L.requestMs);
      e.timer.unref?.();
      Object.assign(effect, { request, maxBytes: L.bytes, maxTotalBytes: L.totalBytes });
      return true;
    });
  }

  clearFiles(e) {
    for (const f of e.files) this.cacheBytes -= f.buffer.length;
    e.files = [];
    e.bytes = 0;
  }

  revoke(e) {
    if (this.requests.get(e.request) !== e) return;
    this.requests.delete(e.request);
    clearTimeout(e.timer);
    e.controller.abort();
    this.clearFiles(e);
  }

  drop(conn) {
    for (const e of [...this.requests.values()]) if (e.conn === conn) this.revoke(e);
  }

  async handle(req, res, url, rest) {
    const fail = this.fail;
    if (req.method !== 'POST') fail(405, 'method-not-allowed', 'POST only');
    const [request, operation, extra] = rest.split('/');
    const e = TOKEN.test(request ?? '') && this.requests.get(request);
    if (!e || extra !== undefined || !['upload', 'complete'].includes(operation)
      || url.searchParams.get('stream') !== e.conn.id || url.searchParams.getAll('stream').length !== 1) {
      req.resume();
      fail(404, 'not-found', 'no active file selection');
    }
    if (!this.alive(e)) { this.revoke(e); req.resume(); fail(410, 'cancelled', 'file selection expired'); }
    if (e.delivering || e.uploading) { req.resume(); fail(409, 'busy', 'file selection is busy'); }
    if (operation === 'upload') return this.upload(req, res, url, e);
    if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      req.resume(); fail(415, 'unsupported-media-type', 'content-type must be application/json');
    }
    const body = await this.readJsonBody(req, 1024);
    if (!isPlainObject(body) || !['selected', 'cancelled', 'error'].includes(body.status)
      || Object.keys(body).some(k => k !== 'status')) fail(400, 'bad-request', 'expected a selection status');
    if (!this.alive(e) || e.delivering || e.uploading) fail(410, 'cancelled', 'file selection expired');
    return this.complete(res, e, body.status);
  }

  async upload(req, res, url, e) {
    const fail = this.fail;
    const reject = (status, code, message) => {
      this.clearFiles(e); e.failed = true; req.resume(); fail(status, code, message);
    };
    if (e.failed) return reject(409, 'cancelled', 'this selection cannot accept more files');
    if (req.aborted || res.destroyed) return reject(400, 'cancelled', 'file upload interrupted');
    if ([...url.searchParams.keys()].some(k => !['stream', 'name', 'mediaType'].includes(k))
      || url.searchParams.getAll('name').length !== 1 || url.searchParams.getAll('mediaType').length > 1) return reject(400, 'bad-request', 'invalid upload metadata');
    const rawName = url.searchParams.get('name');
    // Names are display labels, never paths. Neither the device URI nor its path crosses the wire.
    const name = truncateChars(cleanLine(rawName.split(/[\\/]/).at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/g, ''), L.nameChars);
    const mediaType = url.searchParams.get('mediaType') ?? 'application/octet-stream';
    if (!name || !MIME.test(mediaType)) return reject(400, 'bad-request', 'invalid file name or media type');
    if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') return reject(415, 'unsupported-media-type', 'content-type must be application/octet-stream');
    const header = req.headers['content-length'];
    const length = header === undefined ? undefined : Number(header);
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > L.bytes)) return reject(413, 'too-large', 'file exceeds 8 MiB');
    if (e.files.length >= e.maxFiles || (length !== undefined && e.bytes + length > L.totalBytes)) return reject(413, 'too-large', 'selection exceeds its count or byte budget');
    // Unknown-length streams reserve the entire per-file cap; no unaccounted chunk list/copy.
    const capacity = length ?? Math.min(L.bytes, L.totalBytes - e.bytes);
    if (this.cacheBytes + capacity > L.cacheBytes) return reject(429, 'rate-limited', 'file upload memory budget exhausted');
    const buffer = Buffer.alloc(capacity);
    this.cacheBytes += capacity;
    e.uploading = true;
    let retained = false;
    try {
      const bytes = await new Promise((resolve, rejectRead) => {
        let size = 0, done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          req.removeListener('data', data); req.removeListener('end', end);
          req.removeListener('error', broken); req.removeListener('aborted', broken);
          e.controller.signal.removeEventListener('abort', aborted);
          if (error) { req.resume(); rejectRead(error); } else resolve(size);
        };
        const broken = () => finish({ status: 400, code: 'cancelled', message: 'file upload interrupted' });
        const aborted = () => finish({ status: 410, code: 'cancelled', message: 'file selection expired' });
        const data = chunk => {
          if (!this.alive(e)) return aborted();
          if (size + chunk.length > capacity || e.bytes + size + chunk.length > L.totalBytes) return finish({ status: 413, code: 'too-large', message: 'file or selection byte budget exceeded' });
          chunk.copy(buffer, size); size += chunk.length;
        };
        const end = () => finish(length !== undefined && size !== length ? { status: 400, code: 'bad-request', message: 'incomplete file upload' } : undefined);
        const timer = setTimeout(() => finish({ status: 408, code: 'timeout', message: 'file upload timed out' }), L.uploadMs);
        timer.unref?.();
        req.on('data', data); req.on('end', end); req.on('error', broken); req.on('aborted', broken);
        e.controller.signal.addEventListener('abort', aborted, { once: true });
        if (e.controller.signal.aborted) aborted();
      });
      if (!this.alive(e)) fail(410, 'cancelled', 'file selection expired');
      const file = { handle: randomBytes(24).toString('base64url'), name, bytes, mediaType, buffer };
      e.files.push(file); e.bytes += bytes; retained = true;
      this.sendJson(res, 200, { v: PROTOCOL, file: this.metadata(file) });
    } catch (error) {
      this.clearFiles(e); e.failed = true;
      if (error?.status) fail(error.status, error.code, error.message);
      throw error;
    } finally {
      e.uploading = false;
      if (!retained) this.cacheBytes -= capacity;
    }
  }

  metadata({ handle, name, bytes, mediaType }) { return { handle, name, bytes, mediaType, access: 'read' }; }

  async complete(res, e, status) {
    if (status === 'selected' && (e.failed || e.files.length === 0)) this.fail(409, 'bad-request', 'no complete selection');
    if (status !== 'selected') this.clearFiles(e);
    const release = this.core.admitInvoke(e.pkg);
    if (!release) { this.revoke(e); this.fail(429, 'rate-limited', 'too many invokes'); }
    e.delivering = true;
    const event = { surface: e.surface, id: e.id, action: e.action, locale: e.locale,
      signal: e.controller.signal, value: { status, files: e.files.map(f => this.metadata(f)) } };
    try {
      const result = await withTimeout(this.delivery.run(e, () => call(e.fn, { ...e.scope.scope }, event).then(result => {
        // Own eager work even when metadata is invalid, the request is retired,
        // or the callback settles after its timeout. Never start a lazy function.
        const deferred = splitPending(result);
        const work = deferred?.ok ? deferred.work : deferred ? result.result : undefined;
        if (typeof work?.then === 'function') work.then(undefined, () => {});
        return result;
      })), this.core.limits.handlerTimeoutMs);
      if (!this.alive(e)) this.fail(410, 'cancelled', 'file selection expired');
      const rec = this.core.plugin(e.pkg);
      const norm = normalize(result, { panels: new Set(rec.parsed.items.panels.map(p => p.id)),
        source: e.surface === 'panel' ? e.id : undefined, fileResult: true,
        capabilities: { declared: rec.parsed.capabilities, features: e.conn.features } });
      if (norm.violation) this.core.violation(e.pkg, 'bad-effect', 'invalid file selection callback effects');
      else this.core.success(e.pkg);
      for (const effect of norm.effects) if (effect.type === 'patch') this.core.patchFeed(e.pkg, effect.id, e.scope, effect.data);
      this.sendJson(res, 200, { v: PROTOCOL, effects: norm.effects, issues: norm.issues });
    } catch (error) {
      if (error?.status) throw error;
      if (!this.alive(e)) this.fail(410, 'cancelled', 'file selection expired');
      this.core.violation(e.pkg, error?.timeout ? 'timeout' : 'plugin-error', `file callback(${e.id}): ${errorText(error)}`);
      this.fail(error?.timeout ? 504 : 500, error?.timeout ? 'timeout' : 'plugin-error', 'file selection callback failed');
    } finally {
      release();
      this.revoke(e);
    }
  }

  dispose() {
    this.off();
    if (this.core.pickedFileRead === this.read) this.core.pickedFileRead = undefined;
    for (const e of [...this.requests.values()]) this.revoke(e);
    this.delivery.disable();
  }
}
