// Unit tests for the dsh-go-bridge native plugin modules (no DSH needed).
//   node --test runtime/tests/native-unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Duplex } from "node:stream";

const LIB = new URL("../bridge/dsh-go-bridge/lib/native/", import.meta.url);
const { checkManifest, parseManifest, renderPlugin } = await import(new URL("manifest.js", LIB));
const { checkEffects, normalize, splitPending, validate } = await import(new URL("effects.js", LIB));
const util = await import(new URL("util.js", LIB));
const { createNativeRoutes } = await import(new URL("routes.js", LIB));
const { NativeCore } = await import(new URL("core.js", LIB));
const { LIMITS, effectiveLimits } = await import(new URL("limits.js", LIB));
const { WsConnection, encodeFrame } = await import(new URL("ws.js", LIB));

const CAPS = { versions: [1], app: "0.10.0", locale: "zh-CN", key: "k" };
const LIVE0 = { panels: new Map(), strips: new Set(), handlers: new Set(), degraded: false, runtimeIssues: [] };
const tmp = mkdtempSync(join(tmpdir(), "dsh-go-native-unit-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const codes = (issues) => issues.map((i) => `${i.code}@${i.path}`);

function pkgDir(name, dshGo, extra = {}) {
  const dir = join(tmp, name.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const pkg = { name, version: "1.0.0", dshGo };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "index.js"), "export function apply() {}\n");
  return { dir, pkg };
}

// ------------------------------------------------------------------ util

test("resolveText picks exact, language, en, zh, first", () => {
  const t = { zh: "用量", en: "Usage", "zh-hant": "用量（繁）" };
  assert.equal(util.resolveText(t, "zh-Hant"), "用量（繁）");
  assert.equal(util.resolveText(t, "zh-CN"), "用量");
  assert.equal(util.resolveText(t, "fr"), "Usage");
  assert.equal(util.resolveText({ ja: "a", zh: "b" }, "fr"), "b");
  assert.equal(util.resolveText({ ja: "a" }, ""), "a");
  assert.equal(util.resolveText("plain", "en"), "plain");
  assert.equal(util.parseText("  a\nb\u0000c  "), "a b c");
  assert.equal(util.parseText({ zh: "  ", en: 3 }), undefined);
});

test("merge diff / apply round trip", () => {
  const cases = [
    [{ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2 } }],
    [{ a: [1, 2] }, { a: [1, 2, 3] }],
    [{ a: 1 }, { b: 2 }],
    [{ a: { b: { c: 1 } } }, { a: { b: { c: 1, d: [{ x: 1 }] } } }],
    [{ a: 1, n: { x: 1 } }, { a: 1, n: "scalar" }],
  ];
  for (const [from, to] of cases) {
    const patch = util.mergeDiff(from, to);
    assert.deepEqual(util.mergeApply(from, patch), to);
  }
  assert.equal(util.mergeDiff({ a: 1 }, { a: 1 }), undefined);
  // random objects
  const rnd = (d) => {
    const o = {};
    for (let i = 0; i < 4; i++) {
      const r = Math.random();
      if (r < 0.3) continue;
      o[`k${i}`] = r < 0.5 && d < 3 ? rnd(d + 1) : r < 0.7 ? Math.floor(r * 10) : r < 0.85 ? [1, Math.floor(r * 3)] : "s";
    }
    return o;
  };
  for (let i = 0; i < 300; i++) {
    const a = rnd(0);
    const b = rnd(0);
    assert.deepEqual(util.mergeApply(a, util.mergeDiff(a, b) ?? {}), b);
  }
});

test("viewStats counts typed nodes and depth", () => {
  const v = { type: "stack", children: [{ type: "row", children: [{ type: "text", text: { $: "data.a" } }] }, { type: "metric" }] };
  assert.deepEqual(util.viewStats(v), { nodes: 4, depth: 3 });
});

test("normalizeScope keeps known keys, rejects bad values", () => {
  assert.deepEqual(util.normalizeScope({ sessionId: "s1", other: "x", turnId: "" }), { scope: { sessionId: "s1" }, key: '{"sessionId":"s1"}' });
  assert.equal(util.normalizeScope({ sessionId: "a\nb" }), undefined);
  assert.equal(util.normalizeScope({ sessionId: 3 }), undefined);
  assert.equal(util.normalizeScope("x"), undefined);
  assert.deepEqual(util.normalizeScope(undefined).scope, {});
});

test("effectiveLimits only overrides the timing knobs", () => {
  const l = effectiveLimits({ handlerTimeoutMs: 50, viewBytes: 1 });
  assert.equal(l.handlerTimeoutMs, 50);
  assert.equal(l.viewBytes, LIMITS.viewBytes);
});

// ------------------------------------------------------------------ effects

test("effects: shorthand, whitelist, limits", () => {
  const opts = { panels: new Set(["usage"]), source: "usage" };
  let r = normalize({ insert: "hi", toast: "ok" }, opts);
  assert.deepEqual(r.effects, [{ type: "insert", text: "hi" }, { type: "toast", text: "ok" }]);
  assert.equal(r.violation, false);
  r = normalize([{ refresh: true }, { patch: { a: null } }, { open: "panel:usage" }, { command: { name: "compact", args: "x" } }], opts);
  assert.deepEqual(r.effects.map((e) => e.type), ["refresh", "patch", "open", "command"]);
  assert.equal(r.effects[0].id, "usage");
  r = normalize({ type: "play", asset: "x" }, opts);
  assert.equal(r.effects.length, 0);
  assert.equal(r.violation, false, "unknown type is not a violation");
  assert.equal(r.issues[0].code, "unknown-effect");
  r = normalize([{ link: "http://x.example" }], opts);
  assert.equal(r.violation, true);
  r = normalize([{ link: "https://u:p@x.example" }], opts);
  assert.equal(r.violation, true);
  r = normalize([{ insert: "x".repeat(LIMITS.insertChars + 1) }], opts);
  assert.equal(r.violation, true);
  r = normalize([{ toast: "长".repeat(50) }], opts);
  assert.equal(r.effects[0].text.length, 40);
  assert.equal(r.violation, false);
  r = normalize(42, opts);
  assert.equal(r.violation, true);
  r = normalize([{ toast: "1" }, { toast: "2" }, { toast: "3" }, { toast: "4" }, { toast: "5" }], opts);
  assert.equal(r.effects.length, 4);
  assert.equal(r.violation, true);
  assert.equal(normalize(undefined, opts).effects.length, 0);
  // refresh / patch need a panel when the tap did not come from one
  r = normalize({ refresh: true }, { panels: new Set(["usage"]) });
  assert.equal(r.violation, true);
  assert.ok(validate({ type: "open", page: "panel:other" }, { panels: new Set(["usage"]) }).issue);
  assert.ok(validate({ type: "open", page: "settings" }, { panels: new Set() }).effect);
  assert.ok(validate({ type: "refresh" }, { panels: new Set(["a"]), source: "a", static: true }).issue);
});

test("effects: overflow diagnostics survive unknown and unnegotiated entries", () => {
  const known = Array.from({ length: 6 }, (_, i) => ({ type: "toast", text: String(i + 1) }));
  const unknown = { type: "future-effect" };
  const audio = { type: "audio", op: "play", instance: "reading", src: "media:speech" };
  const opts = { panels: new Set(), capabilities: { declared: ["audio"], features: [], media: ["speech"] } };
  const results = [
    normalize(known, opts),
    normalize([unknown, ...known.slice(0, 4)], opts),
    normalize([audio, ...known.slice(0, 4)], opts),
    normalize([unknown, ...known], opts),
    normalize([audio, ...known], opts),
  ];
  assert.deepEqual(results.map((r) => r.effects), results.map(() => known.slice(0, 4)));
  assert.deepEqual(results.map((r) => r.violation), [true, false, false, true, true]);
  assert.deepEqual(results.map((r) => codes(r.issues)), [
    ["too-many@/runtime/effects/4"],
    ["unknown-effect@/runtime/effects/0"],
    ["unknown-effect@/runtime/effects/0"],
    ["unknown-effect@/runtime/effects/0", "too-many@/runtime/effects/5"],
    ["unknown-effect@/runtime/effects/0", "too-many@/runtime/effects/5"],
  ]);
});

// ------------------------------------------------------------------ manifest

test("manifest: valid manifest renders with locale and ready flags", () => {
  const { dir, pkg } = pkgDir("ok-plugin", {
    v: 1,
    title: { zh: "用量", en: "Usage" },
    icon: "chart",
    wants: ["draft"],
    contributes: {
      "composer.actions": [{ id: "a", label: { zh: "甲", en: "Alpha" }, effect: { type: "insert", text: "x" } }, { id: "b", label: "乙" }],
      "composer.strip": [{ id: "s", panel: "p" }],
      panels: [{ id: "p", title: "面板" }],
    },
  });
  const parsed = parseManifest(pkg, dir);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.issues, []);
  const row = renderPlugin(parsed, CAPS, LIVE0);
  assert.equal(row.state, "ok");
  assert.equal(row.title, "用量");
  assert.deepEqual(row.contributes["composer.actions"][0], { id: "a", label: "甲", effect: [{ type: "insert", text: "x" }], ready: true });
  assert.equal(row.contributes["composer.actions"][1].ready, false);
  assert.ok(codes(row.issues).includes("no-handler@/dshGo/contributes/composer.actions/1"));
  assert.deepEqual(row.contributes.panels[0], { id: "p", title: "面板", placement: ["session.tab"], ready: false, live: false });
  assert.equal(row.contributes["composer.strip"][0].tappable, true);
  const live = { ...LIVE0, panels: new Map([["p", { data: true }]]), handlers: new Set(["b"]) };
  const row2 = renderPlugin(parsed, { ...CAPS, locale: "en" }, live);
  assert.equal(row2.title, "Usage");
  assert.equal(row2.contributes.panels[0].live, true);
  assert.equal(row2.contributes["composer.actions"][1].ready, true);
  assert.equal(row2.contributes["composer.actions"][0].label, "Alpha");
});

test("manifest: per-item validation, caps, truncation and issues", () => {
  const { dir, pkg } = pkgDir("messy-plugin", {
    v: 1,
    extra: 1,
    wants: ["draft", "camera"],
    contributes: {
      "composer.actions": [
        { id: "a", label: "一二三四五六七八九十十一" },
        { id: "a", label: "dup" },
        { id: "bad id", label: "x" },
        { id: "c", label: "c", effect: { type: "patch", data: {} } },
        { id: "d", label: "d" },
      ],
      "message.actions": [{ id: "m" }],
      "composer.strip": [{ id: "s", panel: "nope", text: "t" }, { id: "s2" }],
      panels: [{ id: "p", title: "P", placement: ["features", "moon"], view: "../../etc/passwd" }],
      pets: [],
    },
  });
  const parsed = parseManifest(pkg, dir);
  const got = codes(parsed.issues);
  for (const want of [
    "unknown-field@/dshGo/extra",
    "invalid-field@/dshGo/wants/1",
    "duplicate-id@/dshGo/contributes/composer.actions/1/id",
    "invalid-field@/dshGo/contributes/composer.actions/2/id",
    "invalid-field@/dshGo/contributes/composer.actions/3/effect",
    "too-many@/dshGo/contributes/composer.actions/4",
    "missing-field@/dshGo/contributes/message.actions/0/label",
    "invalid-field@/dshGo/contributes/composer.strip/0/panel",
    "too-many@/dshGo/contributes/composer.strip/1",
    "invalid-field@/dshGo/contributes/panels/0/placement/1",
    "view-file@/dshGo/contributes/panels/0/view",
    "unknown-surface@/dshGo/contributes/pets",
  ]) assert.ok(got.includes(want), `${want} in ${got.join(", ")}`);
  assert.deepEqual(parsed.items["composer.actions"].map((x) => x.id), ["a", "c"]);
  assert.equal(parsed.items["composer.actions"][1].effect, undefined, "invalid static effect dropped, item kept");
  assert.deepEqual(parsed.wants, ["draft"]);
  const row = renderPlugin(parsed, CAPS, LIVE0);
  assert.equal(row.contributes["composer.actions"][0].label, "一二三四五六七八九十");
  assert.ok(codes(row.issues).includes("too-long@/dshGo/contributes/composer.actions/0/label"));
  assert.deepEqual(row.contributes.panels[0].placement, ["features"]);
  assert.equal(row.contributes["composer.strip"][0].ready, true, "static text makes a strip ready");
});

test("manifest: version, minApp, invalid and oversize", () => {
  const base = { contributes: {} };
  let { dir, pkg } = pkgDir("v2-plugin", { ...base, v: 2 });
  let row = renderPlugin(parseManifest(pkg, dir), CAPS, LIVE0);
  assert.equal(row.state, "unsupported");
  assert.equal(row.native, false);
  ({ dir, pkg } = pkgDir("newapp-plugin", { ...base, v: 1, minApp: "0.11.0" }));
  row = renderPlugin(parseManifest(pkg, dir), CAPS, LIVE0);
  assert.equal(row.state, "needs-app");
  row = renderPlugin(parseManifest(pkg, dir), { ...CAPS, app: "0.11.0" }, LIVE0);
  assert.equal(row.state, "ok");
  ({ dir, pkg } = pkgDir("invalid-plugin", "yes"));
  row = renderPlugin(parseManifest(pkg, dir), CAPS, LIVE0);
  assert.equal(row.state, "invalid");
  ({ dir, pkg } = pkgDir("big-plugin", { v: 1, contributes: { panels: [{ id: "p", title: "x".repeat(20000) }] } }));
  assert.equal(parseManifest(pkg, dir).issues[0].code, "invalid-manifest");
  row = renderPlugin(parseManifest(pkg, dir), CAPS, { ...LIVE0, degraded: true });
  assert.equal(row.state, "invalid");
  ({ dir, pkg } = pkgDir("deg-plugin", { v: 1, contributes: {} }));
  assert.equal(renderPlugin(parseManifest(pkg, dir), CAPS, { ...LIVE0, degraded: true }).state, "degraded");
});

// ------------------------------------------------------------------ core with a fake loader

function fakeHost(plugins) {
  const entries = plugins.map(({ dir }, i) => {
    const entry = { options: { id: `e${i}`, name: join(dir, "index.js") }, parent: { tree: { ctx: { baseUrl: `file://${dir}/` } } }, disabled: false };
    entry.fiber = { uid: 100 + i, entry, parent: { fiber: null } };
    return entry;
  });
  const ctx = { get: (name) => (name === "loader" ? { entries: () => entries } : undefined), logger: { warn() {} } };
  const callerOf = (entry) => {
    const disposers = [];
    const sub = { parent: { fiber: entry.fiber } };   // a ctx.inject sub-fiber
    return { fiber: sub, effect: (fn) => { const d = fn(); disposers.push(d); return d; }, disposeAll: () => disposers.splice(0).forEach((d) => d()) };
  };
  return { ctx, entries, callerOf };
}

test("core: scan, cache invalidation by toggle and package.json edit", async () => {
  const a = pkgDir("core-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const b = pkgDir("core-b", { v: 1, contributes: { "composer.actions": [{ id: "x", label: "X" }] } });
  const host = fakeHost([a, b]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  let changed = 0;
  core.onChanged(() => changed++);
  const c1 = core.contributions(CAPS);
  assert.deepEqual(c1.plugins.map((p) => p.pkg), ["core-a", "core-b"]);
  assert.equal(core.contributions(CAPS), c1, "memoized");
  host.entries[1].disabled = true;
  core.markDirty();
  const c2 = core.contributions(CAPS);
  assert.deepEqual(c2.plugins.map((p) => p.pkg), ["core-a"]);
  assert.notEqual(c2.rev, c1.rev);
  host.entries[1].disabled = false;
  core.markDirty();
  writeFileSync(join(b.dir, "package.json"), JSON.stringify({ ...b.pkg, dshGo: { v: 1, title: "B2", contributes: {} } }));
  utimesSync(join(b.dir, "package.json"), new Date(), new Date(Date.now() + 5000));
  core.markDirty();
  const c3 = core.contributions(CAPS);
  assert.equal(c3.plugins.find((p) => p.pkg === "core-b").title, "B2");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(changed >= 1, "changed was broadcast");
  core.dispose();
});

test("core: manifest read failures recover while malformed content stays cached", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const a = pkgDir("manifest-retry", { v: 1, title: "Initial", contributes: {} });
  const core = new NativeCore(fakeHost([a]).ctx, LIMITS, "test");
  const path = join(a.dir, "package.json");
  assert.equal(core.contributions(CAPS).plugins[0].title, "Initial");
  const original = fs.readFileSync;
  let reads = 0, fail = false;
  const spy = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === path) {
      reads++;
      if (fail) throw Object.assign(new Error("descriptor limit"), { code: "EMFILE" });
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); core.dispose(); });

  writeFileSync(path, "{");
  t.mock.timers.tick(2000);
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  t.mock.timers.tick(2000);
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  assert.equal(reads, 1, "malformed JSON keeps its negative cache at the same stamp");

  writeFileSync(path, JSON.stringify({ ...a.pkg, dshGo: { ...a.pkg.dshGo, title: "Recovered" } }));
  fail = true;
  t.mock.timers.tick(2000);
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  assert.equal(reads, 2);
  fail = false;
  t.mock.timers.tick(2000);
  assert.equal(core.contributions(CAPS).plugins[0]?.title, "Recovered", "I/O recovery needs no further edit or markDirty");
  assert.equal(reads, 3);
});

for (const code of ["EMFILE", "ENFILE"]) test(`core: first locate retries after ${code} without changing static contributions`, (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const a = pkgDir(`locate-retry-${code}`, { v: 1, contributes: {
    "composer.actions": [{ id: "draft", label: "Draft", effect: { type: "insert", text: "static text" } }],
  } });
  const core = new NativeCore(fakeHost([a]).ctx, LIMITS, "test");
  const path = join(a.dir, "package.json"), original = fs.readFileSync;
  let reads = 0, fail = true;
  const spy = t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === path) {
      reads++;
      if (fail) throw Object.assign(new Error("descriptor limit"), { code });
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); core.dispose(); });
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  assert.equal(reads, 1);
  fail = false;
  t.mock.timers.tick(2000);
  const recovered = core.contributions(CAPS);
  assert.equal(recovered.plugins.length, 1, "release descriptors then query; no edit or markDirty");
  assert.deepEqual(recovered.plugins[0].contributes["composer.actions"][0].effect, [{ type: "insert", text: "static text" }]);
  assert.equal(recovered.plugins[0].contributes["composer.actions"][0].ready, true);
  assert.equal(reads, 3, "successful locate and manifest read exactly once each");
});

test("core: first locate keeps malformed and missing package negative caches", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const broken = pkgDir("locate-malformed", { v: 1, contributes: {} });
  const missing = pkgDir("locate-missing", { v: 1, contributes: {} });
  const plain = pkgDir("locate-no-contributions", undefined);
  const paths = [broken, missing, plain].map(a => join(a.dir, "package.json"));
  writeFileSync(paths[0], "{");
  const core = new NativeCore(fakeHost([broken, missing, plain]).ctx, LIMITS, "test");
  const original = fs.readFileSync, reads = [0, 0, 0];
  const spy = t.mock.method(fs, "readFileSync", (file, ...args) => {
    const index = paths.indexOf(file);
    if (index >= 0) reads[index]++;
    if (index === 1) throw Object.assign(new Error("package disappeared before read"), { code: "ENOENT" });
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); core.dispose(); });
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  t.mock.timers.tick(2000);
  assert.equal(core.contributions(CAPS).plugins.length, 0);
  assert.deepEqual(reads, [1, 1, 2], "malformed/missing locations and a valid no-dshGo manifest stay cached");
});

test("core: service attribution, registration lifecycle, undeclared", () => {
  const a = pkgDir("svc-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }], "composer.actions": [{ id: "x", label: "X" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  const caller = host.callerOf(host.entries[0]);
  const svc = { ...core.service, ctx: caller };
  svc.panel = core.service.panel;
  svc.on = core.service.on;
  svc.panel("p", { view: { type: "text" }, data: () => {} });
  svc.on("x", () => ({ insert: "y" }));
  svc.on("ghost", () => {});
  let row = core.contributions(CAPS).plugins[0];
  assert.equal(row.contributes.panels[0].ready, true);
  assert.equal(row.contributes.panels[0].live, true);
  assert.equal(row.contributes["composer.actions"][0].ready, true);
  assert.ok(codes(row.issues).includes("undeclared@/runtime/ghost"));
  assert.throws(() => svc.panel("p", { view: 3 }), TypeError);
  assert.throws(() => svc.on("bad id", () => {}), TypeError);
  assert.throws(() => core.service.panel.call({ ctx: { fiber: undefined } }, "p", { view: {} }), /plugin context/);
  caller.disposeAll();
  row = core.contributions(CAPS).plugins[0];
  assert.equal(row.contributes.panels[0].ready, false);
  core.dispose();
});

test("core: violations degrade after 5 in a row, success resets, reload clears", () => {
  const a = pkgDir("deg-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  for (let i = 0; i < 4; i++) core.violation("deg-a", "x", "y");
  core.success("deg-a");
  for (let i = 0; i < 4; i++) core.violation("deg-a", "x", "y");
  assert.equal(core.stateOf(core.plugin("deg-a")), "ok");
  core.violation("deg-a", "x", "y");
  assert.equal(core.stateOf(core.plugin("deg-a")), "degraded");
  const row = core.contributions(CAPS).plugins[0];
  assert.equal(row.native, false);
  assert.ok(codes(row.issues).includes("degraded@/runtime/degraded"));
  host.entries[0].fiber.uid = 999;   // plugin reloaded
  core.markDirty();
  assert.equal(core.stateOf(core.plugin("deg-a")), "ok");
  core.dispose();
});

test("core: invoke token bucket and concurrency", () => {
  const host = fakeHost([]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  const releases = [];
  for (let i = 0; i < 4; i++) releases.push(core.admitInvoke("p"));
  assert.ok(releases.every(Boolean));
  assert.equal(core.admitInvoke("p"), undefined, "concurrency 4");
  releases.forEach((r) => r());
  let ok = 0;
  for (let i = 0; i < 10; i++) { const r = core.admitInvoke("p"); if (r) { ok++; r(); } }
  assert.equal(ok, 4, "burst of 8 minus the 4 used");
  assert.ok(core.retryAfter("p") >= 1);
});

test("core: feeds coalesce to 4 Hz, send patches, linger then cancel", async () => {
  const a = pkgDir("feed-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, { ...LIMITS, feedLingerMs: 150 }, "test");
  const caller = host.callerOf(host.entries[0]);
  let emit;
  let cancelled = 0;
  core.service.panel.call({ ctx: caller }, "p", { view: {}, data: (scope, e) => { emit = e; e({ n: 0, keep: "k" }); return () => cancelled++; } });
  const scope = util.normalizeScope({ sessionId: "s" });
  const feed = core.feed("feed-a", "p", "panel", scope);
  await feed.waitFirst(500);
  assert.deepEqual(feed.data, { n: 0, keep: "k" });
  const got = [];
  feed.attach({ id: "s1", send: (m) => got.push(m) }, undefined);
  assert.equal(got[0].t, "data");
  const t0 = Date.now();
  for (let i = 1; i <= 10; i++) emit({ n: i, keep: "k" });
  await new Promise((r) => setTimeout(r, 600));
  const patches = got.filter((m) => m.t === "patch");
  assert.equal(patches.length, 1, "ten emits in one tick -> one patch");
  assert.deepEqual(patches[0].merge, { n: 10 });
  assert.equal(patches[0].base, got[0].rev);
  for (let i = 0; i < 6; i++) { emit({ n: 100 + i, keep: "k" }); await new Promise((r) => setTimeout(r, 40)); }
  await new Promise((r) => setTimeout(r, 400));
  const span = Date.now() - t0;
  const all = got.filter((m) => m.t === "patch").length;
  assert.ok(all <= Math.ceil(span / 250) + 1, `${all} patches in ${span} ms respects 4 Hz`);
  emit({ blob: "x".repeat(LIMITS.dataBytes + 10) });
  emit("not an object");
  assert.equal(core.health.get("feed-a").total, 2, "oversize and non-object data are violations");
  const sync = [];
  feed.attach({ id: "s2", send: (m) => sync.push(m) }, feed.rev);
  assert.equal(sync[0].t, "sync");
  for (const s of [...feed.subs]) feed.detach(s);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(cancelled, 1, "lingered then cancelled");
  assert.equal(core.feeds.size, 0);
  core.dispose();
});

// ------------------------------------------------------------------ ws codec

class Pipe extends Duplex {
  constructor() { super(); this.out = []; }
  _read() {}
  _write(chunk, enc, cb) { this.out.push(chunk); cb(); }
  setNoDelay() {}
  setTimeout() {}
}

function parseServerFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const op = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { len = buf.readUInt32BE(p + 4); p += 8; }
    frames.push({ op, payload: buf.subarray(p, p + len) });
    off = p + len;
  }
  return frames;
}

test("ws: masked text, fragments, ping, close, limits", async () => {
  const sock = new Pipe();
  const ws = new WsConnection(sock, Buffer.alloc(0), 64);
  const msgs = [];
  ws.on("message", (m) => msgs.push(m));
  sock.emit("data", encodeFrame(0x1, "héllo", { mask: true }));
  sock.emit("data", Buffer.concat([encodeFrame(0x1, "ab", { mask: true, fin: false }), encodeFrame(0x0, "cd", { mask: true })]));
  const split = encodeFrame(0x1, "split", { mask: true });
  sock.emit("data", split.subarray(0, 3));
  sock.emit("data", split.subarray(3));
  sock.emit("data", encodeFrame(0x9, "p", { mask: true }));
  assert.deepEqual(msgs, ["héllo", "abcd", "split"]);
  ws.send("x".repeat(200));
  const out = parseServerFrames(Buffer.concat(sock.out));
  assert.equal(out[0].op, 0xa);
  assert.equal(out[0].payload.toString(), "p");
  assert.equal(out[1].op, 0x1);
  assert.equal(out[1].payload.length, 200);
  let code;
  ws.on("close", (c) => { code = c; });
  sock.emit("data", encodeFrame(0x1, "y".repeat(65), { mask: true }));
  assert.equal(code, 1009);
  const sock2 = new Pipe();
  const ws2 = new WsConnection(sock2, Buffer.alloc(0), 64);
  let code2;
  ws2.on("close", (c) => { code2 = c; });
  sock2.emit("data", encodeFrame(0x1, "unmasked"));
  assert.equal(code2, 1002);
  const sock3 = new Pipe();
  const ws3 = new WsConnection(sock3, Buffer.alloc(0), 64);
  let code3;
  ws3.on("close", (c) => { code3 = c; });
  sock3.emit("data", encodeFrame(0x1, Buffer.from([0xff, 0xfe]), { mask: true }));
  assert.equal(code3, 1007);
});

test("checkManifest: SDK entry (assumed handlers, static view files)", () => {
  const { dir, pkg } = pkgDir("check-plugin", {
    v: 1,
    contributes: {
      "composer.actions": [{ id: "a", label: "A" }],
      panels: [{ id: "p", title: "P", view: "./v/p.json" }, { id: "q", title: "Q", view: "./v/q.json" }],
    },
  }, { "v/p.json": "{ not json", "v/q.json": JSON.stringify({ type: "stack", children: Array.from({ length: 130 }, () => ({ type: "text" })) }) });
  const r = checkManifest(pkg, dir);
  assert.equal(r.state, "ok");
  assert.equal(r.plugin.contributes["composer.actions"][0].ready, true, "handlers assumed");
  assert.deepEqual(codes(r.issues), ["view-file@/dshGo/contributes/panels/0/view", "too-many@/dshGo/contributes/panels/1/view"]);
  const strict = checkManifest(pkg, dir, { handlers: [], locale: "en" });
  assert.ok(codes(strict.issues).includes("no-handler@/dshGo/contributes/composer.actions/0"));
  assert.deepEqual(checkManifest({ name: "x" }, dir), { state: "absent", plugin: null, issues: [] });
  assert.equal(checkEffects({ insert: "x" }, { panels: new Set() }).effects[0].type, "insert");
});

test("core: feeds are per locale and data() gets caps", async () => {
  const a = pkgDir("loc-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  const seen = [];
  core.service.panel.call({ ctx: host.callerOf(host.entries[0]) }, "p", { view: {}, data: (scope, emit, caps) => { seen.push(caps); emit({ l: caps.locale }); } });
  const scope = util.normalizeScope({ sessionId: "s" });
  const zh = core.feed("loc-a", "p", "panel", scope, "zh-CN");
  const en = core.feed("loc-a", "p", "panel", scope, "en");
  assert.notEqual(zh, en);
  assert.equal(core.feed("loc-a", "p", "panel", scope, "ZH_cn"), zh, "locale key is case and separator insensitive");
  await zh.waitFirst(500);
  await en.waitFirst(500);
  assert.deepEqual(seen, [{ protocol: 1, locale: "zh-CN" }, { protocol: 1, locale: "en" }]);
  assert.deepEqual(zh.data, { l: "zh-CN" });
  core.patchFeed("loc-a", "p", scope, { x: 1 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(zh.data.x, 1);
  assert.equal(en.data.x, 1, "patch effects reach every locale's feed of that scope");
  core.dispose();
});

test("deferred: splitPending shapes, clamps and the deferred whitelist", () => {
  assert.equal(splitPending({ insert: "x" }), undefined, "not deferred");
  assert.equal(splitPending(undefined), undefined);
  const p = Promise.resolve(1);
  let r = splitPending({ pending: true, result: p });
  assert.equal(r.ok, true);
  assert.equal(r.timeoutMs, LIMITS.pendingDefaultMs);
  assert.equal(r.label, undefined);
  assert.equal(r.work, p);
  r = splitPending({ pending: { label: "  一二三四五六七八九十一二三四五六七  ", timeoutMs: 10 }, result: () => 1 });
  assert.equal(r.label, "一二三四五六七八九十一二三四五六");
  assert.equal(r.timeoutMs, LIMITS.pendingMinMs);
  assert.equal(r.issues[0].code, "too-long");
  assert.equal(splitPending({ pending: { timeoutMs: 1e9 }, result: () => 1 }).timeoutMs, LIMITS.pendingMaxMs);
  assert.equal(splitPending({ pending: { timeoutMs: "x" }, result: () => 1 }).timeoutMs, LIMITS.pendingDefaultMs);
  r = splitPending({ pending: true });
  assert.equal(r.ok, false);
  assert.equal(r.violation, true);
  assert.equal(splitPending({ pending: "soon", result: p }).ok, false);
  r = splitPending({ pending: true, result: p, toast: "x" });
  assert.equal(r.ok, true);
  assert.match(r.issues[0].message, /ignored next to pending/);
  const opts = { panels: new Set(["p"]), source: "p", deferred: true };
  r = normalize([{ insert: "a" }, { copy: "b" }, { toast: "c" }, { patch: { x: 1 } }], opts);
  assert.deepEqual(r.effects.map((e) => e.type), ["insert", "copy", "toast", "patch"]);
  assert.equal(r.violation, false);
  for (const e of [{ link: "https://x.example" }, { open: "panel:p" }, { command: "compact" }, { refresh: true }]) {
    r = normalize(e, opts);
    assert.equal(r.effects.length, 0, JSON.stringify(e));
    assert.equal(r.violation, true);
    assert.match(r.issues[0].message, /deferred/);
  }
});


test("JSON helpers preserve own prototype-named keys", () => {
  const value = JSON.parse('{"__proto__":{"label":"own"},"nested":{"__proto__":7},"constructor":"data"}');
  assert.deepEqual(util.withoutNulls(value), value);
  const added = util.mergeDiff({}, value);
  assert.deepEqual(added, value);
  assert.deepEqual(util.mergeApply({}, added), value);
  const removed = util.mergeDiff(value, {});
  assert.deepEqual(util.mergeApply(value, removed), {});
  assert.equal(Object.getPrototypeOf(util.mergeApply({}, value)), Object.prototype);
});

test("core: real panel feed retains prototype-named JSON keys in data and patches", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const a = pkgDir("own-keys", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  t.after(() => core.dispose());
  let emit;
  const first = JSON.parse('{"__proto__":{"label":"first"},"nested":{"__proto__":7}}');
  core.service.panel.call({ ctx: host.callerOf(host.entries[0]) }, "p", { view: {}, data: (_, e) => { emit = e; e(first); } });
  const scope = util.normalizeScope({ sessionId: "s" });
  const feed = core.feed("own-keys", "p", "panel", scope);
  t.mock.timers.tick(1);
  const messages = [];
  feed.attach({ id: "own", send: m => messages.push(JSON.parse(JSON.stringify(m))) });
  assert.deepEqual(messages[0].data, first);
  const next = JSON.parse('{"__proto__":{"label":"second"},"nested":{"__proto__":8}}');
  emit(next);
  t.mock.timers.tick(250);
  assert.equal(messages.at(-1).t, "patch");
  assert.deepEqual(messages.at(-1).merge, JSON.parse('{"__proto__":{"label":"second"},"nested":{"__proto__":8}}'));
  assert.deepEqual(util.mergeApply(first, messages.at(-1).merge), next);
  const normalized = normalize({ type: "patch", id: "p", data: JSON.parse('{"__proto__":{"extra":true}}') }, { panels: new Set(["p"]) });
  assert.equal(normalized.violation, false);
  core.patchFeed("own-keys", "p", scope, normalized.effects[0].data);
  t.mock.timers.tick(250);
  assert.deepEqual(feed.data, JSON.parse('{"__proto__":{"label":"second","extra":true},"nested":{"__proto__":8}}'));
  const removed = { nested: {} };
  emit(removed);
  t.mock.timers.tick(250);
  assert.deepEqual(messages.at(-1).merge, JSON.parse('{"__proto__":null,"nested":{"__proto__":null}}'));
  assert.deepEqual(util.mergeApply(next, messages.at(-1).merge), removed);
});


test("core: completed first-data deadlines release their waiters while the feed stays live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const a = pkgDir("waiter-a", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  const routes = createNativeRoutes(core);
  t.after(() => { routes.dispose(); core.dispose(); });
  const svc = { ...core.service, ctx: host.callerOf(host.entries[0]), panel: core.service.panel };
  let emit;
  let cancelled = 0;
  svc.panel("p", { view: { type: "text", text: "Waiting" }, data: (_scope, send) => {
    emit = send;
    return () => cancelled++;
  } });
  const feed = core.feed("waiter-a", "p", "panel", util.normalizeScope({}));
  const messages = [];
  const sub = { id: "panel", send: (message) => messages.push(message) };
  feed.attach(sub);
  for (let i = 0; i < 3; i++) {
    const url = new URL("http://local/dsh-go/v1/views/waiter-a/p");
    let status;
    let body;
    const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; }, end(value) { body = JSON.parse(value); } };
    const response = routes.handle({ method: "GET", headers: {} }, res, url.pathname, url);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feed.waiters.length, 1, "one active first-data wait per GET");
    t.mock.timers.tick(LIMITS.firstDataWaitMs);
    assert.equal(await response, true);
    assert.equal(status, 200);
    assert.equal(body.live, true);
    assert.equal(body.data, null);
    assert.equal(feed.waiters.length, 0, "completed deadline must not stay retained by the live feed");
  }
  assert.equal(cancelled, 0);
  emit({ ready: true });
  t.mock.timers.tick(250);
  assert.deepEqual(messages.at(-1).data, { ready: true });
  feed.detach(sub);
  t.mock.timers.tick(LIMITS.feedLingerMs);
  assert.equal(cancelled, 1);
});

test("core: concurrent first-data waits settle once on data or stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const a = pkgDir("waiter-b", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  t.after(() => core.dispose());
  const svc = { ...core.service, ctx: host.callerOf(host.entries[0]), panel: core.service.panel };
  let emit;
  svc.panel("p", { view: {}, data: (_scope, send) => { emit = send; } });
  const feed = core.feed("waiter-b", "p", "panel", util.normalizeScope({}));
  let settled = 0;
  const first = feed.waitFirst(100).then(() => settled++);
  const second = feed.waitFirst(200).then(() => settled++);
  t.mock.timers.tick(100);
  await first;
  assert.equal(feed.waiters.length, 1, "only the unfinished wait remains");
  emit({ value: 1 });
  t.mock.timers.tick(1);
  await second;
  assert.equal(feed.waiters.length, 0);
  t.mock.timers.tick(200);
  assert.equal(settled, 2);
  const other = core.feed("waiter-b", "p", "panel", util.normalizeScope({ sessionId: "other" }));
  const stopped = other.waitFirst(100);
  other.stop();
  await stopped;
  assert.equal(other.waiters.length, 0);
  t.mock.timers.tick(100);
});


for (const keepOld of [true, false]) test(`core: plugin reload resolves its new package directory, old retained=${keepOld}`, (t) => {
  const pkg = `location-move-${keepOld}`;
  const old = pkgDir(`${pkg}-old`, { v: 1, title: "Old package", contributes: {} });
  const next = pkgDir(`${pkg}-new`, { v: 1, title: "New package manifest", contributes: {} });
  writeFileSync(join(old.dir, "package.json"), JSON.stringify({ ...old.pkg, name: pkg }));
  writeFileSync(join(next.dir, "package.json"), JSON.stringify({ ...next.pkg, name: pkg, version: "2.0.0" }));
  const profile = join(tmp, `home-${pkg}`, "profiles", "web");
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  const link = join(profile, "node_modules", pkg);
  symlinkSync(old.dir, link, "junction");
  const baseUrl = pathToFileURL(profile + "/").href;
  const host = fakeHost([old]);
  const entry = host.entries[0];
  entry.options.name = pkg;
  entry.parent.tree.ctx.baseUrl = baseUrl;
  const resolved = [];
  const loader = { entries: () => host.entries, internal: { version: "v2", resolveSync(base, request) {
    assert.equal(base, baseUrl);
    assert.equal(request.specifier, pkg);
    // The live loader is an explicit peer; directory movement and manifest reads are real.
    const url = pathToFileURL(realpathSync(join(link, "index.js"))).href;
    resolved.push(url);
    return { url };
  } } };
  const core = new NativeCore({ ...host.ctx, get: (name) => name === "loader" ? loader : undefined }, LIMITS, "test");
  t.after(() => core.dispose());
  const before = core.contributions(CAPS);
  assert.equal(before.plugins[0].title, "Old package");
  assert.equal(core.contributions(CAPS), before);
  assert.equal(resolved.length, 1, "same generation uses its location cache");

  host.entries.splice(0, 1);
  entry.fiber.uid = null;
  core.markDirty();
  assert.deepEqual(core.contributions(CAPS).plugins, []);
  unlinkSync(link);
  symlinkSync(next.dir, link, "junction");
  if (!keepOld) rmSync(old.dir, { recursive: true, force: true });
  assert.equal(realpathSync(join(link, "index.js")), join(next.dir, "index.js"));
  const replacement = { ...entry, options: { ...entry.options } };
  replacement.fiber = { uid: 101, entry: replacement, parent: { fiber: null } };
  host.entries.push(replacement);
  core.markDirty();

  const after = core.contributions(CAPS);
  assert.equal(after.plugins.length, 1, "the newly enabled plugin stays discoverable");
  assert.equal(after.plugins[0].title, "New package manifest");
  assert.equal(after.plugins[0].version, "2.0.0");
  assert.equal(core.plugin(pkg).dir, next.dir);
  assert.notEqual(after.rev, before.rev);
  assert.equal(resolved.length, 2, "new generation asks the live loader again");
  assert.equal(core.contributions(CAPS), after);
  assert.equal(resolved.length, 2, "new generation is cached again");
});
