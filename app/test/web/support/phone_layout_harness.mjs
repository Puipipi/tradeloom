// Runs assets/web/dsh_web_phone.js against a model of the official frame (node,
// no DOM library) and prints what the app's menu button does to it, as JSON.
// Used by test/web/web_phone_layout_test.dart. The selectors are the script's
// own; the model answers those (checked against DSH 0.2.1-rc.4 and 0.2.2-rc.1
// in a browser).
//
//   node phone_layout_harness.mjs <script.js> <scenario JSON>
//
// Scenario:
//   officialDrawer  the frame has data-sidebar-drawer (DSH 0.2.2 on, below 768px)
//   steps           ['toggle' | 'close', …]  calls on window.__dshApp
import fs from 'node:fs';
import vm from 'node:vm';

const [scriptPath, scenarioJson] = process.argv.slice(2);
const s = JSON.parse(scenarioJson);

const attrs = new Set(['data-sidebar-collapsed', 'data-rightbar-collapsed']);
if (s.officialDrawer) attrs.add('data-sidebar-drawer');
const frame = {
  hasAttribute: (a) => attrs.has(a),
  setAttribute: (a) => attrs.add(a),
  removeAttribute: (a) => attrs.delete(a),
  querySelector: () => null,
};
let clicks = 0;
const toggle = {
  click() {
    clicks++;
    if (attrs.has('data-sidebar-collapsed')) attrs.delete('data-sidebar-collapsed');
    else attrs.add('data-sidebar-collapsed');
  },
};
const html = { getAttribute: () => 'drawer', style: {} };
const sheets = [];
const document = {
  documentElement: html,
  body: {},
  head: { firstChild: null, insertBefore: (sheet) => sheets.unshift(sheet.textContent) },
  createElement: () => ({}),
  addEventListener() {},
  querySelector(sel) {
    if (sel === '[data-slot="root"] > [class*="_frame"]') return frame;
    if (sel.includes('_logoRow')) return toggle;
    return null;
  },
};
const window = { matchMedia: () => ({ addEventListener() {} }) };
const sandbox = {
  window,
  document,
  getComputedStyle: () => ({ backgroundColor: '' }),
  MutationObserver: class { observe() {} },
  setTimeout: (fn) => (fn(), 0),
  clearTimeout() {},
};
const source = fs.readFileSync(scriptPath, 'utf8');
vm.runInNewContext(source, sandbox);
vm.runInNewContext(source, sandbox);

const out = { afterLoad: { clicks, attrs: [...attrs].sort() }, sheets, steps: [] };
for (const step of s.steps ?? []) {
  if (step === 'toggle') window.__dshApp.toggleSidebar();
  else window.__dshApp.closeSidebar();
  out.steps.push({ open: window.__dshApp.sidebarOpen(), attrs: [...attrs].sort() });
}
process.stdout.write(JSON.stringify(out));
