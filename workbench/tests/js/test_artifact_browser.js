import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const jsdomPath = process.env.TRADELOOM_DOM_MODULE;
if (!jsdomPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime');
const { JSDOM } = require(jsdomPath);
const source = await readFile(new URL('../../static/workbench/artifact-browser.js', import.meta.url), 'utf8');
const businessUrlSource = await readFile(new URL('../../static/workbench/business-url.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../../static/workbench/styles.css', import.meta.url), 'utf8');

async function fixture(t, mode = 'files', { sourceFailure = false, previewFailures = 0, includeImageLess = false, artifactType = 'catalog_html', artifactBytes } = {}) {
  const markdown = artifactType === 'catalog_markdown';
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-testid="intake-workbench" data-sources-url="/api/intake/sources" data-preview-url="/api/intake/previews/__SNAPSHOT__" data-source-download-url="/api/intake/sources/__SOURCE__/download"></section>
    <section data-file-browser data-browser-mode="${mode}">
      <button data-file-up hidden aria-label="返回全部资料">全部</button>
      <label for="file-scope-filter">资料范围</label><select id="file-scope-filter" data-file-filter aria-label="资料范围"><option value="all">全部资料</option><option value="source">来源资料</option><option value="artifact">交付版本</option></select>
      <button data-file-refresh></button>
      <button data-file-view="rows" aria-label="列表视图"></button><button data-file-view="grid" aria-label="缩略图视图"></button>
      <section data-file-list-pane><div data-file-list></div></section>
      <section data-file-preview-pane><div data-file-preview-heading hidden><strong data-file-preview-name></strong><p data-file-preview-status></p><div data-image-controls hidden><button data-image-fit disabled></button><button data-image-actual disabled></button><button data-image-zoom-in disabled></button><button data-image-zoom-out disabled></button></div><a data-file-download hidden></a></div>
        <details data-file-preview-info hidden><summary>文件信息</summary><div data-file-preview-metadata hidden></div></details><details data-file-technical-details hidden><div data-file-technical-content></div></details>
        <iframe data-artifact-inline-preview hidden></iframe>
        <div data-file-image-viewer hidden><div data-file-image-strip hidden></div><div data-file-image-stage><img data-file-image hidden></div></div>
        <div data-file-source-preview><section class="intake-main-preview"><div class="intake-preview-controls"><select data-intake-sheet></select><input data-intake-row-start><input data-intake-col-start></div></section></div><div data-file-preview-empty><h3>尚未选择文件</h3><p>在文件面板选择条目后查看可用预览。</p></div>
      </section>
    </section>
    <script id="file-browser-rows" type="application/json">${JSON.stringify([{
      id: 'version-123', kind: 'artifact', artifact_type: artifactType, name: '产品目录 · v2', category: '交付版本', status: '已批准',
      timestamp: '2026-10-25 12:00', preview_url: '/api/workflow-tasks/task-1/artifact-versions/version-123/preview',
      download_url: '/api/workflow-tasks/task-1/artifact-versions/version-123/download', task_title: '批次 A',
      filename: markdown ? 'catalog.md' : 'catalog.html', mime_type: markdown ? 'text/markdown' : 'text/html',
      extension: markdown ? 'MD' : 'HTML', last_modified: 1792900800000,
      byte_size: artifactBytes,
    }])}</script>
  </body></html>`, { url: `http://localhost/artifacts#${mode}`, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  let previewRequests = 0;
  const sourceRecords = [{
    id: 'source-abc', display_name: '订单.xlsx', byte_size: 8192, received_at: '2026-10-25T02:00:00Z',
    snapshots: [{ id: 'snapshot-abc', status: 'ready', cell_count: 8 }],
  }, {
    id: 'source-def', display_name: '客户要求.xlsx', byte_size: 4096, received_at: '2026-10-24T04:00:00Z',
    snapshots: [{ id: 'snapshot-def', status: 'ready', cell_count: 4 }],
  }];
  if (includeImageLess) sourceRecords.push({
    id: 'source-no-image', display_name: '工时分析.xlsx', byte_size: 1024, received_at: '2026-10-23T04:00:00Z',
    snapshots: [{ id: 'snapshot-empty', status: 'ready', cell_count: 2 }],
  });
  const parent = { location: { href: 'http://localhost/', origin: 'http://localhost' }, messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
  Object.defineProperty(window, 'parent', { configurable: true, value: parent });
  window.document.documentElement.dataset.businessEmbed = 'true';
  window.eval(businessUrlSource);
  window.TradeLoomBusiness = { ...window.TradeLoomBusiness, businessUrl: value => `/business${value}` };
  window.fetch = async url => {
    if (String(url).includes('/api/intake/previews/')) {
      previewRequests += 1;
      if (previewFailures > 0) {
        previewFailures -= 1;
        return { ok: false, json: async () => ({ ok: false, detail: 'Preview temporarily unavailable' }) };
      }
      if (String(url).includes('snapshot-empty')) return { ok: true, json: async () => ({ ok: true, images: [] }) };
      return { ok: true, json: async () => ({ ok: true, images: [{
        id: 'image-123', mime_type: 'image/png', coordinate: 'B4', preview_url: '/api/intake/images/image-123/preview',
      }] }) };
    }
    if (String(url).includes('/api/intake/sources/source-abc/download')) return {
      ok: true, headers: { get: () => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      blob: async () => new window.Blob([new Uint8Array(8192)]),
    };
    if (String(url).includes('/artifact-versions/version-123/download')) return {
      ok: true, headers: { get: () => 'application/octet-stream' },
      blob: async () => new window.Blob(['<h1>Catalog</h1>']),
    };
    if (sourceFailure) throw new Error('API unavailable');
    return { ok: true, json: async () => ({ ok: true, sources: sourceRecords, next_offset: null }) };
  };
  window.eval(source);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { dom, parent, get previewRequests() { return previewRequests; } };
}

test('files pane lists real source and artifact records and emits only stable ids', async t => {
  const { dom, parent } = await fixture(t, 'files', { includeImageLess: true });
  const { document } = dom.window;
  assert.ok(document.querySelector('.file-list-group-title')?.textContent.includes('来源资料'));
  assert.equal(document.querySelector('[data-file-filter]').getAttribute('aria-label'), '资料范围');
  assert.deepEqual([...document.querySelectorAll('[data-file-filter] option')].map(option => option.value), ['all', 'source', 'artifact']);
  assert.ok(document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]'));
  const sourceRow = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  assert.match(sourceRow.querySelector('.file-list-detail').textContent, /2026[/-]10[/-]25/);
  assert.match(sourceRow.querySelector('.file-list-detail').textContent, /10:00/, 'ISO UTC timestamps display in Asia/Shanghai time');
  assert.doesNotMatch(sourceRow.querySelector('.file-list-detail').textContent, /8\.0 KB/);
  assert.match(sourceRow.getAttribute('aria-label'), /8\.0 KB/);
  assert.match(sourceRow.title, /2026-10-25T02:00:00Z/, 'the accessible detail keeps the source timestamp verbatim');
  assert.match(sourceRow.title, /解析就绪/);
  assert.ok(document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]'));
  assert.equal(document.querySelector('[data-file-kind="source"] .file-type-icon').dataset.fileType, 'XLSX');
  assert.ok(document.querySelector('[data-file-kind="source"] .file-type-icon svg'));
  assert.equal(document.querySelector('[data-file-kind="artifact"] .file-type-icon').dataset.fileType, 'HTML');
  document.querySelector('[data-file-view="grid"]').click();
  assert.equal(document.querySelector('[data-file-list]').dataset.displayMode, 'grid');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('.file-card-thumbnail')?.src, 'http://localhost/business/api/intake/images/image-123/preview');
  const sourceCard = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  assert.match(sourceCard.querySelector('.file-list-detail').textContent, /8\.0 KB/);
  assert.doesNotMatch(sourceCard.querySelector('.file-list-detail').textContent, /2026|10:00/, 'grid keeps date metadata out of the compact size line');
  assert.match(sourceCard.title, /2026-10-25T02:00:00Z/, 'full timestamp remains available in the accessible details');
  const artifactCard = document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]');
  assert.equal(artifactCard.querySelector('.file-list-size')?.textContent, '大小未知', 'a missing artifact size stays explicitly unknown');
  assert.doesNotMatch(artifactCard.querySelector('.file-list-detail').textContent, /\b(?:KB|MB)\b/);
  sourceCard.click();
  assert.equal(sourceCard.getAttribute('aria-current'), 'true', 'grid selection remains represented by the existing selected state');
  const imageLess = document.querySelector('[data-file-kind="source"][data-file-id="source-no-image"]');
  assert.equal(imageLess.dataset.thumbnailState, 'empty');
  assert.ok(imageLess.querySelector('.file-type-icon svg'));
  assert.equal(imageLess.querySelector('.file-card-thumbnail'), null, 'a workbook with no extracted images keeps its real file icon');
  document.querySelector('[data-file-view="rows"]').click();
  assert.equal(document.querySelector('[data-file-list]').dataset.displayMode, 'rows');
  assert.equal(parent.messages[0].message.type, 'tradeloom:files-ready');
  document.querySelector('[data-file-kind="artifact"]').click();
  assert.equal(parent.messages.at(-1).origin, 'http://localhost');
  assert.equal(parent.messages.at(-1).message.type, 'tradeloom:file-selection');
  assert.equal(parent.messages.at(-1).message.kind, 'artifact');
  assert.equal(parent.messages.at(-1).message.id, 'version-123');
  assert.equal('previewMime' in parent.messages.at(-1).message, false, 'non-Markdown artifact selection stays unchanged');
  assert.equal('url' in parent.messages.at(-1).message, false);
});

test('failed source-image lookup can be retried from its grid card', async t => {
  const fixtureState = await fixture(t, 'files', { previewFailures: 1 });
  const { dom } = fixtureState;
  const { document } = dom.window;
  document.querySelector('[data-file-view="grid"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const sourceCard = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  assert.match(sourceCard.dataset.thumbnailState, /error/);
  assert.match(sourceCard.textContent, /图片预览失败，点击此项重试/);
  assert.match(sourceCard.getAttribute('aria-label'), /图片预览失败，点击此项重试/);
  assert.equal(fixtureState.previewRequests, 2, 'the grid loads one real preview list for each source');
  sourceCard.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(fixtureState.previewRequests, 3, 'the rejected source request is retried instead of remaining cached');
  const thumbnail = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"] .file-card-thumbnail');
  assert.equal(thumbnail?.src,
    'http://localhost/business/api/intake/images/image-123/preview');
  thumbnail.dispatchEvent(new dom.window.Event('load'));
  assert.equal(document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]').dataset.thumbnailState, 'ready');
});

test('failed thumbnail image has a visible retry state and can be loaded again', async t => {
  const { dom } = await fixture(t);
  const { document } = dom.window;
  document.querySelector('[data-file-view="grid"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  document.querySelector('.file-card-thumbnail').dispatchEvent(new dom.window.Event('error'));
  let sourceCard = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  assert.equal(sourceCard.dataset.thumbnailState, 'error');
  assert.match(sourceCard.textContent, /图片预览失败，点击此项重试/);
  assert.match(sourceCard.getAttribute('aria-label'), /图片预览失败，点击此项重试/);
  sourceCard.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  sourceCard = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  const thumbnail = sourceCard.querySelector('.file-card-thumbnail');
  assert.ok(thumbnail, 'retry rebuilds an image element from the registered preview URL');
  thumbnail.dispatchEvent(new dom.window.Event('load'));
  assert.equal(sourceCard.dataset.thumbnailState, 'ready');
});

test('thumbnail grid keeps two scaled columns, contain images and isolated card styling', () => {
  assert.match(styles, /\.file-list-scroll\[data-display-mode="grid"\]\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-list-scroll\[data-display-mode="grid"\]\s*\{[^}]*gap:\s*calc\(6px \* var\(--wb-ui-scale\)\)/s);
  const thumbnailBlock = styles.match(/\.file-card-thumbnail\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(thumbnailBlock, /position:\s*absolute/);
  assert.match(thumbnailBlock, /inset:\s*0/);
  assert.match(thumbnailBlock, /object-fit:\s*contain/);
  assert.doesNotMatch(thumbnailBlock, /background-image|background-color/);
  assert.match(styles, /\.file-card-thumbnail-frame\s*\{[^}]*aspect-ratio:\s*16 \/ 10/s);
  assert.match(styles, /-webkit-line-clamp:\s*2/);
  assert.match(styles, /\.file-list-scroll\[data-display-mode="grid"\] \.file-list-time\s*\{\s*margin-left:\s*4px;/);
  assert.match(styles, /file-list-scroll\[data-display-mode="grid"\] \.file-list-detail,[\s\S]*?\.file-thumbnail-status \{\s*font-size:\s*calc\(11px \* var\(--wb-ui-scale\)\)/);
});

test('only the registered catalog_markdown row adds the fixed previewMime hint', async t => {
  const { dom, parent } = await fixture(t, 'files', { artifactType: 'catalog_markdown' });
  dom.window.document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]').click();
  const selection = parent.messages.map(item => item.message).findLast(item => item.type === 'tradeloom:file-selection');
  assert.deepEqual(JSON.parse(JSON.stringify(selection)), {
    type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-123', previewMime: 'text/markdown',
  });
});

test('registered source and delivery scopes filter real rows and return to all', async t => {
  const { dom } = await fixture(t);
  const { document } = dom.window;
  const scope = document.querySelector('[data-file-filter]');
  scope.value = 'source';
  scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(scope.value, 'source');
  assert.ok(document.querySelector('[data-file-up]').hidden === false);
  assert.ok(document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]'));
  assert.equal(document.querySelector('[data-file-kind="artifact"]'), null);
  document.querySelector('[data-file-up]').click();
  assert.equal(scope.value, 'all');
  assert.ok(document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]'));
});

test('preview pane announces readiness and resolves a validated artifact id to its safe preview URL', async t => {
  const { dom, parent } = await fixture(t, 'preview');
  const { document, Event } = dom.window;
  assert.equal(parent.messages.some(item => item.message.type === 'tradeloom:preview-ready'), true);
  const message = new Event('message');
  Object.defineProperties(message, {
    origin: { value: 'http://localhost' },
    source: { value: dom.window.parent },
    data: { value: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-123' } },
  });
  dom.window.dispatchEvent(message);
  assert.equal(document.querySelector('[data-artifact-inline-preview]').src,
    'http://localhost/business/api/workflow-tasks/task-1/artifact-versions/version-123/preview');
  assert.equal(document.querySelector('[data-image-fit]').disabled, true);
  assert.equal(document.querySelector('[data-file-download]').href,
    'http://localhost/business/api/workflow-tasks/task-1/artifact-versions/version-123/download');
  assert.equal(document.querySelector('[data-file-preview-heading]').hidden, false);
  assert.equal(document.querySelector('[data-image-controls]').hidden, true);
  assert.equal(document.querySelector('[data-file-source-preview]').hidden, true);
  const forged = new Event('message');
  Object.defineProperties(forged, {
    origin: { value: 'http://evil.test' }, source: { value: dom.window.parent },
    data: { value: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-123' } },
  });
  dom.window.dispatchEvent(forged);
  assert.equal(document.querySelector('[data-file-preview-status]').textContent, '交付文件预览');
});

test('preview starts with one empty state and reveals workbook tools only after a source snapshot is ready', async t => {
  const { dom } = await fixture(t, 'preview');
  const { document, Event } = dom.window;
  const sourcePreview = document.querySelector('.intake-main-preview');
  const empty = document.querySelector('[data-file-preview-empty]');
  const heading = document.querySelector('[data-file-preview-heading]');
  const imageControls = document.querySelector('[data-image-controls]');
  const sourceHost = document.querySelector('[data-file-source-preview]');
  assert.equal(sourcePreview.hidden, true);
  assert.equal(sourceHost.hidden, true, 'the empty source preview host must not consume pane height');
  assert.equal(empty.hidden, false);
  assert.equal(heading.hidden, true);
  assert.equal(imageControls.hidden, true);
  assert.equal(empty.querySelector('p').textContent, '在文件面板选择条目后查看可用预览。');

  const message = new Event('message');
  Object.defineProperties(message, {
    origin: { value: 'http://localhost' }, source: { value: dom.window.parent },
    data: { value: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-abc' } },
  });
  dom.window.dispatchEvent(message);
  assert.equal(sourceHost.hidden, true, 'loading workbook contents must not reserve preview height');
  assert.equal(sourcePreview.hidden, true);
  assert.equal(empty.hidden, false);
  assert.equal(empty.querySelector('h3').textContent, '正在读取工作簿');

  dom.window.dispatchEvent(new dom.window.CustomEvent('tradeloom:source-preview-state', {
    detail: { sourceId: 'source-abc', phase: 'error', message: '请求失败（HTTP 403）' },
  }));
  assert.equal(sourceHost.hidden, true, 'failed workbook contents must not reserve preview height');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent.includes('HTTP 403'), true);

  dom.window.dispatchEvent(new dom.window.CustomEvent('tradeloom:source-preview-state', {
    detail: { sourceId: 'source-abc', phase: 'ready' },
  }));
  assert.equal(sourceHost.hidden, false);
  assert.equal(sourcePreview.hidden, false);
  assert.equal(empty.hidden, true);
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('preview pane resolves a source id from the loaded source list and exposes its safe original download', async t => {
  const { dom } = await fixture(t, 'preview');
  const { document, Event } = dom.window;
  let selection = null;
  dom.window.addEventListener('tradeloom:file-selection', event => { selection = event.detail; });
  const message = new Event('message');
  Object.defineProperties(message, {
    origin: { value: 'http://localhost' }, source: { value: dom.window.parent },
    data: { value: { type: 'tradeloom:file-selection', kind: 'source', id: 'source-abc' } },
  });
  dom.window.dispatchEvent(message);
  assert.equal(selection.kind, 'source');
  assert.equal(selection.id, 'source-abc');
  assert.equal(document.querySelector('[data-file-download]').href,
    'http://localhost/business/api/intake/sources/source-abc/download');
  assert.equal(document.querySelector('[data-file-preview-metadata]').textContent.includes('8192 bytes'), true);
  assert.equal(document.querySelector('[data-file-preview-info]').open, false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('[data-file-preview-name]').textContent, '订单.xlsx');
  assert.equal(document.querySelector('[data-file-image-viewer]').hidden, false);
  const image = document.querySelector('[data-file-image]');
  const stage = document.querySelector('[data-file-image-stage]');
  assert.equal(image.src, 'http://localhost/business/api/intake/images/image-123/preview');
  assert.equal(document.querySelector('[data-image-fit]').disabled, false);
  assert.equal(document.querySelector('[data-image-controls]').hidden, false);
  Object.defineProperties(stage, {
    clientWidth: { configurable: true, value: 280 },
    clientHeight: { configurable: true, value: 150 },
  });
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 1200 },
    naturalHeight: { configurable: true, value: 900 },
  });
  image.dispatchEvent(new Event('load'));
  assert.equal(image.style.width, '200px', 'fit mode calculates image width from the visible stage');
  assert.equal(image.style.height, '150px', 'fit mode calculates image height from the visible stage');
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 160 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 80 });
  dom.window.dispatchEvent(new Event('resize'));
  assert.equal(image.style.width, '106px', 'fit mode recomputes after the pane is resized');
  assert.equal(image.style.height, '80px');
  document.querySelector('[data-image-actual]').click();
  assert.equal(image.style.width, '', 'actual-size mode restores the natural image dimensions');
  assert.equal(image.style.height, '');
  assert.equal(image.style.transform, 'scale(1)');
  document.querySelector('[data-image-zoom-in]').click();
  assert.equal(document.querySelector('[data-file-image]').style.transform, 'scale(1.25)');
});

test('source preview node survives source A to B to artifact to source A selection changes', async t => {
  const { dom } = await fixture(t, 'preview');
  const { document, Event } = dom.window;
  const originalPreview = document.querySelector('.intake-main-preview');
  const sendSelection = (kind, id) => {
    const message = new Event('message');
    Object.defineProperties(message, {
      origin: { value: 'http://localhost' }, source: { value: dom.window.parent },
      data: { value: { type: 'tradeloom:file-selection', kind, id } },
    });
    dom.window.dispatchEvent(message);
  };
  sendSelection('source', 'source-abc');
  assert.strictEqual(document.querySelector('.intake-main-preview'), originalPreview);
  sendSelection('source', 'source-def');
  assert.strictEqual(document.querySelector('.intake-main-preview'), originalPreview);
  sendSelection('artifact', 'version-123');
  assert.strictEqual(document.querySelector('.intake-main-preview'), originalPreview);
  assert.equal(originalPreview.hidden, true);
  sendSelection('source', 'source-abc');
  assert.strictEqual(document.querySelector('.intake-main-preview'), originalPreview);
  dom.window.dispatchEvent(new dom.window.CustomEvent('tradeloom:source-preview-state', {
    detail: { sourceId: 'source-abc', phase: 'ready' },
  }));
  assert.equal(originalPreview.hidden, false);
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('delivery-only browser omits the source category and uses a real download when preview is unavailable', async t => {
  const { dom } = await fixture(t, 'deliverables');
  const { document } = dom.window;
  assert.equal([...document.querySelectorAll('.file-list-group-title')].some(node => node.textContent === '来源资料'), false);
  assert.ok(document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]'));
});

test('file-focus reveals and scrolls only an existing row in the files pane', async t => {
  const { dom, parent } = await fixture(t, 'files');
  const { document, Event } = dom.window;
  await new Promise(resolve => setTimeout(resolve, 0));
  const list = document.querySelector('[data-file-list]');
  Object.defineProperties(list, {
    clientTop: { configurable: true, value: 0 },
    clientHeight: { configurable: true, value: 100 },
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === list) return { top: 100, bottom: 200, left: 0, right: 240, width: 240, height: 100 };
    if (this.matches?.('[data-file-kind][data-file-id]')) return { top: 250, bottom: 280, left: 0, right: 200, width: 200, height: 30 };
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  };

  const sendFocus = (kind, id, nonce, overrides = {}) => {
    const message = new Event('message');
    Object.defineProperties(message, {
      origin: { value: overrides.origin ?? 'http://localhost' },
      source: { value: overrides.source ?? dom.window.parent },
      data: { value: { type: 'tradeloom:file-focus', kind, id, nonce } },
    });
    dom.window.dispatchEvent(message);
  };

  const scope = document.querySelector('[data-file-filter]');
  scope.value = 'source';
  scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  sendFocus('artifact', 'version-123', 'focus-artifact-1');
  await new Promise(resolve => setTimeout(resolve, 0));
  let row = document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]');
  assert.ok(row, 'focus switches from source filter to the real artifact category');
  assert.equal(row.getAttribute('aria-current'), 'true');
  assert.equal(document.activeElement, row);
  assert.equal(list.scrollTop, 80, 'only the file list scroll container is moved to reveal the row');
  assert.equal(scope.value, 'artifact');
  assert.deepEqual(JSON.parse(JSON.stringify(parent.messages.map(item => item.message).filter(item => item.type === 'tradeloom:file-focus-result').at(-1))), {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'version-123', nonce: 'focus-artifact-1', found: true,
  });

  sendFocus('source', 'source-abc', 'focus-source-2');
  await new Promise(resolve => setTimeout(resolve, 0));
  row = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  assert.ok(row, 'focus switches back to the real source category');
  assert.equal(row.getAttribute('aria-current'), 'true');
  assert.equal(scope.value, 'source');
  assert.equal(parent.messages.map(item => item.message).filter(item => item.type === 'tradeloom:file-focus-result').at(-1).found, true);

  sendFocus('artifact', 'not-registered', 'focus-missing-3');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('[data-file-id="not-registered"]'), null, 'unknown IDs never synthesize rows');
  assert.deepEqual(JSON.parse(JSON.stringify(parent.messages.map(item => item.message).filter(item => item.type === 'tradeloom:file-focus-result').at(-1))), {
    type: 'tradeloom:file-focus-result', kind: 'artifact', id: 'not-registered', nonce: 'focus-missing-3', found: false,
  });

  const priorResults = parent.messages.filter(item => item.message.type === 'tradeloom:file-focus-result').length;
  sendFocus('artifact', 'version-123', 'invalid-origin-4', { origin: 'null' });
  sendFocus('artifact', 'version-123', 'invalid-source-5', { source: {} });
  sendFocus('artifact', 'version-123', '', {});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(parent.messages.filter(item => item.message.type === 'tradeloom:file-focus-result').length, priorResults,
    'untrusted origins/sources and malformed nonces receive no response');
});

test('source-list API failure preserves artifact browsing and still announces the pane as ready', async t => {
  const files = await fixture(t, 'files', { sourceFailure: true });
  const { document: filesDocument } = files.dom.window;
  assert.ok(filesDocument.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]'));
  assert.match(filesDocument.querySelector('.file-list-error').textContent, /API unavailable/);
  assert.equal(files.parent.messages.some(item => item.message.type === 'tradeloom:files-ready'), true);

  const preview = await fixture(t, 'preview', { sourceFailure: true });
  const { document, Event } = preview.dom.window;
  assert.equal(preview.parent.messages.some(item => item.message.type === 'tradeloom:preview-ready'), true);
  const message = new Event('message');
  Object.defineProperties(message, {
    origin: { value: 'http://localhost' }, source: { value: preview.dom.window.parent },
    data: { value: { type: 'tradeloom:file-selection', kind: 'artifact', id: 'version-123' } },
  });
  preview.dom.window.dispatchEvent(message);
  assert.equal(document.querySelector('[data-file-preview-status]').textContent, '交付文件预览');
  assert.equal(document.querySelector('[data-artifact-inline-preview]').hidden, false);
});

test('file rows expose stable drag payloads and export requests return verified same-origin blobs', async t => {
  const { dom, parent } = await fixture(t, 'files');
  const { document, Event } = dom.window;
  const sourceRow = document.querySelector('[data-file-kind="source"][data-file-id="source-abc"]');
  const transfer = { values: {}, setData(type, value) { this.values[type] = value; } };
  const drag = new Event('dragstart');
  Object.defineProperty(drag, 'dataTransfer', { value: transfer });
  sourceRow.dispatchEvent(drag);
  assert.equal(JSON.stringify(JSON.parse(transfer.values['application/x-tradeloom-file'])), JSON.stringify({ kind: 'source', id: 'source-abc' }));
  assert.ok(parent.messages.some(item => item.message.type === 'tradeloom:file-selection'
    && item.message.kind === 'source' && item.message.id === 'source-abc'),
  'dragging announces the selected source so the shell locks export to this frame');
  assert.equal(parent.messages.find(item => item.message.type === 'tradeloom:file-selection').message.previewMime, undefined);

  const request = (kind, id, nonce) => {
    const message = new Event('message');
    Object.defineProperties(message, {
      origin: { value: 'http://localhost' }, source: { value: dom.window.parent },
      data: { value: { type: 'tradeloom:file-export-request', kind, id, nonce } },
    });
    dom.window.dispatchEvent(message);
  };
  request('source', 'source-abc', 'source-nonce');
  request('artifact', 'version-123', 'artifact-nonce');
  await new Promise(resolve => setTimeout(resolve, 0));
  const responses = parent.messages.map(item => item.message).filter(item => item.type === 'tradeloom:file-export-response');
  const source = responses.find(item => item.nonce === 'source-nonce');
  const artifact = responses.find(item => item.nonce === 'artifact-nonce');
  assert.equal(source.name, '订单.xlsx');
  assert.equal(source.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(source.blob.size, 8192);
  assert.deepEqual(Object.keys(source).sort(), ['blob', 'id', 'kind', 'lastModified', 'mimeType', 'name', 'nonce', 'type'].sort());
  assert.equal(artifact.name, 'catalog.html');
  assert.equal(artifact.mimeType, 'text/html');
  assert.equal(await artifact.blob.text(), '<h1>Catalog</h1>');
});

for (const item of [
  { name: 'missing', bytes: undefined, label: '大小未知', exports: true },
  { name: 'null', bytes: null, label: '大小未知', exports: true },
  { name: 'known', bytes: 16, label: '16 B', exports: true },
  { name: 'zero mismatch', bytes: 0, label: '0 B', exports: false },
]) test(`artifact ${item.name} size is visible and export validates only a known count`, async t => {
  const { dom, parent } = await fixture(t, 'files', { artifactBytes: item.bytes });
  const { document, Event } = dom.window;
  const row = () => document.querySelector('[data-file-kind="artifact"][data-file-id="version-123"]');
  assert.equal(row().querySelector('.file-list-size')?.textContent, item.label);
  assert.ok(row().getAttribute('aria-label').includes(item.label));
  document.querySelector('[data-file-view="grid"]').click();
  assert.equal(row().querySelector('.file-list-size')?.textContent, item.label);
  const message = new Event('message');
  Object.defineProperties(message, {
    origin: { value: 'http://localhost' }, source: { value: dom.window.parent },
    data: { value: { type: 'tradeloom:file-export-request', kind: 'artifact', id: 'version-123', nonce: 'size-check' } },
  });
  dom.window.dispatchEvent(message);
  await new Promise(resolve => setTimeout(resolve, 0));
  const response = parent.messages.map(item => item.message).find(item => item.type === 'tradeloom:file-export-response' && item.nonce === 'size-check');
  assert.ok(response);
  if (item.exports) {
    assert.equal(response.blob.size, 16);
    assert.equal('error' in response, false);
  } else {
    assert.match(response.error, /大小与资料记录不一致/);
    assert.equal('blob' in response, false);
  }
});
