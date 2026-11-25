// Runs assets/web/dsh_web_back.js against a page model (node, no DOM
// library) and prints what each press of back did, as JSON. Used by
// test/web/web_back_bridge_test.dart. The selectors are the bridge's own:
// the model answers exactly those (checked against DSH 0.2.1-rc.4's client
// in a browser).
//
//   node back_bridge_harness.mjs <bridge.js> <scenario JSON>
//
// Scenario:
//   layers     [{role: 'dialog'|'menu', mask, close, closes: 'escape'|'mask'|'close'|'touch'|'never'}]
//              open dialogs and menus, bottom first; what closes each
//   popups     [{closes: 'touch'|'never'}]  open popovers
//   editing    focus is in a text field
//   layout     'drawer' | 'desktop' | ''      (html[data-dsh-app-layout])
//   drawer     the app's drawer is open (window.__dshApp)
//   noPhoneLayout  no window.__dshApp at all
//   officialDrawer  DSH Web's own sidebar is a drawer over the page (official
//                   layout, phone widths), open
//   rightFull  the right panel covers the conversation
//   page       'conversation' | 'page'      what the main area shows
//   crumb      the page has a crumb back
//   lineage    the conversation's crumbs (ancestors as buttons)
//   stored     the stored conversation id
//   rows       [{id, archived}]               conversation rows in the sidebar
//   presses    [ms, …]  when each press of back comes (virtual clock)
import fs from 'node:fs';
import vm from 'node:vm';

const [bridgePath, scenarioJson] = process.argv.slice(2);
const s = JSON.parse(scenarioJson);
const log = [];
let now = 1000;

class El {
  constructor(name, attrs = {}) {
    this.name = name;
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.tagName = attrs.tag || 'DIV';
    this.isConnected = true;
    this.isContentEditable = !!attrs.editable;
    this.previousElementSibling = null;
    this.onClick = null;
  }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  hasAttribute(n) { return n in this.attrs; }
  getClientRects() { return this.isConnected ? [{}] : []; }
  click() { log.push('click ' + this.name); this.onClick?.(); }
  blur() { log.push('blur ' + this.name); if (document.activeElement === this) document.activeElement = document.body; }
  dispatchEvent(e) {
    log.push(e.type + ' ' + (e.key || e.pointerType) + ' @' + this.name);
    listeners.forEach((l) => l(e, this));
    return true;
  }
  remove() { this.isConnected = false; }
}

const listeners = [];
const body = new El('body', { tag: 'BODY' });
const html = new El('html', { 'data-dsh-app-layout': s.layout ?? 'drawer' });
const document = { body, documentElement: html, activeElement: body };

// Dialogs and menus, bottom first, each with what closes it.
const layers = (s.layers || []).map((l, i) => {
  const el = new El(`${l.role}${i}`, l.role === 'menu' ? { role: 'menu' } : { role: 'dialog', 'aria-modal': 'true' });
  if (l.mask) {
    const mask = new El(`mask${i}`, { 'aria-hidden': 'true', class: 'x_mask' });
    mask.onClick = () => l.closes === 'mask' && el.remove();
    el.previousElementSibling = mask;
  }
  if (l.close) {
    el.closeButton = new El(`close${i}`, { class: 'x_close', tag: 'BUTTON' });
    el.closeButton.onClick = () => l.closes === 'close' && el.remove();
  }
  el.closes = l.closes;
  return el;
});
const popups = (s.popups || []).map((p, i) => Object.assign(new El(`popup${i}`, { role: 'listbox' }), { closes: p.closes }));

const top = (list) => list.filter((e) => e.isConnected).at(-1);
listeners.push((e) => {
  if (e.type === 'keydown' && e.key === 'Escape') {
    const layer = top(layers);
    if (layer?.closes === 'escape') layer.remove();
  }
  if (e.type === 'pointerdown') {
    const layer = top(layers);
    if (layer?.getAttribute('role') === 'menu' && layer.closes === 'touch') layer.remove();
    for (const p of popups) if (p.closes === 'touch') p.remove();
  }
});

const editor = new El('editor', { tag: 'DIV', editable: true });
if (s.editing) document.activeElement = editor;

let drawerOpen = !!s.drawer;
// dsh_web_phone.js's handle on the drawer (absent with the phone layout off).
const app = s.noPhoneLayout
  ? undefined
  : {
      sidebarOpen: () => drawerOpen,
      closeSidebar: () => { log.push('closeSidebar'); drawerOpen = false; },
      toggleSidebar: () => {},
    };

const frame = new El('frame', s.rightFull ? { 'data-rightbar-fullscreen': 'true' } : {});
// DSH Web as shipped at phone widths: its sidebar slides over the page as a
// drawer, folded through the toggle in the sidebar's logo row.
if (s.officialDrawer) frame.attrs['data-sidebar-drawer'] = '';
const sidebarToggle = new El('sidebarToggle', { tag: 'BUTTON', class: 'x_iconButton' });
sidebarToggle.onClick = () => { frame.attrs['data-sidebar-collapsed'] = ''; };
const fold = new El('fold', { tag: 'BUTTON' });
fold.onClick = () => { delete frame.attrs['data-rightbar-fullscreen']; };

const conversation = new El('conversation', { 'data-slot': 'main.conversation' });
const section = new El('section', { tag: 'SECTION' });
let mainChild = s.page === 'page' ? section : conversation;
const crumb = s.crumb ? new El('crumb', { tag: 'BUTTON', class: 'x_crumb' }) : null;
const lineage = (s.lineage || []).map((name) => new El(`lineage:${name}`, { tag: 'BUTTON', class: 'x_crumb' }));
const rows = (s.rows || []).map((r) => {
  const row = new El(`row:${r.id}`, r.archived ? { 'aria-description': 'archived' } : {});
  row.id = r.id;
  row.archived = !!r.archived;
  row.onClick = () => { if (!r.archived) mainChild = conversation; };
  return row;
});

const main = {
  get firstElementChild() { return mainChild; },
  querySelector(sel) {
    if (sel === ':scope > [data-slot="main.conversation"]') return mainChild === conversation ? conversation : null;
    throw new Error('main.querySelector: ' + sel);
  },
  querySelectorAll(sel) {
    if (sel === ':scope > section button[class*="_crumb"]') return mainChild === section && crumb ? [crumb] : [];
    if (sel === 'nav[class*="_crumbs"] button[class*="_crumb"]') return mainChild === conversation ? lineage : [];
    throw new Error('main.querySelectorAll: ' + sel);
  },
};
for (const l of layers) {
  l.querySelector = (sel) => {
    if (sel === 'button[class*="_close"]') return l.closeButton ?? null;
    throw new Error('layer.querySelector: ' + sel);
  };
}

document.querySelectorAll = (sel) => {
  if (sel === '[role="dialog"][aria-modal="true"], [role="menu"]') return layers.filter((e) => e.isConnected);
  if (sel === '[role="dialog"]:not([aria-modal="true"]), [role="listbox"], [data-cordis-panel]') {
    return popups.filter((e) => e.isConnected);
  }
  if (sel === '[data-slot="rightbar"] button[data-sidebar-right-toggle]') return s.rightFull ? [fold] : [];
  if (sel === '[data-slot="sidebar"] [class*="_logoRow"] button[class*="_iconButton"]') {
    return s.officialDrawer && !frame.hasAttribute('data-sidebar-collapsed') ? [sidebarToggle] : [];
  }
  throw new Error('document.querySelectorAll: ' + sel);
};
document.querySelector = (sel) => {
  if (sel === '[data-slot="root"] > [class*="_frame"]') return frame;
  if (sel === '[data-slot="main"]') return main;
  const row = /^\[data-slot="sidebar"\] \[role="treeitem"\]\[data-row-key="session:(.*)"\]:not\(\[aria-description\]\)$/.exec(sel);
  if (row) return rows.find((r) => r.id === row[1] && !r.archived) ?? null;
  throw new Error('document.querySelector: ' + sel);
};

const localStorage = {
  getItem: (k) => (k === 'dsh.sessions.current' && s.stored ? JSON.stringify({ sessionId: s.stored }) : null),
};

class KeyboardEvent { constructor(type, init) { Object.assign(this, init, { type }); } }
class PointerEvent { constructor(type, init) { Object.assign(this, init, { type }); } }
const window = app ? { __dshApp: app } : {};
const context = vm.createContext({
  window, document, localStorage, KeyboardEvent, PointerEvent, JSON,
  CSS: { escape: (v) => String(v) },
  Date: { now: () => now },
});
const source = fs.readFileSync(bridgePath, 'utf8');
vm.runInContext(source, context);
const first = window.__dshAppBack;
vm.runInContext(source, context);

const steps = [];
for (const at of s.presses || [0]) {
  now = 1000 + at;
  log.push('press @' + at);
  steps.push(window.__dshAppBack());
}
process.stdout.write(JSON.stringify({
  steps,
  log,
  idempotent: window.__dshAppBack === first,
  open: layers.filter((e) => e.isConnected).map((e) => e.name),
  popups: popups.filter((e) => e.isConnected).map((e) => e.name),
  drawer: drawerOpen,
  officialDrawer: frame.hasAttribute('data-sidebar-drawer') && !frame.hasAttribute('data-sidebar-collapsed'),
  rightFull: frame.attrs['data-rightbar-fullscreen'] === 'true',
  main: mainChild.name,
}));
