import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import {
  defaultDockLayout,
  migrateLegacyDockLayout,
  normalizeDockLayouts,
  validateDockviewLayout,
  validateDockLayouts,
} from '../dock-layout.js'
import { resolveSceneConfiguration, validateSceneConfig } from '../scene-layout.js'

const config = JSON.parse(await readFile(new URL('../scenes.json', import.meta.url), 'utf8'))
const center = config.scenes.find(scene => scene.id === 'center')
const optionalClosedPanelIds = center.panels.filter(panel => panel.optional === true).map(panel => panel.id)

test('business entry order preserves scene identities and exposes the new order route', async () => {
  assert.strictEqual(validateSceneConfig(config), config)
  assert.deepEqual(config.scenes.map(scene => scene.id), [
    'center', 'user-profile', 'products', 'order-production', 'deliverables', 'agent-center', 'runs', 'erpnext',
  ])
  assert.deepEqual(config.businessRoutes['/orders'], { sceneId: 'order-production', panelId: 'business-main' })
  assert.equal(config.scenes.find(scene => scene.id === 'order-production').roleId, 'order-production',
    'the order scene uses its dedicated role')

  let registration
  const source = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  const exports = registration.factory(() => ({ createElement() {} }))
  assert.deepEqual(JSON.parse(JSON.stringify(exports.sceneNavigationItems(config).map(({ id, label }) => [id, label]))).slice(0, 7), [
    ['center', '总览'], ['user-profile', '资料与核对'], ['products', '商品'], ['order-production', '订单与生产'],
    ['deliverables', '交付'], ['agent-center', '工作流'], ['runs', '运行记录'],
  ])
})

test('legacy saved scene documents gain only the missing order route and default scene', () => {
  const legacy = structuredClone(config)
  legacy.scenes = legacy.scenes.filter(scene => scene.id !== 'order-production')
  delete legacy.businessRoutes['/orders']
  const product = legacy.scenes.find(scene => scene.id === 'products')
  product.label = '已保存的商品入口'
  product.panels.find(panel => panel.id === 'business-main').col = 2
  const resolved = resolveSceneConfiguration(config, { sceneConfiguration: { value: legacy } })
  assert.equal(resolved.scenes.find(scene => scene.id === 'products').label, '已保存的商品入口')
  assert.equal(resolved.scenes.find(scene => scene.id === 'products').panels.find(panel => panel.id === 'business-main').col, 2)
  assert.equal(resolved.scenes.findIndex(scene => scene.id === 'order-production'),
    resolved.scenes.findIndex(scene => scene.id === 'products') + 1)
  assert.deepEqual(resolved.businessRoutes['/orders'], config.businessRoutes['/orders'])
  assert.deepEqual(resolved.scenes.find(scene => scene.id === 'order-production'), config.scenes.find(scene => scene.id === 'order-production'))
  assert.deepEqual(Object.keys(resolved.businessRoutes).sort(), ['/agent-center', '/artifacts', '/home', '/orders', '/products', '/runs'])

  const partial = structuredClone(legacy)
  const orderScene = structuredClone(config.scenes.find(scene => scene.id === 'order-production'))
  delete orderScene.roleId
  partial.scenes.push(orderScene)
  const repaired = resolveSceneConfiguration(config, { sceneConfiguration: { value: partial } })
  assert.equal(repaired.scenes.find(scene => scene.id === 'order-production').roleId,
    config.scenes.find(scene => scene.id === 'order-production').roleId)
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

test('adding and removing an instance preserves other Dockview groups and the saved preset', () => {
  const custom = { ...structuredClone(center), id: 'custom-composition', templateSceneId: 'center' }
  delete custom.defaultBusinessRoute
  custom.panels.find(panel => panel.id === 'native-chat').w = 2
  const withScene = scene => ({ ...config, scenes: [...config.scenes, scene] })
  const prior = defaultDockLayout(custom)
  prior.dockview.grid.root.data[0].size = 63
  prior.dockview.grid.root.data[1].size = 37
  prior.preset = { dockview: structuredClone(prior.dockview), closedPanelIds: [...prior.closedPanelIds] }
  const initial = { version: 2, scenes: { [custom.id]: prior } }
  const instance = { id: 'component-product-catalog', type: 'business-iframe', title: '商品', path: '/products',
    col: 4, row: 4, w: 1, h: 1, category: 'business', componentId: 'product-catalog' }
  const updated = { ...custom, panels: [...custom.panels, instance] }
  const added = normalizeDockLayouts(withScene(updated), initial).scenes[custom.id]
  assert.equal(added.dockview.panels[instance.id]?.id, instance.id)
  assert.deepEqual(added.dockview.grid.root.data.map(group => group.size), [63, 37])
  assert.equal(added.preset.closedPanelIds.includes(instance.id), true)
  assert.doesNotThrow(() => validateDockLayouts(withScene(updated), { version: 2, scenes: { [custom.id]: added } }))
  const removed = normalizeDockLayouts(withScene(custom), { version: 2, scenes: { [custom.id]: added } }).scenes[custom.id]
  assert.deepEqual(removed.dockview, prior.dockview)
  assert.deepEqual(removed.preset, prior.preset)
})

test('stored stale restore anchors are dropped without changing valid Dockview geometry or closed panels', () => {
  const dockview = structuredClone(serializedDockviewFixture)
  dockview.grid.root.data[0].data = { id: '1', views: ['business-main'], activeView: 'business-main' }
  delete dockview.panels.files
  delete dockview.panels.preview
  const closedPanelIds = [...optionalClosedPanelIds, 'files', 'preview']
  const closedPanelPositions = {
    files: { direction: 'within', index: 1, neighbors: ['business-main'] },
    preview: { direction: 'left', neighbors: ['auxiliary'] },
  }
  const body = { version: 2, scenes: { center: { version: 2, dockview, closedPanelIds, closedPanelPositions } } }
  assert.throws(() => validateDockLayouts(config, body), /closed panel positions are invalid/)
  const normalized = normalizeDockLayouts(config, body).scenes.center
  assert.deepEqual(normalized.dockview, dockview)
  assert.deepEqual(normalized.closedPanelIds, closedPanelIds)
  assert.deepEqual(normalized.closedPanelPositions, { files: closedPanelPositions.files })
})

test('Host validates a scene preset independently from its current layout and other scenes', () => {
  const layout = defaultDockLayout(center)
  const preset = { dockview: structuredClone(serializedDockviewFixture), closedPanelIds: optionalClosedPanelIds }
  const scenes = { center: { ...layout, preset } }
  const saved = validateDockLayouts(config, { version: 2, scenes })
  assert.deepEqual(normalizeDockLayouts(config, saved).scenes.center.preset, preset)
  assert.deepEqual(saved.scenes.center.dockview, layout.dockview)
  assert.equal(saved.scenes.products.preset, undefined)
  const damaged = structuredClone(saved)
  damaged.scenes.center.preset.closedPanelIds.push('unknown')
  assert.throws(() => validateDockLayouts(config, damaged), /invalid Dockview layout/)
  const recovered = normalizeDockLayouts(config, damaged)
  assert.equal(recovered.scenes.center.preset, undefined)
  assert.deepEqual(recovered.scenes.center.dockview, layout.dockview)
})

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
  assert.deepEqual(result.dockview.grid.root.data.map(group => group.size), [100], 'overview gives business panels the full default canvas')
  assert.equal(result.dockview.activeGroup, '1', 'overview opens on the main business panels')
  assert.deepEqual(result.dockview.grid.root.data[0].data.views, ['business-main', 'files', 'preview'])
  assert.ok(result.closedPanelIds.includes('native-chat'), 'the overview assistant starts collapsed and remains reopenable')
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
      if (scene.id === 'center') {
        assert.deepEqual(recommendation.dockview.grid.root.data.map(group => group.size), [100])
        assert.deepEqual(recommendation.dockview.grid.root.data[0].data.views, ['business-main', 'files', 'preview'])
        assert.ok(recommendation.closedPanelIds.includes('native-chat'))
        continue
      }
      assert.equal(recommendation.dockview.grid.orientation, 'VERTICAL', scene.id)
      const [top, bottom] = recommendation.dockview.grid.root.data
      assert.equal(top.type, 'branch')
      assert.equal(bottom.type, 'branch')
      const describeGroups = row => row.data.map(group => [group.size, group.data.views, group.data.activeView])
      if (scene.id === 'agent-center') {
        assert.deepEqual([top.size, bottom.size], [65, 35])
        assert.deepEqual(describeGroups(top), [[75, ['business-main'], 'business-main'], [25, ['files'], 'files']])
        assert.deepEqual(describeGroups(bottom), [[50, ['preview'], 'preview'], [50, ['native-chat'], 'native-chat']])
        assert.ok(recommendation.closedPanelIds.includes('business-plan'))
        const legacy = migrateLegacyDockLayout(scene, legacyDefaults(scene))
        assert.ok(legacy.dockview.panels['business-plan'], 'a saved legacy five-panel layout retains its open plan')
        const implicitOpen = legacyDefaults(scene)
        delete implicitOpen.panels['business-plan'].visible
        assert.ok(migrateLegacyDockLayout(scene, implicitOpen).dockview.panels['business-plan'], 'stored coordinates without visibility were open in v1')
        implicitOpen.panels['business-plan'].visible = false
        assert.ok(migrateLegacyDockLayout(scene, implicitOpen).closedPanelIds.includes('business-plan'))
        const custom = structuredClone(legacy)
        custom.dockview.grid.root.data[0].size = 45
        custom.dockview.grid.root.data[1].size = 55
        const existing = { version: 2, scenes: { 'agent-center': custom } }
        assert.deepEqual(normalizeDockLayouts(config, existing).scenes['agent-center'], custom)
      } else if (scene.id === 'deliverables') {
        assert.deepEqual([top.size, bottom.size], [50, 50])
        assert.deepEqual(describeGroups(top), [[75, ['business-main'], 'business-main'], [25, ['files'], 'files']])
        assert.deepEqual(describeGroups(bottom), [[60, ['preview'], 'preview'], [40, ['native-chat'], 'native-chat']])
      } else {
        assert.deepEqual([top.size, bottom.size], [65, 35])
        assert.deepEqual(describeGroups(top), [[75, ['business-main'], 'business-main'], [25, ['files'], 'files']])
        assert.deepEqual(describeGroups(bottom), [[25, ['preview'], 'preview'], [75, ['native-chat'], 'native-chat']])
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
  assert.deepEqual(migrated.dockview.grid.root.data[0].data.views, ['business-main', 'files', 'preview'],
    'legacy auxiliary/reference IDs migrate to files/preview, the assistant starts collapsed, and the original snapshot remains unchanged')

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
  const products = config.scenes.find(scene => scene.id === 'products')
  const legacy = { products: legacyDefaults(products) }
  const first = normalizeDockLayouts(config, undefined, legacy)
  const saved = structuredClone(first)
  saved.scenes.products.dockview.activeGroup = 'topb'
  const normalized = validateDockLayouts(config, saved, { existingDockLayouts: first, legacySceneLayouts: legacy })
  assert.equal(normalized.scenes.products.dockview.activeGroup, 'topb')
  const later = normalizeDockLayouts(config, normalized, { products: legacyDefaults(products) })
  assert.deepEqual(later.scenes.products, normalized.scenes.products)
  assert.deepEqual(later.scenes.products.legacyV1Snapshot, legacy.products)

  const corrupted = structuredClone(normalized)
  corrupted.scenes.products.dockview.grid.root.data[0].data[0].data.views.push('unknown-panel')
  const changedLegacy = legacyDefaults(products)
  changedLegacy.panels['business-main'].visible = false
  const recovered = normalizeDockLayouts(config, corrupted, { products: changedLegacy })
  assert.deepEqual(recovered.scenes.products.legacyV1Snapshot, legacy.products)
  assert.equal(recovered.scenes.products.migration.reason, 'stored-layout-invalid')
})
