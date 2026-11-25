import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localize } from '../lib/index.js'

for (const [name, text, locale, expected] of [
  ['underscore text keys', { zh_Hans_CN: '简体', zh_Hant_TW: '繁體' }, 'zh-Hant-TW', '繁體'],
  ['underscore request', { 'zh-Hans-CN': '简体', 'zh-Hant-TW': '繁體' }, 'zh_Hant_TW', '繁體'],
  ['mixed separators and case', { sr_Cyrl_RS: 'Cyrillic', 'sr_Latn-RS': 'Latin' }, 'SR-lAtN_rs', 'Latin'],
  ['several subtags', { en: 'Default', en_Latn_US_posix: 'Exact' }, 'en-Latn-US-posix', 'Exact'],
  ['single underscore', { en: 'Default', pt_BR: 'Brasil' }, 'pt-BR', 'Brasil'],
  ['language fallback', { zh: '中文', en: 'English' }, 'zh-HK', '中文'],
  ['English fallback', { zh: '中文', en: 'English' }, 'fr-FR', 'English'],
]) {
  test(`localize: ${name}`, () => {
    const before = JSON.stringify(text)
    assert.equal(localize(locale, text), expected)
    assert.equal(localize({ locale }, text), expected)
    assert.equal(JSON.stringify(text), before)
  })
}

test('localize: aliases follow the existing first matching key rule', () => {
  const text = { zh_Hant_TW: 'first', 'zh-Hant-TW': 'last' }
  assert.equal(localize('zh-Hant-TW', text), 'first')
})
