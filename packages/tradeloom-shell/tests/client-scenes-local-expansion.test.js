import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const sourceUrl = new URL('../client.scenes.js', import.meta.url)

async function readSource() { return readFile(sourceUrl, 'utf8') }

async function loadChunkApi(source) {
  let registration
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  assert.equal(registration?.chunk, 'client.scenes.js')
  const React = { createElement() {}, Fragment: Symbol('Fragment') }
  return registration.factory(name => {
    if (name === 'react') return React
    throw new Error(`Unexpected module requested while creating the scene chunk: ${name}`)
  })
}

test('local expansion exposes the exact production DOM controller without Dockview layout APIs', async () => {
  const source = await readSource()
  const api = await loadChunkApi(source)
  assert.equal(typeof api.createLocalPanelExpansionController, 'function')
  const start = source.indexOf('function createLocalPanelExpansionController(')
  const end = source.indexOf('function subscribeDockActions(', start)
  assert.ok(start >= 0 && end > start)
  const controllerSource = source.slice(start, end)
  for (const forbidden of ['.fromJSON(', '.toJSON(', '.layout(', '.setSize(', 'lastWideLayoutRef', 'queueDockLayoutSave']) {
    assert.equal(controllerSource.includes(forbidden), false, `the presentation helper must not call ${forbidden}`)
  }
  assert.match(controllerSource, /\.dv-render-overlay/)
  assert.match(controllerSource, /\.dv-content-container/)
  assert.match(controllerSource, /\.dv-tabs-and-actions-container/)
  assert.match(controllerSource, /data-tl-local-placeholder/)
  assert.match(controllerSource, /generation/)
  assert.match(controllerSource, /const header = \{ left:natural\.header\.left, top:viewport\.top,/)
  assert.match(controllerSource, /const overlay = \{ left:natural\.content\.left, top:header\.top \+ height,/)
  assert.match(controllerSource, /viewport\.top \+ viewport\.height - \(header\.top \+ height\)/)
  assert.match(controllerSource, /const motionWasInFlight = current\.motionInFlight/)
  assert.match(controllerSource, /if \(motionWasInFlight\) \{\s*const token = \+\+current\.generation\s*void transitionTo\(current, from, to, token\)/)
  assert.match(controllerSource, /if \(!current \|\| current\.restoring\) return false/)
  assert.match(controllerSource, /if \(current\.restoring\) \{\s*if \(animate\) return true/)
  assert.match(controllerSource, /current\.restoring = true/)
  assert.match(controllerSource, /current\.motionInFlight = true/)
  assert.match(controllerSource, /if \(preference === 'on'\) return true[\s\S]{0,100}if \(preference === 'off'\) return false[\s\S]{0,120}return !document\.defaultView\.matchMedia/)
})

test('pane header offers local expansion as a separate action from Dockview maximize', async () => {
  const source = await readSource()
  assert.match(source, /局部展开\$\{label\}/)
  assert.match(source, /aria-pressed':Boolean\(context\.isPanelLocallyExpanded\?\.\(panel\.id\)\)/)
  assert.match(source, /onClick:runWithoutActivatingGroup\(\(\) => context\.toggleLocalExpansion\?\.\(panel\.id\)\)/)
  assert.match(source, /context\.toggleMaximize\?\.\(panel\.id\)/)
  assert.match(source, /disabled:Boolean\(floatingPanel \|\| context\.isPanelMaximized\?\.\(panel\.id\) \|\| context\.hasMaximizedGroup\?\.\(\)\)/)
})

test('local expansion targets the active tab in its own group and survives neighbor focus', async () => {
  const source = await readSource()
  const start = source.indexOf('function createLocalPanelExpansionController(')
  const end = source.indexOf('function subscribeDockActions(', start)
  const controllerSource = source.slice(start, end)
  assert.match(controllerSource, /panel\.api\?\.group\?\.activePanel\?\.id !== panelId/)
  assert.doesNotMatch(controllerSource, /api\.activePanel\?\.id !== panelId/)
  assert.match(controllerSource, /function handleActivePanelChange\(selectedPanelId\)/)
  assert.match(controllerSource, /selectedGroup\?\.element === current\.group && group\.activePanel\?\.id !== current\.panelId/)
  assert.match(source, /selected\) localPanelExpansionRef\.current\?\.handleActivePanelChange\(selected\)/)
  assert.match(source, /function validTarget\(panelId[\s\S]{0,850}api\.hasMaximizedGroup\?\.\(\)/)
  assert.doesNotMatch(controllerSource, /hasFloatingPanels/)
})

test('sash pointer interruption restores before resize and keyboard interruption respects sash orientation', async () => {
  const source = await readSource()
  const start = source.indexOf('const interrupt = event => {', source.indexOf('function SceneDock'))
  const end = source.indexOf('\n        }', start)
  const handler = source.slice(start, end)
  assert.match(handler, /if \(event\.type === 'pointerdown' \|\| event\.type === 'mousedown'\)[\s\S]*?if \(event\.target\?\.closest\?\.\('\.dv-sash\.dv-enabled'\)\) localPanelExpansionRef\.current\?\.restore\(\)[\s\S]*?return[\s\S]*?if \(!\['ArrowLeft'/)
  assert.match(handler, /if \(!\['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'\]\.includes\(event\.key\)/)
  assert.match(handler, /classList\?\.contains\('dv-horizontal'\)[\s\S]*\['ArrowLeft', 'ArrowRight'\]/)
  assert.match(handler, /classList\?\.contains\('dv-vertical'\)[\s\S]*\['ArrowUp', 'ArrowDown'\]/)
  assert.match(handler, /if \(sizeKey\) localPanelExpansionRef\.current\?\.restore\(\)/)
  assert.doesNotMatch(handler, /event\.key === 'Tab'/)

  const body = handler.slice('const interrupt = event => {'.length)
  const restored = []
  const interrupt = new Function('localPanelExpansionRef', `return event => {${body}\n}`)({
    current: { restore() { restored.push('restore') } },
  })
  const sash = { closest(selector) { return selector === '.dv-sash.dv-enabled' ? this : null } }
  interrupt({ type: 'pointerdown', target: sash })
  interrupt({ type: 'mousedown', target: sash })
  assert.deepEqual(restored, ['restore', 'restore'])
  interrupt({ type: 'keydown', key: 'ArrowLeft', target: { closest: () => ({ closest: () => ({ classList: { contains: name => name === 'dv-horizontal' } }) }) } })
  assert.deepEqual(restored, ['restore', 'restore', 'restore'])
})

test('local geometry cannot update persisted or last-wide layout snapshots', async () => {
  const source = await readSource()
  assert.match(source, /if \(!currentApi \|\| localPanelExpansionRef\.current\?\.isExpanded\(\) \|\| layoutTransitionRef\.current/)
  assert.match(source, /if \(!localPresentationActive && !layoutTransitionRef\.current && viewport/)
  assert.match(source, /if \(restoredRef\.current && !narrowRef\.current && !localPresentationActive\) void persistCurrentLayout\(\)/)
})

test('local presentation is cleared before scene reset, maximize, floating, popout, drag, sash resize, and offstage', async () => {
  const source = await readSource()
  assert.match(source, /function toggleDockPanel\(panel\) \{\s*if \(!panel\) return\s*localPanelExpansionRef\.current\?\.restore\(\)/)
  assert.match(source, /async function toggleFloatingPanel\(panel\)[\s\S]{0,350}activePanelId === panel\.id\) localPanelExpansionRef\.current\.restore\(\)/)
  assert.match(source, /function resetLayout\(\)[\s\S]{0,220}localPanelExpansionRef\.current\?\.restore\(\)/)
  assert.match(source, /onDidAddPopoutGroup\?\.\(event => \{[\s\S]{0,260}some\(panel => panel\?\.id === expandedPanelId\)[\s\S]{0,120}restore\(\)/)
  assert.match(source, /onWillDragPanel\(event => \{[\s\S]{0,260}event\?\.panel\?\.api\?\.group === expandedPanel\.api\.group[\s\S]{0,100}restore\(\)/)
  assert.match(source, /onWillDragGroup\?\.\(event => \{[\s\S]{0,260}event\?\.group === expandedPanel\.api\.group[\s\S]{0,100}restore\(\)/)
  assert.match(source, /event\.target\?\.closest\?\.\('\.dv-sash\.dv-enabled'\)/)
  assert.match(source, /if \(!active\) localPanelExpansionRef\.current\?\.restore\(\)/)
  assert.match(source, /localPanelExpansionRef\.current\?\.dispose\(\)/)
})
