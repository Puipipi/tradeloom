import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  defaultDockLayout,
  migrateLegacyDockLayout,
  normalizeDockLayouts,
  validateDockviewLayout,
  validateDockLayouts,
} from '../dock-layout.js'

const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
const center = config.scenes.find(scene => scene.id === 'center')
test('chat-only scenes have one valid default group', () => {
  const scene = { id: 'chat-only', panels: [{ id: 'native-chat', type: 'native-chat', title: '中心助手' }] }
  const layout = defaultDockLayout(scene)
  assert.equal(layout.dockview.grid.root.data.length, 1)
  assert.doesNotThrow(() => validateDockviewLayout(scene, layout.dockview, layout.closedPanelIds))
})

const serializedDockviewFixture = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { views: ['business-main', 'auxiliary', 'reference'], activeView: 'reference', id: '1' }, size: 100 },
        { type: 'leaf', data: { views: ['native-chat'], activeView: 'native-chat', id: '2' }, size: 100 },
      ],
      size: 100,
    },
    width: 100,
    height: 100,
    orientation: 'HORIZONTAL',
  },
  panels: {
    'business-main': { id: 'business-main', contentComponent: 'business-iframe', title: '总览', renderer: 'always' },
    auxiliary: { id: 'auxiliary', contentComponent: 'business-iframe', title: '商品', renderer: 'always' },
    reference: { id: 'reference', contentComponent: 'business-iframe', title: '资料', renderer: 'always' },
    'native-chat': { id: 'native-chat', contentComponent: 'native-chat', title: '中心助手', renderer: 'always' },
  },
  activeGroup: '2',
}

function legacyDefaults(scene) {
  return {
    expandedPanel: '',
    panels: Object.fromEntries(scene.panels.map(panel => [panel.id, {
      col: panel.col, row: panel.row, w: panel.w, h: panel.h, visible: true,
    }])),
  }
}

test('pinned Dockview api.toJSON trees validate, including one group and no open panels', () => {
  assert.equal(validateDockviewLayout(center, serializedDockviewFixture, []), true)
  const oneGroup = structuredClone(serializedDockviewFixture)
  oneGroup.grid.root.data = [{ type: 'leaf', data: { views: ['business-main', 'auxiliary', 'reference', 'native-chat'], activeView: 'reference', id: '1' }, size: 100 }]
  oneGroup.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, oneGroup, []), true)
  const onePanel = structuredClone(serializedDockviewFixture)
  onePanel.grid.root.data = [{ type: 'leaf', data: { views: ['business-main'], activeView: 'business-main', id: '1' }, size: 100 }]
  onePanel.panels = { 'business-main': onePanel.panels['business-main'] }
  onePanel.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, onePanel, ['auxiliary', 'reference', 'native-chat']), true)
  const noPanels = structuredClone(serializedDockviewFixture)
  noPanels.grid.root.data = []
  noPanels.panels = {}
  delete noPanels.activeGroup
  assert.equal(validateDockviewLayout(center, noPanels, ['business-main', 'auxiliary', 'reference', 'native-chat']), true)

  const result = defaultDockLayout(center)
  assert.equal(validateDockviewLayout(center, result.dockview, result.closedPanelIds), true)
  assert.deepEqual(result.dockview.grid.root.data.map(group => group.size), [60, 40])
  assert.deepEqual(result.dockview.grid.root.data[0].data.views, ['business-main', 'auxiliary', 'reference'])
  assert.deepEqual(result.dockview.grid.root.data[1].data.views, ['native-chat'])
  assert.ok(Object.values(result.dockview.panels).every(panel => panel.renderer === 'always'))
  assert.deepEqual(Object.entries(result.dockview.panels).map(([panelId, panel]) => [panelId, panel.params]),
    Object.keys(result.dockview.panels).map(panelId => [panelId, { panelId }]))

  const withoutChat = { ...center, panels: center.panels.filter(panel => panel.type !== 'native-chat') }
  const oneGroupDefault = defaultDockLayout(withoutChat)
  assert.equal(oneGroupDefault.dockview.grid.root.data.length, 1)
  assert.deepEqual(oneGroupDefault.dockview.grid.root.data[0].data.views, ['business-main', 'auxiliary', 'reference'])
})

test('unchanged v1 geometry upgrades to the wider dock default and keeps its first snapshot', () => {
  const snapshot = legacyDefaults(center)
  const migrated = migrateLegacyDockLayout(center, snapshot)
  assert.equal(migrated.migration.status, 'default_upgrade')
  assert.equal(migrated.migration.reason, 'matches-scene-default')
  assert.deepEqual(migrated.legacyV1Snapshot, snapshot)
  assert.deepEqual(migrated.dockview.grid.root.data[0].data.views, ['business-main', 'auxiliary', 'reference'])

  const edited = structuredClone(migrated)
  edited.legacyV1Snapshot.panels['business-main'].w = 1
  const normalized = validateDockLayouts(config, { version: 2, scenes: { center: edited } }, {
    existingDockLayouts: { version: 2, scenes: { center: migrated } },
    legacySceneLayouts: { center: snapshot },
  })
  assert.deepEqual(normalized.scenes.center.legacyV1Snapshot, snapshot)
})

test('simple custom business/chat geometry maps proportions into Dockview group sizes', () => {
  const custom = legacyDefaults(center)
  custom.panels['business-main'] = { col: 1, row: 1, w: 3, h: 4, visible: true }
  custom.panels['native-chat'] = { col: 4, row: 1, w: 1, h: 4, visible: true }
  custom.panels.auxiliary = { col: 1, row: 1, w: 1, h: 1, visible: false }
  custom.panels.reference = { col: 1, row: 1, w: 1, h: 1, visible: false }
  const migrated = migrateLegacyDockLayout(center, custom)
  assert.equal(migrated.migration.status, 'mapped')
  assert.deepEqual(migrated.dockview.grid.root.data.map(group => group.size), [75, 25])
  assert.deepEqual(migrated.closedPanelIds.sort(), ['auxiliary', 'reference'])
  assert.deepEqual(migrated.legacyV1Snapshot, custom)
})

test('overlapping legacy rectangles fall back deterministically without losing the snapshot', () => {
  const overlapping = legacyDefaults(center)
  overlapping.panels['native-chat'] = { col: 1, row: 1, w: 3, h: 2, visible: true }
  const migrated = migrateLegacyDockLayout(center, overlapping)
  assert.equal(migrated.migration.status, 'fallback')
  assert.equal(migrated.migration.reason, 'legacy-overlap')
  assert.deepEqual(migrated.legacyV1Snapshot, overlapping)
  assert.deepEqual(migrated.dockview, defaultDockLayout(center).dockview)
})

test('dock layout validation rejects unknown panels and malformed serialized trees', () => {
  const unknownPanel = structuredClone(serializedDockviewFixture)
  unknownPanel.panels.rogue = { id: 'rogue', contentComponent: 'business-iframe', title: 'Rogue', renderer: 'always' }
  assert.throws(() => validateDockviewLayout(center, unknownPanel, []), /unknown or closed panel/)
  const malformed = structuredClone(serializedDockviewFixture)
  malformed.grid.root.data[0].data.views.push('missing')
  assert.throws(() => validateDockviewLayout(center, malformed, []), /view/)
})

test('normalization initializes dock layouts and legacy scene-layout writes do not replace them', () => {
  const legacy = { center: legacyDefaults(center) }
  const first = normalizeDockLayouts(config, undefined, legacy)
  const saved = structuredClone(first)
  saved.scenes.center.dockview.activeGroup = '2'
  const normalized = validateDockLayouts(config, saved, { existingDockLayouts: first, legacySceneLayouts: legacy })
  assert.equal(normalized.scenes.center.dockview.activeGroup, '2')
  const later = normalizeDockLayouts(config, normalized, { center: legacyDefaults(center) })
  assert.deepEqual(later.scenes.center, normalized.scenes.center)
  assert.deepEqual(later.scenes.center.legacyV1Snapshot, legacy.center)

  const corrupted = structuredClone(normalized)
  corrupted.scenes.center.dockview.grid.root.data[0].data.views.push('unknown-panel')
  const changedLegacy = legacyDefaults(center)
  changedLegacy.panels['business-main'].visible = false
  const recovered = normalizeDockLayouts(config, corrupted, { center: changedLegacy })
  assert.deepEqual(recovered.scenes.center.legacyV1Snapshot, legacy.center)
  assert.equal(recovered.scenes.center.migration.reason, 'stored-layout-invalid')
})
