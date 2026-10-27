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
import { normalizeSceneLayout } from '../scene-layout.js'

const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
const center = { ...config.scenes.find(scene => scene.id === 'center'), panels: config.scenes.find(scene => scene.id === 'center').panels.filter(panel => panel.optional !== true) }
const centerLegacy = { ...center, panels: center.panels.map(panel => panel.id === 'files'
  ? { ...panel, id: 'auxiliary', title: '商品', path: '/products' }
  : panel.id === 'preview' ? { ...panel, id: 'reference', title: '资料', path: '/artifacts' } : panel) }
test('legacy scene pane names migrate only where the scene config adopted files and preview roles', () => {
  const centerLayout = normalizeSceneLayout(center, { expandedPanel: 'auxiliary', panels: {
    auxiliary: { col: 4, row: 1, w: 1, h: 2, visible: false },
    reference: { col: 1, row: 3, w: 1, h: 2, visible: true },
  } })
  assert.equal(centerLayout.expandedPanel, 'files')
  assert.equal(centerLayout.panels.files.visible, false)
  assert.equal(centerLayout.panels.preview.visible, true)
  const runs = config.scenes.find(scene => scene.id === 'runs')
  const runsLayout = normalizeSceneLayout(runs, { panels: {
    auxiliary: { col: 4, row: 1, w: 1, h: 2, visible: true },
    reference: { col: 1, row: 3, w: 1, h: 2, visible: true },
  } })
  assert.ok(runsLayout.panels.auxiliary && runsLayout.panels.reference)
})
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
        { type: 'leaf', data: { views: ['business-main', 'files', 'preview'], activeView: 'preview', id: '1' }, size: 100 },
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
    files: { id: 'files', contentComponent: 'business-iframe', title: '文件', renderer: 'always' },
    preview: { id: 'preview', contentComponent: 'business-iframe', title: '预览', renderer: 'always' },
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
  oneGroup.grid.root.data = [{ type: 'leaf', data: { views: ['business-main', 'files', 'preview', 'native-chat'], activeView: 'preview', id: '1' }, size: 100 }]
  oneGroup.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, oneGroup, []), true)
  const onePanel = structuredClone(serializedDockviewFixture)
  onePanel.grid.root.data = [{ type: 'leaf', data: { views: ['business-main'], activeView: 'business-main', id: '1' }, size: 100 }]
  onePanel.panels = { 'business-main': onePanel.panels['business-main'] }
  onePanel.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, onePanel, ['files', 'preview', 'native-chat']), true)
  const noPanels = structuredClone(serializedDockviewFixture)
  noPanels.grid.root.data = []
  noPanels.panels = {}
  delete noPanels.activeGroup
  assert.equal(validateDockviewLayout(center, noPanels, ['business-main', 'files', 'preview', 'native-chat']), true)

  const result = defaultDockLayout(center)
  assert.equal(validateDockviewLayout(center, result.dockview, result.closedPanelIds), true)
  assert.equal(result.dockview.grid.orientation, 'VERTICAL', 'center uses a business overview across the top and context/chat below')
  assert.deepEqual(result.dockview.grid.root.data.map(group => group.size), [60, 40])
  assert.equal(result.dockview.activeGroup, 'topa', 'center opens on its primary business panel')
  assert.deepEqual(result.dockview.grid.root.data[0].data.map(group => [group.size, group.data.views[0]]), [[75, 'business-main'], [25, 'files']])
  assert.deepEqual(result.dockview.grid.root.data[1].data.map(group => [group.size, group.data.views[0]]), [[40, 'preview'], [60, 'native-chat']])
  assert.ok(Object.values(result.dockview.panels).every(panel => panel.renderer === 'always'))
  assert.deepEqual(Object.entries(result.dockview.panels).map(([panelId, panel]) => [panelId, panel.params]),
    Object.keys(result.dockview.panels).map(panelId => [panelId, { panelId }]))

  const withoutChat = { ...center, panels: center.panels.filter(panel => panel.type !== 'native-chat') }
  const oneGroupDefault = defaultDockLayout(withoutChat)
  assert.equal(oneGroupDefault.dockview.grid.root.data.length, 1)
  assert.deepEqual(oneGroupDefault.dockview.grid.root.data[0].data.views, ['business-main', 'files', 'preview'])
})

test('each configured scene gets its mapped recommendation while overview scenes preserve the screenshot grid', () => {
  let collaborationCustom
  for (const scene of config.scenes) {
    const recommendation = defaultDockLayout(scene)
    assert.equal(validateDockviewLayout(scene, recommendation.dockview, recommendation.closedPanelIds), true, scene.id)
    if (scene.layoutProfile.kind === 'collaboration_grid') {
      assert.equal(recommendation.dockview.grid.orientation, 'VERTICAL', scene.id)
      const [top, bottom] = recommendation.dockview.grid.root.data
      assert.equal(top.type, 'branch')
      assert.equal(bottom.type, 'branch')
      assert.deepEqual([top.size, bottom.size], [60, 40])
      assert.deepEqual(top.data.map(group => [group.size, group.data.views[0]]), [[75, 'business-main'], [25, 'files']])
      assert.deepEqual(bottom.data.map(group => [group.size, group.data.views[0]]), [[40, 'preview'], [60, 'native-chat']])
      if (scene.id === 'products') {
        collaborationCustom = structuredClone(recommendation)
        collaborationCustom.dockview.grid.root.data[0].data[0].size = 70
        collaborationCustom.dockview.grid.root.data[0].data[1].size = 30
        assert.equal(validateDockviewLayout(scene, collaborationCustom.dockview, collaborationCustom.closedPanelIds), true)
      }
    } else if (scene.layoutProfile.kind === 'business_lead') {
      assert.deepEqual(recommendation.dockview.grid.root.data.map(group => group.size), [72, 28], scene.id)
    }
  }
  const normalizedCustom = normalizeDockLayouts(config, { version: 2, scenes: { products: collaborationCustom } })
  assert.deepEqual(normalizedCustom.scenes.products.dockview, collaborationCustom.dockview,
    'a saved custom pane tree and its proportions remain unchanged as optional panels are added')
  assert.deepEqual(normalizedCustom.scenes.products.closedPanelIds.sort(),
    ['assistant-center', 'assistant-delivery', 'assistant-user-profile', 'native-workspace'])
  assert.equal(normalizedCustom.scenes.products.migration.status, 'default')
  const customWithClosedPanel = structuredClone(collaborationCustom)
  customWithClosedPanel.closedPanelIds = ['files']
  const [topRow, bottomRow] = customWithClosedPanel.dockview.grid.root.data
  customWithClosedPanel.dockview.grid.root.data = [
    { type: 'leaf', size: topRow.size, data: { ...topRow.data[0].data, id: topRow.data[0].data.id } },
    bottomRow,
  ]
  delete customWithClosedPanel.dockview.panels.files
  const restoredCustom = normalizeDockLayouts(config, { version: 2, scenes: { products: customWithClosedPanel } })
  assert.deepEqual(restoredCustom.scenes.products.dockview, customWithClosedPanel.dockview,
    'custom proportions and the user-closed pane remain intact during optional-panel migration')
  assert.deepEqual(restoredCustom.scenes.products.closedPanelIds.sort(), ['assistant-center', 'assistant-delivery', 'assistant-user-profile', 'files', 'native-workspace'].sort())
})

test('previous Dockview saves keep their exact pane tree while new panes remain closed until chosen', () => {
  const previous = defaultDockLayout(center).dockview
  previous.panels.auxiliary = { ...previous.panels.files, id: 'auxiliary', title: '商品', params: { panelId: 'auxiliary' } }
  previous.panels.reference = { ...previous.panels.preview, id: 'reference', title: '资料', params: { panelId: 'reference' } }
  delete previous.panels.files
  delete previous.panels.preview
  const rename = node => {
    if (node.type === 'leaf') {
      node.data.views = node.data.views.map(id => id === 'files' ? 'auxiliary' : id === 'preview' ? 'reference' : id)
      if (node.data.activeView === 'files') node.data.activeView = 'auxiliary'
      if (node.data.activeView === 'preview') node.data.activeView = 'reference'
    } else node.data.forEach(rename)
  }
  rename(previous.grid.root)
  const normalized = normalizeDockLayouts(config, { version: 2, scenes: { center: {
    version: 2, dockview: previous, closedPanelIds: [], legacyV1Snapshot: null, migration: { status: 'default', reason: 'no-legacy-layout' },
  } } })
  const migrated = normalized.scenes.center
  assert.deepEqual(migrated.dockview.grid.root, defaultDockLayout(center).dockview.grid.root,
    'the old pane tree, placement and proportions survive ID normalization')
  assert.equal(migrated.dockview.panels.files.title, '文件')
  assert.equal(migrated.dockview.panels.preview.title, '预览')
  assert.deepEqual(migrated.closedPanelIds.sort(), ['assistant-delivery', 'assistant-product', 'assistant-user-profile', 'native-workspace'])
  assert.equal(migrated.migration.status, 'panel_upgrade')
})

test('unchanged v1 geometry upgrades to the wider dock default and keeps its first snapshot', () => {
  const snapshot = legacyDefaults(centerLegacy)
  const migrated = migrateLegacyDockLayout(center, snapshot)
  assert.equal(migrated.migration.status, 'default_upgrade')
  assert.equal(migrated.migration.reason, 'matches-scene-default')
  assert.deepEqual(migrated.legacyV1Snapshot, snapshot)
  assert.equal(migrated.dockview.grid.orientation, 'VERTICAL', 'legacy layout upgrades to the current overview recommendation')

  const edited = structuredClone(migrated)
  edited.legacyV1Snapshot.panels['business-main'].w = 1
  edited.closedPanelIds = config.scenes.find(scene => scene.id === 'center').panels
    .filter(panel => panel.optional === true).map(panel => panel.id)
  const normalized = validateDockLayouts(config, { version: 2, scenes: { center: edited } }, {
    existingDockLayouts: { version: 2, scenes: { center: migrated } },
    legacySceneLayouts: { center: snapshot },
  })
  assert.deepEqual(normalized.scenes.center.legacyV1Snapshot, snapshot)
})

test('simple custom business/chat geometry maps proportions into Dockview group sizes', () => {
  const custom = legacyDefaults(centerLegacy)
  custom.panels['business-main'] = { col: 1, row: 1, w: 3, h: 4, visible: true }
  custom.panels['native-chat'] = { col: 4, row: 1, w: 1, h: 4, visible: true }
  custom.panels.auxiliary = { col: 1, row: 1, w: 1, h: 1, visible: false }
  custom.panels.reference = { col: 1, row: 1, w: 1, h: 1, visible: false }
  const migrated = migrateLegacyDockLayout(center, custom)
  assert.equal(migrated.migration.status, 'mapped')
  assert.deepEqual(migrated.dockview.grid.root.data.map(group => group.size), [75, 25])
  assert.deepEqual(migrated.closedPanelIds.sort(), ['files', 'preview'])
  assert.deepEqual(migrated.legacyV1Snapshot, custom)
})

test('overlapping legacy rectangles fall back deterministically without losing the snapshot', () => {
  const overlapping = legacyDefaults(centerLegacy)
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
  const unknownComponent = structuredClone(serializedDockviewFixture)
  unknownComponent.panels['business-main'].contentComponent = 'unregistered-component'
  assert.throws(() => validateDockviewLayout(center, unknownComponent, []), /registered component/)
  const unknownParams = structuredClone(serializedDockviewFixture)
  unknownParams.panels['business-main'].params = { panelId: 'business-main', arbitrary: true }
  assert.throws(() => validateDockviewLayout(center, unknownParams, []), /not allowlisted/)
  const unprojectedDockviewDefaults = structuredClone(serializedDockviewFixture)
  unprojectedDockviewDefaults.panels['business-main'].pinned = false
  assert.throws(() => validateDockviewLayout(center, unprojectedDockviewDefaults, []), /registered component/,
    'the server validator remains strict for Dockview UI metadata that survives JSON serialization')
})

test('normalization initializes dock layouts and legacy scene-layout writes do not replace them', () => {
  const legacy = { center: legacyDefaults(center) }
  const first = normalizeDockLayouts(config, undefined, legacy)
  const saved = structuredClone(first)
  saved.scenes.center.dockview.activeGroup = 'bottomb'
  const normalized = validateDockLayouts(config, saved, { existingDockLayouts: first, legacySceneLayouts: legacy })
  assert.equal(normalized.scenes.center.dockview.activeGroup, 'bottomb')
  const later = normalizeDockLayouts(config, normalized, { center: legacyDefaults(center) })
  assert.deepEqual(later.scenes.center, normalized.scenes.center)
  assert.deepEqual(later.scenes.center.legacyV1Snapshot, legacy.center)

  const corrupted = structuredClone(normalized)
  corrupted.scenes.center.dockview.grid.root.data[0].data[0].data.views.push('unknown-panel')
  const changedLegacy = legacyDefaults(center)
  changedLegacy.panels['business-main'].visible = false
  const recovered = normalizeDockLayouts(config, corrupted, { center: changedLegacy })
  assert.deepEqual(recovered.scenes.center.legacyV1Snapshot, legacy.center)
  assert.equal(recovered.scenes.center.migration.reason, 'stored-layout-invalid')
})
