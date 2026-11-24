import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const [renderer, tabs, bridge, style, bridgeStyle, panelStyle] = await Promise.all([
  readFile(new URL('renderer.js', root), 'utf8'), readFile(new URL('panel-tabs.js', root), 'utf8'),
  readFile(new URL('business-bridge.js', root), 'utf8'), readFile(new URL('style.css', root), 'utf8'),
  readFile(new URL('business-bridge.css', root), 'utf8'), readFile(new URL('panel-interactions.css', root), 'utf8'),
])

test('material component tabs keep one title and production header children in order', () => {
  const panelHead = renderer.slice(renderer.indexOf('function panelHead('), renderer.indexOf('\nfunction createPanelExpandIcon('))
  const makePanel = renderer.slice(renderer.indexOf('function makePanel('), renderer.indexOf('\nfunction applyGeom('))
  assert.match(panelHead, /head\.append\(grip, identity\)/)
  assert.ok(makePanel.indexOf('identity.append(exp)') < makePanel.indexOf('head.append(controls)'))
  assert.match(bridge, /panelHeader\.insertBefore\(group, panelHeader\.querySelector\('\.panel-controls'\)\)/)
  assert.match(tabs, /header\.insertBefore\(bar, header\.querySelector\('\.workflow-header-actions'\) \|\| header\.querySelector\('\.panel-controls'\)\)/)
  assert.match(style, /\.panel-header:has\(\.pi-component-tabs\) \.panel-title[^\n]*display:none/)
  assert.doesNotMatch(bridgeStyle, /\.panel-header\.tl-workflow-file-header:has\(\.pi-component-tabs\) \.panel-title\s*\{\s*display:block/)
})

test('narrow panel headers reserve the full close-control hit area', () => {
  assert.match(style, /\.panel-controls\{display:flex;flex:0 0 auto;[^\n]*margin-inline-start:auto;[^\n]*z-index:2\}/)
  assert.match(style, /\.pi-component-tabs\{display:flex;flex:1 1 2em;min-width:0;overflow:auto/)
  assert.match(panelStyle, /\.panel-controls \.pi-action\s*\{[^}]*min-width:\s*24px/)
  assert.match(bridgeStyle, /@container \(max-width:480px\)/)
})
