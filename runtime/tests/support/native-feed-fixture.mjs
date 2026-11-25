import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../../bridge/dsh-go-bridge/lib/native/core.js';
import { LIMITS } from '../../bridge/dsh-go-bridge/lib/native/limits.js';
import { normalizeScope } from '../../bridge/dsh-go-bridge/lib/native/util.js';

// Real NativeCore discovery and service registration; only Cordis loader/effect boundaries are fixtures.
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feed-cost-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'feed-cost', version: '1.0.0',
    dshGo: { v: 1, contributes: { panels: [{ id: 'p', title: 'P' }] } } }));
  writeFileSync(join(dir, 'index.js'), 'export {};\n');
  const entry = { options: { name: join(dir, 'index.js') },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(dir + '/').href } } }, disabled: false };
  entry.fiber = { uid: 1, entry, parent: { fiber: null } };
  const ctx = { get: name => name === 'loader' ? { entries: () => [entry] } : undefined,
    logger: { warn(error) { throw error; } } };
  const caller = { fiber: { parent: { fiber: entry.fiber } }, effect: fn => fn() };
  const core = new NativeCore(ctx, LIMITS, 'test');
  let emit;
  let cancels = 0;
  core.service.panel.call({ ctx: caller }, 'p', { view: { type: 'text', text: 'fixture' },
    data(_scope, next) { emit = next; return () => cancels++; } });
  const feed = core.feed('feed-cost', 'p', 'panel', normalizeScope({ sessionId: 's' }));
  return { core, feed, emit: value => emit(value), get cancels() { return cancels; },
    close() { core.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
