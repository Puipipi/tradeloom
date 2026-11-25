// The places added after the first four: the ＋ panel's tools, a conversation's actions, per-turn
// notes, a panel on the plugin's own page and a panel that opens as a sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = new URL("../bridge/dsh-go-bridge/lib/native/", import.meta.url);
const { checkManifest, parseManifest, renderPlugin } = await import(new URL("manifest.js", LIB));
const util = await import(new URL("util.js", LIB));
const { NativeCore } = await import(new URL("core.js", LIB));
const { LIMITS, SURFACES } = await import(new URL("limits.js", LIB));

const tmp = mkdtempSync(join(tmpdir(), "dsh-go-native-seams-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

function pkgDir(name, dshGo) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const pkg = { name, version: "1.0.0", dshGo };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "index.js"), "export function apply() {}\n");
  return { dir, pkg };
}

function fakeHost(plugins) {
  const entries = plugins.map(({ dir }, i) => {
    const entry = { options: { id: `e${i}`, name: join(dir, "index.js") }, parent: { tree: { ctx: { baseUrl: `file://${dir}/` } } }, dispose() {} };
    entry.fiber = { uid: 100 + i, entry, parent: { fiber: null } };
    return entry;
  });
  const ctx = { get: (name) => (name === "loader" ? { entries: () => entries } : undefined), logger: { warn() {} } };
  const callerOf = (entry) => ({ fiber: { parent: { fiber: entry.fiber } }, effect: (fn) => fn() });
  return { ctx, entries, callerOf };
}

const check = (name, contributes, opts) => {
  const { dir, pkg } = pkgDir(name, { v: 1, contributes });
  return checkManifest(pkg, dir, opts);
};
const codes = (issues) => issues.map((i) => `${i.code}@${i.path}`);

test("composer.tools: a panel is a shorthand for opening it, and takes its limits", () => {
  const r = check("tools", {
    panels: [{ id: "p", title: "P" }],
    "composer.tools": [
      { id: "a", label: "贴纸", icon: "image", panel: "p" },
      { id: "b", label: "一二三四五六七八九" },
      { id: "c", label: "第三个" },
    ],
  });
  const tools = r.plugin.contributes["composer.tools"];
  assert.equal(tools.length, 2, "two a plugin");
  assert.deepEqual(tools[0].effect, [{ type: "open", page: "panel:p" }]);
  assert.equal(tools[1].label, "一二三四五六七八", "eight characters");
  assert.ok(codes(r.issues).includes("too-many@/dshGo/contributes/composer.tools/2"));
});

test("composer.tools: panel and effect exclude each other; the panel must exist", () => {
  const both = check("tools-both", {
    panels: [{ id: "p", title: "P" }],
    "composer.tools": [{ id: "a", label: "A", panel: "p", effect: { type: "toast", text: "x" } }],
  });
  assert.ok(codes(both.issues).includes("invalid-field@/dshGo/contributes/composer.tools/0/panel"));
  const missing = check("tools-missing", { "composer.tools": [{ id: "a", label: "A", panel: "nope" }] });
  assert.ok(codes(missing.issues).includes("invalid-field@/dshGo/contributes/composer.tools/0/panel"));
});

test("session.actions: a label of twelve, ready only with a way to run", () => {
  const assumed = check("actions", { "session.actions": [{ id: "x", label: "一二三四五六七八九十一二三" }] });
  assert.equal(assumed.plugin.contributes["session.actions"][0].label, "一二三四五六七八九十一二");
  const strict = check("actions-strict", { "session.actions": [{ id: "x", label: "导出" }] }, { handlers: [] });
  assert.equal(strict.plugin.contributes["session.actions"][0].ready, false);
  assert.ok(codes(strict.issues).includes("no-handler@/dshGo/contributes/session.actions/0"));
});

test("turn.note: declared takes a registration to be ready", () => {
  const none = check("note", { "turn.note": [{ id: "cost" }] }, { handlers: [] });
  assert.deepEqual(none.plugin.contributes["turn.note"], [{ id: "cost", ready: false }]);
  const some = check("note-on", { "turn.note": [{ id: "cost" }] }, { handlers: [], notes: ["cost"] });
  assert.deepEqual(some.plugin.contributes["turn.note"], [{ id: "cost", ready: true }]);
});

test("placement plugin: only for an app that says it draws it, and a panel never vanishes", () => {
  const panels = [
    { id: "only", title: "A", placement: ["plugin"] },
    { id: "both", title: "B", placement: ["plugin", "features"] },
  ];
  const place = (surfaces) => check(`place-${surfaces.length}`, { panels }, { surfaces }).plugin.contributes.panels.map((p) => p.placement);
  assert.deepEqual(place(["panels", "plugin"]), [["plugin"], ["plugin", "features"]]);
  assert.deepEqual(place(["panels"]), [["session.tab"], ["features"]]);
});

test("presentation: sheet is kept, anything else is an error and stays a page", () => {
  const r = check("sheet", {
    panels: [
      { id: "s", title: "S", presentation: "sheet" },
      { id: "x", title: "X", presentation: "popover" },
    ],
  });
  assert.equal(r.plugin.contributes.panels[0].presentation, "sheet");
  assert.equal(r.plugin.contributes.panels[1].presentation, undefined);
  assert.ok(codes(r.issues).includes("invalid-field@/dshGo/contributes/panels/1/presentation"));
});

test("a plugin using none of them gets the row it always did; one using them gets only those", () => {
  const base = ["composer.actions", "message.actions", "composer.strip", "panels"];
  const old = check("old", { "composer.actions": [{ id: "a", label: "A" }] });
  assert.deepEqual(Object.keys(old.plugin.contributes), base);
  const some = check("some", { "session.actions": [{ id: "a", label: "A" }] });
  assert.deepEqual(Object.keys(some.plugin.contributes), [...base, "session.actions"]);
});

test("every surface has its limits", () => {
  for (const surface of SURFACES) assert.equal(typeof LIMITS.perPlugin[surface], "number", surface);
});

test("core: a turn note feed cuts text, drops junk and keeps the newest turns", async (t) => {
  // The feed's own timers don't hold the process open.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const a = pkgDir("note-feed", { v: 1, contributes: { "turn.note": [{ id: "cost" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  const many = Object.fromEntries(Array.from({ length: LIMITS.turnNotesPerFeed + 6 }, (_, i) => [`t${i}`, { text: "x" }]));
  const first = {
    t1: { text: "一二三四五六七八九十一二三四五六七八", tone: "good" },
    t2: { text: "  " },
    t3: "not a note",
    t4: { text: "ok", tone: "loud" },
  };
  let emit;
  core.service.turnNote.call({ ctx: host.callerOf(host.entries[0]) }, "cost", (scope, e) => {
    emit = e;
    e(first);
    return () => {};
  });
  const feed = core.feed("note-feed", "cost", "note", util.normalizeScope({ sessionId: "s" }));
  await feed.waitFirst(500);
  assert.deepEqual(feed.data, { t1: { text: "一二三四五六七八九十一二三四五六", tone: "good" }, t4: { text: "ok" } });
  emit(many);
  await new Promise((r) => setTimeout(r, 300));
  const turns = Object.keys(feed.data);
  assert.equal(turns.length, LIMITS.turnNotesPerFeed);
  assert.equal(turns.at(-1), `t${LIMITS.turnNotesPerFeed + 5}`);
  assert.equal(turns[0], "t6");
  emit("nonsense");
  assert.equal(core.health.get("note-feed").consecutive, 1, "a violation, and the old notes stay");
  assert.equal(Object.keys(feed.data).length, LIMITS.turnNotesPerFeed);
  core.dispose();
});

test("core: turnNote on an id declared elsewhere is reported", () => {
  const a = pkgDir("note-wrong", { v: 1, contributes: { panels: [{ id: "p", title: "P" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  core.service.turnNote.call({ ctx: host.callerOf(host.entries[0]) }, "p", () => () => {});
  const row = core.contributions({ versions: [1], app: "1.0.0", locale: "zh", surfaces: [], key: "k" }).plugins[0];
  assert.ok(codes(row.issues).includes("undeclared@/runtime/p"));
  core.dispose();
});

test("requires holds on the ＋ panel's tools and a conversation's actions too", () => {
  const effect = { type: "toast", text: "x" };
  const { dir, pkg } = pkgDir("requires", {
    v: 1,
    capabilities: ["audio"],
    contributes: {
      "composer.tools": [{ id: "t", label: "T", effect, requires: ["audio"] }, { id: "u", label: "U", effect, requires: ["voice"] }],
      "session.actions": [{ id: "s", label: "S", effect, requires: ["audio"] }],
    },
  });
  const parsed = parseManifest(pkg, dir);
  const row = (features) => renderPlugin(parsed, { versions: [1], app: "1.0.0", locale: "zh", features }, {
    panels: new Map(), strips: new Set(), notes: new Set(), handlers: new Set(), degraded: false, runtimeIssues: [],
  }).contributes;
  assert.equal(row([])["composer.tools"][0].ready, false, "the app can't do it");
  assert.equal(row([])["session.actions"][0].ready, false, "the app can't do it");
  assert.equal(row(["audio"])["composer.tools"][0].ready, true);
  assert.equal(row(["audio"])["session.actions"][0].ready, true);
  assert.equal(row(["audio", "voice"])["composer.tools"][1].ready, false, "not declared: it never comes true");
});

test("nothing opens a panel that was rejected", () => {
  const r = check("rejected", {
    panels: [{ id: "untitled" }, { id: "kept", title: "K" }],
    "composer.tools": [{ id: "t", label: "T", panel: "untitled" }, { id: "u", label: "U", panel: "kept" }],
    "composer.actions": [{ id: "a", label: "A", effect: { type: "open", page: "panel:untitled" } }],
    "composer.strip": [{ id: "s", text: "x", panel: "untitled" }],
  }, { handlers: [], panels: ["kept"] });
  const c = r.plugin.contributes;
  assert.equal(c["composer.tools"][0].effect, undefined);
  assert.equal(c["composer.tools"][0].ready, false);
  assert.deepEqual(c["composer.tools"][1].effect, [{ type: "open", page: "panel:kept" }]);
  assert.equal(c["composer.actions"][0].effect, undefined);
  assert.equal(c["composer.strip"][0].panel, undefined);
  for (const at of ["composer.tools/0", "composer.actions/0", "composer.strip/0"]) {
    assert.ok(codes(r.issues).includes(`invalid-field@/dshGo/contributes/${at}`), at);
  }
});

test("core: removing a turn note's registration ends its feed", async (t) => {
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const a = pkgDir("note-removed", { v: 1, contributes: { "turn.note": [{ id: "cost" }] } });
  const host = fakeHost([a]);
  const core = new NativeCore(host.ctx, LIMITS, "test");
  let cancelled = 0;
  const remove = core.service.turnNote.call({ ctx: host.callerOf(host.entries[0]) }, "cost", (scope, emit) => {
    emit({ 1: { text: "x" } });
    return () => { cancelled++; };
  });
  const feed = core.feed("note-removed", "cost", "note", util.normalizeScope({ sessionId: "s" }));
  await feed.waitFirst(500);
  remove();
  assert.equal(feed.stopped, true);
  assert.equal(cancelled, 1);
  core.dispose();
});

test("requires, micro and reports go by the entry that was accepted, not an earlier one with its id", () => {
  const effect = { type: "toast", text: "x" };
  const { dir, pkg } = pkgDir("accepted-entry", {
    v: 1,
    capabilities: ["audio", "micro"],
    contributes: {
      micro: [{ id: "m" }],
      // The first entry of each pair has no label or title, so it is rejected.
      "composer.tools": [{ id: "t" }, { id: "t", label: "T", effect, requires: ["audio"] }, { id: "u" }, { id: "u", label: "U", effect, requires: ["voice"] }],
      "session.actions": [{ id: "s", requires: ["audio"] }, { id: "s", label: "S", effect }],
      panels: [{ id: "p" }, { id: "p", title: "P", micro: "m" }, { id: "gone" }],
      "composer.actions": [{ id: "a" }, { id: "a", label: "A", effect: { type: "open", page: "panel:gone" } }],
    },
  });
  const parsed = parseManifest(pkg, dir);
  const row = renderPlugin(parsed, { versions: [1], app: "1.0.0", locale: "zh", features: [] }, {
    panels: new Map(), strips: new Set(), notes: new Set(), handlers: new Set(), degraded: false, runtimeIssues: [],
  }).contributes;
  assert.deepEqual(row["composer.tools"][0].requires, ["audio"]);
  assert.equal(row["composer.tools"][0].ready, false, "the valid tool keeps its requirement");
  assert.equal(row["session.actions"][0].requires, undefined, "a rejected entry's requirement isn't borrowed");
  assert.equal(row["session.actions"][0].ready, true);
  assert.equal(row.panels[0].micro, "m");
  const found = codes(parsed.issues);
  assert.ok(found.includes("invalid-field@/dshGo/contributes/composer.tools/3/requires"), found.join());
  assert.ok(found.includes("invalid-field@/dshGo/contributes/composer.actions/1"), found.join());
});

test("issue paths point at the entry in the manifest, past the rejected ones", () => {
  const { dir, pkg } = pkgDir("issue-paths", {
    v: 1,
    contributes: {
      // Each list starts with an entry that is rejected, so nothing else sits at index 0.
      "composer.actions": [{ id: "a" }, { id: "a", label: "this label is far too long for a capsule" }],
      "composer.strip": [{ id: "!" }, { id: "s" }],
      "turn.note": [{ id: "!" }, { id: "n" }],
      panels: [{ id: "p" }, { id: "q", title: "Q" }, { id: "v", title: "V", view: "view.json" }],
    },
  });
  writeFileSync(join(dir, "view.json"), "not json");
  const found = codes(checkManifest(pkg, dir, { handlers: [] }).issues);
  for (const at of [
    "no-handler@/dshGo/contributes/composer.actions/1",
    "too-long@/dshGo/contributes/composer.actions/1/label",
    "no-handler@/dshGo/contributes/composer.strip/1",
    "no-handler@/dshGo/contributes/turn.note/1",
    "no-handler@/dshGo/contributes/panels/1",
    "view-file@/dshGo/contributes/panels/2/view",
  ]) assert.ok(found.includes(at), `${at} in ${found.join()}`);
});
