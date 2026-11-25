// Actual bridge registration and served-page scripts, with modeled Cordis and
// WebServer lifetimes. Node VM realms are not a WebView or a running DSH Host.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {apply} from '../bridge/dsh-go-bridge/lib/index.js';

function bridge(t) {
  const taps = new Set(), stops = [];
  const ctx = {
    webServer: {
      tapIndex(transform) { taps.add(transform); return () => taps.delete(transform); },
      register() { return () => {}; },
      registerUpgrade() { return () => {}; },
    },
    on() {}, provide() {}, get() {},
    inject(_deps, callback) { callback(ctx); },
    effect(start) { const stop = start(); if (typeof stop === 'function') stops.push(stop); },
  };
  const dispose = () => { while (stops.length) stops.pop()(); };
  t.after(dispose);
  apply(ctx, {persist: false, guardRoutes: false});
  return {render: html => [...taps].reduce((text, tap) => tap(text), html), dispose};
}

function scripts(html, context) {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
}

function oldPage(t) {
  const context = vm.createContext({AbortController, AbortSignal});
  vm.runInContext('delete Promise.withResolvers', context);
  scripts(bridge(t).render('<html><head></head><body></body></html>'), context);
  return context;
}

test('the served page installs the missing method before injected head scripts and READY', async t => {
  // Exact READY expression from dsh-host-webserver/src/injections.ts at
  // 66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db; head rows run before this body tail.
  const html = '<html><head><script>globalThis.head = Promise.withResolvers(); head.resolve(7)</script></head>' +
    '<body><script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script></body></html>';
  const context = vm.createContext({AbortController, AbortSignal});
  vm.runInContext('delete Promise.withResolvers', context);
  assert.throws(() => scripts(html, context), error => error.name === 'TypeError' && /withResolvers/.test(error.message));
  scripts(bridge(t).render(html), context);
  assert.equal(await vm.runInContext('head.promise', context), 7);
  assert.equal(await vm.runInContext('__DSH_BOOT_READY__.promise', context), undefined);
});

test('an existing browser implementation keeps its identity and property descriptor', t => {
  const context = vm.createContext({AbortController, AbortSignal});
  // A callable already supplied by this browser must not be replaced.
  vm.runInContext('Object.defineProperty(Promise, "withResolvers", {value: function existing() {}, configurable: true})', context);
  const before = vm.runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers")', context);
  const html = bridge(t).render('<head></head>');
  scripts(html, context);
  scripts(html, context);
  const after = vm.runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers")', context);
  for (const key of ['value', 'writable', 'enumerable', 'configurable']) assert.strictEqual(after[key], before[key]);
});

test('the fallback creates independent promises, resolves and rejects, and has the builtin descriptor', async t => {
  const context = oldPage(t);
  const descriptor = vm.runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers")', context);
  assert.equal(descriptor.configurable, true);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.value.name, 'withResolvers');
  assert.equal(descriptor.value.length, 0);
  const first = vm.runInContext('Promise.withResolvers()', context);
  const second = vm.runInContext('Promise.withResolvers()', context);
  assert.notStrictEqual(first.promise, second.promise);
  first.resolve('ready');
  first.reject('ignored');
  assert.equal(await first.promise, 'ready');
  const reason = {message: 'same object'};
  const rejected = assert.rejects(second.promise, error => error === reason);
  second.reject(reason);
  await rejected;
});

test('the fallback uses its constructor receiver and remains nonconstructible itself', async t => {
  const context = oldPage(t);
  vm.runInContext('class Derived extends Promise {}; globalThis.d = Derived.withResolvers(); d.resolve(11)', context);
  assert.equal(vm.runInContext('d.promise instanceof Derived', context), true);
  assert.equal(await vm.runInContext('d.promise', context), 11);
  assert.throws(() => vm.runInContext('new Promise.withResolvers()', context), error => error.name === 'TypeError');
  for (const expression of [
    'Promise.withResolvers.call(() => {})',
    'Promise.withResolvers.call(class { constructor() {} })',
    'Promise.withResolvers.call(class { constructor(executor) { executor(1, () => {}) } })',
    'Promise.withResolvers.call(class { constructor(executor) { executor(() => {}, () => {}); executor(() => {}, () => {}) } })',
  ]) assert.throws(() => vm.runInContext(expression, context), error => error.name === 'TypeError');
});

test('disposing the bridge removes its index transform', t => {
  const instance = bridge(t), html = '<html><head data-host="dsh"></head><body>unchanged</body></html>';
  assert.notEqual(instance.render(html), html);
  instance.dispose();
  assert.equal(instance.render(html), html);
});
