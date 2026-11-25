// Runs the real injected script with deterministic DOM mutation delivery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../../assets/web/dsh_web_sidebar.js', import.meta.url), 'utf8');

function page({ mounted = true, collapsed = true, layout = '' } = {}) {
  const observers = [];
  const messages = [];
  function element(parent, attrs = {}) {
    return { parent, attrs, hasAttribute(name) { return name in this.attrs; },
      getAttribute(name) { return this.attrs[name] ?? null; } };
  }
  const html = element(null, { 'data-dsh-app-layout': layout });
  let root = mounted ? element(html) : null;
  function frame(parent, folded) {
    return element(parent, { 'data-sidebar-drawer': 'true',
      ...(folded ? { 'data-sidebar-collapsed': 'true' } : {}) });
  }
  let current = root ? frame(root, collapsed) : null;
  const document = { documentElement: html, querySelector(selector) {
    if (selector === '[data-slot="root"]') return root;
    assert.equal(selector, '[data-slot="root"] > [class*="_frame"]');
    return current;
  } };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
  }
  function mutate(target, type, name) {
    const pending = observers.filter(o => {
      let node = target;
      while (node && node !== o.target) node = o.options?.subtree ? node.parent : null;
      return node && o.options[type] &&
        (type !== 'attributes' || !o.options.attributeFilter || o.options.attributeFilter.includes(name));
    });
    pending.forEach(o => o.callback([{ target, type, attributeName: name }]));
  }
  function attr(target, name, present) {
    if (present) target.attrs[name] = 'true';
    else delete target.attrs[name];
    mutate(target, 'attributes', name);
  }
  const context = vm.createContext({ document, MutationObserver,
    window: { DshAppSidebar: { postMessage(value) { messages.push(value); } } } });
  const inject = () => vm.runInContext(source, context);
  inject();
  return { messages, inject,
    toggle(folded) { attr(current, 'data-sidebar-collapsed', folded); },
    drawer(present) { attr(current, 'data-sidebar-drawer', present); },
    layout(value) {
      html.attrs['data-dsh-app-layout'] = value;
      mutate(html, 'attributes', 'data-dsh-app-layout');
    },
    mount(folded = true) {
      root = element(html);
      current = frame(root, folded);
      mutate(html, 'childList');
    },
    replaceFrame(folded = true) {
      const old = current;
      current = frame(root, folded);
      mutate(root, 'childList');
      assert.equal(observers.filter(o => o.target === old).length, 0);
    },
    remove() { root = null; current = null; mutate(html, 'childList'); },
    observerCount() { return observers.length; },
  };
}

test('mounted drawer reports open and closed, without duplicate messages', () => {
  const p = page();
  p.toggle(false);
  p.toggle(false);
  p.toggle(true);
  assert.deepEqual(p.messages, ['open', 'closed']);
});

test('root mounts after injection: opening still hides the marker', () => {
  const p = page({ mounted: false });
  p.mount();
  p.toggle(false);
  p.toggle(true);
  assert.deepEqual(p.messages, ['open', 'closed']);
});

test('late root can already contain an open drawer', () => {
  const p = page({ mounted: false });
  p.mount(false);
  assert.deepEqual(p.messages, ['open']);
});

test('root and frame replacements rebind, removal restores the marker', () => {
  const p = page({ collapsed: false });
  p.replaceFrame();
  p.toggle(false);
  p.remove();
  p.mount(false);
  p.toggle(true);
  assert.deepEqual(p.messages, ['open', 'closed', 'open', 'closed', 'open', 'closed']);
});

test('phone layout and wide columns do not hide the marker', () => {
  const p = page({ collapsed: false, layout: 'drawer' });
  assert.deepEqual(p.messages, []);
  p.layout('');
  p.drawer(false);
  p.drawer(true);
  p.layout('drawer');
  assert.deepEqual(p.messages, ['open', 'closed', 'open', 'closed']);
});

test('reinjection does not duplicate observers or reports', () => {
  const p = page();
  const count = p.observerCount();
  p.inject();
  assert.equal(p.observerCount(), count);
  p.toggle(false);
  assert.deepEqual(p.messages, ['open']);
});
