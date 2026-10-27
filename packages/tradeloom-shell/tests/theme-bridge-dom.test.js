import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require(process.env.TRADELOOM_DOM_MODULE || 'jsdom')
const appScript = readFileSync(new URL('../../../workbench/static/workbench/app.js', import.meta.url), 'utf8')
const businessUrlScript = readFileSync(new URL('../../../workbench/static/workbench/business-url.js', import.meta.url), 'utf8')
const baseTemplate = readFileSync(new URL('../../../workbench/templates/workbench/base.html', import.meta.url), 'utf8')

test('embedded theme bridge applies canonical palette and 14/12px UI tokens to the live iframe DOM', () => {
  const parent = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const childDom = new JSDOM('<!doctype html><html data-business-embed="true"><body></body></html>', {
    url: 'http://localhost/business/home', runScripts: 'outside-only',
  })
  const child = childDom.window
  Object.defineProperty(child, 'parent', { value: parent.window, configurable: true })
  child.document.documentElement.dataset.businessEmbed = 'true'
  child.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ items: [] }) })
  const businessUrlIndex = baseTemplate.indexOf('business-url.js')
  const appIndex = baseTemplate.indexOf("app.js?v=business-popout-bridge1")
  assert.ok(businessUrlIndex >= 0 && appIndex > businessUrlIndex,
    'base.html loads the real business URL helper before app.js')
  child.eval(businessUrlScript)
  child.eval(appScript)

  const palette = Object.fromEntries([
    'accent', 'accentSoft', 'accentStrong', 'border', 'buttonInk', 'canvas', 'danger', 'dangerBackground',
    'dangerBorder', 'header', 'muted', 'panel', 'success', 'successBackground', 'teal', 'text', 'warning',
    'warningBackground', 'warningBorder',
  ].map(key => [key, '#123456']))
  const ui = {
    fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
    fontBody: 14, fontCompact: 12, lineHeight: 1.45,
    topRowHeight: 30, navHeight: 30, modelControl: 28, sceneTabHeight: 26,
    dockTabHeight: 30, controlHeight: 28, toolbarHeight: 28, iconSize: 16, cornerRadius: 6,
  }
  child.dispatchEvent(new child.MessageEvent('message', {
    data: { type: 'tradeloom:theme', colorScheme: 'dark', palette, ui },
    origin: 'http://localhost', source: parent.window,
  }))

  const rootStyle = child.getComputedStyle(child.document.documentElement)
  assert.equal(rootStyle.getPropertyValue('--wb-font-body'), '14px')
  assert.equal(rootStyle.getPropertyValue('--wb-font-compact'), '12px')
  assert.equal(rootStyle.getPropertyValue('--wb-control-height'), '28px')
  assert.equal(rootStyle.getPropertyValue('--wb-dock-tab-height'), '30px')
  assert.equal(rootStyle.getPropertyValue('--wb-theme-canvas'), '#123456')
  assert.equal(rootStyle.getPropertyValue('--wb-theme-accentSoft'), '#123456', 'the iframe consumes the exact accent-soft palette entry from its shell bridge')
  assert.equal(child.document.documentElement.dataset.colorScheme, 'dark')
})
