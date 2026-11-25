// Runs assets/web/dsh_web_open.js in a minimal page (node, no DOM library)
// and prints what it did as JSON. Used by test/web/web_open_bridge_test.dart.
//
//   node open_bridge_harness.mjs <bridge.js> <scenario JSON>
//
// Scenario: {href, stored, pending, open, shown}
//   href     the page's address
//   stored   the stored conversation (`dsh.sessions.current`)
//   pending  a hop's pending target in sessionStorage (this load came from it)
//   open     the target the app opens (window.__dshAppOpen), if any
//   shown    whether a conversation is on screen
import fs from 'node:fs';
import vm from 'node:vm';

const [bridgePath, scenarioJson] = process.argv.slice(2);
const scenario = JSON.parse(scenarioJson);
const out = { replaced: [], reloaded: 0, historyReplaced: [], reports: [], stored: null };

function storage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const localStorage = storage(
  scenario.stored ? { 'dsh.sessions.current': JSON.stringify({ sessionId: scenario.stored }) } : {},
);
const sessionStorage = storage(
  scenario.pending ? { 'dsh-app-open-pending': JSON.stringify(scenario.pending) } : {},
);

let href = scenario.href;
const location = {
  get href() { return href; },
  replace: (url) => out.replaced.push(url),
  reload: () => { out.reloaded++; },
};
const history = {
  state: null,
  replaceState: (_state, _title, url) => { out.historyReplaced.push(url); href = url; },
};
const sidebar = { querySelectorAll: () => [], querySelector: () => null };
const document = {
  querySelector: (sel) => {
    if (sel === '[data-slot="sidebar"]') return sidebar;
    if (sel === '[data-slot="conversation.session"]') return scenario.shown ? {} : null;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
};
const window = {
  DshAppOpen: { postMessage: (m) => out.reports.push(JSON.parse(m)) },
};
// A virtual clock: every look at it is 100 ms later, so the bridge's polls
// (up to 15 s) run out in a few ticks.
let now = 0;
const clock = { now: () => (now += 100) };
const context = vm.createContext({
  window, document, location, history, localStorage, sessionStorage, URL, JSON, Object, Promise,
  Date: clock,
  setTimeout: (fn) => setTimeout(fn, 1),
});
vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), context);
if (scenario.open) window.__dshAppOpen(scenario.open);
if (window.__dshAppOpening) await window.__dshAppOpening;
// Let the short polls of a failing wait run out.
await new Promise((r) => setTimeout(r, 200));
out.stored = localStorage.dump()['dsh.sessions.current'] || null;
out.pending = sessionStorage.dump()['dsh-app-open-pending'] || null;
out.href = href;
process.stdout.write(JSON.stringify(out));
