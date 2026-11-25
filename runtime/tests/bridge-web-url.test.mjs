import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const client = readFileSync(new URL('../bridge/dsh-go-bridge/lib/client.js', import.meta.url), 'utf8');

function page({ missing = true } = {}) {
  // Keep each simulated page independent. URL parsing is Node's implementation,
  // not a claim of Chromium or device execution.
  class PageURL extends URL {}
  if (missing) Object.defineProperty(PageURL, 'canParse', { value: undefined, configurable: true });
  let entry;
  const context = {
    URL: PageURL,
    __ModuleLoader__: { load(value) { entry = value; } },
  };
  context.window = context;
  vm.runInNewContext(client, context);
  assert.equal(entry.id, 'dsh-go-bridge');
  return { PageURL, materialize: () => entry.factory(() => assert.fail('unexpected import')) };
}

test('the complete client installs the missing method synchronously in its factory', () => {
  const p = page();
  assert.equal(p.PageURL.canParse, undefined);
  const plugin = p.materialize();
  assert.equal(plugin.name, 'dsh-go-bridge');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(p.PageURL.canParse('https://example.test/'), true);
  assert.equal(p.PageURL.canParse('README.md'), false);
  const installed = p.PageURL.canParse;
  p.materialize();
  assert.strictEqual(p.PageURL.canParse, installed);
});

test('an existing callable method and its property ownership remain unchanged', () => {
  for (const own of [false, true]) {
    const p = page({ missing: false });
    if (own) Object.defineProperty(p.PageURL, 'canParse', { value: URL.canParse });
    const descriptor = Object.getOwnPropertyDescriptor(p.PageURL, 'canParse');
    const original = p.PageURL.canParse;
    p.materialize();
    assert.strictEqual(p.PageURL.canParse, original);
    assert.deepEqual(Object.getOwnPropertyDescriptor(p.PageURL, 'canParse'), descriptor);
  }
});

test('the fallback uses the page URL parser and preserves required and optional arguments', () => {
  const p = page();
  p.materialize();
  const cases = [
    ['https://example.test/'], ['README.md'], ['README.md', 'https://example.test/base/'],
    ['https://example.test/', null], ['https://example.test/', undefined],
    [undefined], [undefined, 'https://example.test/'], [null, 'https://example.test/'],
    ['https://'], ['https://example.test/\ud800'], ['mailto:person@example.test'],
    ['file:///tmp/report.md'], ['../report.md', new URL('https://example.test/base/')],
  ];
  for (const args of cases) assert.equal(p.PageURL.canParse(...args), URL.canParse(...args));
  assert.throws(() => p.PageURL.canParse(), error => error.name === 'TypeError');
  assert.throws(() => p.PageURL.canParse(Symbol('url')), error => error.name === 'TypeError');
  assert.throws(() => p.PageURL.canParse('https://example.test/', Symbol('base')), error => error.name === 'TypeError');
});

test('conversion occurs once in url/base order and conversion exceptions escape', () => {
  const p = page();
  p.materialize();
  const seen = [];
  const value = (name, text) => ({ [Symbol.toPrimitive](hint) { seen.push(`${name}:${hint}`); return text; } });
  assert.equal(p.PageURL.canParse(value('url', 'https://'), value('base', 'invalid')), false);
  assert.deepEqual(seen, ['url:string', 'base:string']);
  const error = { reason: 'conversion failed' };
  assert.throws(() => p.PageURL.canParse({ toString() { throw error; } }), actual => actual === error);
  assert.throws(() => p.PageURL.canParse('https://', { toString() { throw error; } }), actual => actual === error);
  assert.throws(() => p.PageURL.canParse({ [Symbol.toPrimitive]() { return Symbol('result'); } }),
    actual => actual.name === 'TypeError');
});

test('the method has WebIDL attributes and ignores the receiver without becoming a constructor', () => {
  const p = page();
  p.materialize();
  const descriptor = Object.getOwnPropertyDescriptor(p.PageURL, 'canParse');
  for (const key of ['writable', 'enumerable', 'configurable']) assert.equal(descriptor[key], true);
  assert.equal(p.PageURL.canParse.length, 1);
  assert.equal(p.PageURL.canParse.name, 'canParse');
  assert.equal(Object.hasOwn(p.PageURL.canParse, 'prototype'), false);
  for (const receiver of [undefined, null, {}, function unrelated() {}]) {
    assert.equal(p.PageURL.canParse.call(receiver, 'https://example.test/'), true);
  }
  assert.throws(() => new p.PageURL.canParse('https://example.test/'), error => error.name === 'TypeError');
});
