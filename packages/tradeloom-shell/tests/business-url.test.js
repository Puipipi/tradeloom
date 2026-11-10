import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)
const businessUrlSource = await readFile(new URL('workbench/static/workbench/business-url.js', root), 'utf8')
const appSource = await readFile(new URL('workbench/static/workbench/app.js', root), 'utf8')

function browserUrl(enabled) {
  const context = {
    URL,
    document: { documentElement: { dataset: { businessEmbed: enabled ? 'true' : 'false' } } },
    window: { location: { href: 'http://127.0.0.1:3088/agent-center', origin: 'http://127.0.0.1:3088' } },
  }
  runInNewContext(businessUrlSource, context)
  return context.TradeLoomBusiness.businessUrl
}

test('browser URL wrapper preserves default URLs and maps embed page, API, static, and upload paths', () => {
  assert.equal(browserUrl(false)('/api/tasks?next=%2Fproducts'), '/api/tasks?next=%2Fproducts')
  const url = browserUrl(true)
  assert.equal(url('/home?tab=1'), '/business/home?tab=1')
  assert.equal(url('/api/workflow-tasks/wf%2Fid?limit=2'), '/business-api/workflow-tasks/wf%2Fid?limit=2')
  assert.equal(url('/static/workbench/app.js?v=2'), '/business-static/workbench/app.js?v=2')
  assert.equal(url('/uploads/review/image.png?download=1'), '/business-media/review/image.png?download=1')
  assert.equal(url('/api?next=%2Fproducts#section'), '/business-api?next=%2Fproducts#section')
  assert.equal(url('/static?v=2#app'), '/business-static?v=2#app')
  assert.equal(url('/uploads?download=1#file'), '/business-media?download=1#file')
  assert.equal(url('/business-api/workflow-tasks?limit=2'), '/business-api/workflow-tasks?limit=2')
  assert.equal(url('/business-static?version=1#asset'), '/business-static?version=1#asset')
  assert.equal(url('/business-media/file?download=1#preview'), '/business-media/file?download=1#preview')
  assert.equal(url('https://example.com/api/tasks'), 'https://example.com/api/tasks')
})

test('app fetch and upload paths pass through URL wrapper while retaining CSRF headers', () => {
  assert.match(appSource, /fetch\(businessUrl\(url\),/)
  assert.match(appSource, /fetch\(businessUrl\(form\.dataset\.uploadUrl\),/)
  assert.match(appSource, /"X-CSRFToken": csrfToken/)
})

test('embedded business theme bridge accepts only same-origin messages with the exact validated semantic palette', () => {
  let messageHandler
  const variables = new Map()
  const html = { dataset: { businessEmbed: 'true' }, style: { setProperty(name, value) { variables.set(name, value) } } }
  const parent = { postMessage() {} }
  const document = { documentElement: html, querySelector() { return null }, querySelectorAll() { return [] }, getElementById() { return null } }
  const window = {
    parent, location: { origin: 'http://localhost:3088' },
    addEventListener(type, listener) { if (type === 'message') messageHandler = listener },
  }
  runInNewContext(appSource, { document, window, URL, URLSearchParams, globalThis: {
    TradeLoomBusiness: {
      isTrustedBridgeEvent: event => event.source === parent && event.origin === window.location.origin,
      bridgeTarget: () => parent,
    },
  } })
  const palette = {
    canvas: '#0c1017', panel: '#131925', header: '#171f2c', border: '#293345',
    text: '#dfe7f3', muted: '#8b97ab', accent: '#4d83dd', accentStrong: '#6b9bf5', accentSoft: '#1d2538',
    teal: '#37b5a9', buttonInk: '#10131b', danger: '#ed7373', dangerBackground: '#392729', dangerBorder: '#623c42',
    warning: '#d6ad5b', warningBackground: '#302a20', warningBorder: '#5a4b32', success: '#39d5a1', successBackground: '#1e3735',
  }
  const ui = {
    controlHeight: 32, cornerRadius: 8, dockTabHeight: 32, fontBody: 14, fontCompact: 12,
    fontFamily: 'Segoe UI', iconSize: 16, lineHeight: 1.4, modelControl: 32,
    navHeight: 48, sceneTabHeight: 36, toolbarHeight: 40, topRowHeight: 48,
  }
  const event = data => messageHandler({ source: parent, origin: window.location.origin, data: { ui, ...data } })
  event({ type: 'tradeloom:theme', colorScheme: 'dark', palette })
  assert.equal(html.dataset.colorScheme, 'dark')
  assert.equal(variables.get('--wb-theme-canvas'), '#0c1017')
  assert.equal(variables.get('--wb-theme-teal'), '#37b5a9')
  event({ type: 'tradeloom:theme', colorScheme: 'light', palette: { ...palette, canvas: 'url(https://bad.example)' } })
  assert.equal(html.dataset.colorScheme, 'dark', 'unsafe token values are ignored without partially applying the palette')
  assert.equal(variables.get('--wb-theme-canvas'), '#0c1017')
  messageHandler({ source: {}, origin: window.location.origin, data: { type: 'tradeloom:theme', colorScheme: 'light', palette } })
  messageHandler({ source: parent, origin: 'https://other.example', data: { type: 'tradeloom:theme', colorScheme: 'light', palette } })
  event({ type: 'tradeloom:theme', colorScheme: 'light', palette, extra: true })
  assert.equal(html.dataset.colorScheme, 'dark', 'foreign senders, origins, and extra fields are rejected')
})
