import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const root = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/', import.meta.url)
const renderer = await readFile(new URL('renderer.js', root), 'utf8')
const styles = await readFile(new URL('style.css', root), 'utf8')
const bridge = await readFile(new URL('business-bridge.js', root), 'utf8')
const bridgeCss = await readFile(new URL('business-bridge.css', root), 'utf8')

test('global refresh rerenders active data panels without replacing canvas drafts, chats or connector state', () => {
  const cleaned = [], rendered = []
  const panel = (id, sceneId, type, hidden = false) => {
    const body = { replaceChildren() { this.cleared = true } }
    return {
      __meta: { id, sceneId, type }, body,
      querySelector(selector) { return selector === '.panel-content' ? body : null },
      classList: { contains(name) { return hidden && name === 'pi-closed' } },
    }
  }
  const panels = [
    panel('sources', 'center', 'doc'), panel('files', 'center', 'files'),
    panel('draft', 'center', 'canvas'), panel('session', 'center', 'chat'),
    panel('connector', 'center', 'erpnext-status'), panel('old', 'products', 'doc'),
    panel('closed', 'center', 'preview', true),
  ]
  const cleanups = new Map(panels.map(item => [item.__meta.id, () => cleaned.push(item.__meta.id)]))
  const context = {
    currentTab: 'center',
    grid: { querySelectorAll() { return panels } },
    cleanups,
    rendererRegistry: Object.fromEntries(['doc', 'files', 'preview', 'canvas', 'chat', 'erpnext-status'].map(type => [type, meta => { rendered.push(meta.id); return () => {} }])),
    unsupportedRenderer() { throw new Error('unexpected renderer type') },
    Set,
  }
  const start = renderer.indexOf('function refreshPanel(')
  const end = renderer.indexOf('\nfunction layoutGeometry(', start)
  assert.ok(start >= 0 && end > start)
  const dispatch = vm.runInNewContext(`${renderer.slice(start, end)}\nrefreshCurrentScenePanels`, context)
  dispatch()
  assert.deepEqual(cleaned, ['sources', 'files'])
  assert.deepEqual(rendered, ['sources', 'files'])
  assert.equal(panels[0].body.cleared, true)
  assert.equal(panels[2].body.cleared, undefined)
  assert.equal(panels[3].body.cleared, undefined)
  assert.equal(panels[4].body.cleared, undefined)
  assert.equal(panels[6].body.cleared, undefined)
})

test('shared panel chrome stays compact and material controls no longer duplicate refresh or local folder picking', () => {
  assert.match(styles, /--ui-titlebar-height:36px;[^\n]*--ui-scenebar-height:32px/)
  assert.match(styles, /--ui-panel-header-height:25px/)
  assert.match(styles, /@container \(max-width:300px\)/)
  assert.match(styles, /\.pi-component-tabs\{display:flex;flex:1 1 2em;min-width:0;overflow:auto/)
  assert.doesNotMatch(renderer, /'刷新面板'/)
  assert.doesNotMatch(bridge, /makeTool\('↻', '刷新资料列表'/)
  assert.match(bridge, /if \(!fileHeaderGroup\) actions\.append\(button\('打开'/)
  assert.match(bridgeCss, /@container \(max-width:360px\)/)
  assert.doesNotMatch(bridge, /makeTool\('全部', '显示全部资料'/)
})

test('embedded Django file list keeps its DOM refresh hook but hides the duplicate visible refresh control', async () => {
  const djangoStyles = await readFile(new URL('../../../workbench/static/workbench/styles.css', import.meta.url), 'utf8')
  assert.match(bridge, /!child\.querySelector\('\[data-file-refresh\]'\)/, 'the bridge still requires and preserves the child refresh capability')
  assert.match(djangoStyles, /html\[data-business-iframe="true"\]\[data-business-browser-mode\] \.file-pane-tools \[data-file-refresh\] \{ display: none; \}/)
})
