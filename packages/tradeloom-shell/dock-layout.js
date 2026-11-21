import { isComponentInstanceId, normalizeSceneLayout, validateSceneConfig } from './scene-layout.js'

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

function isWorkflowScene(scene) { return (scene.templateSceneId ?? scene.id) === 'agent-center' }

function buildLayout(businessPanels, chatPanels, split = [72, 28], activeGroup = '1') {
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
      activeGroup,
    },
  }
}

function buildRecommendation(scene, businessPanels, chatPanels) {
  const kind = scene.layoutProfile?.kind
  if (kind === 'assistant_lead') return buildLayout(businessPanels, chatPanels, [32, 68], '2')
  if (kind === 'collaboration_grid') {
    const panels = new Map([...businessPanels, ...chatPanels].map(panel => [panel.id, panel]))
    const hasPlan = panels.has('business-plan')
    if (panels.size === (hasPlan ? 5 : 4)
      && ['business-main', 'files', 'preview', 'native-chat'].every(id => panels.has(id))) {
      const leaf = (groupId, panelId, size) => makeLeaf(groupId, [panels.get(panelId)], size)
      const row = (size, ...data) => ({ type: 'branch', size, data })
      return {
        dockview: {
          grid: {
            root: { type: 'branch', size: 100, data: [
              row(hasPlan ? 50 : scene.id === 'deliverables' ? 50 : 65,
                ...(hasPlan ? [leaf('top-plan', 'business-plan', 20)] : []),
                leaf('topa', 'business-main', hasPlan ? 60 : 75), leaf('topb', 'files', hasPlan ? 20 : 25)),
              row(hasPlan ? 50 : scene.id === 'deliverables' ? 50 : 35,
                leaf('bottoma', 'preview', hasPlan ? 20 : scene.id === 'deliverables' ? 60 : isWorkflowScene(scene) ? 50 : 25),
                leaf('bottomb', 'native-chat', hasPlan ? 80 : scene.id === 'deliverables' ? 40 : isWorkflowScene(scene) ? 50 : 75)),
            ] },
            width: 100, height: 100, orientation: 'VERTICAL',
          },
          panels: panelRecords(scene.panels.filter(panel => panels.has(panel.id))),
          activeGroup: 'topa',
        },
      }
    }
  }
  return buildLayout(businessPanels, chatPanels, [72, 28])
}

function recommendedDockLayout(scene, includePlan) {
  const activePanels = scene.panels.filter(panel => panel.optional !== true
    && !(scene.id === 'center' && panel.id === 'native-chat')
    && (panel.id !== 'business-plan' || includePlan || !isWorkflowScene(scene)))
  const chatPanels = activePanels.filter(panel => panel.type === 'native-chat')
  const businessPanels = activePanels.filter(panel => panel.type !== 'native-chat')
  if (activePanels.length === 0) fail('scene must have panels')
  const groups = chatPanels.length > 0 && businessPanels.length > 0
    ? buildRecommendation(scene, businessPanels, chatPanels)
    : buildLayout(activePanels, [])
  return {
    ...groups,
    version: 2,
    closedPanelIds: scene.panels.filter(panel => !activePanels.includes(panel)).map(panel => panel.id),
    legacyV1Snapshot: null,
    migration: { status: 'default', reason: 'no-legacy-layout' },
  }
}

export function defaultDockLayout(scene) { return recommendedDockLayout(scene, false) }

function rectangleOverlap(left, right) {
  return left.col < right.col + right.w && left.col + left.w > right.col
    && left.row < right.row + right.h && left.row + left.h > right.row
}

function isDefaultLegacy(scene, layout) {
  const normalized = normalizeSceneLayout(scene, layout)
  const configured = normalized.panels['business-plan']?.visible === true && isWorkflowScene(scene)
    ? { panels: { 'business-plan': { visible: true } } } : undefined
  return same(normalized, normalizeSceneLayout(scene, configured))
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
  const aliases = scenePanels(scene).has('files') && scenePanels(scene).has('preview')
    ? { auxiliary: 'files', reference: 'preview' } : {}
  const compatibleLegacy = object(legacyLayout?.panels) ? {
    ...legacyLayout,
    expandedPanel: aliases[legacyLayout.expandedPanel] ?? legacyLayout.expandedPanel,
    panels: Object.fromEntries(Object.entries(legacyLayout.panels).map(([id, panel]) => [aliases[id] ?? id, panel])),
  } : legacyLayout
  try { normalized = normalizeSceneLayout(scene, compatibleLegacy) }
  catch {
    return {
      ...defaultDockLayout(scene),
      legacyV1Snapshot: snapshot,
      migration: { status: 'fallback', reason: 'legacy-invalid' },
    }
  }
  const recommendation = recommendedDockLayout(scene, normalized.panels['business-plan']?.visible === true)
  if (isDefaultLegacy(scene, compatibleLegacy)) {
    return {
      ...recommendation,
      legacyV1Snapshot: snapshot,
      migration: { status: 'default_upgrade', reason: 'matches-scene-default' },
    }
  }
  const visible = scene.panels.filter(panel => normalized.panels[panel.id].visible)
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (rectangleOverlap(normalized.panels[visible[i].id], normalized.panels[visible[j].id])) {
        return {
          ...recommendation,
          legacyV1Snapshot: snapshot,
          migration: { status: 'fallback', reason: 'legacy-overlap' },
        }
      }
    }
  }
  if (normalized.expandedPanel !== '') {
    return {
      ...recommendation,
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
    ...recommendation,
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
  if (!object(dockview) || Object.keys(dockview).some(key => !['activeGroup', 'grid', 'panels', 'floatingGroups'].includes(key))
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
  const floatingGroups = dockview.floatingGroups ?? []
  if (!Array.isArray(floatingGroups) || floatingGroups.length > 1) fail('floating group list is invalid')
  for (const floating of floatingGroups) {
    const floatingPanelId = floating?.data?.views?.length === 1 ? floating.data.views[0] : ''
    const floatingPanel = configured.get(floatingPanelId)
    if (!object(floating) || Object.keys(floating).sort().join(',') !== 'data,position'
      || !object(floating.data) || floating.data.views?.length !== 1
      || !floatingPanel || !['native-chat', 'native-workspace', 'business-iframe'].includes(floatingPanel.type)
      || typeof floating.data.id !== 'string' || !object(floating.position)) fail('only a business panel, native chat or native workspace may be floated')
    const position = floating.position
    const positionKeys = Object.keys(position)
    if (positionKeys.some(key => !['top', 'bottom', 'left', 'right', 'width', 'height'].includes(key))
      || !['top', 'bottom'].some(key => Number.isFinite(position[key]))
      || !['left', 'right'].some(key => Number.isFinite(position[key]))
      || !Number.isFinite(position.width) || position.width < 1 || position.width > MAX_DIMENSION
      || !Number.isFinite(position.height) || position.height < 1 || position.height > MAX_DIMENSION
      || ['top', 'bottom', 'left', 'right'].some(key => position[key] !== undefined && Math.abs(position[key]) > MAX_DIMENSION)) fail('floating group bounds are invalid')
    validateDockNode({ type: 'leaf', size: 100, data: floating.data }, ids, groups, seenViews, { count: MAX_LAYOUT_NODES })
  }
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

function validClosedPanelPosition(ids, closedPanelIds, id, position) {
  return closedPanelIds.includes(id) && object(position)
    && ['within', 'left', 'right', 'above', 'below'].includes(position.direction)
    && Object.keys(position).sort().join(',') === (position.direction === 'within' ? 'direction,index,neighbors' : 'direction,neighbors')
    && (position.direction !== 'within' || Number.isInteger(position.index) && position.index >= 0 && position.index < MAX_PANELS)
    && Array.isArray(position.neighbors) && position.neighbors.length > 0 && position.neighbors.length < MAX_PANELS
    && new Set(position.neighbors).size === position.neighbors.length
    && position.neighbors.every(neighbor => neighbor !== id && ids.has(neighbor))
}

function validateClosedPanelPositions(scene, positions, closedPanelIds) {
  if (positions === undefined) return
  const ids = scenePanels(scene)
  if (!object(positions) || Object.keys(positions).length > MAX_PANELS
    || Object.entries(positions).some(([id, position]) => !validClosedPanelPosition(ids, closedPanelIds, id, position))) {
    fail('closed panel positions are invalid')
  }
}

function cleanSavedClosedPanelPositions(scene, saved) {
  if (!object(saved) || saved.closedPanelPositions === undefined) return saved
  const { closedPanelPositions, ...record } = saved
  if (!object(closedPanelPositions) || !Array.isArray(saved.closedPanelIds)) return record
  const ids = scenePanels(scene)
  const positions = Object.entries(closedPanelPositions)
    .filter(([id, position]) => validClosedPanelPosition(ids, saved.closedPanelIds, id, position))
  return positions.length ? { ...record, closedPanelPositions: Object.fromEntries(positions) } : record
}

function validateDockPreset(scene, preset) {
  if (!object(preset) || Object.keys(preset).some(key => !['dockview', 'closedPanelIds', 'closedPanelPositions'].includes(key))
    || !Array.isArray(preset.closedPanelIds) || preset.dockview?.floatingGroups?.length) fail('saved scene preset is invalid')
  validateDockviewLayout(scene, preset.dockview, preset.closedPanelIds)
  validateClosedPanelPositions(scene, preset.closedPanelPositions, preset.closedPanelIds)
}

function cleanSavedDockRecord(scene, saved) {
  saved = reconcileComponentDockRecord(scene, saved)
  const record = cleanSavedClosedPanelPositions(scene, saved)
  if (!object(record) || record.preset === undefined) return record
  const { preset, ...layout } = record
  const normalized = cleanSavedClosedPanelPositions(scene, preset)
  try { validateDockPreset(scene, normalized) } catch { return layout }
  return { ...layout, preset: normalized }
}

function reconcileComponentDockRecord(scene, saved) {
  if (!scene.templateSceneId || !object(saved?.dockview?.panels) || !Array.isArray(saved?.closedPanelIds)) return saved
  const configured = scenePanels(scene)
  const isRemoved = id => isComponentInstanceId(id) && !configured.has(id)
  const reconcile = (value, openNew) => {
    if (!object(value?.dockview?.panels) || !Array.isArray(value?.closedPanelIds)) return value
    const visible = Object.keys(value.dockview.panels)
    const missing = [...configured.keys()].filter(id => isComponentInstanceId(id) && !visible.includes(id) && !value.closedPanelIds.includes(id))
    if (!missing.length && ![...visible, ...value.closedPanelIds].some(isRemoved)) return value
    const record = clone(value), dock = record.dockview
    const leafGroups = []
    const prune = (node, root = false) => {
      if (node.type === 'leaf') {
        const group = node.data
        group.views = group.views.filter(id => !isRemoved(id))
        if (!group.views.length) return null
        if (!group.views.includes(group.activeView)) group.activeView = group.views[0]
        leafGroups.push(group)
        return node
      }
      node.data = node.data.map(child => prune(child)).filter(Boolean)
      if (root) return node
      if (node.data.length === 1) return { ...node.data[0], size: node.size }
      return node.data.length ? node : null
    }
    dock.grid.root = prune(dock.grid.root, true)
    if (dock.floatingGroups) {
      dock.floatingGroups = dock.floatingGroups.filter(group => !group.data.views.some(isRemoved))
      if (!dock.floatingGroups.length) delete dock.floatingGroups
    }
    for (const id of Object.keys(dock.panels).filter(isRemoved)) delete dock.panels[id]
    record.closedPanelIds = record.closedPanelIds.filter(id => !isRemoved(id))
    if (missing.length && openNew) {
      const panels = missing.map(id => configured.get(id))
      const target = leafGroups.find(group => !group.locked && group.views.some(id => configured.get(id)?.type === 'business-iframe'))
      if (target) target.views.push(...missing)
      else {
        let groupId = 'component-dock'
        for (let suffix = 1; leafGroups.some(group => group.id === groupId); suffix++) groupId = `component-dock-${suffix}`
        const node = makeLeaf(groupId, panels, 100)
        dock.grid.root.data.push(node)
        leafGroups.push(node.data)
      }
      Object.assign(dock.panels, panelRecords(panels))
    } else record.closedPanelIds.push(...missing)
    if (dock.activeGroup && ![...leafGroups, ...(dock.floatingGroups ?? []).map(group => group.data)].some(group => group.id === dock.activeGroup)) {
      if (leafGroups.length) dock.activeGroup = leafGroups[0].id
      else delete dock.activeGroup
    }
    if (record.closedPanelPositions) {
      for (const [id, position] of Object.entries(record.closedPanelPositions)) {
        if (isRemoved(id)) delete record.closedPanelPositions[id]
        else if (Array.isArray(position?.neighbors)) position.neighbors = position.neighbors.filter(neighbor => !isRemoved(neighbor))
      }
    }
    return cleanSavedClosedPanelPositions(scene, record)
  }
  try {
    const current = reconcile(saved, true)
    const preset = reconcile(current.preset, false)
    const floatingRestore = reconcile(current.floatingRestore, true)
    return { ...current, ...(preset ? { preset } : {}), ...(floatingRestore ? { floatingRestore } : {}) }
  } catch { return saved }
}

// The Host owns migration metadata; it is recovered from storage or recomputed from v1.
function canonicalMigrationMetadata(scene, previous, legacy) {
  const migrated = previous ?? migrateLegacyDockLayout(scene, legacy)
  return {
    legacyV1Snapshot: clone(migrated.legacyV1Snapshot),
    migration: clone(migrated.migration),
  }
}

function renameLegacyBusinessPanes(scene, value) {
  const aliases = scenePanels(scene).has('files') && scenePanels(scene).has('preview')
    ? { auxiliary: 'files', reference: 'preview' } : {}
  if (!Object.keys(aliases).some(id => value?.dockview?.panels?.[id] || value?.closedPanelIds?.includes?.(id))) return clone(value)
  const renameDockview = dockview => {
    if (!object(dockview) || !object(dockview.panels)) return null
    const copy = clone(dockview)
    if (Object.keys(copy.panels).some(id => aliases[id] && copy.panels[aliases[id]])) return null
    const renameGroupViews = group => {
      group.views = group.views.map(id => aliases[id] ?? id)
      if (aliases[group.activeView]) group.activeView = aliases[group.activeView]
    }
    const renameNode = node => {
      if (!object(node)) return
      if (node.type === 'leaf' && object(node.data)) renameGroupViews(node.data)
      else if (node.type === 'branch' && Array.isArray(node.data)) node.data.forEach(renameNode)
    }
    renameNode(copy.grid?.root)
    for (const group of copy.floatingGroups ?? []) {
      if (object(group?.data)) renameGroupViews(group.data)
    }
    for (const [oldId, newId] of Object.entries(aliases)) {
      if (!copy.panels[oldId]) continue
      const record = copy.panels[oldId]
      delete copy.panels[oldId]
      copy.panels[newId] = { ...record, id: newId,
        ...(record.params === undefined ? {} : { params: { ...record.params, panelId: newId } }) }
    }
    return copy
  }
  const dockview = renameDockview(value?.dockview)
  if (!dockview) return null
  return {
    ...clone(value),
    dockview,
    closedPanelIds: (value.closedPanelIds ?? []).map(id => aliases[id] ?? id),
    ...(value.floatingRestore === undefined ? {} : {
      floatingRestore: {
        ...clone(value.floatingRestore),
        dockview: renameDockview(value.floatingRestore.dockview),
        closedPanelIds: (value.floatingRestore.closedPanelIds ?? []).map(id => aliases[id] ?? id),
      },
    }),
  }
}

// Both saved layouts use the same panel records. Geometry and closed sets are handled by their callers.
function refreshSavedPanelTitles(records, panelIds, configured) {
  if (!panelIds.length || panelIds.some(id => !configured.has(id))) return false
  for (const id of panelIds) {
    const panel = configured.get(id)
    const record = records[id]
    if (!object(record) || record.id !== id || record.contentComponent !== panel.type || record.renderer !== 'always'
      || Object.keys(record).some(key => !['id', 'contentComponent', 'title', 'renderer', 'params'].includes(key))) return false
    record.title = panel.title
  }
  return true
}

function upgradeSavedRecordWithNewPanels(scene, saved) {
  saved = cleanSavedClosedPanelPositions(scene, renameLegacyBusinessPanes(scene, saved))
  if (!object(saved) || saved.version !== 2 || !object(saved.dockview) || !object(saved.dockview.panels)
    || !Array.isArray(saved.closedPanelIds) || Object.keys(saved).some(key => !['version', 'dockview', 'closedPanelIds', 'legacyV1Snapshot', 'migration', 'floatingRestore', 'closedPanelPositions', 'preset'].includes(key))) return null
  const configured = scenePanels(scene)
  const closed = new Set(saved.closedPanelIds)
  const dockview = clone(saved.dockview)
  const existing = Object.keys(dockview.panels)
  if (!refreshSavedPanelTitles(dockview.panels, existing, configured)) return null
  const added = [...configured.keys()].filter(id => !dockview.panels[id] && !closed.has(id))
  if (!added.length) return null
  added.forEach(id => closed.add(id))
  let floatingRestore
  if (saved.floatingRestore !== undefined) {
    if (!object(saved.floatingRestore) || !object(saved.floatingRestore.dockview?.panels)
      || !Array.isArray(saved.floatingRestore.closedPanelIds)) return null
    floatingRestore = clone(saved.floatingRestore)
    const restoreClosed = new Set(floatingRestore.closedPanelIds)
    const restorePanels = Object.keys(floatingRestore.dockview.panels)
    if (!refreshSavedPanelTitles(floatingRestore.dockview.panels, restorePanels, configured)) return null
    for (const id of configured.keys()) if (!floatingRestore.dockview.panels[id] && !restoreClosed.has(id)) restoreClosed.add(id)
    floatingRestore.closedPanelIds = [...restoreClosed]
  }
  const candidate = {
    ...saved,
    dockview,
    closedPanelIds: [...closed],
    ...(floatingRestore ? { floatingRestore } : {}),
    migration: { status: 'panel_upgrade', reason: 'new-recommendation-panels-available' },
  }
  try {
    validateDockviewLayout(scene, candidate.dockview, candidate.closedPanelIds)
    validateClosedPanelPositions(scene, candidate.closedPanelPositions, candidate.closedPanelIds)
    if (candidate.floatingRestore !== undefined) {
      validateDockviewLayout(scene, candidate.floatingRestore.dockview, candidate.floatingRestore.closedPanelIds)
    }
    return candidate
  } catch { return null }
}

export function normalizeDockLayouts(config, existingDockLayouts, legacySceneLayouts = {}) {
  validateSceneConfig(config)
  const existingScenes = object(existingDockLayouts?.scenes) ? existingDockLayouts.scenes : {}
  const scenes = {}
  for (const scene of config.scenes) {
    const saved = cleanSavedDockRecord(scene, existingScenes[scene.id])
    if (saved !== undefined) {
      try {
        const canonical = validateDockLayouts(config, { version: 2, scenes: { [scene.id]: saved } }, { existingDockLayouts: { version: 2, scenes: { [scene.id]: saved } }, legacySceneLayouts })
        scenes[scene.id] = canonical.scenes[scene.id]
        continue
      } catch {
        const upgraded = upgradeSavedRecordWithNewPanels(scene, saved)
        if (upgraded) {
          scenes[scene.id] = {
            version: 2,
            dockview: clone(upgraded.dockview),
            closedPanelIds: [...upgraded.closedPanelIds],
            ...(upgraded.closedPanelPositions === undefined ? {} : { closedPanelPositions: clone(upgraded.closedPanelPositions) }),
            ...(upgraded.preset === undefined ? {} : { preset: clone(upgraded.preset) }),
            ...(upgraded.floatingRestore === undefined ? {} : { floatingRestore: clone(upgraded.floatingRestore) }),
            legacyV1Snapshot: clone(upgraded.legacyV1Snapshot ?? null),
            migration: { status: 'panel_upgrade', reason: 'new-recommendation-panels-available' },
          }
          continue
        }
        const retainedSnapshot = object(saved?.legacyV1Snapshot) ? saved.legacyV1Snapshot : legacySceneLayouts?.[scene.id]
        const fallback = migrateLegacyDockLayout(scene, retainedSnapshot)
        scenes[scene.id] = {
          ...fallback,
          ...(saved?.preset === undefined ? {} : { preset: clone(saved.preset) }),
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
      scenes[scene.id] = cleanSavedDockRecord(scene, previous)
      continue
    }
    if (submitted === undefined) {
      scenes[scene.id] = migrateLegacyDockLayout(scene, legacy?.[scene.id])
      continue
    }
    if (!object(submitted) || submitted.version !== 2
      || Object.keys(submitted).some(key => !['version', 'dockview', 'closedPanelIds', 'legacyV1Snapshot', 'migration', 'floatingRestore', 'closedPanelPositions', 'preset'].includes(key))) fail(`scene record for ${scene.id} is invalid`)
    validateDockviewLayout(scene, submitted.dockview, submitted.closedPanelIds)
    validateClosedPanelPositions(scene, submitted.closedPanelPositions, submitted.closedPanelIds)
    if (submitted.preset !== undefined) validateDockPreset(scene, submitted.preset)
    const preset = submitted.preset ?? cleanSavedDockRecord(scene, previous)?.preset
    if (submitted.floatingRestore !== undefined) {
      const restore = submitted.floatingRestore
      if (!object(restore) || Object.keys(restore).sort().join(',') !== 'closedPanelIds,dockview'
        || restore.dockview?.floatingGroups?.length) fail(`floating restore snapshot for ${scene.id} is invalid`)
      validateDockviewLayout(scene, restore.dockview, restore.closedPanelIds)
    }
    const metadata = canonicalMigrationMetadata(scene, previous, legacy?.[scene.id])
    scenes[scene.id] = {
      version: 2,
      dockview: clone(submitted.dockview),
      closedPanelIds: [...submitted.closedPanelIds],
      ...(submitted.closedPanelPositions === undefined ? {} : { closedPanelPositions: clone(submitted.closedPanelPositions) }),
      ...(preset === undefined ? {} : { preset: clone(preset) }),
      ...(submitted.floatingRestore === undefined ? {} : { floatingRestore: clone(submitted.floatingRestore) }),
      ...metadata,
    }
  }
  return { version: 2, scenes }
}
