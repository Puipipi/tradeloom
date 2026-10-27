import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const jsdomPath = process.env.TRADELOOM_DOM_MODULE;
if (!jsdomPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime');
const { JSDOM } = require(jsdomPath);
const template = await readFile(new URL('../../templates/workbench/artifacts.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../../static/workbench/intake.js', import.meta.url), 'utf8');
const browserSource = await readFile(new URL('../../static/workbench/artifact-browser.js', import.meta.url), 'utf8');

async function fixture(t, hash = '', { fetch: fetchImplementation, csrfMeta = '', csrfCookie = '' } = {}) {
  const html = template.replace(/{%[\s\S]*?%}/g, '');
  const dom = new JSDOM(html, { url: `http://localhost/artifacts${hash}`, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage() {} } });
  const document = window.document;
  if (csrfMeta) {
    let meta = document.querySelector('meta[name="csrf-token"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'csrf-token';
      document.head.append(meta);
    }
    meta.content = csrfMeta;
  }
  if (csrfCookie) document.cookie = `csrftoken=${csrfCookie}; Path=/; SameSite=Strict`;
  const root = document.querySelector('[data-testid="intake-workbench"]');
  root.dataset.sourcesUrl = '/api/intake/sources';
  root.dataset.sourcePreviewUrl = '/api/intake/sources/__SOURCE__/previews';
  root.dataset.previewUrl = '/api/intake/previews/__SNAPSHOT__';
  const schema = document.createElement('script');
  schema.id = 'intake-field-schemas';
  schema.textContent = '{}';
  document.body.append(schema);
  const scrolled = [];
  const scroller = document.scrollingElement || document.documentElement;
  const localScrolls = [];
  const windowScrolls = [];
  scroller.scrollTop = 35;
  scroller.scrollTo = options => localScrolls.push(options.top);
  window.scrollTo = (...args) => windowScrolls.push(args);
  for (const [id, target] of [['source-intake', document.getElementById('source-intake')], ['deliverables', document.querySelector('[data-deliverables-section]')]]) {
    target.getBoundingClientRect = () => ({ top: id === 'source-intake' ? 120 : 640 });
    target.scrollIntoView = () => scrolled.push(id);
  }
  window.fetch = fetchImplementation || (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ sources: [], candidates: [], narratives: [], next_offset: null }),
  }));
  window.eval(source);
  window.eval(browserSource);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { window, document, root, scrolled, localScrolls, windowScrolls };
}

test('sources alias opens and scrolls to the existing source work area', async t => {
  const app = await fixture(t, '#sources');
  assert.equal(app.root.querySelector('[data-intake-task-tab="sources"]').getAttribute('aria-selected'), 'true');
  assert.equal(app.root.querySelector('[data-intake-task-panel="sources"]').hidden, false);
  assert.deepEqual(app.localScrolls, [155]);
  assert.deepEqual(app.windowScrolls, []);
  assert.deepEqual(app.scrolled, []);
});

test('source workflow tabs and file browser routes stay local to the iframe', async t => {
  const app = await fixture(t, '#sources');
  app.window.location.hash = '#plans';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.root.querySelector('[data-intake-task-tab="plans"]').getAttribute('aria-selected'), 'true');
  assert.equal(app.root.querySelector('[data-intake-task-panel="plans"]').hidden, false);

  app.window.location.hash = '#deliverables';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(app.localScrolls, [155]);
  assert.deepEqual(app.windowScrolls, []);
  assert.deepEqual(app.scrolled, []);
  assert.equal(app.document.getElementById('deliverables'), null, 'the hash must not match a native fragment target inside the iframe');
  assert.equal(app.document.querySelector('[data-file-browser]').hidden, false);
  assert.equal(app.document.querySelector('[data-file-browser]').dataset.browserMode, 'deliverables');
  assert.equal(app.document.querySelector('[data-testid="intake-workbench"]').hidden, true);
  assert.equal(app.document.querySelector('[data-deliverables-section]').hidden, true);

  app.window.location.hash = '#files';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.document.querySelector('[data-file-list-pane]').hidden, false);
  assert.equal(app.document.querySelector('[data-file-preview-pane]').hidden, true);

  app.window.location.hash = '#preview';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.document.querySelector('[data-file-list-pane]').hidden, true);
  assert.equal(app.document.querySelector('[data-file-preview-pane]').hidden, false);
  assert.equal(app.document.querySelector('.intake-main-preview').parentElement, app.document.querySelector('[data-file-source-preview]'));

  app.window.location.hash = '#sources';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.document.querySelector('[data-testid="intake-workbench"]').hidden, false);
  assert.equal(app.document.querySelector('[data-file-browser]').hidden, true);
  assert.equal(app.document.querySelector('.intake-main-preview').parentElement, app.document.querySelector('#intake-task-panel-sources .intake-columns'));
});

test('source preview reads the current CSRF cookie after another iframe rotated it', async t => {
  const requests = [];
  const source = {
    id: 'source-rotate', display_name: '生产指令单.xlsx', byte_size: 1024,
    received_at: '2026-10-25T00:00:00Z', snapshots: [],
  };
  const json = value => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => value,
  });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method || 'GET';
    requests.push({ path: url.pathname, method, csrf: init.headers?.['X-CSRFToken'] });
    if (url.pathname === '/api/intake/sources') return json({ sources: [source], candidates: [], narratives: [], next_offset: null });
    if (url.pathname === '/api/intake/sources/source-rotate/previews') return json({ ok: true, preview: { id: 'snapshot-rotate' } });
    if (url.pathname === '/api/intake/previews/snapshot-rotate' && !url.search) {
      return json({
        ok: true, preview: { id: 'snapshot-rotate', status: 'ready', cell_count: 1 },
        sheets: [{ sheet_index: 1, title: 'Sheet1', dimensions: 'A1', merged_ranges: [], warnings: [] }],
        images: [],
      });
    }
    if (url.pathname === '/api/intake/previews/snapshot-rotate') {
      return json({
        ok: true, preview: { id: 'snapshot-rotate', status: 'ready', cell_count: 1 },
        window: { sheet_index: 1 }, rows: [[{ coordinate: 'A1', blank: false, normalized_value: '测试值' }]], images: [],
      });
    }
    return json({ ok: true, sources: [], candidates: [], narratives: [], next_offset: null });
  };
  const app = await fixture(t, '', { fetch, csrfMeta: 'stale-meta-token', csrfCookie: 'old-cookie-token' });
  await new Promise(resolve => setTimeout(resolve, 0));
  app.document.cookie = 'csrftoken=current-cookie-token; Path=/; SameSite=Strict';
  app.document.querySelector("[data-testid='intake-sources'] [data-source-id='source-rotate']").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  const previewPost = requests.find(item => item.method === 'POST' && item.path === '/api/intake/sources/source-rotate/previews');
  assert.ok(previewPost, 'selecting a source requests its existing workbook preview');
  assert.equal(previewPost.csrf, 'current-cookie-token');
  assert.notEqual(previewPost.csrf, 'stale-meta-token');
});
