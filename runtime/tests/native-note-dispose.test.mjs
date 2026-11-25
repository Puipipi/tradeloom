import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { LIMITS } from '../bridge/dsh-go-bridge/lib/native/limits.js';
import { normalizeScope } from '../bridge/dsh-go-bridge/lib/native/util.js';

const prefix = resolve(process.env.DSH_PREFIX);
const { boot } = await import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));

for (const [mode, delayed] of [['disposer', false], ['disposer', true], ['subfiber-dispose', false], ['subfiber-dispose', true], ['replace-then-old-disposer', false]]) {
  test(`turnNote ${mode} retires an actively subscribed feed; delayed cancel=${delayed}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-note-dispose-'));
    let ctx, core;
    t.after(async () => { await ctx?.fiber.dispose(); core?.dispose(); await rm(dir, { recursive: true, force: true }); });
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'note-lifecycle-fixture', version: '1.0.0', type: 'module',
      dshGo: { v: 1, contributes: { 'turn.note': [{ id: 'cost' }] } },
    }));
    await writeFile(join(dir, 'plugin.mjs'), `
export const inject = ['dshGo', 'probe'];
export function apply(ctx) {
  ctx.probe.fiber = ctx.plugin(child => {
  child.probe.register = () => child.dshGo.turnNote('cost', (scope, emit) => {
    ctx.probe.emit = emit;
    emit({ t1: { text: 'first' } });
    const cancel = () => { ctx.probe.cancelled++; };
    return ctx.probe.cancelGate ? ctx.probe.cancelGate.then(() => cancel) : cancel;
  });
  child.probe.dispose = child.probe.register();
  });
}
`);
    const main = join(dir, 'main.json');
    await writeFile(main, JSON.stringify([{ id: 'note', name: pathToFileURL(join(dir, 'plugin.mjs')).href }]));
    let resolveCancel;
    const probe = { cancelled: 0, cancelGate: delayed ? new Promise(r => { resolveCancel = r; }) : undefined };
    ctx = await boot('dsh', main, [], c => {
      core = new NativeCore(c, LIMITS, 'test');
      c.provide('dshGo', core.service);
      c.provide('probe', probe);
    });
    await ctx.loader.await();
    let feed = core.feed('note-lifecycle-fixture', 'cost', 'note', normalizeScope({ sessionId: 's' }));
    const messages = [];
    feed.attach({ id: 'sub', send: message => messages.push(message) });
    await feed.waitFirst(0);
    await Promise.resolve();
    assert.deepEqual(feed.data, { t1: { text: 'first' } });
    let expectedCancels = 1;
    if (mode === 'replace-then-old-disposer') {
      const oldFeed = feed;
      const oldDispose = probe.dispose;
      const replacementDispose = probe.register();
      assert.equal(oldFeed.stopped, true);
      feed = core.feed('note-lifecycle-fixture', 'cost', 'note', normalizeScope({ sessionId: 's' }));
      messages.length = 0;
      feed.attach({ id: 'sub', send: message => messages.push(message) });
      await feed.waitFirst(0);
      await Promise.resolve();
      await oldDispose();
      assert.equal(feed.stopped, false, 'stale token must not retire its replacement');
      assert.equal(probe.cancelled, 1);
      assert.ok(core.registration('note-lifecycle-fixture', 'notes', 'cost'));
      await replacementDispose();
      expectedCancels = 2;
    } else if (mode === 'disposer') await probe.dispose();
    else {
      await probe.fiber.dispose();
    }
    assert.ok(ctx.loader.resolve('include:note'), 'owning plugin remains loaded');
    resolveCancel?.();
    await Promise.resolve();
    await Promise.resolve();
    const beforeLate = feed.data;
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    probe.emit({ t1: { text: 'late' } });
    t.mock.timers.tick(1000);
    t.diagnostic(JSON.stringify({ mode, cancelled: probe.cancelled, stopped: feed.stopped, pendingLate: feed.pending !== undefined, ends: messages.filter(m => m.t === 'end').length, data: feed.data }));
    assert.equal(probe.cancelled, expectedCancels, 'registration retirement must cancel the data producer exactly once');
    assert.equal(feed.stopped, true);
    assert.equal(core.feeds.has(feed.key), false);
    assert.equal(feed.pending, undefined, 'late emit must not queue an update');
    assert.deepEqual(feed.data, beforeLate);
    assert.deepEqual(messages.filter(m => m.t === 'end'), [{ t: 'end', sub: 'sub', reason: 'not-found' }]);
    await probe.dispose();
    assert.equal(probe.cancelled, expectedCancels);
  });
}
