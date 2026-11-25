// Public manifest text resolution; no engine, device, or network required.
// node --test runtime/tests/native-locale-separators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkManifest } from '../bridge/dsh-go-bridge/lib/native/manifest.js';
import { parseText, resolveText } from '../bridge/dsh-go-bridge/lib/native/util.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
function render(text, locale) {
  return checkManifest({ name: 'locale-fixture', version: '1.0.0', dshGo: {
    v: 1, title: text,
    contributes: {
      'composer.actions': [{ id: 'choose', label: text, effect: { type: 'insert', text: 'x' } }],
      'composer.strip': [{ id: 'summary', text }],
      panels: [{ id: 'details', title: text }],
    },
  } }, root, { locale }).plugin;
}

for (const [name, text, locale, expected] of [
  ['underscore manifest keys', { zh_Hans_CN: '简体', zh_Hant_TW: '繁體' }, 'zh-Hant-TW', '繁體'],
  ['underscore request', { 'zh-Hans-CN': '简体', 'zh-Hant-TW': '繁體' }, 'zh_Hant_TW', '繁體'],
  ['mixed separators and case', { sr_Cyrl_RS: 'Cyrillic', 'sr_Latn-RS': 'Latin' }, 'SR-lAtN_rs', 'Latin'],
  ['several subtags', { en: 'Default', en_Latn_US_posix: 'Exact' }, 'en-Latn-US-posix', 'Exact'],
  ['one underscore remains supported', { en: 'Default', pt_BR: 'Brasil' }, 'pt-BR', 'Brasil'],
  ['language fallback remains supported', { zh: '中文', en: 'English' }, 'zh-HK', '中文'],
  ['English fallback remains supported', { zh: '中文', en: 'English' }, 'fr-FR', 'English'],
]) {
  test(`native locale: ${name}`, () => {
    const plugin = render(text, locale);
    assert.equal(plugin.state, 'ok');
    assert.deepEqual([
      plugin.title,
      plugin.contributes['composer.actions'][0].label,
      plugin.contributes['composer.strip'][0].text,
      plugin.contributes.panels[0].title,
    ], Array(4).fill(expected));
  });
}

test('native locale: aliases follow the existing last normalized key rule', () => {
  const source = { 'zh-Hant-TW': 'first', zh_Hant_TW: 'last' };
  const parsed = parseText(source);
  assert.deepEqual(parsed, { 'zh-hant-tw': 'last' });
  assert.equal(resolveText(parsed, 'zh-Hant-TW'), 'last');
  assert.deepEqual(source, { 'zh-Hant-TW': 'first', zh_Hant_TW: 'last' });
});
