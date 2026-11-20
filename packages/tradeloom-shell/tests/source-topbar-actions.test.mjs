import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const shell = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/', import.meta.url)
const renderer = await readFile(new URL('replica-ui/renderer.js', shell), 'utf8')
function sourceFunction(name, nextName) {
  const start = renderer.indexOf(`function ${name}(`)
  const end = renderer.indexOf(`\nfunction ${nextName}(`, start)
  assert.ok(start >= 0 && end > start)
  return renderer.slice(start, end)
}
function element(tag, className, ...children) {
  const attributes = new Map(), events = new Map()
  return {
    tag, className, children, attributes, events, dataset: {},
    append(...items) { this.children.push(...items) },
    setAttribute(name, value) { attributes.set(name, value) },
    addEventListener(name, callback) { events.set(name, callback) },
  }
}

test('source shell workbench tools keep distinct desktop actions and avoid duplicate or unavailable entries', () => {
  const actions = []
  const handlers = ['showAppearanceSettings','showERPNextService','showAssistantCapabilities',
    'showAppsEditor','showSceneConfiguration','showEngineGenerations','showRegisteredTools']
  let native = true, body
  const showTools = vm.runInNewContext(sourceFunction('showTools','showERPNextService') + '\nshowTools', {
    window: { businessBridge: { isDesktop: () => native } },
    el: element, make: element, toolModalBack: null,
    ...Object.fromEntries(handlers.map(name => [name, () => actions.push(name)])),
    openModal(title, render) {
      assert.equal(title,'工作台工具')
      body = element('body')
      render(body)
    },
  })
  const entries = () => body.children[0].children.map(row => row.children.at(-1))
  showTools()
  assert.deepEqual(entries().map(button => button.attributes.get('aria-label')), [
    '打开界面大小与动效','打开ERPNext 服务','打开助手能力','打开应用 / 编辑','打开场景配置','打开引擎程序快照','打开已注册工具',
  ])
  for (const button of entries()) button.events.get('click')()
  assert.deepEqual(actions, handlers)
  native = false
  showTools()
  assert.deepEqual(entries().map(button => button.attributes.get('aria-label')), ['打开界面大小与动效'])
})

test('desktop and preview titlebars omit the duplicate directories in normal and overflow markup', async () => {
  for (const route of ['source-entry.html', 'replica-ui/index.html']) {
    const markup = await readFile(new URL(route, shell), 'utf8')
    assert.doesNotMatch(markup, /\bid="btn-(?:plugins|models)"/)
    assert.match(markup, /\bid="btn-tools"/)
    assert.match(markup, /\bid="btn-refresh"/)
  }
  const overflow = sourceFunction('initTitlebarOverflow', 'initTitlebar')
  assert.doesNotMatch(overflow, /btn-(?:plugins|models)/)
  assert.match(overflow, /btn-tools/)
  assert.doesNotMatch(sourceFunction('initTitlebar','reportInitialPaintProgress'), /btn-(?:plugins|models)/)
})

test('the workbench tools reuse one modal header through open, back, close and reopen', {
  skip: !process.env.TRADELOOM_DOM_MODULE,
}, async () => {
  const { JSDOM } = await import(pathToFileURL(process.env.TRADELOOM_DOM_MODULE).href)
  const markup = await readFile(new URL('source-entry.html', shell), 'utf8')
  const { window } = new JSDOM(markup)
  const $ = selector => window.document.querySelector(selector)
  const make = (tag, className, ...children) => {
    const node = window.document.createElement(tag)
    if (className) node.className = className
    node.append(...children)
    return node
  }
  try {
    const shell = vm.runInNewContext('let toolModalBack = null\n'
      + sourceFunction('ensureModalHeader', 'modalRows')
      + sourceFunction('showTools', 'showERPNextService')
      + '\nfunction showAppearanceSettings() { openModal("界面大小与动效", () => {}) }'
      + '\n({ showTools, closeModal })', {
      $, make, el: make, window: { businessBridge: { isDesktop: () => false } },
    })
    const title = $('#modal-title')
    const header = title.parentElement
    shell.showTools()
    const group = title.parentElement
    const back = header.querySelector('.modal-tool-back')
    function assertHeader(text, hidden) {
      assert.equal(title.textContent, text)
      assert.equal(title.parentElement, group)
      assert.equal(group.parentElement, header)
      assert.equal(header.querySelectorAll('.modal-title-group').length, 1)
      assert.equal(header.querySelectorAll('.modal-tool-back').length, 1)
      assert.equal(header.querySelector('.modal-tool-back'), back)
      assert.equal(back.hidden, hidden)
    }
    assertHeader('工作台工具', true)
    for (let index = 0; index < 3; index++) {
      shell.showTools()
      assertHeader('工作台工具', true)
      $('[aria-label="打开界面大小与动效"]').click()
      assertHeader('界面大小与动效', false)
      back.click()
      assertHeader('工作台工具', true)
      shell.closeModal()
      assert.equal($('#modal-mask').style.display, 'none')
    }
    shell.showTools()
    assertHeader('工作台工具', true)
  } finally { window.close() }
})
