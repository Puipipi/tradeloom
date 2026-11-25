// v1.2 capability runtime (docs/design/native-plugins-protocol.md §11): leases for audio / voice /
// overlay effects, the media route, capability events and the micro channel. Nothing here runs
// unless an app negotiated a feature and a plugin declared it. The bridge never touches a
// microphone, never proxies a URL and never executes what a capability callback returns.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AUDIO_TYPES, CAP_EVENTS, CAP_LIMITS as L, KEY, TERMINAL_EVENTS, microModel } from './capabilities.js';
import { ID, PKG } from './limits.js';
import { call, deepEqual, normalizeScope, withTimeout } from './util.js';

export class CapabilityRuntime {
  constructor(core, fail) {
    this.core = core;
    this.fail = fail;
    this.leases = new Map();
    this.feeds = new Map();
    this.mediaBusy = new Set();
    this.off = core.onChanged(() => this.sweep());
    // Registration and plugin status hooks: sweep once, after the hook has finished.
    core.capabilityChanged = () => {
      if (this.sweepQueued || this.leases.size + this.feeds.size === 0) return;
      this.sweepQueued = true;
      setImmediate(() => { this.sweepQueued = false; this.sweep(); });
    };
  }
  alive(e) {
    const rec = this.core.plugin(e.pkg);
    return rec && this.core.stateOf(rec) === 'ok' && rec.uid === e.uid && rec.stamp === e.stamp;
  }
  currentLease(e) {
    return this.alive(e)
      && (!e.media || this.core.registration(e.pkg, 'media', e.media)?.token === e.mediaToken);
  }
  sweep() {
    for (const e of [...this.leases.values()]) if (!this.currentLease(e)) this.revoke(e);
    for (const f of [...this.feeds.values()]) if (!this.alive(f)
      || this.core.registration(f.pkg, 'micro', f.id)?.token !== f.token) f.stop(this.core.health.get(f.pkg)?.degraded ? 'degraded' : 'not-found');
  }
  revoke(e) {
    this.leases.delete(e.lease);
    e.controller.abort();
    e.download?.abort();
  }
  drop(conn) {
    for (const e of [...this.leases.values()]) if (e.conn === conn) this.revoke(e);
    for (const sub of conn.microSubs?.values() ?? []) sub.feed.detach(sub);
    conn.microSubs?.clear();
  }
  dispose() {
    this.off();
    this.core.capabilityChanged = undefined;
    for (const e of [...this.leases.values()]) this.revoke(e);
    for (const f of [...this.feeds.values()]) f.stop('closed');
  }
  options(rec, conn) {
    return { declared: rec.parsed.capabilities ?? [], features: conn?.helloed && !conn.ws.closed ? conn.features ?? [] : [],
      media: (rec.parsed.items.media ?? []).map(x => x.id), overlays: (rec.parsed.items.overlays ?? []).map(x => x.id) };
  }
  bind(effects, rec, conn, scope, locale, issues) {
    const prepared = new Set();
    const started = new Set();
    const isStart = effect => effect.type === 'audio' ? effect.op === 'play'
      : effect.type === 'voice' ? effect.op === 'start' : effect.type === 'overlay' && effect.op === 'show';
    return effects.filter(effect => {
      if (!['audio', 'voice', 'overlay'].includes(effect.type)) return true;
      const reject = () => { issues.push({ path: '/runtime/effects', code: 'bad-effect', severity: 'warn', message: 'capability requires a live negotiated instance and resource budget' }); return false; };
      if (!conn?.helloed || conn.ws.closed || !this.alive({ pkg: rec.pkg, uid: rec.uid, stamp: rec.stamp })) return reject();
      let e = [...this.leases.values()].find(x => x.conn === conn && x.pkg === rec.pkg && x.instance === effect.instance);
      // A registration hook may have retired this lease before its queued sweep.
      if (e && !this.currentLease(e)) { this.revoke(e); e = undefined; }
      const start = isStart(effect);
      // Plan rotation once from the pre-batch state, independent of role order.
      if (!prepared.has(effect.instance)) {
        prepared.add(effect.instance);
        const restart = e && effects.some(next => next.instance === effect.instance && isStart(next)
          && (e.roles.has(next.type) || (next.type === 'audio' && e.media !== undefined)));
        if (e && (restart || !deepEqual(e.scope, scope.scope))) { this.revoke(e); e = undefined; }
      }
      const roleKey = `${effect.instance}/${effect.type}`;
      // One generation cannot represent two starts of the same role in a batch.
      if (start && started.has(roleKey)) return reject();
      const media = effect.type === 'audio' && start ? effect.src.slice(6) : undefined;
      const reg = media && this.core.registration(rec.pkg, 'media', media);
      if (media && !reg) return reject();
      if (!e) {
        if (!start) return reject();
        const owned = [...this.leases.values()].filter(x => x.conn === conn);
        if (owned.length >= L.leases || owned.filter(x => x.pkg === rec.pkg).length >= L.pluginLeases) return reject();
        e = { lease: randomBytes(24).toString('base64url'), conn, pkg: rec.pkg, instance: effect.instance,
          scope: { ...scope.scope }, locale, uid: rec.uid, stamp: rec.stamp, roles: new Set(), seq: 0, controller: new AbortController() };
        this.leases.set(e.lease, e);
      }
      if (!start && !e.roles.has(effect.type)) return reject();
      if (start) { e.roles.add(effect.type); started.add(roleKey); }
      if (media) { e.media = media; e.mediaToken = reg.token; e.key = effect.key; }
      if (effect.type === 'audio' && effect.op === 'stop') { e.audioStopping = true; e.download?.abort(); }
      if (effect.type === 'overlay' && start) e.overlay = effect.id;
      if (effect.type === 'overlay' && effect.id !== e.overlay) return reject();
      effect.lease = e.lease;
      return true;
    });
  }
  event(conn, msg) {
    const e = typeof msg.lease === 'string' ? this.leases.get(msg.lease) : undefined;
    if (!e || e.conn !== conn) return;
    if (!this.currentLease(e)) { this.revoke(e); return; }
    if (!Number.isSafeInteger(msg.seq) || msg.seq <= e.seq) return;
    const role = Object.hasOwn(CAP_EVENTS, msg.event) ? CAP_EVENTS[msg.event] : undefined;
    if (!role || !e.roles.has(role)) return;
    if (msg.reason !== undefined && (typeof msg.reason !== 'string' || [...msg.reason].length > 120)) return;
    const terminal = TERMINAL_EVENTS.has(msg.event);
    // Speech edges: at most 10 a second (burst 4). Terminal events are bounded by the roles a
    // lease holds (three at most), so they are never dropped for pacing: a lost one would leak it.
    if (!terminal) {
      const now = performance.now();
      e.tokens = Math.min(L.eventBurst, (e.tokens ?? L.eventBurst) + ((now - (e.tokenAt ?? now)) / 1000) * L.eventsPerSecond);
      e.tokenAt = now;
      if (e.tokens < 1) return;
      e.tokens -= 1;
    }
    e.seq = msg.seq;
    if (terminal) e.roles.delete(role);
    if (role === 'audio' || msg.event === 'voice.speechStart') e.download?.abort();
    if (msg.event === 'voice.speechStart') { e.audioStopping = true; e.roles.delete('audio'); }
    const handler = this.core.registration(e.pkg, 'capability', 'events')?.def;
    // Callback results never execute effects. The signal belongs to the lease, not
    // the callback: final terminal dispatch revokes it before an async continuation.
    if (handler) call(handler, { ...e.scope }, { instance: e.instance, event: msg.event, seq: msg.seq,
      ...(msg.reason === undefined ? {} : { reason: msg.reason }), signal: e.controller.signal }).catch(() => {});
    if (e.roles.size === 0) this.revoke(e);
  }
  async media(req, res, url, pkg, id) {
    const fail = this.fail;
    if (req.method !== 'GET') fail(405, 'method-not-allowed', 'GET only');
    if ([...url.searchParams.keys()].some(k => k !== 'lease' && k !== 'key') || url.searchParams.getAll('lease').length !== 1 || url.searchParams.getAll('key').length > 1) fail(400, 'bad-request', 'invalid media query');
    const e = this.leases.get(url.searchParams.get('lease'));
    const key = url.searchParams.has('key') ? url.searchParams.get('key') : undefined;
    if (!ID.test(id) || !e || e.pkg !== pkg || e.media !== id || e.key !== key || (key !== undefined && !KEY.test(key))
      || !e.roles.has('audio') || e.audioStopping || e.conn.ws.closed || !this.alive(e)) fail(404, 'not-found', 'no active media lease');
    const reg = this.core.registration(pkg, 'media', id);
    if (!reg || reg.token !== e.mediaToken) { this.revoke(e); fail(404, 'not-found', 'media was unloaded'); }
    if (req.aborted || res.destroyed) fail(410, 'cancelled', 'media cancelled');
    if (this.mediaBusy.size >= L.mediaConcurrent || this.mediaBusy.has(pkg)) fail(429, 'rate-limited', 'media busy');
    this.mediaBusy.add(pkg);
    const controller = new AbortController();
    e.download = controller;
    const abort = () => controller.abort();
    e.controller.signal.addEventListener('abort', abort, { once: true });
    res.on('close', abort);
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => {
        if (res.headersSent && !res.writableFinished) res.destroy();
        reject({ aborted: true });
      };
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const transfer = async () => {
      const result = await call(reg.def, { ...e.scope }, { key, locale: e.locale, signal: controller.signal });
      // Registration changes precede the deferred sweep; their old bytes must not be published.
      if (controller.signal.aborted || !this.alive(e) || !this.leases.has(e.lease)
        || this.core.registration(pkg, 'media', id)?.token !== reg.token) fail(410, 'cancelled', 'media cancelled');
      if (!result || !(result.body instanceof Uint8Array) || !AUDIO_TYPES.has(result.contentType)) fail(502, 'invalid-media', 'expected bounded audio bytes and supported MIME');
      if (result.body.byteLength === 0 || result.body.byteLength > L.mediaBytes) fail(413, 'too-large', 'audio must be 1..16 MiB');
      // Keep the slot and cancellation live until Node has finished the response.
      await new Promise((resolve, reject) => {
        const cleanup = () => { res.off('finish', finish); res.off('close', closed); res.off('error', error); };
        const finish = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject({ aborted: true }); };
        const error = cause => { cleanup(); reject(cause); };
        res.once('finish', finish); res.once('close', closed); res.once('error', error);
        try {
          res.writeHead(200, { 'content-type': result.contentType, 'content-length': result.body.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          res.end(result.body);
        } catch (cause) { error(cause); }
      });
    };
    try {
      // A single deadline covers both production and a backpressured response.
      await withTimeout(Promise.race([transfer(), aborted]), L.mediaMs);
    } catch (error) {
      if (error?.timeout) fail(504, 'timeout', 'media timed out');
      if (error?.aborted) fail(410, 'cancelled', 'media cancelled');
      throw error;
    } finally {
      controller.abort();
      controller.signal.removeEventListener('abort', rejectAbort);
      e.controller.signal.removeEventListener('abort', abort);
      res.off('close', abort);
      if (e.download === controller) e.download = undefined;
      this.mediaBusy.delete(pkg);
    }
  }

  message(conn, msg) {
    if (msg.t === 'cap.event') { this.event(conn, msg); return true; }
    if (msg.t !== 'micro.sub' && msg.t !== 'micro.unsub') return false;
    if (typeof msg.sub !== 'string' || msg.sub.length < 1 || msg.sub.length > 32) return true;
    conn.microSubs ??= new Map();
    const old = conn.microSubs.get(msg.sub);
    if (old) { old.feed.detach(old); conn.microSubs.delete(msg.sub); }
    if (msg.t === 'micro.unsub') return true;
    const end = reason => conn.send({ t: 'micro.end', sub: msg.sub, reason });
    const scope = normalizeScope(msg.scope);
    const rec = typeof msg.pkg === 'string' && PKG.test(msg.pkg) && this.core.plugin(msg.pkg);
    if (!conn.features?.includes('micro') || !scope || !rec || this.core.stateOf(rec) !== 'ok'
      || !rec.parsed.capabilities?.includes('micro') || !(rec.parsed.items.micro ?? []).some(x => x.id === msg.id)) { end('unsupported'); return true; }
    if (conn.microSubs.size >= L.microSubs || [...conn.microSubs.values()].filter(s => s.pkg === msg.pkg).length >= L.pluginMicroSubs) { end('limit'); return true; }
    const reg = this.core.registration(msg.pkg, 'micro', msg.id);
    if (!reg) { end('no-handler'); return true; }
    const key = JSON.stringify([msg.pkg, msg.id, scope.key, conn.locale]);
    let feed = this.feeds.get(key);
    if (feed && (!this.alive(feed) || feed.token !== reg.token)) { feed.stop('not-found'); feed = undefined; }
    if (!feed) {
      feed = new MicroFeed(this, key, rec, msg.id, scope.scope, conn.locale, reg);
      this.feeds.set(key, feed);
    }
    const sub = { pkg: msg.pkg, id: msg.sub, conn, feed };
    conn.microSubs.set(msg.sub, sub);
    feed.attach(sub);
    return true;
  }
}

class MicroFeed {
  constructor(runtime, key, rec, id, scope, locale, reg) {
    Object.assign(this, { runtime, key, pkg: rec.pkg, uid: rec.uid, stamp: rec.stamp, id, scope, locale, reg, token: reg.token });
    this.subs = new Set(); this.seq = 0; this.epoch = randomBytes(8).toString('hex'); this.last = undefined;
  }
  attach(sub) {
    this.subs.add(sub);
    if (this.current !== undefined) this.send(sub);
    if (this.started) return;
    this.started = true;
    call(this.reg.def.data, { ...this.scope }, value => this.emit(value), { protocol: 1, locale: this.locale }).then(cancel => {
      if (typeof cancel === 'function') { if (this.closed) { try { Promise.resolve(cancel()).catch(() => {}); } catch {} } else this.cancel = cancel; }
    }, () => this.stop('error'));
  }
  // Registration hooks defer their sweep; a producer may settle in an earlier microtask.
  checkCurrent() {
    if (this.closed) return false;
    if (this.runtime.alive(this)
      && this.runtime.core.registration(this.pkg, 'micro', this.id)?.token === this.token) return true;
    this.stop(this.runtime.core.health.get(this.pkg)?.degraded ? 'degraded' : 'not-found');
    return false;
  }
  emit(value) {
    if (!this.checkCurrent()) return;
    const data = microModel(value);
    if (!data) { this.runtime.core.violation(this.pkg, 'invalid-micro', 'micro data exceeds the small model budget'); return; }
    this.pending = data;
    if (this.timer) return;
    const wait = this.last === undefined ? 0
      : Math.max(0, Math.ceil(this.last + L.microMs - performance.now()));
    if (wait === 0) this.flush();
    else { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, wait); this.timer.unref?.(); }
  }
  flush() {
    const data = this.pending; this.pending = undefined;
    if (!this.checkCurrent() || data === undefined || deepEqual(data, this.current)) return;
    if (this.seq >= Number.MAX_SAFE_INTEGER) { this.stop('limit'); return; }
    this.last = performance.now(); this.current = data; this.seq++;
    for (const sub of this.subs) this.send(sub);
  }
  send(sub) { sub.conn.send({ t: 'micro.data', sub: sub.id, rev: `${this.epoch}.${this.seq}`, data: this.current }); }
  detach(sub) { this.subs.delete(sub); if (this.subs.size === 0) this.stop(); }
  stop(reason) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    try { if (this.cancel) Promise.resolve(this.cancel()).catch(() => {}); } catch {}
    this.runtime.feeds.delete(this.key);
    for (const sub of this.subs) { sub.conn.microSubs?.delete(sub.id); if (reason) sub.conn.send({ t: 'micro.end', sub: sub.id, reason }); }
    this.subs.clear();
  }
}
