import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const replica = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const [desktop, panels, css, web, webShell, entry, preview, shellCss, businessBridge, businessBridgeCss] = await Promise.all([
  readFile(new URL('renderer.js', replica), 'utf8'),
  readFile(new URL('panel-interactions.js', replica), 'utf8'),
  readFile(new URL('style.css', replica), 'utf8'),
  readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'),
  readFile(new URL('../client.js', import.meta.url), 'utf8'),
  readFile(new URL('../source-entry.html', replica), 'utf8'),
  readFile(new URL('index.html', replica), 'utf8'),
  readFile(new URL('../styles.css', replica), 'utf8'),
  readFile(new URL('business-bridge.js', replica), 'utf8'),
  readFile(new URL('business-bridge.css', replica), 'utf8'),
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
  const context = { panels: [panel, { id: 'another' }], togglePopout: () => calls.push('popout') }
  const browser = runInNewContext(between(web, '    const closeActionPath = ', '    function notifyNarrowListeners(')
    + '\nDockGroupActions', {
    h, React: { useState: () => [0, () => {}], useEffect: () => {} }, useSnapshot: () => ({}),
    dockRenderContexts: new Map([['center', context]]), dockviewApis: new Map(),
  })
  const bar = browser({ sceneId: 'center', activePanel: panel })
  const [inline, webMore] = bar.children
  const webAction = name => inline.children.find(item => item?.attrs['data-pane-action'] === name).children[0]
  assert.equal(glyph(webAction('maximize')), 'M4 10V4h6M14 4h6v6M20 14v6h-6M10 20H4v-6',
    'the right-side maximize action keeps its original four-corner icon')
  assert.doesNotMatch(web, /function panelStackIcon\(/, 'the overlapping-window icon belongs to the native panel-expand control, never maximize')
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
  const popoutButton = inline.children.find(item => item?.attrs['data-pane-action'] === 'popout')
  const [popoutArrow] = popoutButton.children
  assert.equal(popoutArrow.tag, 'span')
  assert.equal(popoutArrow.attrs.className, 'tl-dock-popout-arrow')
  assert.equal(popoutArrow.attrs['aria-hidden'], 'true')
  assert.equal(popoutArrow.children[0], '↗', 'the popout control uses the established simplified external-window arrow')
  popoutButton.attrs.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, ['maximize', 'more', 'close', 'popout'], 'simplifying the glyph preserves the popout action')
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

test('native panel-expand restores the layered two-window icon and swaps real front-to-back paint order', () => {
  const iconSource = between(desktop, 'function createPanelExpandIcon()', 'function setPanelExpandControl(')
  const stateSource = between(desktop, 'function setPanelExpandControl(', 'function layoutGeometry(')
  const native = runInNewContext(iconSource + stateSource + '\n({ createPanelExpandIcon, setPanelExpandControl })', { document })
  const button = new Element('button')
  button.append(native.createPanelExpandIcon())
  const icon = button.children[0]
  native.setPanelExpandControl(button, false)
  assert.equal(button.children[0], icon, 'state changes keep the same SVG and its two stable layers')
  assert.equal(icon.attrs.viewBox, '0 0 24 20')
  assert.equal(icon.attrs['aria-hidden'], 'true')
  assert.equal(icon.attrs.focusable, 'false')
  const [normal, extended] = icon.children
  assert.equal(normal.attrs.class, 'panel-expand-icon-normal')
  assert.equal(extended.attrs.class, 'panel-expand-icon-extended')
  const [normalRear, normalFront] = normal.children
  assert.equal(normalRear.attrs.x, 9)
  assert.equal(normalRear.attrs.stroke, 'var(--text-dim)')
  assert.equal(normalFront.attrs.x, 2)
  assert.equal(normalFront.attrs.stroke, 'currentColor')
  assert.equal(normalFront.attrs.fill, 'var(--panel-header)')
  const [extendedRear, extendedFront] = extended.children
  assert.equal(extendedRear.attrs.x, 2)
  assert.equal(extendedRear.attrs.stroke, 'var(--text-dim)')
  assert.equal(extendedFront.attrs.x, 9)
  assert.equal(extendedFront.attrs.stroke, 'currentColor')
  assert.equal(button.dataset.extended, 'false')
  assert.equal(button.attrs['aria-pressed'], 'false')
  assert.equal(button.attrs['aria-label'], '向上延长面板')
  native.setPanelExpandControl(button, true)
  assert.equal(button.children[0], icon)
  assert.equal(button.dataset.extended, 'true')
  assert.equal(button.attrs['aria-pressed'], 'true')
  assert.equal(button.attrs['aria-label'], '还原面板高度')
  assert.match(desktop, /exp\.append\(createPanelExpandIcon\(\)\)[\s\S]{0,250}setPanelExpandControl\(exp, false\)[\s\S]{0,550}identity\.append\(exp\)/,
    'the original title-adjacent panel-expand button owns the layered icon')
  assert.match(desktop, /if \(expandedStateOf\(wrap\)\) collapsePanel\(wrap\)[\s\S]{0,80}else expandPanel\(wrap, exp\)/,
    'the icon remains attached to the original expand/collapse behavior')
  assert.match(css, /\.panel-expand svg g\{[^}]*transition:opacity \.16s ease,transform \.16s ease\}/)
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.panel-expand svg g\{transition:none\}\}/)
  assert.match(shellCss, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\);/,
    'keyboard users retain the project-wide focus indicator on the original button')
})

test('native business placement uses a frameless stroked arrow while preserving popout and return actions', () => {
  const updaterSource = between(businessBridge, '  function updatePlacementButton(record) {', '  async function requestPlacement(')
  const updatePlacementButton = runInNewContext(updaterSource + '\nupdatePlacementButton', { document })
  const button = new Element('button')
  const record = { placementButton: button, placement: 'docked', created: true, status: 'context-mounted' }
  updatePlacementButton(record)
  const [openSvg] = button.children
  assert.equal(openSvg.tag, 'svg')
  assert.equal(openSvg.attrs.viewBox, '0 0 24 24')
  assert.equal(openSvg.attrs['aria-hidden'], 'true')
  assert.equal(openSvg.attrs.stroke, 'currentColor')
  assert.equal(openSvg.children[0].attrs.d, 'M6 18 18 6M10 6h8v8')
  assert.equal(button.attrs['aria-label'], '在独立窗口打开助手')
  assert.equal(button.hidden, false)
  record.placement = 'popped-out'
  updatePlacementButton(record)
  const [returnSvg] = button.children
  assert.equal(returnSvg.children[0].attrs.d, 'M18 6 6 18M6 10v8h8')
  assert.equal(button.attrs['aria-label'], '返回主工作台')
  assert.equal(button.hidden, false)
  assert.match(businessBridge, /placementButton\.className = 'icon-control business-native-placement'/)
  assert.match(businessBridge, /placementButton\.addEventListener\('click', event => \{ event\.preventDefault\(\); event\.stopPropagation\(\); void requestPlacement\(record\) \}\)/,
    'the actual native control continues through requestPlacement')
  assert.match(businessBridgeCss, /\.business-native-placement\s*\{[^}]*border:\s*0;/)
  assert.match(businessBridgeCss, /\.business-native-placement:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-edge\)/)
  assert.match(businessBridgeCss, /\.business-native-placement svg\s*\{[^}]*width:\s*14px; height:\s*14px/)
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
