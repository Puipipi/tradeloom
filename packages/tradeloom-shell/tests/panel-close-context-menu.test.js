import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const interactionsPath = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui/panel-interactions.js')
const domModule = process.env.TRADELOOM_DOM_MODULE

const PANEL_TEMPLATE = (id, title) => `
  <section class="panel" data-panel-id="${id}" data-col="1" data-row="1" data-w="2" data-h="1">
    <div class="panel-header">
      <div class="panel-identity"><strong class="panel-title">${title}</strong></div>
      <div class="panel-controls"></div>
    </div>
  </section>`

async function loadHarness() {
  const { JSDOM } = await import(pathToFileURL(domModule).href)
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scenebar"><button class="tab active">工作总览</button></div>
    <div id="grid" style="--cols:4;--rows:4">
      ${PANEL_TEMPLATE('overview', '总览')}
      ${PANEL_TEMPLATE('files', '文件')}
    </div>
  </body></html>`, { url: 'https://source-shell.test/', pretendToBeVisual: true })
  dom.window.businessBridge = {
    panelMenuCapabilities: () => ({ nativeConversation: true, independent: true }),
    openSceneRotation: () => undefined,
    openNativeMenu: async () => ({ ok: true }),
    requestPanelPlacement: async () => ({ ok: true }),
    requestRolePlacement: async () => ({ ok: true }),
  }
  const source = await readFile(interactionsPath, 'utf8')
  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: dom.window.ResizeObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    setTimeout: dom.window.setTimeout.bind(dom.window),
    clearTimeout: dom.window.clearTimeout.bind(dom.window),
  }
  vm.runInContext(source, vm.createContext(sandbox), { filename: interactionsPath })
  return dom
}

test('desktop panels close with the header × and restore through the scene context menu', async () => {
  const dom = await loadHarness()
  const { window } = dom
  const { document } = window
  try {
    const overview = document.querySelector('.panel[data-panel-id="overview"]')
    const files = document.querySelector('.panel[data-panel-id="files"]')
    assert.ok(overview && files, 'both scene panels mount')
    overview.__meta = { sceneId: 'scene-center' }
    files.__meta = { sceneId: 'scene-center' }

    assert.equal(document.querySelector('.pi-more'), null, 'the ⋯ overflow control is gone from every panel header')
    const closeButtons = [...document.querySelectorAll('.panel-controls > .pi-close')]
    assert.equal(closeButtons.length, 2, 'every panel header exposes exactly one × close control')
    assert.equal(closeButtons[0].textContent, '×')
    assert.equal(closeButtons[0].getAttribute('aria-label'), '关闭面板')

    closeButtons[0].click()
    assert.ok(overview.classList.contains('pi-closed'), 'clicking × hides the owning panel')
    assert.equal(files.classList.contains('pi-closed'), false, 'closing one panel leaves the others visible')
    const stored = JSON.parse(window.localStorage.getItem('uiClosedPanels:v1'))
    assert.deepEqual(Object.values(stored), [['overview']], 'the closed panel is persisted per scene')

    const contextEvent = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 220 })
    document.getElementById('scenebar').dispatchEvent(contextEvent)
    const menu = document.querySelector('.pi-menu')
    assert.ok(menu, 'right-clicking the scene navigation bar opens the context menu')
    const restoreItem = [...menu.querySelectorAll('button')].find(item => item.textContent === '恢复面板：总览')
    assert.ok(restoreItem, 'the context menu lists the closed panel by title')
    restoreItem.click()
    assert.equal(overview.classList.contains('pi-closed'), false, 'the context-menu entry restores the panel')
    assert.deepEqual(Object.values(JSON.parse(window.localStorage.getItem('uiClosedPanels:v1') || '{}')), [],
      'restoring clears the persisted closed-panel entry')

    const blankEvent = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })
    document.getElementById('grid').dispatchEvent(blankEvent)
    assert.equal(document.querySelector('.pi-menu'), null, 'no context menu appears when the scene has nothing to restore')
  } finally {
    window.close()
  }
})

test('the panel header context menu keeps the rotation, popout and native entries', async () => {
  const dom = await loadHarness()
  const { window } = dom
  const { document } = window
  try {
    const filesPanel = document.querySelector('.panel[data-panel-id="files"]')
    filesPanel.__meta = { sceneId: 'scene-center' }
    document.querySelector('.panel[data-panel-id="overview"]').__meta = { sceneId: 'scene-center' }
    document.querySelector('.panel[data-panel-id="overview"] .panel-controls > .pi-close').click()
    const header = document.querySelector('.panel[data-panel-id="files"] .panel-header')
    header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))
    const menu = document.querySelector('.pi-menu')
    assert.ok(menu, 'right-clicking a panel header opens its action menu')
    const labels = [...menu.querySelectorAll('button')].map(item => item.textContent)
    for (const label of ['独立窗口', '打开原生会话', '轮换此角色会话', '关闭面板']) {
      assert.ok(labels.includes(label), `panel context menu keeps ${label}`)
    }
    assert.ok(!labels.includes('应用') && !labels.includes('编辑'),
      'the native DSH application/edit entries stay out of ordinary panel menus')
    assert.ok(labels.some(label => label.startsWith('恢复面板：')), 'panel context menu also offers restore entries')

    filesPanel.classList.add('panel-native-chat')
    header.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }))
    const assistantMenu = document.querySelector('.pi-menu')
    const assistantLabels = [...assistantMenu.querySelectorAll('button')].map(item => item.textContent)
    assert.ok(!assistantLabels.includes('应用') && !assistantLabels.includes('编辑'),
      'the useless native application/edit entries are gone from assistant menus too')
  } finally {
    window.close()
  }
})