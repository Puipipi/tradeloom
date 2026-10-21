import { normalizeSceneLayout, validateSceneConfig } from './scene-layout.js'

const MAX_SCENES = 16
const MAX_PANELS = 12
const MAX_GROUPS = 24
const MAX_LAYOUT_NODES = 64
const MAX_DIMENSION = 100000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(`invalid Dockview layout: ${message}`) }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function scenePanels(scene) {
  return new Map(scene.panels.map(panel => [panel.id, panel]))
}

function makeLeaf(id, panels, size) {
  return {
    type: 'leaf',
    data: { views: panels.map(panel => panel.id), activeView: panels[0].id, id },
    size,
  }
}

function panelRecords(panels) {
  return Object.fromEntries(panels.map(panel => [panel.id, {
    id: panel.id,
    contentComponent: panel.type,
    title: panel.title,
    renderer: 'always',
    params: { ...(panel.params === undefined ? {} : clone(panel.params)), panelId: panel.id },
  }]))
}

function buildLayout(businessPanels, chatPanels, split = [60, 40]) {
  const groups = chatPanels.length === 0
    ? [makeLeaf('1', businessPanels, 100)]
    : [makeLeaf('1', businessPanels, split[0]), makeLeaf('2', chatPanels, split[1])]
  return {
    dockview: {
      grid: {
        root: { type: 'branch', data: groups, size: 100 },
        width: 100,
        height: 100,
        orientation: 'HORIZONTAL',
      },
      panels: panelRecords([...businessPanels, ...chatPanels]),
      activeGroup: '1',
    },
  }
}

export function defaultDockLayout(scene) {
  const chatPanels = scene.panels.filter(panel => panel.type === 'native-chat')
  const businessPanels = scene.panels.filter(panel => panel.type !== 'native-chat')
  if (chatPanels.length > 1 || scene.panels.length === 0) fail('scene must have panels and no more than one native chat panel')
  const groups = chatPanels.length > 0 && businessPanels.length > 0
    ? buildLayout(businessPanels, chatPanels, [60, 40])
    : buildLayout(scene.panels, [])
  return {
    ...groups,
    version: 2,
    closedPanelIds: [],
    legacyV1Snapshot: null,
    migration: { status: 'default', reason: 'no-legacy-layout' },
  }
}

function rectangleOverlap(left, right) {
  return left.col < right.col + right.w && left.col + left.w > right.col
    && left.row < right.row + right.h && left.row + left.h > right.row
}

function isDefaultLegacy(scene, layout) {
  const normalized = normalizeSceneLayout(scene, layout)
  return same(normalized, normalizeSceneLayout(scene))
}

function customTwoPanelLayout(scene, normalized) {
  const visible = scene.panels.filter(panel => normalized.panels[panel.id].visible)
  const chat = visible.filter(panel => panel.id === 'native-chat')
  const business = visible.filter(panel => panel.id !== 'native-chat')
  if (chat.length !== 1 || business.length !== 1 || visible.length !== 2) return null
  const businessPanel = business[0]
  const chatPanel = chat[0]
  const a = normalized.panels[businessPanel.id]
  const b = normalized.panels[chatPanel.id]
  const horizontal = a.row === b.row && a.h === b.h
    && (a.col + a.w === b.col || b.col + b.w === a.col)
  const vertical = a.col === b.col && a.w === b.w
    && (a.row + a.h === b.row || b.row + b.h === a.row)
  if (!horizontal && !vertical) return null
  const leadingBusiness = horizontal ? a.col < b.col : a.row < b.row
  const businessSize = horizontal ? a.w : a.h
  const chatSize = horizontal ? b.w : b.h
  const total = businessSize + chatSize
  const businessPercent = Math.round((businessSize / total) * 100)
  const chatPercent = 100 - businessPercent
  const businessPanels = leadingBusiness ? [businessPanel] : [chatPanel]
  const chatPanels = leadingBusiness ? [chatPanel] : [businessPanel]
  const dockview = {
    grid: {
      root: {
        type: 'branch',
        data: [
          makeLeaf('1', businessPanels, leadingBusiness ? businessPercent : chatPercent),
          makeLeaf('2', chatPanels, leadingBusiness ? chatPercent : businessPercent),
        ],
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: horizontal ? 'HORIZONTAL' : 'VERTICAL',
    },
    panels: panelRecords([businessPanel, chatPanel]),
    activeGroup: leadingBusiness ? '1' : '2',
  }
  return { dockview, closedPanelIds: scene.panels.filter(panel => !normalized.panels[panel.id].visible).map(panel => panel.id) }
}

function legacySnapshot(layout) {
  if (layout === undefined || layout === null) return null
  if (!object(layout)) fail('legacy layout must be an object')
  return clone(layout)
}

export function migrateLegacyDockLayout(scene, legacyLayout) {
  const snapshot = legacySnapshot(legacyLayout)
  if (legacyLayout == null) return { ...defaultDockLayout(scene), legacyV1Snapshot: null }
  let normalized
  try { normalized = normalizeSceneLayout(scene, legacyLayout) }
  catch {
    return {
      ...defaultDockLayout(scene),
      legacyV1Snapshot: snapshot,
      migration: { status: 'fallback', reason: 'legacy-invalid' },
    }
  }
  if (isDefaultLegacy(scene, legacyLayout)) {
    return {
      ...defaultDockLayout(scene),
      legacyV1Snapshot: snapshot,
      migration: { status: 'default_upgrade', reason: 'matches-scene-default' },
    }
  }
  const visible = scene.panels.filter(panel => normalized.panels[panel.id].visible)
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (rectangleOverlap(normalized.panels[visible[i].id], normalized.panels[visible[j].id])) {
        return {
          ...defaultDockLayout(scene),
          legacyV1Snapshot: snapshot,
          migration: { status: 'fallback', reason: 'legacy-overlap' },
        }
      }
    }
  }
  if (normalized.expandedPanel !== '') {
    return {
      ...defaultDockLayout(scene),
      legacyV1Snapshot: snapshot,
      migration: { status: 'fallback', reason: 'legacy-expanded-panel' },
    }
  }
  const mapped = customTwoPanelLayout(scene, normalized)
  if (mapped) {
    return {
      ...mapped,
      version: 2,
      legacyV1Snapshot: snapshot,
      migration: { status: 'mapped', reason: 'legacy-business-chat-ratio' },
    }
  }
  return {
    ...defaultDockLayout(scene),
    legacyV1Snapshot: snapshot,
    migration: { status: 'fallback', reason: 'legacy-not-mappable' },
  }
}

function finiteDimension(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_DIMENSION
}

function validateDockNode(node, panelIds, groups, seenViews, budget, isRoot = false) {
  if (--budget.count < 0 || !object(node) || !['branch', 'leaf'].includes(node.type) || !finiteDimension(node.size)) fail('tree node shape or size is invalid')
  if (Object.keys(node).some(key => !['type', 'data', 'size', 'visible'].includes(key))
    || node.visible !== undefined && typeof node.visible !== 'boolean') fail('tree node has unsupported fields')
  if (node.type === 'leaf') {
    const group = node.data
    const groupKeys = object(group) ? Object.keys(group) : []
    if (!object(group) || groupKeys.some(key => !['activeView', 'id', 'views', 'locked', 'hideHeader', 'headerPosition', 'constraints', 'initialWidth', 'initialHeight', 'tabGroups'].includes(key))
      || typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(group.id) || groups.has(group.id)
      || !Array.isArray(group.views) || group.views.length < 1 || group.views.length > MAX_PANELS
      || group.activeView !== undefined && (typeof group.activeView !== 'string' || !group.views.includes(group.activeView))
      || group.locked !== undefined && ![true, false, 'no-drop-target'].includes(group.locked)
      || group.hideHeader !== undefined && typeof group.hideHeader !== 'boolean'
      || group.headerPosition !== undefined && !['top', 'bottom', 'left', 'right'].includes(group.headerPosition)
      || group.initialWidth !== undefined && !finiteDimension(group.initialWidth)
      || group.initialHeight !== undefined && !finiteDimension(group.initialHeight)
      || group.constraints !== undefined && (!object(group.constraints) || Object.keys(group.constraints).some(key => !['minimumWidth', 'minimumHeight', 'maximumWidth', 'maximumHeight'].includes(key)
        || !finiteDimension(group.constraints[key])))) fail('leaf group is invalid')
    groups.add(group.id)
    for (const view of group.views) {
      if (typeof view !== 'string' || !panelIds.has(view) || seenViews.has(view)) fail('tree view references an unknown or repeated panel')
      seenViews.add(view)
    }
    return
  }
  if (!object(node.data) && !Array.isArray(node.data)) fail('branch children are invalid')
  if (!Array.isArray(node.data) || node.data.length > MAX_GROUPS
    || (!isRoot && node.data.length < 2)) fail('branch children are invalid')
  for (const child of node.data) validateDockNode(child, panelIds, groups, seenViews, budget)
}

export function validateDockviewLayout(scene, dockview, closedPanelIds = []) {
  if (!object(dockview) || Object.keys(dockview).some(key => !['activeGroup', 'grid', 'panels'].includes(key))
    || !('grid' in dockview) || !('panels' in dockview)
    || !object(dockview.grid) || Object.keys(dockview.grid).sort().join(',') !== 'height,orientation,root,width'
    || !['HORIZONTAL', 'VERTICAL'].includes(dockview.grid.orientation)
    || !finiteDimension(dockview.grid.width) || !finiteDimension(dockview.grid.height)
    || !object(dockview.panels)) fail('serialized Dockview root is invalid')
  const configured = scenePanels(scene)
  const ids = new Set(configured.keys())
  if (ids.size === 0 || ids.size > MAX_PANELS) fail('scene panel count is invalid')
  const closed = new Set()
  if (!Array.isArray(closedPanelIds) || closedPanelIds.length > MAX_PANELS) fail('closed panel list is invalid')
  for (const id of closedPanelIds) {
    if (typeof id !== 'string' || !ids.has(id) || closed.has(id)) fail('closed panel list contains an unknown or repeated panel')
    closed.add(id)
  }
  const panelKeys = Object.keys(dockview.panels)
  if (panelKeys.length > MAX_PANELS || panelKeys.some(id => !ids.has(id) || closed.has(id))) fail('Dockview contains an unknown or closed panel')
  const groups = new Set()
  const seenViews = new Set()
  validateDockNode(dockview.grid.root, ids, groups, seenViews, { count: MAX_LAYOUT_NODES }, true)
  if (dockview.grid.root.type !== 'branch' || groups.size > MAX_GROUPS
    || groups.size === 0 && dockview.activeGroup !== undefined && dockview.activeGroup !== null
    || groups.size > 0 && dockview.activeGroup !== undefined && dockview.activeGroup !== null && !groups.has(dockview.activeGroup)) fail('active group or root is invalid')
  const expectedOpen = [...ids].filter(id => !closed.has(id)).sort()
  if (JSON.stringify([...seenViews].sort()) !== JSON.stringify(expectedOpen)
    || JSON.stringify(panelKeys.sort()) !== JSON.stringify(expectedOpen)) fail('open views and panel records do not match')
  for (const id of expectedOpen) {
    const record = dockview.panels[id]
    const panel = configured.get(id)
    if (!object(record) || !['id', 'contentComponent', 'title', 'renderer'].every(key => key in record)
      || Object.keys(record).some(key => !['id', 'contentComponent', 'title', 'renderer', 'params'].includes(key))
      || record.id !== id || record.contentComponent !== panel.type || record.title !== panel.title || record.renderer !== 'always') {
      fail(`panel record for ${id} does not match its registered component`)
    }
    if (record.params !== undefined && (!object(record.params) || Object.keys(record.params).some(key => key !== 'panelId')
      || record.params.panelId !== id)) fail(`panel parameters for ${id} are not allowlisted`)
  }
  return true
}

function canonicalMetadata(scene, submitted, previous, legacy) {
  const migrated = previous ?? migrateLegacyDockLayout(scene, legacy)
  return {
    legacyV1Snapshot: clone(migrated.legacyV1Snapshot),
    migration: clone(migrated.migration),
  }
}

export function normalizeDockLayouts(config, existingDockLayouts, legacySceneLayouts = {}) {
  validateSceneConfig(config)
  const existingScenes = object(existingDockLayouts?.scenes) ? existingDockLayouts.scenes : {}
  const scenes = {}
  for (const scene of config.scenes) {
    const saved = existingScenes[scene.id]
    if (saved !== undefined) {
      try {
        const canonical = validateDockLayouts(config, { version: 2, scenes: { [scene.id]: saved } }, { existingDockLayouts: { version: 2, scenes: { [scene.id]: saved } }, legacySceneLayouts })
        scenes[scene.id] = canonical.scenes[scene.id]
        continue
      } catch {
        const retainedSnapshot = object(saved?.legacyV1Snapshot) ? saved.legacyV1Snapshot : legacySceneLayouts?.[scene.id]
        const fallback = migrateLegacyDockLayout(scene, retainedSnapshot)
        scenes[scene.id] = {
          ...fallback,
          migration: { status: 'fallback', reason: 'stored-layout-invalid' },
        }
        continue
      }
    }
    scenes[scene.id] = migrateLegacyDockLayout(scene, legacySceneLayouts?.[scene.id])
  }
  return { version: 2, scenes }
}

export function validateDockLayouts(config, value, options = {}) {
  validateSceneConfig(config)
  if (!object(value) || value.version !== 2 || !object(value.scenes)
    || Object.keys(value).some(key => !['version', 'scenes'].includes(key))
    || Object.keys(value.scenes).length > MAX_SCENES
    || Object.keys(value.scenes).some(id => !config.scenes.some(scene => scene.id === id))) fail('dock layout collection is invalid')
  const existingScenes = object(options.existingDockLayouts?.scenes) ? options.existingDockLayouts.scenes : {}
  const legacy = options.legacySceneLayouts ?? {}
  const scenes = {}
  for (const scene of config.scenes) {
    const submitted = value.scenes[scene.id]
    const previous = existingScenes[scene.id]
    if (submitted === undefined && previous !== undefined) {
      scenes[scene.id] = previous
      continue
    }
    if (submitted === undefined) {
      scenes[scene.id] = migrateLegacyDockLayout(scene, legacy?.[scene.id])
      continue
    }
    if (!object(submitted) || submitted.version !== 2
      || Object.keys(submitted).some(key => !['version', 'dockview', 'closedPanelIds', 'legacyV1Snapshot', 'migration'].includes(key))) fail(`scene record for ${scene.id} is invalid`)
    validateDockviewLayout(scene, submitted.dockview, submitted.closedPanelIds)
    const metadata = canonicalMetadata(scene, submitted, previous, legacy?.[scene.id])
    scenes[scene.id] = {
      version: 2,
      dockview: clone(submitted.dockview),
      closedPanelIds: [...submitted.closedPanelIds],
      ...metadata,
    }
  }
  return { version: 2, scenes }
}
