// Execute the production head script in Node VM page realms with controlled
// API availability and real abort events. These are not WebView/Host tests.
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {test} from 'node:test';
import vm from 'node:vm';
import {injectPromiseWithResolvers} from '../bridge/dsh-go-bridge/lib/web-promise.js';

const nativeAny = AbortSignal.any;
const listeners = signal => getEventListeners(signal, 'abort').length;

function page({native = false, missingPromise = false} = {}) {
  // Shadow the static method per page without changing the process global.
  class PageAbortSignal extends AbortSignal {}
  Object.defineProperty(PageAbortSignal, 'any', native
    ? {value: nativeAny, configurable: false, writable: false, enumerable: true}
    : {value: undefined, configurable: true, writable: true, enumerable: false});
  const context = vm.createContext({AbortController, AbortSignal: PageAbortSignal});
  if (missingPromise) vm.runInContext('delete Promise.withResolvers', context);
  return {context, Signal: PageAbortSignal};
}

function scripts(html, context) {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
}

function installed() {
  const fixture = page();
  scripts(injectPromiseWithResolvers('<html><head></head><body></body></html>'), fixture.context);
  return fixture;
}

test('the production transform installs any before existing head scripts alongside Promise.withResolvers', async () => {
  const html = '<html><head data-page="fixture"><script>' +
    'globalThis.empty = AbortSignal.any([]);' +
    'globalThis.ready = Promise.withResolvers(); ready.resolve(41);' +
    '</script></head><body></body></html>';
  const {context} = page({missingPromise: true});
  assert.throws(() => scripts(html, context), error => error.name === 'TypeError' && /any/.test(error.message));
  scripts(injectPromiseWithResolvers(html), context);
  assert.equal(vm.runInContext('empty.aborted', context), false);
  assert.equal(await vm.runInContext('ready.promise', context), 41);
  assert.equal(AbortSignal.any, nativeAny);
});

test('an existing callable any keeps its identity and full descriptor through repeated head injection', () => {
  const {context, Signal} = page({native: true});
  const before = Object.getOwnPropertyDescriptor(Signal, 'any');
  const promiseBefore = vm.runInContext('Promise.withResolvers', context);
  const html = injectPromiseWithResolvers('<head></head>');
  scripts(html, context);
  scripts(html, context);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Signal, 'any'), before);
  assert.equal(Signal.any, nativeAny);
  assert.equal(vm.runInContext('Promise.withResolvers', context), promiseBefore);
  assert.equal(AbortSignal.any, nativeAny);
});

test('64 successful calls share source listeners and all fresh outputs cancel when an owner stops', async t => {
  const {Signal} = installed();
  const mount = new AbortController(), caller = new AbortController();
  const outputs = [];
  const counts = [];
  for (let completed = 1; completed <= 64; completed++) {
    const signal = Signal.any([mount.signal, caller.signal, mount.signal]);
    outputs.push(signal);
    // A completed operation does not abort either long-lived source.
    await Promise.resolve();
    signal.throwIfAborted();
    assert.equal(listeners(mount.signal), 1);
    assert.equal(listeners(caller.signal), 1);
    if ([1, 8, 64].includes(completed)) counts.push([completed, listeners(mount.signal), listeners(caller.signal)]);
  }
  assert.equal(new Set(outputs).size, 64, 'every call returns a fresh signal');
  const reason = {owner: 'released'};
  caller.abort(reason);
  assert.ok(outputs.every(signal => signal.aborted && signal.reason === reason));
  assert.equal(listeners(mount.signal), 0);
  assert.equal(listeners(caller.signal), 0);
  // Retaining outputs permits exact listener inspection, not a heap or GC claim.
  t.diagnostic(JSON.stringify({completedAndNativeListeners: counts, afterAbort: [0, 0]}));
});

test('one combination cleans up before notifying and preserves other live combinations', () => {
  const {Signal} = installed();
  const shared = new AbortController(), a = new AbortController(), b = new AbortController();
  const one = Signal.any([shared.signal, a.signal]);
  const two = Signal.any([shared.signal, b.signal]);
  assert.equal(listeners(shared.signal), 1);
  let notified = 0;
  one.addEventListener('abort', () => {
    notified++;
    assert.equal(listeners(a.signal), 0);
    assert.equal(listeners(shared.signal), 1, 'the other live combination still needs this source');
    assert.equal(two.aborted, false);
    b.abort('second');
    assert.equal(two.reason, 'second');
    assert.equal(listeners(shared.signal), 0);
    assert.equal(listeners(b.signal), 0);
  });
  a.abort('first');
  assert.equal(one.reason, 'first');
  assert.equal(notified, 1);
  shared.abort('later');
  assert.equal(one.reason, 'first');
  assert.equal(two.reason, 'second');
});

test('pre-aborted inputs choose their first reason without adding or disturbing live subscriptions', () => {
  const {Signal} = installed();
  const shared = new AbortController(), live = new AbortController();
  const retained = Signal.any([shared.signal, live.signal]);
  const first = new AbortController(), second = new AbortController();
  const firstReason = {first: true}, secondReason = {second: true};
  second.abort(secondReason);
  first.abort(firstReason);
  const result = Signal.any([shared.signal, first.signal, second.signal, first.signal]);
  assert.equal(result.reason, firstReason);
  assert.equal(result.aborted, true);
  assert.equal(retained.aborted, false);
  assert.equal(listeners(shared.signal), 1);
  assert.equal(listeners(live.signal), 1);
  assert.equal(listeners(first.signal), 0);
  assert.equal(listeners(second.signal), 0);
  live.abort();
  assert.equal(listeners(shared.signal), 0);
});

test('a released source supports a later combination with one listener and correct cancellation', () => {
  const {Signal} = installed();
  const shared = new AbortController(), a = new AbortController(), b = new AbortController();
  const first = Signal.any([shared.signal, shared.signal, a.signal]);
  assert.equal(listeners(shared.signal), 1);
  a.abort('retired');
  assert.equal(first.aborted, true);
  assert.equal(listeners(shared.signal), 0);
  const second = Signal.any([shared.signal, b.signal]);
  assert.equal(listeners(shared.signal), 1);
  shared.abort('new owner stopped');
  assert.equal(second.reason, 'new owner stopped');
  assert.equal(listeners(shared.signal), 0);
  assert.equal(listeners(b.signal), 0);
});

test('nested combinations propagate the source reason and clear both levels before the final observer', () => {
  const {Signal} = installed();
  const a = new AbortController(), b = new AbortController(), c = new AbortController();
  const parent = Signal.any([a.signal, b.signal]);
  const child = Signal.any([parent, c.signal]);
  const reason = new Error('nested cancellation');
  let notified = false;
  child.addEventListener('abort', () => {
    notified = true;
    for (const source of [a.signal, b.signal, c.signal, parent]) assert.equal(listeners(source), 0);
  });
  b.abort(reason);
  assert.equal(parent.reason, reason);
  assert.equal(child.reason, reason);
  assert.equal(notified, true);
});

test('a shared-source abort fixes every pending reason before an output observer aborts another source', t => {
  const {Signal} = installed();
  const a = new AbortController(), b = new AbortController();
  const first = Signal.any([a.signal]);
  const second = Signal.any([a.signal, b.signal]);
  const firstReason = {source: 'a'}, nestedReason = {source: 'b'};
  const order = [];
  let secondAlreadyAborted;
  let listenersAtFirstObserver;
  first.addEventListener('abort', () => {
    order.push('first');
    secondAlreadyAborted = second.aborted;
    listenersAtFirstObserver = [listeners(a.signal), listeners(b.signal)];
    b.abort(nestedReason);
  });
  second.addEventListener('abort', () => { order.push('second'); });
  a.abort(firstReason);
  assert.equal(first.reason, firstReason);
  assert.equal(second.reason, firstReason, 'the reentrant source must not steal the shared-source reason');
  assert.equal(b.signal.reason, nestedReason);
  assert.deepEqual(listenersAtFirstObserver, [0, 0], 'all combinations detach before the first output notification');
  assert.deepEqual(order, ['first', 'second']);
  t.diagnostic(JSON.stringify({secondAlreadyAbortedAtFirstObserver: secondAlreadyAborted,
    limitation: 'Outputs are notified sequentially; this is not the native all-dependent-state update algorithm.'}));
});
