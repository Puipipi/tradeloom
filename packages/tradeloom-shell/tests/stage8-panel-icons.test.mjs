import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const replica = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const [desktop, panels, css, web, webShell, entry, preview] = await Promise.all([
  readFile(new URL('renderer.js', replica), 'utf8'),
  readFile(new URL('panel-interactions.js', replica), 'utf8'),
  readFile(new URL('style.css', replica), 'utf8'),
  readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'),
  readFile(new URL('../client.js', import.meta.url), 'utf8'),
  readFile(new URL('../source-entry.html', replica), 'utf8'),
  readFile(new URL('index.html', replica), 'utf8'),
])
function between(source, start, end) {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  assert.ok(first !== -1 && last > first, start)
  return source.slice(first, last)
}
class Element {
  constructor(tag) {
    this.tag = tag
    this.nodeType = 1
    this.attrs = {}
    this.children = []
    this.dataset = {}
    this.listeners = {}
  }
  setAttribute(key, value) { this.attrs[key] = value }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  addEventListener(name, listener) { this.listeners[name] = listener }
}
const document = {
  createElement: tag => new Element(tag),
  createElementNS: (_namespace, tag) => new Element(tag),
}
const h = (tag, attrs, ...children) => ({ tag, attrs, children })
const desktopIcon = between(desktop, 'function createReplicaIcon(', 'function iconBtn(')
const lineStyle = svg => [svg.attrs.viewBox, svg.attrs.stroke,
  svg.attrs['stroke-width'] ?? svg.attrs.strokeWidth,
  svg.attrs['stroke-linecap'] ?? svg.attrs.strokeLinecap,
  svg.attrs['stroke-linejoin'] ?? svg.attrs.strokeLinejoin]
const glyph = svg => svg.children[0].attrs.d

test('desktop and Web scene icons keep their semantic identity after reorder and cloning', () => {
  const native = runInNewContext(desktopIcon
    + between(desktop, 'const SCENE_ICONS =', 'function tabListOf(')
    + '\ncreateSceneIcon', { document })
  const browser = runInNewContext(between(web, '    function sceneNavigationItems(', '    function sceneTabsNeedCompact(')
    + between(web, '    const sceneIcons =', '    function updatePanelLayout(') + '\n({ sceneIcon, sceneNavigationItems })', { h })
  const scenes = [{ id: 'center' }, { id: 'products' }, { id: 'agent-center' }, { id: 'deliverables' }, { id: 'runs' }]
  const expected = new Map(scenes.map(scene => [scene.id, glyph(native(scene))]))
  assert.equal(new Set(expected.values()).size, scenes.length)
  for (const scene of [...scenes].reverse()) {
    assert.equal(glyph(native(scene)), expected.get(scene.id))
    assert.equal(glyph(browser.sceneIcon(scene.id)), expected.get(scene.id))
    assert.deepEqual(lineStyle(native(scene)), lineStyle(browser.sceneIcon(scene.id)).map(String))
  }
  const clone = { id: 'runs-copy', label: '运行记录副本', templateSceneId: 'runs' }
  const [projected] = browser.sceneNavigationItems({ scenes: [clone] })
  assert.equal(glyph(native(clone)), expected.get('runs'))
  assert.equal(glyph(browser.sceneIcon(projected.templateSceneId)), expected.get('runs'))
  assert.equal(glyph(native({ id: 'old-custom' })), glyph(browser.sceneIcon('old-custom')))
})

test('common desktop and Web panel actions share a compact line glyph and keep their actions', () => {
  const controls = new Element('div')
  const panel = { id: 'business-main', type: 'business-iframe', title: '概要', querySelector: () => ({ querySelector: () => controls }) }
  const calls = []
  const native = runInNewContext(desktopIcon
    + between(panels, '  function setFullscreenButton(', '  function equalTracks(')
    + between(panels, '  function installPanel(', '  function onContextMenu(')
    + '\n({ installPanel, setFullscreenButton })', {
    document, maximize: () => calls.push('maximize'), closePanel: () => calls.push('close'),
    openMenu: () => calls.push('more'), menu: undefined,
  })
  native.installPanel(panel)
  const [fullscreen, more, close] = controls.children
  const context = { panels: [panel, { id: 'another' }] }
  const browser = runInNewContext(between(web, '    const closeActionPath = ', '    function notifyNarrowListeners(')
    + '\nDockGroupActions', {
    h, React: { useState: () => [0, () => {}], useEffect: () => {} }, useSnapshot: () => ({}),
    dockRenderContexts: new Map([['center', context]]), dockviewApis: new Map(),
  })
  const bar = browser({ sceneId: 'center', activePanel: panel })
  const [inline, webMore] = bar.children
  const webAction = name => inline.children.find(item => item?.attrs['data-pane-action'] === name).children[0]
  for (const [button, icon] of [[fullscreen, webAction('maximize')], [more, webMore.children[0]], [close, webAction('close')]]) {
    const [desktopSvg] = button.children
    assert.deepEqual(lineStyle(desktopSvg), ['0 0 24 24', 'currentColor', '1.5', 'round', 'round'])
    assert.deepEqual(lineStyle(desktopSvg), lineStyle(icon).map(String))
    assert.equal(glyph(desktopSvg), glyph(icon))
    assert.ok(button.attrs['aria-label'])
    button.listeners.click({ stopPropagation() {}, preventDefault() {} })
  }
  assert.deepEqual(calls, ['maximize', 'more', 'close'])
  assert.ok(desktop.includes(`createReplicaIcon('${glyph(webAction('refresh'))}'), '刷新面板'`))
  assert.ok(panels.includes(`: '${glyph(webAction('popout'))}')`))
  const previous = glyph(fullscreen.children[0])
  native.setFullscreenButton(fullscreen, true)
  const restore = glyph(fullscreen.children[0])
  assert.notEqual(restore, previous)
  const [, returnWindow] = panels.match(/createReplicaIcon\(returning \? '([^']+)'/)
  assert.notEqual(restore, returnWindow)
  assert.match(returnWindow, /z$/)
  context.isPanelMaximized = () => true
  const [restoredActions] = browser({ sceneId: 'center', activePanel: panel }).children
  const webRestore = restoredActions.children.find(item => item?.attrs['data-pane-action'] === 'maximize')
  assert.equal(glyph(webRestore.children[0]), restore)
  assert.equal(webRestore.attrs['aria-label'], '还原概要')
  assert.equal(fullscreen.attrs['aria-pressed'], 'true')
  assert.match(css, /\.replica-line-icon\{display:block;width:var\(--replica-glyph-size,15px\);height:var\(--replica-glyph-size,15px\)/)
  assert.match(webShell, /iconSize: 15,/)
  assert.match(web, /\.tl-dock-group-actions button svg \{[^}]*width:var\(--tl-icon-size\); height:var\(--tl-icon-size\)/)
})

test('persistent desktop tools share the compact line style and preserve accessible labels', () => {
  for (const [id, label] of [['btn-settings', '设置'], ['btn-refresh', '刷新当前场景'], ['btn-tools', '工作台工具']]) {
    const button = new RegExp(`<button ([^>]*id="${id}"[^>]*)>(.*?)</button>`)
    const [, attributes, icon] = entry.match(button)
    if (id === 'btn-settings') assert.doesNotMatch(preview, button, 'preview has no separate settings button')
    else assert.equal(preview.match(button)?.[0], entry.match(button)?.[0], `${id} keeps identical icon, size class, and accessible name in preview`)
    assert.ok(attributes.includes(`aria-label="${label}"`))
    assert.match(icon, /^<svg class="replica-line-icon"/)
    assert.match(icon, /stroke="currentColor" stroke-width="1.5"/)
    assert.match(icon, /aria-hidden="true" focusable="false"/)
  }
  const theme = /<button [^>]*id="btn-theme"[^>]*>[\s\S]*?<\/button>/
  const themeButton = entry.match(theme)?.[0]
  assert.ok(themeButton)
  assert.equal(preview.match(theme)?.[0]?.replace(/\r\n/g, '\n'), themeButton.replace(/\r\n/g, '\n'))
  assert.match(themeButton, /aria-label="切换外观" data-theme-icon="dark" data-theme-effective="dark"/)
  assert.match(themeButton, /theme-icon-dark/)
  assert.match(themeButton, /theme-icon-light/)
  assert.match(themeButton, /class="theme-auto-badge" aria-hidden="true">A</)
})

test('Web auxiliary close commands share the panel close icon and keep their labelled actions', () => {
  const icons = between(web, '    const closeActionPath = ', '    function DockGroupActions(')
  const makeCloseIcon = runInNewContext(icons + '\n() => actionIcon(closeActionPath)', { h })
  const icon = makeCloseIcon()
  assert.deepEqual(lineStyle(icon).map(String), ['0 0 24 24', 'currentColor', '1.5', 'round', 'round'])
  for (const [label, behavior] of [
    ['关闭绑定详情', /root\.current\.open = false; root\.current\.querySelector\('summary'\)\.focus\(\)/],
    ['关闭文件导入提示', /setFileDropStatus\(null\)/],
  ]) {
    const line = web.split(/\r?\n/).find(source => source.includes(`'aria-label': '${label}'`))
    assert.match(line ?? '', behavior)
    assert.match(line ?? '', /actionIcon\(closeActionPath\)/)
  }
  assert.match(web, /\.tl-dock-binding-details-content button svg \{[^}]*width:var\(--tl-icon-size,15px\); height:var\(--tl-icon-size,15px\)/)
  assert.match(web, /\.tl-chat-file-drop-status button svg \{[^}]*width:var\(--tl-icon-size,15px\); height:var\(--tl-icon-size,15px\)/)
})
