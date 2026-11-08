import { createHash } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { createStateStore, HOME_MARKER_VALUE, resolveOwnedHome, roleWorkspacePath } from './state.js'

export const AGENT_CONFIGURATION_ROUTE = '/tradeloom/agent-configuration'
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const SKILL_MODULE = '@deepseek-ai/dsh-skill-filesystem'
const POLICY_MODULE = '@tradeloom/dsh-business-shell/tool-policy'
const MCP_ID_PREFIX = 'tradeloom-mcp-'
const SKILL_ROW_ID = 'tradeloom-skill-filesystem'
const POLICY_ROW_ID = 'tradeloom-tool-policy'
const MAX_BODY = 128 * 1024
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MCP_ROW_ID = /^tradeloom-mcp-[a-z0-9][a-z0-9-]{0,31}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const PROFILE_NAMES = new Set(['tradeloom', 'desktop'])
// Cordis exports FiberState as a const enum, so ACTIVE is erased at runtime.
// Keep the pinned 4.0.5 enum value in sync with the official loader-status mirror.
const ACTIVE_FIBER_STATE = 2
const configurationWriteFlights = new Map()

class ConfigurationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every(key => keys.includes(key))
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isManagedRow(row) {
  return typeof row?.id === 'string'
    && (row.id.startsWith(MCP_ID_PREFIX) || row.id === SKILL_ROW_ID || row.id === POLICY_ROW_ID)
}

function managedRows(config) {
  return Array.isArray(config?.plugins) ? config.plugins.filter(isManagedRow) : []
}

function revisionOf(config) {
  return createHash('sha256').update(canonical(managedRows(config))).digest('hex')
}

function trustedManagedConfigurationDigest(config) {
  if (!isRecord(config) || !Array.isArray(config.plugins)) {
    throw new ConfigurationError('managed-configuration-schema-invalid', 503)
  }
  for (const row of config.plugins) {
    if (isManagedRow(row) && (!isRecord(row) || typeof row.name !== 'string' || !isRecord(row.config))) {
      throw new ConfigurationError('managed-configuration-schema-invalid', 503)
    }
  }
  return revisionOf(config)
}

function profileOwnedPath(profile, home, editor) {
  if (!isRecord(profile) || !PROFILE_NAMES.has(profile.name)
    || !samePath(profile.home, home)) return false
  const profileDir = resolve(home, 'profiles', profile.name)
  if (!samePath(profile.dir, profileDir)
    || !samePath(profile.patchPath, join(profileDir, 'cordis.patch.yml'))
    || !samePath(editor.documentPath, profile.patchPath)
    || !Array.isArray(profile.startedBundles)
    || !profile.startedBundles.includes('@tradeloom/dsh-business-shell')) return false
  return true
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function validateOwnedProfile(profile, home, editor) {
  if (!profileOwnedPath(profile, home, editor)) throw new ConfigurationError('profile-not-owned', 403)
  const realHome = await realpath(home).catch(() => undefined)
  const realProfile = await realpath(profile.dir).catch(() => undefined)
  if (!samePath(realHome, home) || !samePath(realProfile, profile.dir)) {
    throw new ConfigurationError('profile-not-owned', 403)
  }
  const markerPath = join(home, '.tradeloom-owned')
  const markerInfo = await lstat(markerPath).catch(() => undefined)
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new ConfigurationError('profile-not-owned', 403)
  const marker = await import('node:fs/promises').then(({ readFile }) => readFile(markerPath, 'utf8')).catch(() => '')
  if (marker !== HOME_MARKER_VALUE) throw new ConfigurationError('profile-not-owned', 403)
}

function contextService(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined }
  catch { return undefined }
}

async function accessForRole(ctx, role, dependencies, { providerGuard } = {}) {
  const editor = contextService(ctx, 'configEditor')
  const profile = contextService(ctx, 'profileContext')
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new ConfigurationError('configuration-unavailable', 503)
  }
  let home
  try { home = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)() }
  catch { throw new ConfigurationError('profile-not-owned', 403) }
  await validateOwnedProfile(profile, home, editor)
  if (providerGuard) await providerGuard({ editor, profile, home, role })

  const activeFiberState = dependencies.FiberState?.ACTIVE ?? ACTIVE_FIBER_STATE
  let entries
  try { entries = editor.entries() }
  catch { throw new ConfigurationError('configuration-unavailable', 503) }
  const matches = entries.filter(entry => entry?.options?.name === PRESET_MODULE
    && entry.options.config?.id === ROLE_PRESETS[role])
  const target = matches[0]
  if (matches.length !== 1 || target?.fiber?.state !== activeFiberState
    || target.enabled === false || target.disabled === true
    || target.options?.enabled === false || target.options?.disabled === true) {
    throw new ConfigurationError('configuration-unavailable', 503)
  }
  return { home, editor, entry: target, profile, activeFiberState }
}

function activePresetEntry(access, role) {
  const matches = access.editor.entries().filter(entry => entry?.options?.name === PRESET_MODULE
    && entry.options.config?.id === ROLE_PRESETS[role])
  if (matches.length !== 1 || matches[0]?.fiber?.state !== access.activeFiberState
    || matches[0].enabled === false || matches[0].disabled === true
    || matches[0].options?.enabled === false || matches[0].options?.disabled === true) {
    throw new ConfigurationError('configuration-unavailable', 503)
  }
  return matches[0]
}

async function withRoleWriteLock(home, _role, callback) {
  // Managed configuration revisions are Host-wide, so supported writes for
  // different roles must share one ordering boundary.
  const key = resolve(home).toLocaleLowerCase('en-US')
  const prior = configurationWriteFlights.get(key) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(callback)
  configurationWriteFlights.set(key, next)
  try { return await next }
  finally { if (configurationWriteFlights.get(key) === next) configurationWriteFlights.delete(key) }
}

function expressionValue(value) {
  if (isRecord(value) && hasExactKeys(value, ['__jsExpr'])) return value.__jsExpr
  return typeof value === 'string' ? value : undefined
}

function envReference(value) {
  const expression = expressionValue(value)
  if (typeof expression !== 'string') return undefined
  const raw = /^process\.env\[("[A-Z_][A-Z0-9_]*")\]$/.exec(expression)
  if (raw) return { envName: JSON.parse(raw[1]), scheme: 'raw' }
  const bearer = /^"Bearer " \+ process\.env\[("[A-Z_][A-Z0-9_]*")\]$/.exec(expression)
  if (bearer) return { envName: JSON.parse(bearer[1]), scheme: 'bearer' }
  return undefined
}

function secretPresent(reference, env) {
  return typeof env[reference.envName] === 'string' && env[reference.envName].length > 0
}

function canonicalExpression(reference) {
  const variable = `process.env[${JSON.stringify(reference.envName)}]`
  return { __jsExpr: reference.scheme === 'bearer' ? `"Bearer " + ${variable}` : variable }
}

function projectSecretMap(values, env, validateKey) {
  const projected = Object.create(null)
  let editable = true
  if (!isRecord(values)) return { projected, editable: values === undefined }
  for (const [key, value] of Object.entries(values)) {
    if (!validateKey(key)) { editable = false; continue }
    const reference = envReference(value)
    if (reference) projected[key] = { ...reference, present: secretPresent(reference, env) }
    else { projected[key] = { configured: true, present: null }; editable = false }
  }
  return { projected, editable }
}

function safeServerStub(row) {
  return {
    ...(typeof row?.id === 'string' && MCP_ROW_ID.test(row.id) ? { id: row.id } : {}),
    configured: true,
    editable: false,
  }
}

function projectMcpRow(row, env) {
  const config = row.config
  const common = ['transport', 'serverName', 'toolCallTimeoutMs', 'failOnStartupError']
  let editable = hasOnlyKeys(row, ['id', 'name', 'config']) && row.name === MCP_MODULE
    && typeof row.id === 'string' && MCP_ROW_ID.test(row.id)
    && typeof config.serverName === 'string' && SERVER_NAME.test(config.serverName)
    && Number.isInteger(config.toolCallTimeoutMs) && config.toolCallTimeoutMs >= 1 && config.toolCallTimeoutMs <= 600_000
    && typeof config.failOnStartupError === 'boolean'
  if (config.transport === 'stdio') {
    editable &&= hasExactKeys(config, [...common, 'command', 'args', 'cwd', 'env'])
      && typeof config.command === 'string' && config.command.trim().length > 0 && config.command.length <= 1024
      && Array.isArray(config.args) && config.args.length <= 64
      && config.args.every(arg => typeof arg === 'string' && arg.length <= 4096)
      && typeof config.cwd === 'string' && config.cwd.length <= 1024
    const projectedEnv = projectSecretMap(config.env, env, key => ENV_NAME.test(key))
    editable &&= projectedEnv.editable
    if (!editable) return safeServerStub(row)
    return {
      id: row.id, transport: 'stdio', serverName: config.serverName,
      toolCallTimeoutMs: config.toolCallTimeoutMs, failOnStartupError: config.failOnStartupError,
      command: config.command, args: [...config.args], cwd: config.cwd, env: projectedEnv.projected,
    }
  }
  if (config.transport === 'streamable-http') {
    editable &&= hasExactKeys(config, [...common, 'url', 'headers'])
    let url
    if (typeof config.url !== 'string' || config.url.length > 2048) editable = false
    else {
      try {
        const parsed = new URL(config.url)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) editable = false
        else url = parsed.toString()
      } catch { editable = false }
    }
    const projectedHeaders = projectSecretMap(config.headers, env, key => HEADER_NAME.test(key))
    editable &&= projectedHeaders.editable
    if (!editable) return safeServerStub(row)
    return {
      id: row.id, transport: 'streamable-http', serverName: config.serverName,
      toolCallTimeoutMs: config.toolCallTimeoutMs, failOnStartupError: config.failOnStartupError,
      url, headers: projectedHeaders.projected,
    }
  }
  return safeServerStub(row)
}

function projectManaged(config, role, home, env) {
  const rows = managedRows(config)
  let editable = Array.isArray(config?.plugins)
  const mcpServers = []
  let skill = { includeDefaultRoots: true, customSkillDirs: [] }
  let deniedTools = []
  let skillSeen = false
  let policySeen = false
  const ids = new Set()
  for (const row of rows) {
    if (ids.has(row.id)) { editable = false; continue }
    ids.add(row.id)
    if (!isRecord(row.config)) { editable = false; continue }
    if (!hasOnlyKeys(row, ['id', 'name', 'config'])) {
      editable = false
      if (row.id.startsWith(MCP_ID_PREFIX)) mcpServers.push(safeServerStub(row))
      continue
    }
    if (row.id.startsWith(MCP_ID_PREFIX)) {
      const projected = projectMcpRow(row, env)
      if (projected.editable === false) editable = false
      mcpServers.push(projected)
    } else if (row.id === SKILL_ROW_ID) {
      if (skillSeen || row.name !== SKILL_MODULE) { editable = false; continue }
      skillSeen = true
      if (!hasExactKeys(row.config, ['providerName', 'includeDefaultRoots', 'customSkillDirs'])
        || row.config.providerName !== `tradeloom-${role}-skills`
        || typeof row.config.includeDefaultRoots !== 'boolean'
        || !Array.isArray(row.config.customSkillDirs)) { editable = false; continue }
      let skillEditable = true
      const root = resolve(home, 'tradeloom-workspaces', role)
      const customSkillDirs = []
      for (const value of row.config.customSkillDirs) {
        if (typeof value !== 'string') { skillEditable = false; continue }
        const rel = relative(root, resolve(value))
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          skillEditable = false
          continue
        }
        customSkillDirs.push(rel.split(sep).join('/'))
      }
      editable &&= skillEditable
      if (skillEditable) skill = { includeDefaultRoots: row.config.includeDefaultRoots, customSkillDirs }
    } else if (row.id === POLICY_ROW_ID) {
      if (policySeen || row.name !== POLICY_MODULE || !hasExactKeys(row.config, ['deniedTools']) || !Array.isArray(row.config.deniedTools)
        || !row.config.deniedTools.every(name => typeof name === 'string')) { editable = false; continue }
      policySeen = true
      deniedTools = [...row.config.deniedTools]
    }
  }
  return { editable, mcpServers, skill, deniedTools }
}

function pluginRows(nextValue, current, inherited, role) {
  const oldRows = Array.isArray(current?.plugins) ? current.plugins
    : Array.isArray(inherited?.plugins) ? inherited.plugins : []
  const newRows = [
    ...nextValue.mcpServers.map(({ id, config }) => ({ id, name: MCP_MODULE, config })),
    { id: SKILL_ROW_ID, name: SKILL_MODULE, config: {
      providerName: `tradeloom-${role}-skills`,
      includeDefaultRoots: nextValue.skill.includeDefaultRoots,
      customSkillDirs: nextValue.skill.customSkillDirs,
    } },
    { id: POLICY_ROW_ID, name: POLICY_MODULE, config: { deniedTools: nextValue.deniedTools } },
  ]
  const first = oldRows.findIndex(isManagedRow)
  const output = []
  for (let index = 0; index < oldRows.length; index++) {
    const row = oldRows[index]
    if (isManagedRow(row)) {
      if (index === first) output.push(...newRows)
      continue
    }
    output.push(row)
  }
  if (first < 0) output.push(...newRows)
  return { ...current, plugins: output }
}

function restoreManagedRows(current, previous) {
  const oldRows = Array.isArray(current?.plugins) ? current.plugins : []
  const previousRows = managedRows(previous)
  const first = oldRows.findIndex(isManagedRow)
  const output = []
  for (let index = 0; index < oldRows.length; index += 1) {
    const row = oldRows[index]
    if (isManagedRow(row)) {
      if (index === first) output.push(...previousRows)
      continue
    }
    output.push(row)
  }
  if (first < 0) output.push(...previousRows)
  return { ...current, plugins: output }
}

async function resolvePresetState(ctx, preset) {
  const registry = contextService(ctx, 'agentPresets')
  if (typeof registry?.resolve !== 'function') return { available: false, healthy: false }
  try {
    const result = await registry.resolve(preset)
    if (result?.id !== preset) return { available: false, healthy: false }
    return { available: true, healthy: result.broken === undefined }
  } catch { return { available: false, healthy: false } }
}

async function rollbackManagedConfig(ctx, access, role, previousConfig, failedConfig, providerGuard, expectedManagedRows, expectedHealthy = false) {
  try {
    const entry = activePresetEntry(access, role)
    await access.editor.edit(entry, (currentConfig, inherited) => {
      if (revisionOf(currentConfig) !== revisionOf(failedConfig)) throw new ConfigurationError('revision-conflict', 409)
      return restoreManagedRows(currentConfig ?? inherited, previousConfig)
    })
    if (providerGuard) {
      try { await providerGuard('after-compensation-write') }
      catch { return 'unknown' }
    }
    const afterWrite = activePresetEntry(access, role)
    if (revisionOf(afterWrite.options.config) !== revisionOf(previousConfig)) return 'conflict'
    const resolved = await resolvePresetState(ctx, ROLE_PRESETS[role])
    if (!resolved.available) return 'failed'
    if (providerGuard) {
      try { await providerGuard('after-compensation-resolve') }
      catch { return 'unknown' }
    }
    const afterResolve = activePresetEntry(access, role)
    if (revisionOf(afterResolve.options.config) !== revisionOf(previousConfig)) return 'conflict'
    if (expectedManagedRows && canonical(managedRows(afterResolve.options.config)) !== canonical(expectedManagedRows)) return 'failed'
    if (expectedHealthy && !resolved.healthy) return 'failed'
    return { status: 'restored', healthy: resolved.healthy }
  } catch (error) { return error instanceof ConfigurationError && error.status === 409 ? 'conflict' : 'failed' }
}

function validateReference(value, env) {
  if (!hasExactKeys(value, ['envName', 'scheme']) || typeof value.envName !== 'string' || !ENV_NAME.test(value.envName)
    || !['raw', 'bearer'].includes(value.scheme)
    || typeof env[value.envName] !== 'string' || env[value.envName].length === 0) {
    throw new ConfigurationError('invalid-configuration')
  }
  return { ...value }
}

function validateSecretMap(value, env, validateKey) {
  if (!isRecord(value)) throw new ConfigurationError('invalid-configuration')
  const entries = []
  for (const [key, reference] of Object.entries(value)) {
    if (!validateKey(key)) throw new ConfigurationError('invalid-configuration')
    entries.push([key, canonicalExpression(validateReference(reference, env))])
  }
  // ConfigEditor compares the resolved schema object to its serialized YAML round-trip.
  // Object.fromEntries preserves special own keys while matching the ordinary object shape.
  return Object.fromEntries(entries)
}

async function validateSkillPaths(value, role, home, dependencies) {
  if (!hasExactKeys(value, ['includeDefaultRoots', 'customSkillDirs'])
    || typeof value.includeDefaultRoots !== 'boolean'
    || !Array.isArray(value.customSkillDirs) || value.customSkillDirs.length > 32) {
    throw new ConfigurationError('invalid-configuration')
  }
  const root = dependencies.roleWorkspacePathReadOnly
    ? await dependencies.roleWorkspacePathReadOnly(role)
    : await (dependencies.roleWorkspacePath ?? roleWorkspacePath)(role)
  const rootReal = await realpath(root).catch(() => undefined)
  if (!rootReal) {
    if (dependencies.roleWorkspacePathReadOnly && value.customSkillDirs.length === 0) {
      return { includeDefaultRoots: value.includeDefaultRoots, customSkillDirs: [] }
    }
    throw new ConfigurationError('invalid-configuration')
  }
  const output = []
  const seen = new Set()
  for (const input of value.customSkillDirs) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 256
      || input.includes('\\') || isAbsolute(input) || /^[A-Za-z]:/.test(input)
      || input.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new ConfigurationError('invalid-configuration')
    }
    const target = resolve(root, ...input.split('/'))
    const rel = relative(root, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ConfigurationError('invalid-configuration')
    const realTarget = await realpath(target).catch(() => undefined)
    if (!realTarget) throw new ConfigurationError('invalid-configuration')
    const realRel = relative(rootReal, realTarget)
    if (!realRel || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new ConfigurationError('invalid-configuration')
    }
    const info = await stat(realTarget).catch(() => undefined)
    if (!info?.isDirectory()) throw new ConfigurationError('invalid-configuration')
    const normalized = realRel.split(sep).join('/')
    if (seen.has(normalized)) throw new ConfigurationError('invalid-configuration')
    seen.add(normalized)
    output.push(realTarget)
  }
  return { includeDefaultRoots: value.includeDefaultRoots, customSkillDirs: output }
}

function validateServer(input, env) {
  const stdioKeys = ['id', 'transport', 'serverName', 'command', 'args', 'cwd', 'toolCallTimeoutMs', 'failOnStartupError', 'env']
  const httpKeys = ['id', 'transport', 'serverName', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError']
  if (!isRecord(input) || !['stdio', 'streamable-http'].includes(input.transport)
    || !hasExactKeys(input, input.transport === 'stdio' ? stdioKeys : httpKeys)
    || typeof input.id !== 'string' || !MCP_ROW_ID.test(input.id)
    || typeof input.serverName !== 'string' || !SERVER_NAME.test(input.serverName)
    || !Number.isInteger(input.toolCallTimeoutMs) || input.toolCallTimeoutMs < 1 || input.toolCallTimeoutMs > 600_000
    || typeof input.failOnStartupError !== 'boolean') throw new ConfigurationError('invalid-configuration')
  const base = {
    transport: input.transport,
    serverName: input.serverName,
    toolCallTimeoutMs: input.toolCallTimeoutMs,
    failOnStartupError: input.failOnStartupError,
  }
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 1024
      || !Array.isArray(input.args) || input.args.length > 64
      || !input.args.every(arg => typeof arg === 'string' && arg.length <= 4096)
      || typeof input.cwd !== 'string' || input.cwd.length > 1024) throw new ConfigurationError('invalid-configuration')
    return { id: input.id, config: {
      ...base, command: input.command, args: [...input.args], cwd: input.cwd,
      env: validateSecretMap(input.env, env, key => ENV_NAME.test(key)),
    } }
  }
  if (typeof input.url !== 'string' || input.url.length > 2048) throw new ConfigurationError('invalid-configuration')
  let url
  try { url = new URL(input.url) } catch { throw new ConfigurationError('invalid-configuration') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConfigurationError('invalid-configuration')
  return { id: input.id, config: {
    ...base, url: url.toString(),
    headers: validateSecretMap(input.headers, env, key => HEADER_NAME.test(key)),
  } }
}

async function visibleToolNames(ctx, role, preset, dependencies) {
  if (Array.isArray(dependencies.toolNames)) return new Set(dependencies.toolNames)
  try {
    const store = await (dependencies.createStateStore ?? (await import('./state.js')).createStateStore)()
    const state = await store.read()
    const binding = state?.roles?.[role]
    if (binding?.agentPreset !== preset || typeof binding?.sessionId !== 'string' || !binding.sessionId) return new Set()
    const agent = ctx.agents?.get(binding.sessionId)
    if (agent?.session?.id !== binding.sessionId) return new Set()
    const presets = contextService(ctx, 'agentPresets')
    if (typeof presets?.composedPreset !== 'function') return new Set()
    if (await presets.composedPreset(agent.ctx) !== preset) return new Set()
    const schemas = ctx.tools?.schemas(agent)
    return new Set(Array.isArray(schemas) ? schemas.map(schema => schema?.name).filter(name => typeof name === 'string') : [])
  } catch { return new Set() }
}

async function validateInput(input, role, home, ctx, dependencies, currentDeniedTools) {
  if (!hasExactKeys(input, ['expectedRevision', 'mcpServers', 'skill', 'deniedTools'])
    || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || !Array.isArray(input.mcpServers) || input.mcpServers.length > 32
    || !Array.isArray(input.deniedTools) || input.deniedTools.length > 200) {
    throw new ConfigurationError('invalid-configuration')
  }
  const servers = input.mcpServers.map(server => validateServer(server, dependencies.env ?? process.env))
  if (new Set(servers.map(server => server.id)).size !== servers.length
    || new Set(servers.map(server => server.config.serverName)).size !== servers.length) {
    throw new ConfigurationError('invalid-configuration')
  }
  const skill = await validateSkillPaths(input.skill, role, home, dependencies)
  const toolNames = await visibleToolNames(ctx, role, ROLE_PRESETS[role], dependencies)
  const previouslyDenied = new Set(currentDeniedTools)
  if (!input.deniedTools.every(name => typeof name === 'string' && name.length > 0 && name.length <= 160
    && (toolNames.has(name) || previouslyDenied.has(name))) || new Set(input.deniedTools).size !== input.deniedTools.length) {
    throw new ConfigurationError('invalid-configuration')
  }
  return {
    expectedRevision: input.expectedRevision,
    mcpServers: servers,
    skill,
    deniedTools: [...input.deniedTools],
  }
}

function validateInputEnvelope(input) {
  if (!hasExactKeys(input, ['expectedRevision', 'mcpServers', 'skill', 'deniedTools'])
    || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || !Array.isArray(input.mcpServers) || input.mcpServers.length > 32
    || !isRecord(input.skill)
    || !Array.isArray(input.deniedTools) || input.deniedTools.length > 200) {
    throw new ConfigurationError('invalid-configuration')
  }
}

async function readRequestBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY) { req.resume(); return null }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requestRole(req, method) {
  let url
  try { url = new URL(req.url, 'http://localhost') }
  catch { throw new ConfigurationError('invalid-query') }
  const entries = [...url.searchParams.entries()]
  if (url.pathname !== AGENT_CONFIGURATION_ROUTE || entries.length !== 1 || entries[0][0] !== 'role') {
    throw new ConfigurationError('invalid-query')
  }
  const role = entries[0][1]
  if (!ROLE_IDS.includes(role)) throw new ConfigurationError('unknown-role')
  return role
}

function sendFailure(res, failure) {
  const code = failure instanceof ConfigurationError ? failure.code : 'configuration-apply-failed'
  const status = failure instanceof ConfigurationError ? failure.status : 503
  json(res, status, { error: code })
}

function providerIdentity(access, role) {
  return {
    home: resolve(access.home).toLocaleLowerCase('en-US'), role, preset: ROLE_PRESETS[role],
    profile: access.profile, editor: access.editor,
  }
}

function sameProviderIdentity(left, right) {
  return Boolean(left && right && left.home === right.home && left.role === right.role && left.preset === right.preset
    && left.profile === right.profile && left.editor === right.editor)
}

function snapshotRestoreFailure(restore) {
  if (restore === 'conflict') {
    const error = new ConfigurationError('snapshot-restore-conflict', 409)
    error.restoreStatus = 'conflict'
    return error
  }
  if (restore?.status === 'restored') {
    const error = new ConfigurationError('snapshot-restore-failed', 503)
    error.restoreStatus = 'restored'
    return error
  }
  const error = new ConfigurationError('snapshot-restore-outcome-unknown', 503)
  error.restoreStatus = 'unknown'
  return error
}

async function compensateSnapshotUpdate(ctx, access, role, previousConfig, updatedConfig, dependencies, providerGuard, expectedHealthy) {
  try { await providerGuard('before-compensation') }
  catch { return 'unknown' }
  const expectedManagedRows = managedRows(previousConfig)
  return rollbackManagedConfig(ctx, access, role, previousConfig, updatedConfig, providerGuard,
    expectedManagedRows, expectedHealthy)
}

function validateMcpServerCollisions(currentConfig, servers) {
  const rows = Array.isArray(currentConfig?.plugins) ? currentConfig.plugins : []
  const serverNames = new Set()
  for (const row of rows) {
    if (!isManagedRow(row) && servers.some(server => server.id === row?.id)) {
      throw new ConfigurationError('invalid-configuration')
    }
    if (isManagedRow(row) && row.id.startsWith(MCP_ID_PREFIX)) continue
    if (row?.name !== MCP_MODULE) continue
    const serverName = row?.config?.serverName
    if (typeof serverName !== 'string' || !SERVER_NAME.test(serverName)) {
      if (servers.length) throw new ConfigurationError('server-name-conflict', 409)
      continue
    }
    serverNames.add(serverName)
    if (servers.some(server => server.config.serverName === serverName || server.id === row.id)) {
      throw new ConfigurationError('server-name-conflict', 409)
    }
  }
  for (const server of servers) {
    if (serverNames.has(server.config.serverName)) throw new ConfigurationError('server-name-conflict', 409)
    serverNames.add(server.config.serverName)
  }
}

async function applyManagedConfigurationCore(ctx, access, role, rawInput, dependencies, { providerGuard, onWriteStart } = {}) {
  validateInputEnvelope(rawInput)
  const entry = activePresetEntry(access, role)
  const current = entry.options.config
  const currentRevision = revisionOf(current)
  if (rawInput?.expectedRevision !== currentRevision) throw new ConfigurationError('revision-conflict', 409)
  const projection = projectManaged(current, role, access.home, dependencies.env ?? process.env)
  if (!projection.editable) throw new ConfigurationError('unsupported-managed-config', 409)
  const input = await validateInput(rawInput, role, access.home, ctx, dependencies, projection.deniedTools)
  const preset = ROLE_PRESETS[role]
  const beforeState = await resolvePresetState(ctx, preset)
  if (!beforeState.available) throw new ConfigurationError('configuration-unavailable', 503)
  if (providerGuard) await providerGuard('before-write')
  const expected = input.expectedRevision
  const nextValue = { mcpServers: input.mcpServers, skill: input.skill, deniedTools: input.deniedTools }
  const intendedConfig = pluginRows({ ...nextValue, mcpServers: input.mcpServers }, current, current, role)
  await onWriteStart?.({ role, beforeDigest: currentRevision, intendedDigest: revisionOf(intendedConfig) })
  const beforeEditConfig = providerGuard ? structuredClone(current ?? {}) : undefined
  let previousConfig
  let updatedConfig
  try {
    await access.editor.edit(entry, (currentConfig, inherited) => {
      if (revisionOf(currentConfig) !== expected) throw new ConfigurationError('revision-conflict', 409)
      if (!projectManaged(currentConfig, role, access.home, dependencies.env ?? process.env).editable) {
        throw new ConfigurationError('unsupported-managed-config', 409)
      }
      validateMcpServerCollisions(currentConfig, input.mcpServers)
      const config = isRecord(currentConfig) ? currentConfig : inherited
      previousConfig = structuredClone(config)
      updatedConfig = pluginRows({ ...nextValue, mcpServers: input.mcpServers }, config, inherited, role)
      return updatedConfig
    })
  } catch (error) {
    if (!providerGuard) throw error
    if (error instanceof ConfigurationError && error.code === 'revision-conflict' && !previousConfig && !updatedConfig) {
      const conflict = new ConfigurationError('snapshot-restore-conflict', 409)
      conflict.restoreStatus = 'conflict'
      throw conflict
    }

    let observedConfig
    try {
      await providerGuard('after-edit-reject')
      observedConfig = activePresetEntry(access, role).options.config
    } catch {
      throw snapshotRestoreFailure('unknown')
    }
    const expectedBefore = previousConfig ?? beforeEditConfig
    const matchesManaged = (left, right) => revisionOf(left) === revisionOf(right)
      && canonical(managedRows(left)) === canonical(managedRows(right))
    if (previousConfig && updatedConfig && matchesManaged(observedConfig, updatedConfig)) {
      throw snapshotRestoreFailure(await compensateSnapshotUpdate(ctx, access, role, previousConfig,
        updatedConfig, dependencies, providerGuard, beforeState.healthy))
    }
    if (matchesManaged(observedConfig, expectedBefore)) {
      const confirmedState = await resolvePresetState(ctx, preset)
      let verifiedConfig
      try {
        await providerGuard('after-edit-reject-resolve')
        if (contextService(ctx, 'configEditor') !== access.editor || contextService(ctx, 'profileContext') !== access.profile) {
          throw new ConfigurationError('snapshot-restore-outcome-unknown', 503)
        }
        verifiedConfig = activePresetEntry(access, role).options.config
      } catch {
        throw snapshotRestoreFailure('unknown')
      }
      if (!matchesManaged(verifiedConfig, expectedBefore)
        || !confirmedState.available || beforeState.healthy && !confirmedState.healthy) {
        throw snapshotRestoreFailure('unknown')
      }
      throw snapshotRestoreFailure({ status: 'restored', healthy: confirmedState.healthy })
    }
    throw snapshotRestoreFailure('conflict')
  }
  if (!updatedConfig || !previousConfig) throw new ConfigurationError('configuration-apply-failed', 503)
  let compensationAttempted = false
  let writtenRevision
  try {
    if (providerGuard) await providerGuard('after-write')
    const afterWrite = activePresetEntry(access, role)
    writtenRevision = revisionOf(updatedConfig)
    if (revisionOf(afterWrite.options.config) !== writtenRevision) throw new ConfigurationError('revision-conflict', 409)

    const afterState = await resolvePresetState(ctx, preset)
    if (providerGuard) await providerGuard('after-resolve')
    const afterResolve = activePresetEntry(access, role)
    if (revisionOf(afterResolve.options.config) !== writtenRevision) throw new ConfigurationError('revision-conflict', 409)
    if (!afterState.available || !afterState.healthy) {
      if (providerGuard) {
        compensationAttempted = true
        throw snapshotRestoreFailure(await compensateSnapshotUpdate(ctx, access, role, previousConfig, updatedConfig, dependencies, providerGuard, beforeState.healthy))
      }
      const restore = await rollbackManagedConfig(ctx, access, role, previousConfig, updatedConfig)
      if (restore === 'conflict') throw new ConfigurationError('revision-conflict', 409)
      if (restore === 'failed' || restore?.status === 'restored' && beforeState.healthy && !restore.healthy) {
        throw new ConfigurationError('configuration-restore-failed', 503)
      }
      throw new ConfigurationError('configuration-apply-failed', 503)
    }
  } catch (error) {
    if (!providerGuard || !previousConfig || !updatedConfig || compensationAttempted) throw error
    if (error?.code === 'snapshot-restore-outcome-unknown') throw error
    if (error?.code === 'snapshot-restore-conflict') throw error
    if (error?.code === 'revision-conflict') {
      error.code = 'snapshot-restore-conflict'
      error.restoreStatus = 'conflict'
      throw error
    }
    compensationAttempted = true
    throw snapshotRestoreFailure(await compensateSnapshotUpdate(ctx, access, role, previousConfig, updatedConfig, dependencies, providerGuard, beforeState.healthy))
  }
  return {
    publicResult: { role, preset, revision: writtenRevision, appliedForNewAgents: true, currentSessionUnchanged: true },
    previousConfig, updatedConfig, beforeHealthy: beforeState.healthy,
  }
}

export function createManagedConfigurationSequenceTracker(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  const readDigest = dependencies.readManagedConfigurationDigest ?? (async role => {
    const access = await accessForRole(ctx, role, dependencies)
    return trustedManagedConfigurationDigest(activePresetEntry(access, role).options.config)
  })
  const configurationHome = dependencies.resolveManagedConfigurationHome ?? (async role =>
    (await accessForRole(ctx, role, dependencies)).home)
  const withLock = async (role, callback) => {
    const home = await configurationHome(role)
    return withRoleWriteLock(home, role, callback)
  }
  const validSequence = state => {
    const value = state.managedConfigurationMutationSequence ?? 0
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new ConfigurationError('managed-configuration-sequence-invalid', 503)
    }
    return value
  }
  async function reconcilePending(store, state) {
    const prior = state.managedConfigurationMutation
    if (!prior || prior.status !== 'pending') return state
    let observedDigest
    try { observedDigest = await readDigest(prior.role) }
    catch { throw new ConfigurationError('managed-configuration-reconcile-retry', 503) }
    await store.transact(current => {
      const row = current.managedConfigurationMutation
      if (row?.sequence !== prior.sequence || row.status !== 'pending') return
      row.observedDigest = observedDigest
      if (observedDigest === row.intendedDigest) {
        row.status = 'ready'
        row.reconcileEvidence = 'authoritative-intended-readback'
      } else if (observedDigest === row.beforeDigest) {
        row.status = 'ready'
        row.reconcileEvidence = 'authoritative-before-readback'
      } else {
        row.status = 'unknown'
        row.reconcileEvidence = 'authoritative-third-digest'
      }
    })
    return await store.read()
  }
  const readIdentityUnderLock = async role => {
    const store = await storeFactory()
    let state = await store.read()
    state = await reconcilePending(store, state)
    if (state.managedConfigurationMutation?.status === 'unknown') {
      throw new ConfigurationError('managed-configuration-outcome-unknown', 503)
    }
    const roleManagedConfigDigest = await readDigest(role)
    return {
      managedConfigurationSequence: validSequence(state),
      roleManagedConfigDigest,
    }
  }
  return Object.freeze({
    async begin({ role, beforeDigest, intendedDigest }) {
      const store = await storeFactory()
      let state = await store.read()
      state = await reconcilePending(store, state)
      let recoveredUnknown
      if (state.managedConfigurationMutation?.status === 'unknown') {
        const prior = state.managedConfigurationMutation
        let observedDigest
        try { observedDigest = await readDigest(prior.role) }
        catch { throw new ConfigurationError('managed-configuration-reconcile-retry', 503) }
        recoveredUnknown = { sequence: prior.sequence, observedDigest }
      }
      const actualBefore = await readDigest(role).catch(() => {
        throw new ConfigurationError('managed-configuration-reconcile-retry', 503)
      })
      if (actualBefore !== beforeDigest) throw new ConfigurationError('revision-conflict', 409)
      const token = await store.transact(current => {
        const sequence = validSequence(current) + 1
        const prior = current.managedConfigurationMutation
        if (prior?.status === 'pending') throw new ConfigurationError('managed-configuration-reconcile-retry', 503)
        current.managedConfigurationMutationSequence = sequence
        current.managedConfigurationMutation = {
          sequence, role, beforeDigest, intendedDigest, status: 'pending', writeStarted: true,
          startedAt: Date.now(),
          ...(recoveredUnknown ? {
            recoveredUnknownSequence: recoveredUnknown.sequence,
            recoveredUnknownObservedDigest: recoveredUnknown.observedDigest,
          } : {}),
        }
        return { sequence, role, beforeDigest, intendedDigest }
      })
      return token
    },
    async finish(token, { error } = {}) {
      const store = await storeFactory()
      let observedDigest
      try { observedDigest = await readDigest(token.role) }
      catch { throw new ConfigurationError('managed-configuration-reconcile-retry', 503) }
      const result = await store.transact(state => {
        const row = state.managedConfigurationMutation
        if (row?.sequence !== token.sequence || row.role !== token.role) {
          throw new ConfigurationError('managed-configuration-operation-changed', 503)
        }
        row.observedDigest = observedDigest
        row.applyErrorCode = error?.code ?? null
        if (observedDigest === token.intendedDigest) {
          row.status = 'ready'
          row.resultEvidence = error ? 'error-with-intended-readback' : 'apply-success-readback'
        } else if (observedDigest === token.beforeDigest) {
          row.status = 'ready'
          row.resultEvidence = 'authoritative-before-readback'
        } else {
          row.status = 'unknown'
          row.resultEvidence = 'authoritative-third-digest'
        }
        return row.status
      })
      if (result === 'unknown') throw new ConfigurationError('managed-configuration-outcome-unknown', 503)
    },
    async readIdentity(role) {
      return await withLock(role, () => readIdentityUnderLock(role))
    },
    readIdentityUnderLock,
    withLock,
  })
}

async function applyManagedConfiguration(ctx, access, role, rawInput, dependencies, options = {}) {
  const tracker = dependencies.managedConfigurationSequenceTracker
  let token
  const callerStart = options.onWriteStart
  const onWriteStart = async details => {
    if (tracker) token = await tracker.begin(details)
    await callerStart?.(details)
  }
  let result
  try { result = await applyManagedConfigurationCore(ctx, access, role, rawInput, dependencies, { ...options, onWriteStart }) }
  catch (error) {
    if (token) await tracker.finish(token, { error })
    throw error
  }
  if (token) await tracker.finish(token)
  return result
}

function createAgentConfigurationController(ctx, dependencies = {}) {
  const assertSnapshotServices = (expectedIdentity, afterWrite = false) => {
    if (!expectedIdentity) return
    if (contextService(ctx, 'configEditor') !== expectedIdentity.editor
      || contextService(ctx, 'profileContext') !== expectedIdentity.profile) {
      throw new ConfigurationError(afterWrite ? 'snapshot-restore-outcome-unknown' : 'configuration-unavailable', 503)
    }
  }
  const accessForSnapshotRole = async (role, expectedIdentity, afterWrite = false) => {
    if (!ROLE_IDS.includes(role)) throw new ConfigurationError('unknown-role')
    assertSnapshotServices(expectedIdentity, afterWrite)
    const access = await accessForRole(ctx, role, dependencies, {
      providerGuard: ({ editor, profile }) => {
        const matchesContext = contextService(ctx, 'configEditor') === editor && contextService(ctx, 'profileContext') === profile
        const matchesExpected = !expectedIdentity || expectedIdentity.editor === editor && expectedIdentity.profile === profile
        if (!matchesContext || !matchesExpected) {
          throw new ConfigurationError(afterWrite ? 'snapshot-restore-outcome-unknown' : 'configuration-unavailable', 503)
        }
      },
    })
    return { ...access, role, providerIdentity: providerIdentity(access, role) }
  }
  const sameIdentity = sameProviderIdentity
  const read = (access, role) => {
    const config = activePresetEntry(access, role).options.config
    return { role, preset: ROLE_PRESETS[role], revision: revisionOf(config), ...projectManaged(config, role, access.home, dependencies.env ?? process.env) }
  }
  const currentAccess = async (role, active, afterWrite = false) => {
    let latest
    try { latest = await accessForSnapshotRole(role, active.providerIdentity, afterWrite) }
    catch (error) {
      if (afterWrite) {
        const sameServiceOwner = contextService(ctx, 'configEditor') === active.providerIdentity.editor
          && contextService(ctx, 'profileContext') === active.providerIdentity.profile
        if (sameServiceOwner && error?.code !== 'snapshot-restore-outcome-unknown') {
          throw new ConfigurationError('snapshot-restore-readback-failed', 503)
        }
        throw new ConfigurationError('snapshot-restore-outcome-unknown', 503)
      }
      throw error
    }
    if (!sameIdentity(active.providerIdentity, latest.providerIdentity)) {
      throw new ConfigurationError(afterWrite ? 'snapshot-restore-outcome-unknown' : 'configuration-unavailable', 503)
    }
    return latest
  }
  return {
    async prepare(role) { return accessForSnapshotRole(role) },
    sameProviderIdentity: sameIdentity,
    async withRole(role, callback, preparedAccess) {
      const prepared = preparedAccess ?? await accessForSnapshotRole(role)
      return withRoleWriteLock(prepared.home, role, async () => {
        const access = await accessForSnapshotRole(role, prepared.providerIdentity)
        if (!sameIdentity(prepared.providerIdentity, access.providerIdentity)) throw new ConfigurationError('configuration-unavailable', 503)
        const state = { access, role, lastRead: null, mutationStarted: false }
        const assertCurrent = async () => {
          const latest = await currentAccess(role, state.access, state.mutationStarted)
          const current = read(latest, role)
          if (state.lastRead && (state.lastRead.revision !== current.revision
            || canonical(state.lastRead.projection) !== canonical({ editable: current.editable, mcpServers: current.mcpServers, skill: current.skill, deniedTools: current.deniedTools }))) {
            throw new ConfigurationError(state.mutationStarted ? 'snapshot-restore-outcome-unknown' : 'revision-conflict', state.mutationStarted ? 503 : 409)
          }
          return latest
        }
        const operations = {
          providerIdentity: access.providerIdentity,
          assertCurrent,
          async read() {
            const latest = await assertCurrent()
            const value = read(latest, role)
            state.lastRead = { revision: value.revision, projection: { editable: value.editable, mcpServers: value.mcpServers, skill: value.skill, deniedTools: value.deniedTools } }
            return value
          },
          async preview(input) {
            const latest = await assertCurrent()
            validateInputEnvelope(input)
            const config = activePresetEntry(latest, role).options.config
            const currentRevision = revisionOf(config)
            if (input.expectedRevision !== currentRevision) throw new ConfigurationError('revision-conflict', 409)
            const currentProjection = projectManaged(config, role, latest.home, dependencies.env ?? process.env)
            if (!currentProjection.editable) throw new ConfigurationError('unsupported-managed-config', 409)
            const previewDependencies = {
              ...dependencies,
              roleWorkspacePathReadOnly: dependencies.roleWorkspacePathReadOnly
                ?? (async currentRole => join(latest.home, 'tradeloom-workspaces', currentRole)),
            }
            const validated = await validateInput(input, role, latest.home, ctx, previewDependencies, currentProjection.deniedTools)
            validateMcpServerCollisions(config, validated.mcpServers)
            const presetState = await resolvePresetState(ctx, ROLE_PRESETS[role])
            if (!presetState.available) throw new ConfigurationError('configuration-unavailable', 503)
            const targetConfig = pluginRows(validated, config, config, role)
            const targetProjection = projectManaged(targetConfig, role, latest.home, dependencies.env ?? process.env)
            return {
              current: { ...currentProjection, revision: currentRevision },
              target: { ...targetProjection, revision: revisionOf(targetConfig) },
            }
          },
          async update(input) {
            const latest = await assertCurrent()
            const providerGuard = async phase => {
              const afterWrite = ['after-write', 'after-resolve', 'after-edit-reject', 'after-edit-reject-resolve',
                'before-compensation', 'after-compensation-write', 'after-compensation-resolve'].includes(phase)
              await currentAccess(role, state.access, afterWrite)
            }
            const mutation = await applyManagedConfiguration(ctx, latest, role, input, dependencies, {
              providerGuard, onWriteStart: () => { state.mutationStarted = true },
            })
            try {
              const verifiedAccess = await currentAccess(role, state.access, true)
              const verifiedConfig = activePresetEntry(verifiedAccess, role).options.config
              if (revisionOf(verifiedConfig) !== mutation.publicResult.revision) {
                const conflict = new ConfigurationError('snapshot-restore-conflict', 409)
                conflict.restoreStatus = 'conflict'
                throw conflict
              }
              if (canonical(managedRows(verifiedConfig)) !== canonical(managedRows(mutation.updatedConfig))) {
                throw new ConfigurationError('snapshot-restore-readback-failed', 503)
              }
            } catch (error) {
              if (error?.code === 'snapshot-restore-outcome-unknown' || error?.code === 'snapshot-restore-conflict') throw error
              if (error?.code === 'revision-conflict') {
                error.code = 'snapshot-restore-conflict'
                error.restoreStatus = 'conflict'
                throw error
              }
              throw snapshotRestoreFailure(await compensateSnapshotUpdate(ctx, latest, role,
                mutation.previousConfig, mutation.updatedConfig, dependencies, providerGuard, mutation.beforeHealthy))
            }
            const updatedProjection = projectManaged(mutation.updatedConfig, role, latest.home, dependencies.env ?? process.env)
            state.lastRead = { revision: mutation.publicResult.revision, projection: {
              editable: updatedProjection.editable, mcpServers: updatedProjection.mcpServers,
              skill: updatedProjection.skill, deniedTools: updatedProjection.deniedTools,
            } }
            state.mutationRecord = { access: latest, mutation, providerGuard }
            return { revision: mutation.publicResult.revision }
          },
        }
        try { return await callback(operations) }
        catch (error) {
          if (state.mutationRecord && !state.compensationAttempted
            && !['snapshot-restore-outcome-unknown', 'snapshot-restore-conflict', 'revision-conflict'].includes(error?.code)) {
            state.compensationAttempted = true
            const { access: mutationAccess, mutation, providerGuard: guard } = state.mutationRecord
            const failure = snapshotRestoreFailure(await compensateSnapshotUpdate(ctx, mutationAccess, role,
              mutation.previousConfig, mutation.updatedConfig, dependencies, guard, mutation.beforeHealthy))
            if (typeof error?.backupSnapshotId === 'string') failure.backupSnapshotId = error.backupSnapshotId
            throw failure
          }
          throw error
        }
      })
    },
  }
}

export function createAgentConfigurationResources(ctx, dependencies = {}) {
  const sharedDependencies = {
    ...dependencies,
    managedConfigurationSequenceTracker: dependencies.managedConfigurationSequenceTracker
      ?? createManagedConfigurationSequenceTracker(ctx, dependencies),
  }
  return {
    configurationHandler: createAgentConfigurationHandler(ctx, sharedDependencies),
    snapshotOperations: createAgentConfigurationController(ctx, sharedDependencies),
    readManagedConfigurationIdentity: role => sharedDependencies.managedConfigurationSequenceTracker.readIdentity(role),
    readManagedConfigurationIdentityUnderLock: role => sharedDependencies.managedConfigurationSequenceTracker.readIdentityUnderLock(role),
    withManagedConfigurationLock: (role, callback) => sharedDependencies.managedConfigurationSequenceTracker.withLock(role, callback),
  }
}

export function createAgentConfigurationHandler(ctx, dependencies = {}) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    let role
    try { role = requestRole(req) }
    catch (error) { sendFailure(res, error); return }
    if (req.method !== 'GET' && req.method !== 'PUT') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, PUT')
      res.end()
      return
    }
    let access
    try { access = await accessForRole(ctx, role, dependencies) }
    catch (error) { sendFailure(res, error); return }

    if (req.method === 'GET') {
      const config = access.entry.options.config
      const projection = projectManaged(config, role, access.home, dependencies.env ?? process.env)
      json(res, 200, {
        role,
        preset: ROLE_PRESETS[role],
        revision: revisionOf(config),
        ...projection,
      })
      return
    }

    let text
    try { text = await readRequestBody(req) }
    catch { json(res, 400, { error: 'invalid-json' }); return }
    if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
    let rawInput
    try { rawInput = JSON.parse(text) }
    catch { json(res, 400, { error: 'invalid-json' }); return }

    try {
      const result = await withRoleWriteLock(access.home, role, async () => {
        return applyManagedConfiguration(ctx, access, role, rawInput, dependencies)
      })
      json(res, 200, result.publicResult)
    } catch (error) { sendFailure(res, error) }
  }
}
