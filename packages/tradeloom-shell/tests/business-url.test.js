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

test('business bridge accepts the direct same-origin parent and only the exact trusted desktop popout opener', () => {
  const makeBridge = ({ parent, frameHref = 'dsh-app://app/business/artifacts#files', origin = 'dsh-app://app' }) => {
    const context = {
      URL,
      document: { documentElement: { dataset: { businessEmbed: 'true' } } },
      window: { parent, location: { href: frameHref, origin } },
      globalThis: {},
    }
    runInNewContext(businessUrlSource, context)
    const bridge = context.globalThis.TradeLoomBusiness
    bridge.context = context
    return bridge
  }
  const directParent = { location: { href: 'dsh-app://app/', origin: 'dsh-app://app' }, postMessage() {} }
  const direct = makeBridge({ parent: directParent })
  assert.equal(direct.isTrustedBridgeEvent({ source: directParent, origin: 'dsh-app://app' }), true)
  assert.equal(direct.bridgeTarget(), directParent)

  const opener = { location: { href: 'dsh-app://app/index.html', origin: 'dsh-app://app' }, postMessage() {} }
  const ticket = 'A'.repeat(43)
  const popup = { location: { href: `dsh-app://app/desktop-pane-popout.html?ticket=${ticket}`, origin: 'dsh-app://app' }, opener }
  const popped = makeBridge({ parent: popup })
  assert.equal(popped.isTrustedBridgeEvent({ source: opener, origin: 'dsh-app://app' }), true)
  assert.equal(popped.bridgeTarget(), opener)
  assert.equal(popped.isTrustedBridgeEvent({ source: popup, origin: 'dsh-app://app' }), true,
    'the direct popup parent retains same-origin handling')
  assert.equal(popped.isTrustedBridgeEvent({ source: {}, origin: 'dsh-app://app' }), false)
  assert.equal(popped.isTrustedBridgeEvent({ source: opener, origin: 'https://other.example' }), false)

  for (const href of [
    'dsh-app://app/desktop-pane-popout.html?extra=1',
    'dsh-app://app/desktop-pane-popout.html?ticket=short',
    `dsh-app://app/desktop-pane-popout.html?ticket=${ticket}&extra=1`,
    `dsh-app://app/desktop-pane-popout.html?ticket=${ticket}#extra`,
    'dsh-app://app/other.html',
    'dsh-app://app:99/desktop-pane-popout.html',
    'dsh-app://user@app/desktop-pane-popout.html',
  ]) {
    const invalid = makeBridge({ parent: { location: { href, origin: 'dsh-app://app' }, opener } })
    assert.equal(invalid.isTrustedBridgeEvent({ source: opener, origin: 'dsh-app://app' }), false, href)
    if (href.includes('/desktop-pane-popout.html')) assert.equal(invalid.bridgeTarget(), null, href)
    else assert.equal(invalid.bridgeTarget(), invalid.context.window.parent, href,
      'an ordinary direct same-origin parent keeps the existing bridge behavior')
  }
  for (const href of ['dsh-app://app/desktop-pane-popout.html?extra=1', 'dsh-app://app/login']) {
    const invalidOpener = { location: { href, origin: 'dsh-app://app' }, postMessage() {} }
    const invalidPopup = { location: { href: `dsh-app://app/desktop-pane-popout.html?ticket=${ticket}`, origin: 'dsh-app://app' }, opener: invalidOpener }
    const invalid = makeBridge({ parent: invalidPopup })
    assert.equal(invalid.isTrustedBridgeEvent({ source: invalidOpener, origin: 'dsh-app://app' }), false, href)
    assert.equal(invalid.bridgeTarget(), null, href)
  }
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
  const context = { document, window, URL, URLSearchParams, globalThis: {} }
  runInNewContext(businessUrlSource, context)
  runInNewContext(appSource, context)
  const palette = {
    accent: '#4d83dd', accentSoft: '#1c2b43', accentStrong: '#356fc4', border: '#293345',
    buttonInk: '#ffffff', canvas: '#0c1017', danger: '#ff7474', dangerBackground: '#331d24',
    dangerBorder: '#70404a', header: '#171f2c', muted: '#8b97ab', panel: '#131925',
    success: '#66d19e', successBackground: '#173328', teal: '#37b5a9', text: '#dfe7f3',
    warning: '#f5be5d', warningBackground: '#342b1a', warningBorder: '#75603a',
  }
  const ui = {
    controlHeight: 32, cornerRadius: 8, dockTabHeight: 30, fontBody: 16, fontCompact: 14,
    fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', iconSize: 18, lineHeight: 1.45,
    modelControl: 34, navHeight: 40, sceneTabHeight: 34, toolbarHeight: 36, topRowHeight: 42,
  }
  const event = data => messageHandler({ source: parent, origin: window.location.origin, data })
  event({ type: 'tradeloom:theme', colorScheme: 'dark', palette, ui })
  assert.equal(html.dataset.colorScheme, 'dark')
  assert.equal(variables.get('--wb-theme-canvas'), '#0c1017')
  assert.equal(variables.get('--wb-theme-teal'), '#37b5a9')
  assert.equal(variables.get('--wb-theme-dangerBackground'), '#331d24')
  assert.equal(variables.get('--wb-font-body'), '16px')
  assert.equal(variables.get('--wb-font-compact'), '14px')
  assert.equal(variables.get('--wb-nav-height'), '40px')
  event({ type: 'tradeloom:theme', colorScheme: 'light', palette: { ...palette, canvas: 'url(https://bad.example)' }, ui })
  assert.equal(html.dataset.colorScheme, 'dark', 'unsafe token values are ignored without partially applying the palette')
  assert.equal(variables.get('--wb-theme-canvas'), '#0c1017')
  messageHandler({ source: {}, origin: window.location.origin, data: { type: 'tradeloom:theme', colorScheme: 'light', palette, ui } })
  messageHandler({ source: parent, origin: 'https://other.example', data: { type: 'tradeloom:theme', colorScheme: 'light', palette, ui } })
  event({ type: 'tradeloom:theme', colorScheme: 'light', palette, ui: { ...ui, extra: 1 } })
  event({ type: 'tradeloom:theme', colorScheme: 'light', palette, ui })
  assert.equal(html.dataset.colorScheme, 'light', 'the exact complete theme message is accepted')
  assert.equal(variables.get('--wb-theme-canvas'), '#0c1017')
  event({ type: 'tradeloom:theme', colorScheme: 'dark', palette, ui, extra: true })
  assert.equal(html.dataset.colorScheme, 'light', 'foreign senders, origins, and extra fields are rejected')
})
