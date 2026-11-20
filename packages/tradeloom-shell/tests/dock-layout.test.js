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
const optionalClosedPanelIds = center.panels.filter(panel => panel.optional === true).map(panel => panel.id)
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
  assert.equal(validateDockviewLayout(center, serializedDockviewFixture, optionalClosedPanelIds), true)
  const oneGroup = structuredClone(serializedDockviewFixture)
  oneGroup.grid.root.data = [{ type: 'leaf', data: { views: ['business-main', 'files', 'preview', 'native-chat'], activeView: 'preview', id: '1' }, size: 100 }]
  oneGroup.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, oneGroup, optionalClosedPanelIds), true)
  const onePanel = structuredClone(serializedDockviewFixture)
  onePanel.grid.root.data = [{ type: 'leaf', data: { views: ['business-main'], activeView: 'business-main', id: '1' }, size: 100 }]
  onePanel.panels = { 'business-main': onePanel.panels['business-main'] }
  onePanel.activeGroup = '1'
  assert.equal(validateDockviewLayout(center, onePanel, [...optionalClosedPanelIds, 'files', 'preview', 'native-chat']), true)
  const noPanels = structuredClone(serializedDockviewFixture)
  noPanels.grid.root.data = []
  noPanels.panels = {}
  delete noPanels.activeGroup
  assert.equal(validateDockviewLayout(center, noPanels, center.panels.map(panel => panel.id)), true)

  const result = defaultDockLayout(center)
  assert.equal(validateDockviewLayout(center, result.dockview, result.closedPanelIds), true)
  assert.deepEqual(result.dockview.grid.root.data.map(group => group.size), [60, 40], 'center keeps the configured 60/40 collaboration rows')
  assert.equal(result.dockview.activeGroup, 'topa', 'collaboration center opens on the main business panel')
  assert.deepEqual(result.dockview.grid.root.data[0].data.map(group => group.data.views), [['business-main'], ['files']])
  assert.deepEqual(result.dockview.grid.root.data[1].data.map(group => group.data.views), [['preview'], ['native-chat']])
  assert.ok(Object.values(result.dockview.panels).every(panel => panel.renderer === 'always'))
  assert.deepEqual(Object.entries(result.dockview.panels).map(([panelId, panel]) => [panelId, panel.params]),
    Object.keys(result.dockview.panels).map(panelId => [panelId, { panelId }]))

  const withoutChat = { ...center, panels: center.panels.filter(panel => panel.type !== 'native-chat') }
  const oneGroupDefault = defaultDockLayout(withoutChat)
  assert.equal(validateDockviewLayout(withoutChat, oneGroupDefault.dockview, oneGroupDefault.closedPanelIds), true,
    'a no-chat default cannot open optional panels that are also marked closed')
  assert.equal(oneGroupDefault.dockview.grid.root.data.length, 1)
  assert.deepEqual(oneGroupDefault.dockview.grid.root.data[0].data.views, ['business-main', 'files', 'preview'])
})

test('each configured scene gets its mapped recommendation while four-panel scenes preserve the screenshot grid', () => {
  let collaborationCustom
  for (const scene of config.scenes) {
    const recommendation = defaultDockLayout(scene)
    assert.equal(validateDockviewLayout(scene, recommendation.dockview, recommendation.closedPanelIds), true, scene.id)
    if (scene.layoutProfile.kind === 'collaboration_grid') {
      assert.equal(recommendation.dockview.grid.orientation, 'VERTICAL', scene.id)
      const [top, bottom] = recommendation.dockview.grid.root.data
      assert.equal(top.type, 'branch')
      assert.equal(bottom.type, 'branch')
      const describeGroups = row => row.data.map(group => [group.size, group.data.views, group.data.activeView])
      if (scene.id === 'agent-center') {
        assert.deepEqual([top.size, bottom.size], [50, 50])
        assert.deepEqual(describeGroups(top), [
          [25, ['business-plan'], 'business-plan'], [50, ['business-main'], 'business-main'], [25, ['files'], 'files'],
        ])
        assert.deepEqual(describeGroups(bottom), [
          [25, ['preview'], 'preview'], [75, ['native-chat'], 'native-chat'],
        ])
        const custom = structuredClone(recommendation)
        custom.dockview.grid.root.data[0].size = 45
        custom.dockview.grid.root.data[1].size = 55
        const existing = { version: 2, scenes: { 'agent-center': custom } }
        assert.deepEqual(normalizeDockLayouts(config, existing).scenes['agent-center'], custom)
      } else {
        assert.deepEqual([top.size, bottom.size], [60, 40])
        assert.deepEqual(describeGroups(top), [[75, ['business-main'], 'business-main'], [25, ['files'], 'files']])
        assert.deepEqual(describeGroups(bottom), [[40, ['preview'], 'preview'], [60, ['native-chat'], 'native-chat']])
      }
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
  assert.deepEqual(normalizedCustom.scenes.products, collaborationCustom,
    'a saved custom four-panel layout remains unchanged when recommendation profiles are introduced')
  const customWithClosedPanel = structuredClone(collaborationCustom)
  customWithClosedPanel.closedPanelIds = [...customWithClosedPanel.closedPanelIds, 'files']
  const [topRow, bottomRow] = customWithClosedPanel.dockview.grid.root.data
  customWithClosedPanel.dockview.grid.root.data = [
    { type: 'leaf', size: topRow.size, data: { ...topRow.data[0].data, id: topRow.data[0].data.id } },
    bottomRow,
  ]
  delete customWithClosedPanel.dockview.panels.files
  const restoredCustom = normalizeDockLayouts(config, { version: 2, scenes: { products: customWithClosedPanel } })
  assert.deepEqual(restoredCustom.scenes.products, customWithClosedPanel,
    'custom proportions and closed-panel state survive recommendation changes')
})

test('unchanged v1 geometry upgrades to the wider dock default and keeps its first snapshot', () => {
  const current = legacyDefaults(center)
  const snapshot = {
    ...current,
    panels: Object.fromEntries(Object.entries(current.panels).map(([id, panel]) => [
      id === 'files' ? 'auxiliary' : id === 'preview' ? 'reference' : id, panel,
    ])),
  }
  const migrated = migrateLegacyDockLayout(center, snapshot)
  assert.equal(migrated.migration.status, 'default_upgrade')
  assert.equal(migrated.migration.reason, 'matches-scene-default')
  assert.deepEqual(migrated.legacyV1Snapshot, snapshot)
  assert.deepEqual(migrated.dockview.grid.root.data[0].data.map(group => group.data.views), [['business-main'], ['files']],
    'legacy auxiliary/reference IDs migrate to files/preview while the original snapshot remains unchanged')

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
  custom.panels.files = { col: 1, row: 1, w: 1, h: 1, visible: false }
  custom.panels.preview = { col: 1, row: 1, w: 1, h: 1, visible: false }
  for (const panel of center.panels.filter(panel => panel.optional === true)) custom.panels[panel.id].visible = false
  const migrated = migrateLegacyDockLayout(center, custom)
  assert.equal(migrated.migration.status, 'mapped')
  assert.deepEqual(migrated.dockview.grid.root.data.map(group => group.size), [75, 25])
  assert.deepEqual(migrated.closedPanelIds.sort(), [...optionalClosedPanelIds, 'files', 'preview'].sort())
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
  const unknownComponent = structuredClone(serializedDockviewFixture)
  unknownComponent.panels['business-main'].contentComponent = 'unregistered-component'
  assert.throws(() => validateDockviewLayout(center, unknownComponent, optionalClosedPanelIds), /registered component/)
  const unknownParams = structuredClone(serializedDockviewFixture)
  unknownParams.panels['business-main'].params = { panelId: 'business-main', arbitrary: true }
  assert.throws(() => validateDockviewLayout(center, unknownParams, optionalClosedPanelIds), /not allowlisted/)
  const unprojectedDockviewDefaults = structuredClone(serializedDockviewFixture)
  unprojectedDockviewDefaults.panels['business-main'].pinned = false
  assert.throws(() => validateDockviewLayout(center, unprojectedDockviewDefaults, optionalClosedPanelIds), /registered component/,
    'the server validator remains strict for Dockview UI metadata that survives JSON serialization')
})

test('normalization initializes dock layouts and legacy scene-layout writes do not replace them', () => {
  const legacy = { center: legacyDefaults(center) }
  const first = normalizeDockLayouts(config, undefined, legacy)
  const saved = structuredClone(first)
  saved.scenes.center.dockview.activeGroup = 'topb'
  const normalized = validateDockLayouts(config, saved, { existingDockLayouts: first, legacySceneLayouts: legacy })
  assert.equal(normalized.scenes.center.dockview.activeGroup, 'topb')
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
