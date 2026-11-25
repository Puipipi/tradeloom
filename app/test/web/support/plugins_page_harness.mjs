// Runs assets/web/dsh_web_open.js against a model of DSH Web's Plugins page
// (node, no DOM library) and prints what it pressed, as JSON. Used by
// test/web/web_open_plugins_test.dart.
//
//   node plugins_page_harness.mjs <bridge.js> <scenario JSON>
//
// The model follows DSH 0.2.1-rc.4's dsh-client-ui-plugin-manager: the
// sidebar's 「插件」 entry opens the panel (`section[data-plugin-panel]`, busy
// while the list loads); a card is `li[data-plugin-package=<name>]` with its
// title button `查看 <title>` and its enable switch `启用 <title>` (an empty
// thumb inside); experimental bundles past the first few sit behind 「更多」
// (a page of their own); a bundle's page and a part's page have a crumb back
// at the top (`返回插件`, `返回 <bundle>`). The panel remembers its page.
//
// Scenario:
//   open       the target the app opens (window.__dshAppOpen)
//   bundles    [{name, title, more}]  cards (more: behind 「更多」)
//   view       the panel's remembered page: 'list' | 'more' |
//              {package: name} | {row: name}
//   bootMs     when the sidebar appears (default 0)
//   loadMs     when the list has loaded (default 0; null: never)
//   touchAt    ms: the person touches the page (a trusted pointerdown)
//   reopenAt   ms: the app opens [reopen] while the first is on its way
//   reopen     that second target
//   untilMs    how long to run the clock (default 60000)
import fs from 'node:fs';
import vm from 'node:vm';

const [bridgePath, scenarioJson] = process.argv.slice(2);
const s = JSON.parse(scenarioJson);
const out = { presses: [], reports: [], view: null, switched: [], lastPressAt: null, doneAt: null };

// ---------------------------------------------------------------------------
// A virtual clock: timers run in time order, each after the microtasks of
// the one before (so awaits resolve as in a page).
let now = 1000;
const t0 = now;
const timers = [];
let seq = 0;
function setTimer(fn, ms) {
  timers.push({ at: now + Math.max(0, ms || 0), seq: seq++, fn });
}
const clock = { now: () => now };

// ---------------------------------------------------------------------------
// A minimal element tree and the selectors the bridge uses.
class El {
  constructor(tag, attrs = {}, kids = [], text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.kids = kids;
    this.ownText = text;
    this.onClick = null;
    this.name = attrs['aria-label'] || text || tag;
  }
  get children() { return this.kids; }
  get textContent() { return this.ownText + this.kids.map((k) => k.textContent).join(''); }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  hasAttribute(n) { return n in this.attrs; }
  get className() { return this.attrs.class || ''; }
  getClientRects() { return [{}]; }
  click() {
    out.presses.push({ at: now - t0, name: this.name });
    out.lastPressAt = now - t0;
    this.onClick?.();
    render();
  }
  descendants() {
    const all = [];
    const walk = (e) => e.kids.forEach((k) => { all.push(k); walk(k); });
    walk(this);
    return all;
  }
  querySelectorAll(sel) {
    const alts = splitOutside(sel, ',').map((a) => splitOutside(a.trim(), ' ').filter(Boolean).map(parseCompound));
    return this.descendants().filter((el) => alts.some((chain) => matchChain(el, chain, this)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// [text] split at [sep] outside brackets (`[aria-label^="查看 "]` is one part).
function splitOutside(text, sep) {
  const parts = [''];
  let depth = 0;
  for (const ch of text) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === sep && depth === 0) parts.push('');
    else parts[parts.length - 1] += ch;
  }
  return parts;
}

function parseCompound(text) {
  const tag = (text.match(/^[a-z*]+/i) || ['*'])[0];
  const attrs = [...text.matchAll(/\[([a-z-]+)(?:([\^*]?=)"([^"]*)")?\]/gi)].map((m) => ({ name: m[1], op: m[2], value: m[3] }));
  return { tag, attrs };
}

function matchCompound(el, c) {
  if (c.tag !== '*' && el.tagName !== c.tag.toUpperCase()) return false;
  return c.attrs.every((a) => {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (!a.op) return true;
    if (a.op === '=') return v === a.value;
    if (a.op === '^=') return v.startsWith(a.value);
    return v.includes(a.value);
  });
}

// [el] matches the last compound and has ancestors (inside [root]) for the rest.
function matchChain(el, chain, root) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let p = parentOf(el);
  while (i >= 0 && p && p !== root) {
    if (matchCompound(p, chain[i])) i--;
    p = parentOf(p);
  }
  return i < 0;
}

// Every tree drawn so far keeps its links (the bridge may hold an element
// from the frame before).
const parents = new WeakMap();
function parentOf(el) { return parents.get(el) || null; }
function index(el) {
  el.kids.forEach((k) => { parents.set(k, el); index(k); });
}

// ---------------------------------------------------------------------------
// The page.
const bundles = s.bundles || [];
let panelOpen = false;
let view = s.view || 'list';
const booted = () => now - t0 >= (s.bootMs || 0);
const loaded = () => s.loadMs !== null && now - t0 >= (s.loadMs || 0);

const btn = (label, text, extra = {}, kids = []) => new El('button', { 'aria-label': label, ...extra }, kids, text);
const titleOf = (name) => bundles.find((b) => b.name === name)?.title || name;

function card(b) {
  const open = btn(`查看 ${b.title}`, b.title, { class: 'X_cardTitle X_cardOpen' });
  open.onClick = () => { view = { package: b.name }; };
  const toggle = btn(`启用 ${b.title}`, '', { role: 'switch' }, [new El('span', { class: 'X_thumb' })]);
  toggle.onClick = () => out.switched.push(b.name);
  return new El('li', { 'data-plugin-package': b.name, class: 'X_card' }, [
    new El('span', { class: 'X_cardIcon' }, [new El('svg')]),
    new El('div', { class: 'X_cardMain' }, [open]),
    toggle,
  ]);
}

function crumb(label, text, back) {
  const b = btn(label, '', { class: 'X_crumb' }, [new El('svg', { class: 'X_crumbIcon' }), new El('span', {}, [], text)]);
  b.onClick = back;
  return new El('div', { class: 'X_detailTop' }, [b]);
}

function pluginsPage() {
  if (!loaded()) return new El('section', { 'data-plugin-panel': 'true', 'aria-busy': 'true' }, [], '正在读取插件…');
  let body;
  if (view === 'list') {
    const more = bundles.some((b) => b.more);
    const head = [new El('h3', {}, [], '实验性插件')];
    if (more) {
      const m = new El('button', { class: 'X_groupMore' }, [new El('svg')], '更多');
      m.onClick = () => { view = 'more'; };
      head.push(m);
    }
    body = [
      new El('section', { 'data-plugin-group': 'extensions' }, [
        new El('div', {}, head),
        new El('ul', {}, bundles.filter((b) => !b.more).map(card)),
      ]),
    ];
  } else if (view === 'more') {
    body = [crumb('返回插件', '插件', () => { view = 'list'; }), new El('ul', {}, bundles.filter((b) => b.more).map(card))];
  } else if (view.package) {
    body = [
      new El('div', { 'data-plugin-detail': view.package }, [
        crumb('返回插件', '插件', () => { view = 'list'; }),
        new El('h3', {}, [], titleOf(view.package)),
        btn(`配置 ${titleOf(view.package)}`, '配置'),
      ]),
    ];
  } else {
    const pkg = view.row;
    body = [
      new El('div', { 'data-plugin-row-detail': `${pkg}#row` }, [
        crumb(`返回 ${titleOf(pkg)}`, titleOf(pkg), () => { view = { package: pkg }; }),
      ]),
    ];
  }
  return new El('section', { 'data-plugin-panel': 'true' }, body);
}

let sidebarEl = null;
let mainEl = null;
function render() {
  const entry = btn('插件', '插件', { class: 'X_panelRow' });
  entry.onClick = () => { panelOpen = true; };
  const session = btn('更多', '', { class: 'X_rowActions' }, [new El('svg')]);
  sidebarEl = booted() ? new El('div', { 'data-slot': 'sidebar' }, [entry, session]) : null;
  mainEl = booted()
    ? new El('div', { 'data-slot': 'main' }, panelOpen ? [pluginsPage()] : [new El('div', { 'data-slot': 'main.conversation' })])
    : null;
  if (sidebarEl) index(sidebarEl);
  if (mainEl) index(mainEl);
  out.view = !panelOpen ? 'conversation' : typeof view === 'string' ? view : view.package ? `package:${view.package}` : `row:${view.row}`;
}

// The page is drawn again before every timer (what time changes: boot, the
// list loading) and after every press.
const listeners = {};
const document = {
  querySelector(sel) {
    if (sel === '[data-slot="sidebar"]') return sidebarEl;
    if (sel === '[data-slot="main"]') return mainEl;
    for (const r of [sidebarEl, mainEl].filter(Boolean)) {
      const found = r.querySelector(sel);
      if (found) return found;
    }
    return null;
  },
  querySelectorAll(sel) {
    return [sidebarEl, mainEl].filter(Boolean).flatMap((r) => r.querySelectorAll(sel));
  },
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
};

const storage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};

const window = { DshAppOpen: { postMessage: (m) => out.reports.push({ at: now - t0, ...JSON.parse(m) }) } };
const context = vm.createContext({
  window, document,
  location: { href: 'http://127.0.0.1:3080/?token=t', replace: () => {} },
  history: { state: null, replaceState: () => {} },
  localStorage: storage(), sessionStorage: storage(),
  URL, JSON, Object, Promise, Array,
  Date: clock,
  setTimeout: setTimer,
});
vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), context);
render();

if (s.touchAt != null) {
  setTimer(() => (listeners.pointerdown || []).forEach((fn) => fn({ type: 'pointerdown', isTrusted: true })), s.touchAt);
}
if (s.reopenAt != null) setTimer(() => window.__dshAppOpen(s.reopen), s.reopenAt);
const opening = (async () => {
  window.__dshAppOpen(s.open);
  // A second open replaces __dshAppOpening: follow whichever is latest.
  let seen;
  while (seen !== window.__dshAppOpening) {
    seen = window.__dshAppOpening;
    await seen;
  }
  out.doneAt = now - t0;
})();

const until = t0 + (s.untilMs || 60000);
for (;;) {
  // What the last timer set going (awaits, new timers) settles first.
  await new Promise((r) => setImmediate(r));
  if (!timers.length || now >= until) break;
  timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const next = timers.shift();
  now = Math.max(now, next.at);
  render();
  next.fn();
}
await new Promise((r) => setImmediate(r));
void opening;
render();
out.pendingTimers = timers.length;
out.endAt = now - t0;
process.stdout.write(JSON.stringify(out));
