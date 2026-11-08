import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../accepted-runtime/lib/main.js');
const mainSource = readFileSync(mainPath, 'utf8');
const newline = String.fromCharCode(10);

function extractTopLevelBlock(startMarker, closeMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.notEqual(start, -1, 'Main source marker missing: ' + startMarker);
  const end = mainSource.indexOf(closeMarker, start);
  assert.notEqual(end, -1, 'Main source closing marker missing: ' + closeMarker);
  return mainSource.slice(start, end + closeMarker.length);
}

const mimeSource = extractTopLevelBlock('const MIME = {', newline + '};');
const serveSource = extractTopLevelBlock('async function serveWebDocument(request, root) {', newline + '}');
const fixtureRoot = path.resolve(process.cwd(), '.web-document-mjs-memory-fixture');
const files = new Map([
  [path.resolve(fixtureRoot, 'assets', 'entry.mjs'), Buffer.from('export default 1;')],
  [path.resolve(fixtureRoot, 'assets', 'entry.js'), Buffer.from('export const value = 1;')],
  [path.resolve(fixtureRoot, 'assets', 'entry.css'), Buffer.from('body{color:black}')]
]);
const consumer = vm.runInNewContext(mimeSource + newline + serveSource + newline + '({ MIME, serveWebDocument })', {
  resolve: path.resolve,
  extname: path.extname,
  sep: path.sep,
  URL,
  Response,
  Uint8Array,
  readFile$1: async target => {
    const bytes = files.get(target);
    if (bytes === undefined) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return Buffer.from(bytes);
  }
});
const request = (pathname, method = 'GET') => ({ method, url: 'dsh-app://app' + pathname });

test('serves .mjs GET and HEAD with JavaScript MIME and unchanged body', async () => {
  const getResponse = await consumer.serveWebDocument(request('/assets/entry.mjs'), fixtureRoot);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(Buffer.from(await getResponse.arrayBuffer()).equals(files.get(path.resolve(fixtureRoot, 'assets', 'entry.mjs'))), true);

  const headResponse = await consumer.serveWebDocument(request('/assets/entry.mjs', 'HEAD'), fixtureRoot);
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
});

test('preserves JavaScript and CSS MIME mappings', async () => {
  const js = await consumer.serveWebDocument(request('/assets/entry.js'), fixtureRoot);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const css = await consumer.serveWebDocument(request('/assets/entry.css'), fixtureRoot);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('rejects encoded path escape', async () => {
  const response = await consumer.serveWebDocument(request('/%2e%2e%2foutside.js'), fixtureRoot);
  assert.equal(response.status, 403);
});

test('rejects unsupported methods', async () => {
  const response = await consumer.serveWebDocument(request('/assets/entry.js', 'POST'), fixtureRoot);
  assert.equal(response.status, 405);
});
