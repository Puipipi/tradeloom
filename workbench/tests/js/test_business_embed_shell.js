import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const nodeRequire = createRequire(import.meta.url)
const apiPath = process.env.TRADELOOM_DOM_MODULE
if (!apiPath) throw new Error('TRADELOOM_DOM_MODULE must point to the existing external jsdom runtime')
const { JSDOM } = nodeRequire(apiPath)
const baseTemplate = await readFile(new URL('../../templates/workbench/base.html', import.meta.url), 'utf8')
const scriptNames = [...baseTemplate.matchAll(/<script src="{{ '\/static\/workbench\/([^'?]+)(?:\?[^']*)?'\|business_url }}" defer><\/script>/g)]
  .map(([, name]) => name)
assert.deepEqual(scriptNames.filter(name => name === 'business-url.js' || name === 'app.js'), ['business-url.js', 'app.js'])
const scriptSources = await Promise.all(scriptNames.map(name => readFile(new URL(`../../static/workbench/${name}`, import.meta.url), 'utf8')))
const styleSource = await readFile(new URL('../../static/workbench/styles.css', import.meta.url), 'utf8')
const topbarTemplate = baseTemplate.match(/{% if not business_embed %}\s*(<header class="topbar">[\s\S]*?<\/header>)\s*{% endif %}/)?.[1]
assert.ok(topbarTemplate, 'the Django template renders a topbar only outside business embed mode')
const topbarMarkup = topbarTemplate
  .replace(/{% block \w+ %}|{% endblock %}/g, '')
  .replace('{{ planning_mode }}', '模拟模式')
  .replace('{{ planning_status }}', '本地执行')
const pageUrl = 'http://127.0.0.1:3088/business/products'

function renderPage({ configuredForEmbed, insideFrame }) {
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN" data-business-embed="${configuredForEmbed}" data-color-scheme="light">
    <head><style>${styleSource}</style></head><body><div class="app-shell"><div class="workspace">
      ${configuredForEmbed ? '' : topbarMarkup}
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
      <section class="panel intro-panel">
        <div class="panel-heading"><div><h2>从来源核对到交付检查</h2><p>核对来源、确认要求、检查交付。</p></div></div>
        <div class="empty-state file-preview-empty"><h3>尚未选择文件</h3><p>在文件面板选择条目后查看可用预览。</p></div>
      </section>
    </div></div></body></html>`, {
    url: pageUrl,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  })
  const parentMessages = []
  if (insideFrame) {
    Object.defineProperty(dom.window, 'parent', {
      configurable: true,
      value: {
        location: new URL('/', pageUrl),
        postMessage: (message, origin) => parentMessages.push([message.type, origin]),
      },
    })
  }
  for (const source of scriptSources) dom.window.eval(source)
  return { dom, parentMessages }
}

test('the runtime marks and requests theme only in an actual business iframe', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement

  assert.equal(root.dataset.businessIframe, 'true')
  assert.deepEqual(parentMessages, [['tradeloom:theme:request', new URL(pageUrl).origin]])
  dom.window.close()
})

test('embedded iframe omits the desktop header and compacts product content', () => {
  const { dom } = renderPage({ configuredForEmbed: true, insideFrame: true })
  const { document } = dom.window
  const root = document.documentElement
  const content = document.querySelector('.content-area')

  assert.equal(document.querySelector('.topbar'), null)
  assert.equal(document.querySelector('[data-testid="product-filter-error"]')?.textContent, '筛选条件无效，请调整后重试。')
  assert.ok(document.querySelector('form input[name="product"]'))
  assert.ok(document.querySelector('form select[name="state"]'))
  assert.ok(document.querySelector('form button[type="submit"]'))
  assert.equal(document.querySelector('[data-testid="product-summary"]')?.textContent.includes('4 个产品匹配当前筛选 · 3 个已有最新版本 · 1 个存在缺项。'), true)
  assert.equal(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize, 'var(--wb-font-lg)')
  assert.equal(dom.window.getComputedStyle(document.querySelector('.detail-heading h2')).fontSize, 'var(--wb-font-lg)')
  const overviewTitle = dom.window.getComputedStyle(document.querySelector('.intro-panel .panel-heading h2'))
  const overviewDescription = dom.window.getComputedStyle(document.querySelector('.intro-panel .panel-heading p'))
  const previewTitle = dom.window.getComputedStyle(document.querySelector('.file-preview-empty h3'))
  const previewDescription = dom.window.getComputedStyle(document.querySelector('.file-preview-empty p'))
  assert.equal(overviewTitle.fontSize, previewTitle.fontSize)
  assert.equal(overviewDescription.fontSize, previewDescription.fontSize)
  assert.equal(overviewTitle.lineHeight, previewTitle.lineHeight)
  assert.equal(overviewDescription.lineHeight, previewDescription.lineHeight)
  const summaryStyle = dom.window.getComputedStyle(document.querySelector('[data-testid="product-summary"]'))
  assert.equal(summaryStyle.fontSize, 'var(--wb-font-body)')
  assert.equal(summaryStyle.marginTop, 'calc(3px * var(--wb-ui-scale))')
  assert.equal(summaryStyle.lineHeight, '1.5')
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-testid="detail-summary"]')).fontSize, 'var(--wb-font-body)')
  assert.equal(dom.window.getComputedStyle(document.querySelector('[data-testid="product-result-count"]')).display, 'none')
  assert.ok(document.querySelector('.timezone-note')?.textContent.includes('UTC+8'))
  assert.ok(content.querySelector('section.panel'), 'the embedded business section remains mounted')
  assert.equal(root.dataset.businessIframe, 'true', 'the tested iframe scope comes from app.js runtime detection')
  const rootStyle = dom.window.getComputedStyle(root)
  const token = name => rootStyle.getPropertyValue(name).replace(/\s+/g, '')
  assert.equal(token('--wb-font-body'), '14px')
  assert.equal(token('--wb-font-lg'), 'calc(var(--wb-font-body)*1.15)')
  assert.equal(token('--wb-ui-scale'), '1')
  assert.equal(token('--wb-page-inset-block'), 'calc(8px*var(--wb-ui-scale))')
  assert.equal(token('--wb-panel-inset'), 'calc(12px*var(--wb-ui-scale))')
  dom.window.close()
})

test('the server embed setting alone does not apply iframe typography or hide the result count', () => {
  const { dom, parentMessages } = renderPage({ configuredForEmbed: true, insideFrame: false })
  const { document } = dom.window

  assert.equal(document.documentElement.dataset.businessIframe, undefined)
  assert.equal(parentMessages.length, 0)
  assert.equal(document.querySelector('.topbar'), null)
  assert.equal(dom.window.getComputedStyle(document.querySelector('.panel-heading h2')).fontSize, 'var(--wb-font-heading)')
  const headingToken = dom.window.getComputedStyle(document.documentElement).getPropertyValue('--wb-font-heading')
  assert.equal(headingToken.replace(/\s+/g, ''), 'calc(var(--wb-font-body)*1.4)')
  assert.notEqual(dom.window.getComputedStyle(document.querySelector('[data-testid="product-result-count"]')).display, 'none')
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
  assert.match(titleBlock.textContent, /织贸助手/)
  assert.notEqual(dom.window.getComputedStyle(titleBlock).display, 'none')
  assert.ok(document.querySelector('[data-testid="mode-badge"]'))
  assert.ok(document.querySelector('[role="alert"]'))
  dom.window.close()
})
