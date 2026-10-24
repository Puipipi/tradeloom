import { ROLE_IDS } from './roles.js'

export const BUSINESS_ROUTE_PATHS = Object.freeze(['/home', '/products', '/agent-center', '/artifacts', '/runs'])
export const PANEL_TYPES = Object.freeze(['business-iframe', 'placeholder', 'native-chat', 'erpnext-status', 'workflow-canvas'])
const ROLE_ID_SET = new Set(ROLE_IDS)
const BUSINESS_PATHS = new Set(BUSINESS_ROUTE_PATHS)
const DOCK_LAYOUT_PROFILES = Object.freeze({
  assistant_lead: [1000, 360],
  collaboration_grid: [1200, 600],
  business_lead: [1143, 360],
})

function fail(message) { throw new Error(`invalid scene configuration: ${message}`) }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function integer(value) { return Number.isInteger(value) }

export function validateSceneConfig(config, panelTypes = PANEL_TYPES) {
  if (!object(config) || config.version !== 1 || !object(config.grid)
    || config.grid.cols !== 4 || config.grid.rows !== 4) fail('expected version 1 and a 4x4 grid')
  if (!Array.isArray(config.scenes) || config.scenes.length === 0 || config.scenes.length > 16) fail('scenes must be a non-empty bounded list')
  const ids = new Set()
  for (const scene of config.scenes) {
    if (!object(scene) || typeof scene.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(scene.id)
      || ids.has(scene.id) || typeof scene.label !== 'string' || scene.label.length > 100
      || !ROLE_ID_SET.has(scene.roleId) || !Array.isArray(scene.panels) || scene.panels.length < 1 || scene.panels.length > 12) {
      fail('scene identity, role or panel list is invalid')
    }
    if (scene.layoutProfile !== undefined) {
      const profile = scene.layoutProfile
      const expectedMinimums = DOCK_LAYOUT_PROFILES[profile?.kind]
      if (!object(profile) || Object.keys(profile).sort().join(',') !== 'kind,minimumHeight,minimumWidth'
        || !expectedMinimums || profile.minimumWidth !== expectedMinimums[0] || profile.minimumHeight !== expectedMinimums[1]) {
        fail('scene dock layout profile is invalid')
      }
    }
    ids.add(scene.id)
    const panelIds = new Set()
    for (const panel of scene.panels) {
      if (!object(panel) || typeof panel.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(panel.id)
        || panelIds.has(panel.id) || typeof panel.title !== 'string' || panel.title.length > 100
        || !panelTypes.includes(panel.type)) fail('panel identity or type is invalid')
      panelIds.add(panel.id)
      for (const key of ['col', 'row', 'w', 'h']) if (!integer(panel[key]) || panel[key] < 1 || panel[key] > 4) fail('panel grid coordinates must be integers from 1 to 4')
      if (panel.col + panel.w - 1 > 4 || panel.row + panel.h - 1 > 4) fail('panel is outside the 4x4 grid')
      if (panel.type === 'business-iframe' && (!BUSINESS_PATHS.has(panel.path) || typeof panel.path !== 'string')) fail('business iframe path is not allowlisted')
      if (panel.type === 'placeholder' && (typeof panel.text !== 'string' || panel.text.length > 500)) fail('placeholder text is invalid')
    }
    if (scene.panels.filter(panel => panel.type === 'native-chat').length !== 1) fail('each scene must define exactly one native chat panel')
    if (scene.defaultBusinessRoute !== undefined
      && (!BUSINESS_PATHS.has(scene.defaultBusinessRoute) || config.businessRoutes?.[scene.defaultBusinessRoute]?.sceneId !== scene.id)) {
      fail('scene default business route is not mapped to that scene')
    }
  }
  if (!object(config.businessRoutes) || JSON.stringify(Object.keys(config.businessRoutes).sort()) !== JSON.stringify([...BUSINESS_ROUTE_PATHS].sort())) fail('business route map must contain the five existing routes')
  for (const path of BUSINESS_ROUTE_PATHS) {
    const target = config.businessRoutes[path]
    if (!object(target) || Object.keys(target).sort().join(',') !== 'panelId,sceneId'
      || !ids.has(target.sceneId) || typeof target.panelId !== 'string') fail('business route target is invalid')
    const panel = config.scenes.find(scene => scene.id === target.sceneId)?.panels.find(item => item.id === target.panelId)
    if (panel?.type !== 'business-iframe') fail('business route must target a registered business iframe panel')
  }
  const first = config.scenes[0]
  if (typeof first.defaultBusinessRoute !== 'string') fail('first scene must select a default business route')
  return config
}

function normalizePanel(scene, panel, saved) {
  const value = saved ?? {}
  if (!object(value) || Object.keys(value).some(key => !['col', 'row', 'w', 'h', 'visible'].includes(key))) fail('saved panel layout contains unsupported fields')
  const normalized = {
    col: value.col ?? panel.col,
    row: value.row ?? panel.row,
    w: value.w ?? panel.w,
    h: value.h ?? panel.h,
    visible: value.visible ?? true,
  }
  if (!['col', 'row', 'w', 'h'].every(key => integer(normalized[key]) && normalized[key] >= 1 && normalized[key] <= 4)
    || normalized.col + normalized.w - 1 > 4 || normalized.row + normalized.h - 1 > 4
    || typeof normalized.visible !== 'boolean') fail(`saved layout for ${scene.id}/${panel.id} is out of range`)
  return normalized
}

export function normalizeSceneLayout(scene, savedLayout = {}) {
  if (!object(savedLayout) || Object.keys(savedLayout).some(key => !['panels', 'expandedPanel'].includes(key))) fail('scene layout contains unsupported fields')
  const savedPanels = savedLayout.panels ?? {}
  if (!object(savedPanels)) fail('saved panels must be an object')
  const panelIds = new Set(scene.panels.map(panel => panel.id))
  if (Object.keys(savedPanels).some(id => !panelIds.has(id))) fail('saved layout contains an unknown panel')
  const expandedPanel = savedLayout.expandedPanel ?? ''
  if (expandedPanel !== '' && !panelIds.has(expandedPanel)) fail('expanded panel is unknown')
  return {
    expandedPanel,
    panels: Object.fromEntries(scene.panels.map(panel => [panel.id, normalizePanel(scene, panel, savedPanels[panel.id])])),
  }
}

export function defaultSceneWorkbench(config) {
  validateSceneConfig(config)
  const scene = config.scenes[0]
  return {
    version: 1,
    activeSceneId: scene.id,
    roleByScene: Object.fromEntries(config.scenes.map(item => [item.id, item.roleId])),
    businessPath: scene.defaultBusinessRoute ?? null,
    layouts: Object.fromEntries(config.scenes.map(item => [item.id, normalizeSceneLayout(item)])),
  }
}

export function validateSceneWorkbench(config, value) {
  validateSceneConfig(config)
  if (!object(value) || Object.keys(value).sort().join(',') !== 'activeSceneId,businessPath,layouts,roleByScene,version'
    || value.version !== 1 || !object(value.roleByScene)
    || !config.scenes.some(scene => scene.id === value.activeSceneId) || !object(value.layouts)) {
    fail('saved workbench state is invalid')
  }
  if (Object.keys(value.roleByScene).some(id => !config.scenes.some(item => item.id === id)
    || !ROLE_ID_SET.has(value.roleByScene[id]))) fail('saved scene role is unknown')
  const scene = config.scenes.find(item => item.id === value.activeSceneId)
  const mainBusinessPath = scene.panels.find(panel => panel.id === 'business-main' && panel.type === 'business-iframe')?.path
  if (value.businessPath !== null
    && (!BUSINESS_PATHS.has(value.businessPath)
      || (config.businessRoutes[value.businessPath]?.sceneId !== scene.id && mainBusinessPath !== value.businessPath))) {
    fail('business route does not belong to the selected scene')
  }
  if (Object.keys(value.layouts).some(id => !config.scenes.some(item => item.id === id))) fail('saved layout names an unknown scene')
  return {
    version: 1,
    activeSceneId: scene.id,
    roleByScene: Object.fromEntries(config.scenes.map(item => [item.id, value.roleByScene[item.id] ?? item.roleId])),
    businessPath: value.businessPath,
    layouts: Object.fromEntries(config.scenes.map(item => [item.id, normalizeSceneLayout(item, value.layouts[item.id] ?? {})])),
  }
}

export function normalizeSceneWorkbench(config, value) {
  return validateSceneWorkbench(config, value ?? defaultSceneWorkbench(config))
}
