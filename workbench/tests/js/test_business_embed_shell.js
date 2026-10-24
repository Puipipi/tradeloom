import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const apiPath = process.env.TRADELOOM_DOM_MODULE
if (!apiPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime')
const { JSDOM } = nodeRequire(apiPath)
const appSource = await readFile(new URL('../../static/workbench/app.js', import.meta.url), 'utf8')
const styleSource = await readFile(new URL('../../static/workbench/styles.css', import.meta.url), 'utf8')

function renderPage({ configuredForEmbed, insideFrame }) {
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN" data-business-embed="${configuredForEmbed}">
    <head><style>${styleSource}</style></head><body><div class="app-shell"><div class="workspace">
      <header class="topbar"><div><p class="eyebrow">产品资料工作台</p><h1>织贸助手</h1></div>
        <div class="runtime-status" data-testid="mode-badge"><span>模拟模式</span><span>本地执行</span></div></header>
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
      </section></main>
    </div></div></body></html>`, {
    url: 'http://127.0.0.1:3088/business/products',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const parentMessages = []
  if (insideFrame) {
    Object.defineProperty(dom.window, 'parent', {
      configurable: true,
      value: { postMessage: (...args) => parentMessages.push(args) },
    })
  }
  dom.window.eval(appSource)
  return { dom, parentMessages }
}

test('the runtime marks and requests theme only in an actual business iframe', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement

  assert.equal(root.dataset.businessIframe, 'true')
  assert.equal(parentMessages.length, 1, 'the existing theme bridge still requests the parent palette')
  dom.window.close()
})

test('embedded iframe compacts heading copy and hides only the duplicate count note', () => {
  const { dom } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement
  const titleBlock = document.querySelector('.topbar > div:first-child')
  const topbar = document.querySelector('.topbar')
  const status = document.querySelector('[data-testid="mode-badge"]')
  const content = document.querySelector('.content-area')

  assert.equal(titleBlock.textContent.includes('织贸助手'), true)
  assert.equal(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.notEqual(dom.window.getComputedStyle(status).display, 'none')
  assert.equal(document.querySelector('[data-testid="product-filter-error"]')?.textContent, '筛选条件无效，请调整后重试。')
  assert.ok(document.querySelector('form input[name="product"]'))
  assert.ok(document.querySelector('form select[name="state"]'))
  assert.ok(document.querySelector('form button[type="submit"]'))
  assert.equal(document.querySelector('[data-testid="product-summary"]')?.textContent.includes('4 个产品匹配当前筛选 · 3 个已有最新版本 · 1 个存在缺项。'), true)
  assert.equal(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize, '17px')
  assert.equal(dom.window.getComputedStyle(document.querySelector('.detail-heading h2')).fontSize, '17px')
  const summaryStyle = dom.window.getComputedStyle(document.querySelector('[data-testid="product-summary"]'))
  assert.equal(summaryStyle.fontSize, '14px')
  assert.equal(summaryStyle.marginTop, '4px')
  assert.equal(summaryStyle.lineHeight, '1.5')
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-testid="detail-summary"]')).fontSize, '14px')
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-testid="product-result-count"]')).display, 'none')
  assert.ok(document.querySelector('.timezone-note')?.textContent.includes('UTC+8'))
  assert.ok(content.querySelector('section.panel'), 'the embedded business section remains mounted')
  assert.equal(root.dataset.businessIframe, 'true', 'the tested iframe scope comes from app.js runtime detection')
  assert.equal(dom.window.getComputedStyle(root).getPropertyValue('--wb-page-inset-block').trim(), '10px')
  assert.equal(dom.window.getComputedStyle(root).getPropertyValue('--wb-panel-inset').trim(), '14px')
  assert.equal(dom.window.getComputedStyle(topbar).minHeight, '40px')
  dom.window.close()
})

test('a standalone page remains full-header even when the server embed setting is enabled', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: false })
  const { document } = dom.window
  const titleBlock = document.querySelector('.topbar > div:first-child')

  assert.equal(document.documentElement.dataset.businessIframe, undefined)
  assert.equal(parentMessages.length, 0)
  assert.notEqual(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.equal(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize, '21px')
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
