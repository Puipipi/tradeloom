// Refs #656: exercise actual HTTP parsing and the SDK default through a real panel callback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeCore } from '../bridge/dsh-go-bridge/lib/native/core.js';
import { createNativeRoutes } from '../bridge/dsh-go-bridge/lib/native/routes.js';
import { effectiveLimits } from '../bridge/dsh-go-bridge/lib/native/limits.js';
import { hasSurface, hasComponent } from '../../sdk/plugin-kit/lib/caps.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'native-caps-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'caps-test', version: '1.0.0', dshGo: {
    v: 1, contributes: { panels: [{ id: 'panel', title: 'Panel', placement: ['plugin'] }] },
  } }));
  writeFileSync(join(dir, 'index.js'), '');
  const entry = { options: { name: pathToFileURL(join(dir, 'index.js')).href },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(dir + '/').href } } }, fiber: { uid: 7 } };
  const disposers = [];
  const core = new NativeCore({ get: name => name === 'loader' ? { entries: () => [entry] } : undefined,
    logger: { warn() {} } }, effectiveLimits({}), 'test');
  const routes = createNativeRoutes(core);
  const service = Object.assign(Object.create(core.service), { ctx: { fiber: { entry },
    effect(fn) { const off = fn(); disposers.push(off); return off; } } });
  let caps;
  service.panel('panel', { view(_scope, value) {
    caps = value;
    return { type: 'text', text: JSON.stringify({ panels: hasSurface(value, 'panels'),
      plugin: hasSurface(value, 'plugin'), text: hasComponent(value, 'text'), image: hasComponent(value, 'image') }) };
  } });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    routes.handle(req, res, url.pathname, url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    routes.dispose(); core.dispose();
    while (disposers.length) disposers.pop()();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return { get caps() { return caps; }, async get(query, path = 'views/caps-test/panel') {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/dsh-go/v1/${path}?${query}`);
    return { status: res.status, body: await res.json() };
  } };
}

for (const sample of [
  { name: 'absent lists use SDK v1 defaults', query: '', surfaces: undefined, components: undefined, panels: true, text: true },
  { name: 'explicit empty lists stay empty', query: 'surfaces=&components=', surfaces: [], components: [], panels: false, text: false },
  { name: 'surface absence is independent of empty components', query: 'components=', surfaces: undefined, components: [], panels: true, text: false },
  { name: 'component absence is independent of empty surfaces', query: 'surfaces=', surfaces: [], components: undefined, panels: false, text: true },
  { name: 'explicit v1 lists pass unchanged', query: 'surfaces=panels&components=text', surfaces: ['panels'], components: ['text'], panels: true, text: true },
  { name: 'plugin placement remains separately negotiated', query: 'surfaces=panels,plugin&components=text,image', surfaces: ['panels', 'plugin'], components: ['text', 'image'], panels: true, text: true, plugin: true, image: true },
]) test(sample.name, async t => {
  const f = await fixture(t);
  const r = await f.get(sample.query);
  assert.equal(r.status, 200);
  for (const key of ['surfaces', 'components']) {
    assert.equal(Object.hasOwn(f.caps, key), sample[key] !== undefined);
    assert.deepEqual(f.caps[key], sample[key]);
  }
  assert.deepEqual(JSON.parse(r.body.view.text), { panels: sample.panels, text: sample.text, plugin: sample.plugin ?? false, image: sample.image ?? (sample.components === undefined) });
  const c = await f.get(sample.query, 'contributions');
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.plugins[0].contributes.panels[0].placement, [sample.plugin ? 'plugin' : 'session.tab']);
});

test('omitted lists do not bypass incompatible protocol rejection', async t => {
  const f = await fixture(t);
  const r = await f.get('v=2');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'unsupported-version');
  assert.equal(f.caps, undefined);
});
