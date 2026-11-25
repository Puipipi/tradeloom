// Native plugin core (docs/design/native-plugins-protocol.md): which enabled plugins declare
// `dshGo`, what they registered through the `dshGo` service, their health (violations ->
// degraded), and the data feeds shared by GET views and stream subscriptions.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ID, LIMITS, PKG, PROTOCOL, TONES, ICON } from "./limits.js";
import { parseManifest, renderPlugin } from "./manifest.js";
import {
  call, chars, cleanLine, compareSemver, deepEqual, errorText, isPlainObject, mergeApply, mergeDiff,
  normalizeScope, sanitizeNotes, scopeMatches, shortHash, toJson, truncateChars, withoutNulls,
} from "./util.js";

const TRACKER = Symbol.for("cordis.tracker");
const SCAN_MAX_AGE_MS = 2000;
const CHANGED_DEBOUNCE_MS = 300;
const SELF = "dsh-go-bridge";
const REG_NAMES = { panels: "panel", strips: "strip", notes: "turnNote", handlers: "on", media: "media", micro: "micro", capability: "onCapability" };

/** Loader entry owning a fiber (walks up through `ctx.inject` sub-fibers). */
export function entryOf(fiber) {
  for (let f = fiber, depth = 0; f && depth < 64; depth++) {
    if (f.entry) return f.entry;
    const next = f.parent?.fiber;
    if (!next || next === f) return undefined;
    f = next;
  }
  return undefined;
}

function nearestPackage(moduleUrl, expected) {
  if (typeof moduleUrl !== "string" || !moduleUrl.startsWith("file:")) return undefined;
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const name = JSON.parse(readFileSync(candidate, "utf8")).name;
        if (typeof name === "string" && (expected === undefined || name === expected)) return { pkg: name, pkgJsonPath: candidate, dir };
      } catch (error) {
        if (error?.code === "EMFILE" || error?.code === "ENFILE") throw error;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export class NativeCore {
  /** @param ctx the bridge's context; @param limits effective limits; @param logger optional */
  constructor(ctx, limits, version) {
    this.ctx = ctx;
    this.limits = limits;
    this.version = version;
    this.locations = new Map();      // `${baseUrl}\0${name}` -> {pkg, pkgJsonPath, dir} | null
    this.manifests = new Map();      // pkgJsonPath -> {stamp, parsed}
    this.scanState = undefined;      // {at, fingerprint, plugins: Map pkg -> record}
    this.dirty = true;
    this.regs = new Map();           // pkg -> {panels, strips, handlers: Map id -> {def, token}}
    this.regsVersion = 0;
    this.health = new Map();         // pkg -> {uid, consecutive, total, degraded, issues: Map}
    this.healthVersion = 0;
    this.feeds = new Map();          // key -> Feed
    this.changedListeners = new Set();
    this.lastBroadcast = undefined;
    this.changedTimer = undefined;
    this.contribMemo = new Map();
    this.buckets = new Map();        // pkg -> {tokens, at, inflight}
    this.service = this.#createService();
  }

  // ---------------------------------------------------------------- discovery

  #loader() {
    try {
      return this.ctx.get("loader");
    } catch {
      return undefined;
    }
  }

  /** Package of a loader entry, resolved like dsh-client-modules does. Cached. */
  locate(entry) {
    const name = entry?.options?.name;
    if (typeof name !== "string" || name.startsWith("cordis:") || name.startsWith("@deepseek-ai/")) return undefined;
    const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
    const key = `${baseUrl}\0${name}`;
    if (this.locations.has(key)) return this.locations.get(key) ?? undefined;
    let found;
    try {
      const pathLike = name.startsWith(".") || name.startsWith("file:") || isAbsolute(name);
      const expected = !pathLike && PKG.test(name) ? name : undefined;
      if (pathLike || expected !== undefined) {
        const internal = this.#loader()?.internal;
        let url;
        if (internal && typeof Reflect.get(internal, "resolveSync") === "function" && baseUrl !== undefined) {
          url = internal.version === "v2"
            ? internal.resolveSync(baseUrl, { specifier: name, attributes: {} }).url
            : internal.resolveSync(name, baseUrl, {}).url;
        } else if (pathLike) {
          url = name.startsWith("file:") ? name : isAbsolute(name) ? pathToFileURL(name).href : new URL(name, baseUrl).href;
        } else if (baseUrl !== undefined) {
          const require = createRequire(baseUrl);
          try {
            const p = require.resolve(`${expected}/package.json`);
            found = { pkg: expected, pkgJsonPath: p, dir: dirname(p) };
          } catch {
            url = pathToFileURL(require.resolve(expected)).href;
          }
        }
        found ??= nearestPackage(url, expected);
      }
    } catch (error) {
      if (error?.code === "EMFILE" || error?.code === "ENFILE") return undefined;
      found = undefined;
    }
    if (found?.pkg === SELF || found?.pkg?.startsWith("@deepseek-ai/")) found = undefined;
    this.locations.set(key, found ?? null);
    return found;
  }

  #manifest(loc) {
    let st;
    try {
      st = statSync(loc.pkgJsonPath);
    } catch {
      return undefined;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const cached = this.manifests.get(loc.pkgJsonPath);
    if (cached?.stamp === stamp) return cached;
    let text;
    try {
      text = readFileSync(loc.pkgJsonPath, "utf8");
    } catch {
      return undefined;
    }
    let parsed = null;
    try {
      const pkgJson = JSON.parse(text);
      if (isPlainObject(pkgJson) && pkgJson.dshGo !== undefined) parsed = parseManifest(pkgJson, loc.dir);
    } catch {
      parsed = null;
    }
    const value = { stamp, parsed };
    this.manifests.set(loc.pkgJsonPath, value);
    return value;
  }

  /** Enabled plugins that declare dshGo: Map pkg -> {pkg, dir, uid, parsed, stamp}. */
  scan() {
    const now = Date.now();
    if (!this.dirty && this.scanState && now - this.scanState.at < SCAN_MAX_AGE_MS) return this.scanState;
    const plugins = new Map();
    const parts = [];
    let entries = [];
    try {
      entries = [...(this.#loader()?.entries() ?? [])];
    } catch {}
    for (const entry of entries) {
      try {
        if (entry.disabled || entry.fiber === undefined) continue;
        const loc = this.locate(entry);
        if (loc === undefined || plugins.has(loc.pkg)) continue;
        const m = this.#manifest(loc);
        if (m === undefined || m.parsed === null) continue;
        const uid = entry.fiber?.uid ?? null;
        plugins.set(loc.pkg, { pkg: loc.pkg, dir: loc.dir, uid, parsed: m.parsed, stamp: m.stamp });
        parts.push(`${loc.pkg}@${uid}@${m.stamp}`);
        const h = this.health.get(loc.pkg);
        if (h !== undefined && h.uid === null) h.uid = uid;
        else if (h !== undefined && h.uid !== uid) this.#resetHealth(loc.pkg, uid);
      } catch (error) {
        this.ctx.logger?.warn?.(error);
      }
    }
    let graphRev = null;
    try {
      graphRev = this.ctx.get("clientModules")?.graph()?.rev ?? null;
    } catch {}
    this.dirty = false;
    this.scanState = { at: now, fingerprint: shortHash(parts.sort().join("|")), plugins, graphRev };
    return this.scanState;
  }

  markDirty() {
    this.dirty = true;
    this.locations.clear();
    this.capabilityChanged?.();
    this.#scheduleChanged();
  }

  plugin(pkg) {
    return this.scan().plugins.get(pkg);
  }

  // ---------------------------------------------------------------- state

  #liveOf(pkg) {
    const regs = this.regs.get(pkg);
    const h = this.health.get(pkg);
    const panels = new Map();
    for (const [id, r] of regs?.panels ?? []) panels.set(id, { data: typeof r.def.data === "function" });
    return {
      panels,
      strips: new Set(regs?.strips.keys() ?? []),
      notes: new Set(regs?.notes.keys() ?? []),
      handlers: new Set(regs?.handlers.keys() ?? []),
      degraded: h?.degraded === true,
      runtimeIssues: [...(h?.issues.values() ?? [])],
    };
  }

  /** ok | degraded | unsupported | needs-app | invalid; caps undefined skips app checks. */
  stateOf(rec, caps) {
    const p = rec.parsed;
    if (!p.valid) return "invalid";
    if (p.v !== PROTOCOL || (caps && !caps.versions.includes(p.v))) return "unsupported";
    if (caps && p.minApp !== undefined && compareSemver(caps.app, p.minApp) < 0) return "needs-app";
    if (this.health.get(rec.pkg)?.degraded) return "degraded";
    return "ok";
  }

  /** The contributions response body (memoized per state and caps). */
  contributions(caps) {
    const s = this.scan();
    const key = `${s.fingerprint}:${this.regsVersion}:${this.healthVersion}:${s.graphRev}\0${caps.key}`;
    const hit = this.contribMemo.get(key);
    if (hit) return hit;
    const plugins = [...s.plugins.values()].sort((a, b) => a.pkg.localeCompare(b.pkg))
      .map((rec) => renderPlugin(rec.parsed, caps, this.#liveOf(rec.pkg)));
    const body = { v: PROTOCOL, bridge: this.version, bootRev: s.graphRev, limits: this.limits, plugins };
    const rev = shortHash(JSON.stringify(body));
    const out = { v: PROTOCOL, bridge: this.version, rev, bootRev: s.graphRev, limits: this.limits, plugins };
    if (this.contribMemo.size > 32) this.contribMemo.clear();
    this.contribMemo.set(key, out);
    return out;
  }

  onChanged(listener) {
    this.changedListeners.add(listener);
    return () => this.changedListeners.delete(listener);
  }

  #scheduleChanged() {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      let s;
      try {
        s = this.scan();
      } catch {
        return;
      }
      const stateKey = `${s.fingerprint}:${this.regsVersion}:${this.healthVersion}`;
      if (stateKey === this.lastBroadcast) return;
      const first = this.lastBroadcast === undefined;
      this.lastBroadcast = stateKey;
      // Ending feeds of plugins that disappeared.
      for (const feed of [...this.feeds.values()]) if (!s.plugins.has(feed.pkg)) feed.stop("not-found");
      if (first && this.changedListeners.size === 0) return;
      for (const l of this.changedListeners) {
        try {
          l();
        } catch {}
      }
    }, CHANGED_DEBOUNCE_MS);
    this.changedTimer.unref?.();
  }

  // ---------------------------------------------------------------- health

  #health(pkg) {
    let h = this.health.get(pkg);
    if (h === undefined) {
      h = { uid: this.scanState?.plugins.get(pkg)?.uid ?? null, consecutive: 0, total: 0, degraded: false, issues: new Map() };
      this.health.set(pkg, h);
    }
    return h;
  }

  #resetHealth(pkg, uid) {
    const h = this.health.get(pkg);
    if (h === undefined) return;
    const was = h.degraded || h.issues.size > 0;
    this.health.set(pkg, { uid: uid ?? h.uid, consecutive: 0, total: 0, degraded: false, issues: new Map() });
    if (was) {
      this.healthVersion++;
      this.#scheduleChanged();
    }
  }

  runtimeIssue(pkg, key, value) {
    const h = this.#health(pkg);
    if (deepEqual(h.issues.get(key), value)) return;
    if (h.issues.size >= 20 && !h.issues.has(key)) return;
    h.issues.set(key, value);
    this.healthVersion++;
    this.#scheduleChanged();
  }

  violation(pkg, code, message) {
    const h = this.#health(pkg);
    h.consecutive++;
    h.total++;
    this.ctx.logger?.warn?.("dsh-go-bridge: plugin %s violation %s: %s", pkg, code, message);
    h.issues.set("violation", { path: "/runtime/violation", code: "violation", severity: "warn", message: `${code}: ${message}`, count: h.total });
    this.healthVersion++;
    if (h.consecutive >= LIMITS.violationsToDegrade && !h.degraded) {
      h.degraded = true;
      this.capabilityChanged?.();
      h.issues.set("degraded", { path: "/runtime/degraded", code: "degraded", severity: "error", message: `${h.consecutive} consecutive violations; native UI off until the plugin reloads` });
      for (const feed of [...this.feeds.values()]) if (feed.pkg === pkg) feed.stop("degraded");
    }
    this.#scheduleChanged();
  }

  success(pkg) {
    const h = this.health.get(pkg);
    if (h !== undefined) h.consecutive = 0;
  }

  /** Token bucket + concurrency per plugin; returns a release function or undefined (429). */
  admitInvoke(pkg) {
    const now = performance.now();
    let b = this.buckets.get(pkg);
    if (b === undefined) {
      b = { tokens: LIMITS.invokeBurst, at: now, inflight: 0 };
      this.buckets.set(pkg, b);
    }
    b.tokens = Math.min(LIMITS.invokeBurst, b.tokens + ((now - b.at) / 1000) * LIMITS.invokePerSecond);
    b.at = now;
    if (b.tokens < 1 || b.inflight >= LIMITS.invokeConcurrent) return undefined;
    b.tokens -= 1;
    b.inflight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        b.inflight--;
      }
    };
  }

  retryAfter(pkg) {
    const b = this.buckets.get(pkg);
    if (b === undefined || b.tokens >= 1) return 1;
    return Math.max(1, Math.ceil((1 - b.tokens) / LIMITS.invokePerSecond));
  }

  // ---------------------------------------------------------------- registrations

  registration(pkg, kind, id) {
    return this.regs.get(pkg)?.[kind]?.get(id);
  }

  #register(callerCtx, kind, id, def) {
    const entry = entryOf(callerCtx?.fiber);
    const loc = entry === undefined ? undefined : this.locate(entry);
    if (loc === undefined) throw new Error("dshGo: call ctx.dshGo.* as a method from a plugin context (ctx.inject(['dshGo'], ...))");
    if (typeof id !== "string" || !ID.test(id)) throw new TypeError(`dshGo.${kind}: id must match ${ID}`);
    const pkg = loc.pkg;
    let value;
    if (kind === "panels") {
      if (!isPlainObject(def) || !(isPlainObject(def.view) || typeof def.view === "function")) throw new TypeError("dshGo.panel: { view } is required (an object or a function)");
      if (def.data !== undefined && typeof def.data !== "function") throw new TypeError("dshGo.panel: data must be a function (scope, emit) => cancel");
      if (def.actions !== undefined && (!isPlainObject(def.actions) || Object.values(def.actions).some((f) => typeof f !== "function"))) throw new TypeError("dshGo.panel: actions must map names to functions");
      value = { view: def.view, data: def.data, actions: def.actions };
    } else if (kind === "strips" || kind === "micro" || kind === "notes") {
      const data = typeof def === "function" ? def : def?.data;
      if (typeof data !== "function") throw new TypeError(`dshGo.${REG_NAMES[kind]}: pass (scope, emit) => cancel or { data }`);
      value = { data };
    } else {
      if (typeof def !== "function") throw new TypeError(`dshGo.${REG_NAMES[kind]}: handler must be a function`);
      value = def;
    }
    const token = {};
    return callerCtx.effect(() => {
      this.#add(pkg, kind, id, value, token);
      return () => this.#remove(pkg, kind, id, token);
    }, `dshGo.${kind}(${id})`);
  }

  #add(pkg, kind, id, def, token) {
    let regs = this.regs.get(pkg);
    if (regs === undefined) {
      regs = { panels: new Map(), strips: new Map(), notes: new Map(), handlers: new Map(), media: new Map(), micro: new Map(), capability: new Map() };
      this.regs.set(pkg, regs);
    }
    const count = Object.values(regs).reduce((n, entries) => n + entries.size, 0);
    if (count === 0) this.#resetHealth(pkg);
    const replaced = regs[kind].has(id);
    regs[kind].set(id, { def, token });
    if (replaced && (kind === "panels" || kind === "strips" || kind === "notes")) for (const feed of [...this.feeds.values()]) if (feed.pkg === pkg && feed.id === id) feed.stop("not-found");
    const rec = this.plugin(pkg);
    const declared = rec?.parsed.ids.get(id);
    const ok = kind === "capability" ? (rec?.parsed.capabilities?.length ?? 0) > 0
      : kind === "media" || kind === "micro" ? declared === kind
      : kind === "handlers" ? declared !== undefined
      : kind === "panels" ? declared === "panels" : kind === "notes" ? declared === "turn.note" : declared === "composer.strip";
    if (!ok) {
      const what = kind === "capability" ? "onCapability() needs dshGo.capabilities" : `${REG_NAMES[kind]}("${id}") is not declared in dshGo.contributes`;
      this.runtimeIssue(pkg, `undeclared:${kind}:${id}`, { path: `/runtime/${id}`, code: "undeclared", severity: "warn", message: `${what}; ignored` });
    }
    this.regsVersion++;
    this.capabilityChanged?.();
    this.#scheduleChanged();
  }

  #remove(pkg, kind, id, token) {
    const regs = this.regs.get(pkg);
    if (regs?.[kind].get(id)?.token !== token) return;
    regs[kind].delete(id);
    if (kind === "panels" || kind === "strips" || kind === "notes") for (const feed of [...this.feeds.values()]) if (feed.pkg === pkg && feed.id === id) feed.stop("not-found");
    this.regsVersion++;
    this.capabilityChanged?.();
    this.#scheduleChanged();
  }

  #refresh(callerCtx, id, partial) {
    const entry = entryOf(callerCtx?.fiber);
    const loc = entry === undefined ? undefined : this.locate(entry);
    if (loc === undefined) throw new Error("dshGo: call ctx.dshGo.refresh as a method from a plugin context");
    const scope = normalizeScope(partial ?? {});
    if (scope === undefined) throw new TypeError("dshGo.refresh: invalid scope");
    for (const feed of this.feeds.values()) {
      if (feed.pkg === loc.pkg && feed.id === id && scopeMatches(feed.scope, scope.scope)) feed.notifyStale();
    }
  }

  #createService() {
    const core = this;
    const service = {
      ctx: this.ctx,
      v: PROTOCOL,
      bridge: this.version,
      panel(id, def) { return core.#register(this?.ctx, "panels", id, def); },
      strip(id, def) { return core.#register(this?.ctx, "strips", id, def); },
      turnNote(id, def) { return core.#register(this?.ctx, "notes", id, def); },
      media(id, handler) { return core.#register(this?.ctx, "media", id, handler); },
      micro(id, def) { return core.#register(this?.ctx, "micro", id, def); },
      onCapability(handler) { return core.#register(this?.ctx, "capability", "events", handler); },
      on(id, handler) { return core.#register(this?.ctx, "handlers", id, handler); },
      refresh(id, scope) { core.#refresh(this?.ctx, id, scope); },
      readPickedFile(handle) {
        const loc = core.locate(entryOf(this?.ctx?.fiber));
        if (!loc || !core.pickedFileRead) throw new Error("no active file selection callback");
        return core.pickedFileRead(loc.pkg, handle);
      },
    };
    Object.defineProperty(service, TRACKER, { value: { associate: "dshGo", property: "ctx" }, enumerable: false });
    return service;
  }

  // ---------------------------------------------------------------- feeds

  /** Gets or creates the feed of a panel / strip for one scope and locale; undefined when over the cap. */
  feed(pkg, id, kind, scope, locale = "") {
    const loc = typeof locale === "string" ? locale.toLowerCase().replaceAll("_", "-") : "";
    const key = `${pkg}\0${id}\0${scope.key}\0${loc}`;
    let feed = this.feeds.get(key);
    if (feed !== undefined) return feed;
    if (this.feeds.size >= LIMITS.feeds) {
      const idle = [...this.feeds.values()].filter((f) => f.subs.size === 0 && f.pins === 0).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length === 0) return undefined;
      idle[0].stop();
    }
    const reg = this.registration(pkg, kind === "strip" ? "strips" : kind === "note" ? "notes" : "panels", id);
    feed = new Feed(this, key, pkg, id, kind, scope.scope, reg?.def.data, typeof locale === "string" ? locale : "");
    this.feeds.set(key, feed);
    feed.start();
    return feed;
  }

  /** Merges a `patch` effect into a running feed (other subscribers see it through the stream). */
  patchFeed(pkg, id, scope, data) {
    for (const feed of this.feeds.values()) {
      if (feed.pkg !== pkg || feed.id !== id || feed.dataFn === undefined || feed.data === undefined) continue;
      if (feed.scopeKey !== scope.key) continue;
      // Merge over the newest value, including an emit still waiting for its 4 Hz slot.
      const current = feed.pending !== undefined ? feed.pending.value : feed.data;
      feed.push(mergeApply(current ?? {}, data));
    }
  }

  dispose() {
    clearTimeout(this.changedTimer);
    for (const feed of [...this.feeds.values()]) feed.stop();
    this.changedListeners.clear();
  }
}

/** Strip data -> {text, icon?, tone?} | null, or undefined when malformed. */
function sanitizeStrip(d) {
  if (d === null || d === undefined) return null;
  if (!isPlainObject(d)) return undefined;
  if (d.text !== undefined && d.text !== null && typeof d.text !== "string") return undefined;
  const out = {};
  const text = typeof d.text === "string" ? cleanLine(d.text) : "";
  out.text = text === "" ? null : chars(text) > LIMITS.textChars.stripText ? truncateChars(text, LIMITS.textChars.stripText) : text;
  if (typeof d.icon === "string" && ICON.test(d.icon)) out.icon = d.icon;
  if (TONES.includes(d.tone)) out.tone = d.tone;
  return out;
}

/** One `{pkg, id, scope}` data source: plugin data function, rev sequence, subscribers. */
export class Feed {
  constructor(core, key, pkg, id, kind, scope, dataFn, locale = "") {
    this.core = core;
    this.key = key;
    this.pkg = pkg;
    this.id = id;
    this.kind = kind;
    this.scope = scope;
    // Canonical scope is private; plugin callbacks receive a copy.
    this.scopeKey = JSON.stringify(scope);
    this.dataFn = dataFn;
    this.locale = locale;
    this.epoch = randomBytes(3).toString("hex");
    this.seq = 0;
    this.data = undefined;   // undefined: nothing yet; null or object otherwise
    this.rev = null;
    this.subs = new Set();
    this.pins = 0;
    this.stopped = false;
    this.cancel = undefined;
    this.waiters = [];
    this.pending = undefined;
    this.lastFlush = undefined;
    this.timer = undefined;
    this.linger = undefined;
    this.lastUsed = Date.now();
    if (dataFn === undefined) {
      this.data = null;
      this.rev = `${this.epoch}.0`;
    }
  }

  start() {
    if (this.dataFn === undefined) return;
    const emit = (d) => this.#emit(d);
    let result;
    try {
      result = call(this.dataFn, { ...this.scope }, emit, { protocol: PROTOCOL, locale: this.locale });
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then((cancel) => {
      if (typeof cancel !== "function") return;
      if (this.stopped) {
        try { Promise.resolve(cancel()).catch(() => {}); } catch {}
      } else this.cancel = cancel;
    }, (error) => {
      if (this.stopped) return;
      this.core.violation(this.pkg, "plugin-error", `data(${this.id}) failed: ${errorText(error)}`);
      this.stop("error");
    });
  }

  #emit(d) {
    if (this.stopped) return;
    let value;
    if (this.kind === "strip") {
      value = sanitizeStrip(d);
      if (value === undefined) return this.core.violation(this.pkg, "bad-data", `strip(${this.id}) emitted a non-object`);
    } else if (this.kind === "note") {
      value = sanitizeNotes(d);
      if (value === undefined) return this.core.violation(this.pkg, "bad-data", `turnNote(${this.id}) emitted a non-object`);
    } else {
      if (d !== null && !isPlainObject(d)) return this.core.violation(this.pkg, "bad-data", `data(${this.id}) emitted a non-object`);
      const json = toJson(d);
      if (json === undefined) return this.core.violation(this.pkg, "bad-data", `data(${this.id}) emitted a value that is not JSON`);
      if (json.bytes > LIMITS.dataBytes) return this.core.violation(this.pkg, "too-large", `data(${this.id}) is ${json.bytes} bytes (max ${LIMITS.dataBytes})`);
      value = json.value === null ? null : withoutNulls(json.value);
    }
    this.core.success(this.pkg);
    this.push(value);
  }

  /** Queue a new full value; flushed at most `dataHz` times a second. */
  push(value) {
    if (this.stopped) return;
    this.pending = { value };
    if (this.timer !== undefined) return;
    const wait = this.lastFlush === undefined ? 0
      : Math.max(0, Math.ceil(this.lastFlush + 1000 / LIMITS.dataHz - performance.now()));
    this.timer = setTimeout(() => this.#flush(), wait);
    this.timer.unref?.();
  }

  #flush() {
    this.timer = undefined;
    if (this.stopped || this.pending === undefined) return;
    const next = this.pending.value;
    this.pending = undefined;
    this.lastFlush = performance.now();
    const prev = this.data;
    if (prev !== undefined && deepEqual(prev, next)) return;
    const base = this.rev;
    this.seq++;
    this.rev = `${this.epoch}.${this.seq}`;
    this.data = next;
    for (const w of this.waiters.splice(0)) w();
    // Later subscribers receive the current full data, not these unsent patches.
    if (this.subs.size === 0) return;
    let msg;
    if (prev !== undefined && prev !== null && next !== null && base !== null) {
      const merge = mergeDiff(prev, next);
      const json = merge === undefined ? undefined : toJson(merge);
      if (json !== undefined && json.bytes <= LIMITS.patchBytes) msg = { t: "patch", rev: this.rev, base, merge: json.value };
    }
    msg ??= { t: "data", rev: this.rev, data: next };
    for (const sub of this.subs) sub.send({ ...msg, sub: sub.id });
  }

  /** Resolves when the first value is there, or after `ms`. */
  waitFirst(ms) {
    if (this.data !== undefined || this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(done);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.push(done);
    });
  }

  pin() {
    this.pins++;
    this.lastUsed = Date.now();
    clearTimeout(this.linger);
    this.linger = undefined;
  }

  unpin() {
    this.pins = Math.max(0, this.pins - 1);
    this.#maybeLinger();
  }

  /** Attaches a subscriber ({id, send}) and sends what it is missing. */
  attach(sub, rev) {
    this.subs.add(sub);
    this.lastUsed = Date.now();
    clearTimeout(this.linger);
    this.linger = undefined;
    if (this.data === undefined) return;   // first emit will send `data` to everyone
    if (rev !== undefined && rev === this.rev) sub.send({ t: "sync", sub: sub.id, rev: this.rev });
    else sub.send({ t: "data", sub: sub.id, rev: this.rev, data: this.data });
  }

  detach(sub) {
    this.subs.delete(sub);
    this.#maybeLinger();
  }

  notifyStale() {
    for (const sub of this.subs) sub.send({ t: "stale", sub: sub.id });
  }

  #maybeLinger() {
    if (this.stopped || this.subs.size > 0 || this.pins > 0 || this.linger !== undefined) return;
    this.linger = setTimeout(() => this.stop(), this.core.limits.feedLingerMs);
    this.linger.unref?.();
  }

  /** Cancels the plugin side; with a reason, ends every subscription. */
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.linger);
    for (const w of this.waiters.splice(0)) w();
    if (this.core.feeds.get(this.key) === this) this.core.feeds.delete(this.key);
    if (this.cancel) {
      try {
        // Start cleanup now, but own its rejection without delaying retirement.
        Promise.resolve(this.cancel()).catch((error) => this.core.ctx.logger?.warn?.(error));
      } catch (error) {
        this.core.ctx.logger?.warn?.(error);
      }
    }
    const subs = [...this.subs];
    this.subs.clear();
    for (const sub of subs) {
      sub.feedEnded?.(this);
      if (reason !== undefined) sub.send({ t: "end", sub: sub.id, reason });
    }
  }
}
