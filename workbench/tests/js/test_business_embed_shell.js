import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const apiPath = process.env.TRADELOOM_DOM_MODULE
if (!apiPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime')
const { JSDOM } = nodeRequire(apiPath)
const bridgeSource = await readFile(new URL('../../static/workbench/business-url.js', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../../static/workbench/app.js', import.meta.url), 'utf8')
const styleSource = await readFile(new URL('../../static/workbench/styles.css', import.meta.url), 'utf8')

function renderPage({ configuredForEmbed, insideFrame }) {
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN" data-business-embed="${configuredForEmbed}" data-color-scheme="light">
    <head><style>${styleSource}</style></head><body><div class="app-shell"><div class="workspace">
      <header class="topbar"><div><p class="eyebrow">产品资料工作台</p><h1>织贸助手</h1></div>
        <div class="runtime-status" data-testid="mode-badge"><span>local_mock</span><span>本地规则模拟</span></div></header>
      <main class="content-area" id="main-content"><section class="panel">
        <div class="panel-heading"><div><h2>产品资料库</h2>
          <p data-testid="product-summary">4 个产品匹配当前筛选 · 3 个已有最新版本 · 1 个存在缺项。</p></div>
          <span class="tag demo-tag">2 个批次</span></div>
        <div class="detail-heading"><div><h2>资料明细</h2><p data-testid="detail-summary">按当前筛选查看资料字段。</p></div></div>
        <p class="count-note" data-testid="product-result-count">4 个产品匹配当前筛选。</p>
        <form data-testid="product-filter"><label>产品名称<input name="product"></label>
          <select name="state"><option value="">全部状态</option></select><button type="submit">筛选</button></form>
        <p class="inline-alert warning" role="alert" data-testid="product-filter-error">筛选条件无效，请调整后重试。</p>
        <p class="timezone-note">时间均为上海时间（UTC+8）。</p>
      </section>
      <section class="file-browser-panel">
        <div class="file-pane-heading" id="density-file-heading"><div class="file-browser-toolbar"><div class="file-location-row"><div class="file-scope-chip"><span class="file-scope-icon" aria-hidden="true">📁</span><select aria-label="资料范围" data-file-filter><option>来源资料</option></select></div><button class="file-scope-reset">全部</button></div><div class="file-pane-tools"><div class="file-view-switch"><button>列表</button><button>缩略图</button></div></div></div></div>
        <div class="file-list-scroll" data-display-mode="rows"><button class="file-list-item" id="density-file-row"><span class="file-type-icon" id="density-file-icon">XLSX</span>指令单</button></div>
        <div class="file-preview-heading" id="density-preview-heading">预览</div>
        <div class="file-preview-empty" id="density-preview-empty">未选择文件</div>
      </section></main>
    </div></div></body></html>`, {
    url: 'http://127.0.0.1:3088/business/products',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const parentMessages = []
  const parentWindow = { location: new URL('http://127.0.0.1:3088/'), postMessage: (...args) => parentMessages.push(args) }
  if (insideFrame) {
    Object.defineProperty(dom.window, 'parent', {
      configurable: true,
      value: parentWindow,
    })
  }
  dom.window.eval(bridgeSource)
  dom.window.eval(appSource)
  return { dom, parentMessages, parentWindow }
}

function themeMessage(fontBody, fontCompact = Math.max(10, fontBody - 2), uiOverrides = {}) {
  return {
    type: 'tradeloom:theme',
    colorScheme: 'dark',
    palette: {
      accent: '#6b9bf5', accentSoft: '#1c2a43', accentStrong: '#8bb0fa', border: '#282e3c',
      buttonInk: '#101522', canvas: '#0c0e14', danger: '#f18189', dangerBackground: '#29191d',
      dangerBorder: '#71353b', header: '#1b2130', muted: '#939baa', panel: '#12151e',
      success: '#78c9a0', successBackground: '#182921', teal: '#74cec6', text: '#e6e8ef',
      warning: '#e7b568', warningBackground: '#2a2218', warningBorder: '#6b4e29',
    },
    ui: {
      controlHeight: 32, cornerRadius: 8, dockTabHeight: 32, fontBody, fontCompact,
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', iconSize: 16, lineHeight: 1.4,
      modelControl: 32, navHeight: 36, sceneTabHeight: 36, toolbarHeight: 32, topRowHeight: 32,
      ...uiOverrides,
    },
  }
}

function dispatchTheme(dom, parentWindow, data) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data,
    origin: dom.window.location.origin,
    source: parentWindow,
  }))
}

test('the runtime marks and requests theme only in an actual business iframe', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement

  assert.equal(root.dataset.businessIframe, 'true')
  assert.equal(parentMessages.length, 1, 'the existing theme bridge still requests the parent palette')
  dom.window.close()
})

test('the native file-scope popup follows the embedded dark or light theme', () => {
  const { dom, parentWindow } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document, getComputedStyle } = dom.window
  const root = document.documentElement
  const select = document.querySelector('[data-file-filter]')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12))
  assert.equal(root.dataset.colorScheme, 'dark')
  assert.equal(getComputedStyle(select).colorScheme, 'dark')
  assert.equal(getComputedStyle(select.options[0]).color, 'var(--ink)')
  assert.equal(getComputedStyle(select.options[0]).backgroundColor, 'var(--surface)')
  assert.equal(root.style.getPropertyValue('--wb-theme-text'), '#e6e8ef')
  assert.equal(root.style.getPropertyValue('--wb-theme-panel'), '#12151e')

  const light = themeMessage(14, 12)
  light.colorScheme = 'light'
  light.palette = { ...light.palette, canvas: '#f4f7fb', panel: '#ffffff', header: '#e9eef6', border: '#cbd5e2', buttonInk: '#ffffff', text: '#202b3a', muted: '#68778c', accent: '#356fc4', accentStrong: '#285ca4', accentSoft: '#e8f1fd', teal: '#177d78', success: '#0f635a', successBackground: '#e1f2ef', danger: '#ba2121', dangerBackground: '#fdecea', dangerBorder: '#f5c6c6', warning: '#76501b', warningBackground: '#fffaF2', warningBorder: '#eed8b7' }
  dispatchTheme(dom, parentWindow, light)
  assert.equal(root.dataset.colorScheme, 'light')
  assert.equal(getComputedStyle(select).colorScheme, 'light')
  assert.equal(getComputedStyle(select.options[0]).color, 'var(--ink)')
  assert.equal(getComputedStyle(select.options[0]).backgroundColor, 'var(--surface)')
  assert.equal(root.style.getPropertyValue('--wb-theme-text'), '#202b3a')
  assert.equal(root.style.getPropertyValue('--wb-theme-panel'), '#ffffff')
  dom.window.close()
})

test('the business theme bridge scales geometry with persisted text size and validates UI bounds', () => {
  const { dom, parentWindow } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const root = dom.window.document.documentElement

  dispatchTheme(dom, parentWindow, themeMessage(14, 12))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '14px')
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), '1')
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-lg'), /calc\(var\(--wb-font-body\)\*1\.15\)/)
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-display'), /calc\(var\(--wb-font-body\)\*1\.5\)/)
  dispatchTheme(dom, parentWindow, themeMessage(10, 10, {
    controlHeight: 16, dockTabHeight: 16, modelControl: 16, navHeight: 16,
    sceneTabHeight: 16, toolbarHeight: 16, topRowHeight: 16, iconSize: 8, cornerRadius: 0,
  }))
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(10 / 14))
  assert.equal(root.style.getPropertyValue('--wb-control-height'), '16px')
  assert.equal(root.style.getPropertyValue('--wb-icon-size'), '8px')
  assert.equal(root.style.getPropertyValue('--wb-corner-radius'), '0px')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12))
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), '1')
  dispatchTheme(dom, parentWindow, themeMessage(16, 14))
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(16 / 14))
  dispatchTheme(dom, parentWindow, themeMessage(22, 20, {
    controlHeight: 96, dockTabHeight: 96, modelControl: 96, navHeight: 96,
    sceneTabHeight: 96, toolbarHeight: 96, topRowHeight: 96, iconSize: 32, cornerRadius: 16,
  }))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px')
  assert.equal(root.style.getPropertyValue('--wb-font-compact'), '20px')
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(22 / 14))
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-lg'), /calc\(var\(--wb-font-body\)\*1\.15\)/, 'large headings continue to scale above 19px')
  assert.doesNotMatch(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-lg'), /clamp\(/)
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-display'), /calc\(var\(--wb-font-body\)\*1\.5\)/)
  assert.equal(root.style.getPropertyValue('--wb-control-height'), '96px')
  assert.equal(root.style.getPropertyValue('--wb-icon-size'), '32px')
  assert.equal(root.style.getPropertyValue('--wb-corner-radius'), '16px')

  dispatchTheme(dom, parentWindow, themeMessage(9, 10))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'sizes below the supported range are rejected')
  dispatchTheme(dom, parentWindow, themeMessage(23, 21))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'sizes above the supported range are rejected')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12, { controlHeight: 15 }))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'invalid control geometry rejects the message')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12, { modelControl: 97 }))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'height values above the supported range are rejected')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12, { iconSize: 33 }))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'icons above the supported range are rejected')
  dispatchTheme(dom, parentWindow, themeMessage(14, 12, { cornerRadius: 17 }))
  assert.equal(root.style.getPropertyValue('--wb-font-body'), '22px', 'radii above the supported range are rejected')
  dom.window.close()
})

test('embedded controls and panel spacing consume the dynamic density scale', () => {
  const { dom, parentWindow } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const root = dom.window.document.documentElement
  dispatchTheme(dom, parentWindow, themeMessage(14, 12))
  const button = dom.window.document.querySelector('form button[type="submit"]')
  button.classList.add('button')
  const buttonHeightAt14 = dom.window.getComputedStyle(button).minHeight
  assert.equal(buttonHeightAt14, 'var(--wb-control-height, 34px)')
  assert.match(styleSource, /\.panel:not\(\.file-browser-panel\)[\s\S]*?padding: calc\(12px \* var\(--wb-ui-scale\)\)/)
  dispatchTheme(dom, parentWindow, themeMessage(16, 14, { controlHeight: 40 }))
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(16 / 14))
  assert.equal(root.style.getPropertyValue('--wb-control-height'), '40px')
  assert.equal(dom.window.getComputedStyle(button).minHeight, buttonHeightAt14)
  dispatchTheme(dom, parentWindow, themeMessage(22, 20))
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(22 / 14))
  dom.window.close()
})

test('file-browser cascade overrides fixed browser-mode geometry at each density', () => {
  const { dom, parentWindow } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const root = dom.window.document.documentElement
  root.dataset.businessBrowserMode = 'files'
  const declaredValues = (selector, css = styleSource) => {
    const marker = `${selector} {`
    const values = new Map()
    let at = 0
    while ((at = css.indexOf(marker, at)) >= 0) {
      const end = css.indexOf('}', at)
      for (const entry of css.slice(at + marker.length, end).split(';')) {
        const colon = entry.indexOf(':')
        if (colon >= 0) values.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim())
      }
      at = end + 1
    }
    return values
  }
  const assertLastRule = (selector, declaration) => {
    const values = declaredValues(selector)
    assert.ok(values.size, `scoped overrides exist for ${selector}`)
    const properties = [...declaration.source.matchAll(/([a-z-]+):/g)].map(match => match[1])
    assert.ok(properties.length, 'the assertion names CSS properties')
    assert.match(properties.map(name => `${name}: ${values.get(name)}`).join('; '), declaration)
  }

  const scopeSelect = 'html[data-business-iframe="true"][data-business-browser-mode] .file-scope-chip select'
  assert.equal(declaredValues(scopeSelect, styleSource + `\n${scopeSelect} { min-height: 1px; }`).get('min-height'), '1px',
    'a later declaration of the same property still wins; unrelated flex rules do not erase a height')

  dispatchTheme(dom, parentWindow, themeMessage(14, 12))
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-pane > .file-pane-heading', /padding: calc\(4px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-heading', /flex: 0 0 auto;\s*flex-direction: row;\s*flex-wrap: wrap;\s*align-items: center;\s*justify-content: space-between/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-title-group', /flex: 1 1 12rem/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-tools', /flex: 0 1 auto;\s*align-self: center;\s*align-items: center;\s*justify-content: flex-end;\s*margin-left: auto/)
  assert.match(styleSource, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group h3,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group strong,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group p\s*\{\s*text-align: left;/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-scope-chip select', /min-height: calc\(22px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-view-switch button', /width: calc\(24px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll[data-display-mode="rows"] .file-list-item', /min-height: calc\(28px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll[data-display-mode="rows"] .file-list-item', /border-bottom: 0/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll[data-display-mode="rows"] .file-list-name', /font-weight: 500; text-decoration: none/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll[data-display-mode="rows"] .file-type-icon', /width: var\(--wb-icon-size, 16px\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll[data-display-mode="rows"] .file-list-detail', /font-size: calc\(11px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-heading', /min-height: calc\(39px \* var\(--wb-ui-scale\)\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-heading', /flex: 0 0 auto;\s*flex-direction: row;\s*flex-wrap: wrap;\s*align-items: center;\s*justify-content: space-between/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-title-group', /flex: 1 1 12rem/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-tools', /flex: 0 1 auto;\s*align-self: center;\s*align-items: center;\s*justify-content: flex-end;\s*margin-left: auto/)
  assert.match(styleSource, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group h3,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group strong,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-title-group p\s*\{\s*text-align: left;/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-empty', /padding: calc\(10px \* var\(--wb-ui-scale\)\)/)
  assert.match(styleSource, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-image-viewer,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-source\s*\{\s*flex: 1 1 50%;\s*min-height: 0;/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-source', /height: 0; overflow: auto/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-tools', /align-items: center/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-image-controls', /align-items: center/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-preview-tools .button.small', /height: calc\(var\(--wb-control-height, 34px\) \* \.84\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] body', /height: 100vh;\s*min-height: 0;\s*overflow: hidden/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .app-shell', /height: 100%;\s*min-height: 0;\s*grid-template-rows: minmax\(0, 1fr\)/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .workspace', /height: 100%;\s*min-height: 0;\s*overflow: hidden/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .content-area', /height: 100%;\s*min-height: 0;\s*overflow: hidden/)
  assert.match(styleSource, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] #main-content,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.page-stack\s*\{\s*height: 100%;\s*min-height: 0;\s*overflow: hidden;/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-browser-panel', /height: 100%;\s*min-height: 0;\s*flex: 1 1 auto/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-browser-layout', /height: 100%;\s*min-height: 0/)
  assert.match(styleSource, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-pane-heading,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-preview-info,\s*html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-technical-details\s*\{\s*flex: 0 0 auto;/)
  assertLastRule('html[data-business-iframe="true"][data-business-browser-mode] .file-list-scroll', /min-height: 0;\s*flex: 1 1 0;\s*overflow: auto/)
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), '1')

  dispatchTheme(dom, parentWindow, themeMessage(16, 14, { controlHeight: 40, iconSize: 18, cornerRadius: 10 }))
  assert.equal(root.style.getPropertyValue('--wb-control-height'), '40px')
  assert.equal(root.style.getPropertyValue('--wb-icon-size'), '18px')
  assert.equal(root.style.getPropertyValue('--wb-corner-radius'), '10px')
  assert.equal(root.style.getPropertyValue('--wb-ui-scale'), String(16 / 14))
  dom.window.close()
})

test('embedded iframe keeps a compact business title, scene routes, and useful content', () => {
  const { dom } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement
  const titleBlock = document.querySelector('.topbar > div:first-child')
  const topbar = document.querySelector('.topbar')
  const status = document.querySelector('[data-testid="mode-badge"]')
  const content = document.querySelector('.content-area')

  assert.equal(titleBlock.textContent.includes('织贸助手'), true)
  assert.notEqual(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(status).display, 'none')
  assert.equal(document.querySelector('[data-testid="product-filter-error"]')?.textContent, '筛选条件无效，请调整后重试。')
  assert.ok(document.querySelector('form input[name="product"]'))
  assert.ok(document.querySelector('form select[name="state"]'))
  assert.ok(document.querySelector('form button[type="submit"]'))
  assert.equal(document.querySelector('[data-testid="product-summary"]')?.textContent.includes('4 个产品匹配当前筛选 · 3 个已有最新版本 · 1 个存在缺项。'), true)
  assert.ok(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize)
  assert.ok(dom.window.getComputedStyle(document.querySelector('.detail-heading h2')).fontSize)
  const summaryStyle = dom.window.getComputedStyle(document.querySelector('[data-testid="product-summary"]'))
  assert.match(summaryStyle.fontSize, /^(14px|var\(--wb-font-body\))$/)
  assert.equal(summaryStyle.marginTop, 'calc(3px * var(--wb-ui-scale))')
  assert.equal(summaryStyle.lineHeight, '1.5')
  assert.match(dom.window.getComputedStyle(document.querySelector('[data-testid="detail-summary"]')).fontSize, /^(14px|var\(--wb-font-body\))$/)
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-testid="product-result-count"]')).display, 'none')
  assert.ok(document.querySelector('.timezone-note')?.textContent.includes('UTC+8'))
  assert.ok(content.querySelector('section.panel'), 'the embedded business section remains mounted')
  assert.equal(root.dataset.businessIframe, 'true', 'the tested iframe scope comes from app.js runtime detection')
  assert.equal(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-body').trim(), '14px')
  assert.equal(dom.window.getComputedStyle(root).getPropertyValue('--wb-font-compact').trim(), '12px')
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-page-inset-block').trim(), /^calc\(8px\s*\*\s*var\(--wb-ui-scale\)\)$/)
  assert.match(dom.window.getComputedStyle(root).getPropertyValue('--wb-panel-inset').trim(), /^calc\(12px\s*\*\s*var\(--wb-ui-scale\)\)$/)
  assert.equal(dom.window.getComputedStyle(topbar).minHeight, '0px')
  dom.window.close()
})

test('a standalone page remains full-header even when the server embed setting is enabled', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: false })
  const { document } = dom.window
  const titleBlock = document.querySelector('.topbar > div:first-child')

  assert.equal(document.documentElement.dataset.businessIframe, undefined)
  assert.equal(parentMessages.length, 0)
  assert.notEqual(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize, '17px')
  assert.notEqual(dom.window.getComputedStyle(document.querySelector('[data-testid="product-result-count"]')).display, 'none')
  assert.ok(document.querySelector('[data-testid="mode-badge"]'))
  assert.ok(document.querySelector('[role="alert"]'))
  dom.window.close()
})

test('a parent frame without the server embed flag does not activate iframe styles or request theme', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: false, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement
  const titleBlock = document.querySelector('.topbar > div:first-child')

  assert.equal(root.dataset.businessIframe, undefined)
  assert.equal(parentMessages.length, 0)
  assert.notEqual(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.ok(document.querySelector('[data-testid="mode-badge"]'))
  assert.ok(document.querySelector('[role="alert"]'))
  dom.window.close()
})
