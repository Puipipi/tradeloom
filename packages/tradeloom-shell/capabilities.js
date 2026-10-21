import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { createStateStore } from './state.js'

export const AGENT_CAPABILITIES_ROUTE = '/tradeloom/agent-capabilities'
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const SKILL_SOURCES = new Set(['project-dsh', 'project-agents', 'runtime', 'user-dsh', 'user-agents', 'bundled'])
const MAX_TOOLS = 200
const MAX_SKILLS = 100
const MAX_TEXT = 500

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function optionalService(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined }
  catch { return undefined }
}

function unbound(role, mcpStatus) {
  return {
    role, status: 'not_bound',
    tools: null,
    skills: null,
    mcp: { status: mcpStatus, visibleTools: null },
  }
}

function projectTools(toolSchemas) {
  if (!Array.isArray(toolSchemas)) return null
  const items = []
  const seen = new Set()
  const mcpVisible = []
  let total = 0
  for (const schema of toolSchemas) {
    const name = cleanText(schema?.name, 120)
    if (!name || seen.has(name)) continue
    seen.add(name)
    total++
    if (items.length < MAX_TOOLS) items.push({ name })
    if (name.startsWith('mcp__') && mcpVisible.length < MAX_TOOLS) mcpVisible.push(name)
  }
  const mcpTotal = [...seen].filter(name => name.startsWith('mcp__')).length
  return { items, total, truncated: total > MAX_TOOLS, mcpVisible, mcpVisibleTruncated: mcpTotal > MAX_TOOLS }
}

function projectSkills(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.skills)) return null
  const skills = snapshot.skills
  const items = skills.slice(0, MAX_SKILLS).flatMap(skill => {
    const name = cleanText(skill?.name, 120)
    if (!name) return []
    const invocation = skill?.invocation
    return [{
      name,
      description: cleanText(skill?.description),
      source: SKILL_SOURCES.has(skill?.source) ? skill.source : 'custom',
      invocation: {
        modelInvocable: invocation?.modelInvocable === true,
        userInvocable: invocation?.userInvocable === true,
      },
    }]
  })
  return { items, total: skills.length, truncated: skills.length > MAX_SKILLS, complete: snapshot.complete === true && skills.length <= MAX_SKILLS }
}

function mcpDeclaration(inventory, preset) {
  if (!Array.isArray(inventory)) return 'unavailable'
  const composition = inventory.find(item => item?.id === preset)
  if (!composition || !Array.isArray(composition.rows)) return 'not_configured'
  return composition.rows.some(row => row?.moduleName === MCP_MODULE && (row.enabled === true || row.enabled === 'conditional'))
    ? 'declared_only'
    : 'not_configured'
}

export function createAgentCapabilitiesHandler(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }

    let url
    try { url = new URL(req.url, 'http://localhost') }
    catch { json(res, 400, { error: 'invalid-query' }); return }
    const entries = [...url.searchParams.entries()]
    if (url.pathname !== AGENT_CAPABILITIES_ROUTE || entries.length !== 1 || entries[0][0] !== 'role') {
      json(res, 400, { error: 'invalid-query' }); return
    }
    const role = entries[0][1]
    if (!ROLE_IDS.includes(role)) { json(res, 400, { error: 'unknown-role' }); return }
    const preset = ROLE_PRESETS[role]

    const presetRegistry = optionalService(ctx, 'agentPresets')
    let inventory
    if (presetRegistry && typeof presetRegistry.compositionInventory === 'function') {
      try { inventory = await presetRegistry.compositionInventory() } catch { /* optional service remains unavailable */ }
    }
    const declaration = mcpDeclaration(inventory, preset)

    let binding
    try {
      const store = await storeFactory()
      const state = await store.read()
      binding = state?.roles?.[role]
    } catch {
      json(res, 503, { error: 'capability-state-unavailable' }); return
    }
    if (typeof binding?.sessionId !== 'string' || !binding.sessionId
      || binding.agentPreset !== preset) {
      json(res, 200, unbound(role, declaration)); return
    }

    let agent
    try { agent = ctx.agents?.get(binding.sessionId) }
    catch { agent = undefined }
    if (!agent || agent.session?.id !== binding.sessionId) {
      json(res, 200, unbound(role, declaration)); return
    }
    if (typeof presetRegistry?.composedPreset !== 'function') {
      json(res, 200, unbound(role, declaration)); return
    }
    let activePreset
    try { activePreset = await presetRegistry.composedPreset(agent.ctx) }
    catch { /* unavailable live composition must fail closed */ }
    if (activePreset !== preset) {
      json(res, 200, unbound(role, declaration)); return
    }

    let toolProjection = null
    try { toolProjection = projectTools(ctx.tools?.schemas(agent)) } catch { /* report unavailable below */ }

    const skillsService = optionalService(ctx, 'skills')
    let skillProjection = null
    let skillSnapshot
    if (skillsService && typeof agent.session?.header?.cwd === 'string') {
      try {
        skillSnapshot = await skillsService.snapshot({ scope: agent, cwd: agent.session.header.cwd })
        skillProjection = projectSkills(skillSnapshot)
      } catch { /* optional service remains unavailable */ }
    }

    const visibleMcpTools = toolProjection?.mcpVisible ?? null
    const visibleTools = visibleMcpTools?.length ? visibleMcpTools : null
    const mcpStatus = visibleTools ? 'visible_tool' : declaration
    json(res, 200, {
      role,
      status: 'ready',
      tools: toolProjection === null
        ? { status: 'unavailable', items: null, truncated: null, total: null }
        : { status: 'available', items: toolProjection.items, truncated: toolProjection.truncated, total: toolProjection.total },
      skills: skillProjection === null
        ? { status: 'unavailable', items: null }
        : { status: 'available', items: skillProjection.items, complete: skillProjection.complete, truncated: skillProjection.truncated, total: skillProjection.total },
      mcp: { status: mcpStatus, visibleTools, visibleToolsTruncated: toolProjection?.mcpVisibleTruncated ?? null },
    })
  }
}
