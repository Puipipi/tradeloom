import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';

const client = readFileSync(new URL('../bridge/dsh-go-bridge/lib/client.js', import.meta.url), 'utf8');

async function bridgePage(t, { failFirst = true } = {}) {
  const posts = [];
  let server;
  let stored;
  const start = async (port = 0) => {
    stored = undefined;
    server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        posts.push(JSON.parse(body));
        if (failFirst && posts.length === 1) {
          req.socket.destroy();
          return;
        }
        stored = posts.at(-1);
      }
      res.writeHead(204).end();
    });
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  };
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await start();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}/`;
  const listeners = new Map();
  const cleanups = [];
  const pending = new Set();
  const completed = new EventEmitter();
  let failures = 0;
  let reportRuns = 0;
  let disposed = false;
  let plugin;
  const entry = { options: { id: 'visible', name: 'shell.overlay' }, registrant: 'ordinary' };
  const slots = {
    _register() {},
    entries: () => [entry],
    entriesOfSlot: () => [entry],
    snapshot: () => [{ type: 'slot', name: 'shell.overlay' }],
  };
  const loader = {
    entries: () => [{ fiber: { name: 'ordinary' }, options: { name: 'ordinary-plugin/client' } }],
  };
  const window = {
    __DSH_BOOT__: { rev: 'unchanged-boot' },
    __ModuleLoader__: { load: (entry) => { plugin = entry.factory(() => {}); } },
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const off of cleanups.reverse()) off();
  };
  t.after(async () => {
    dispose();
    await close();
  });
  vm.runInNewContext(client, {
    window, location: { hash: '' }, document: { baseURI: origin }, URL, console, queueMicrotask,
    // Keep the real debounce timer; observe its completion even when lastSent suppresses fetch.
    setTimeout(fn, ms) {
      const timer = setTimeout(() => {
        pending.delete(timer);
        reportRuns++;
        Promise.resolve(fn()).then(
          () => completed.emit('report'),
          (error) => completed.emit('report', error),
        );
      }, ms);
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) { pending.delete(timer); clearTimeout(timer); },
    async fetch(...args) {
      try { return await fetch(...args); }
      catch (error) { failures++; throw error; }
    },
  });
  plugin.apply({
    get: (name) => name === 'slots' ? slots : name === 'loader' ? loader : undefined,
    on(event, fn) {
      const callbacks = listeners.get(event) || new Set();
      listeners.set(event, callbacks);
      callbacks.add(fn);
      cleanups.push(() => callbacks.delete(fn));
    },
    effect(fn) { const off = fn(); if (off) cleanups.push(off); },
  });
  return {
    origin, posts, pending, dispose, api: window.__dshGoBridge,
    get failures() { return failures; },
    get reportRuns() { return reportRuns; },
    get stored() { return stored; },
    reset: () => { for (const fn of listeners.get('connection/reset') || []) fn(); },
    slotsChanged: () => { for (const fn of listeners.get('slots/changed') || []) fn('shell.overlay'); },
    // Replace the HTTP fixture's memory while retaining the actual browser client closure.
    async restart() { await close(); await start(port); },
    async nextReport() {
      const [error] = await once(completed, 'report', { signal: AbortSignal.timeout(6000) });
      if (error) throw error;
    },
  };
}

test('connection reset restores unchanged occupancy after failed fetch or lost server memory', async (t) => {
  const page = await bridgePage(t);
  await page.nextReport();
  assert.equal(page.failures, 1);
  assert.equal(page.posts.length, 1);

  const recovered = page.nextReport();
  page.reset();
  await recovered;
  assert.equal(page.posts.length, 2);
  assert.equal(page.failures, 1);
  assert.deepEqual(page.posts[1], page.posts[0]);
  assert.equal(page.posts[1].slots['shell.overlay'][0].package, 'ordinary-plugin');

  const deduped = page.nextReport();
  page.slotsChanged();
  await deduped;
  assert.equal(page.reportRuns, 3);
  assert.equal(page.posts.length, 2);

  // Explicit report is a force-report API; ordinary slot notifications remain deduped.
  await page.api.report();
  assert.equal(page.posts.length, 3);
  assert.deepEqual(page.posts[2], page.posts[1]);

  await page.restart();
  assert.equal(page.stored, undefined);
  const restarted = page.nextReport();
  page.reset();
  await restarted;
  assert.equal(page.posts.length, 4);
  assert.deepEqual(page.stored, page.posts[1]);
  assert.equal(page.failures, 1);

  const currentConnection = page.nextReport();
  page.slotsChanged();
  await currentConnection;
  assert.equal(page.reportRuns, 5);
  assert.equal(page.posts.length, 4);
});

test('disposing the page clears its pending report and removes the reset subscription', async (t) => {
  const page = await bridgePage(t, { failFirst: false });
  page.reset();
  assert.equal(page.pending.size, 1);
  page.dispose();
  assert.equal(page.pending.size, 0);
  page.reset();
  assert.equal(page.pending.size, 0);
  await delay(1350);
  assert.equal(page.reportRuns, 0);
  assert.equal(page.posts.length, 0);
});
