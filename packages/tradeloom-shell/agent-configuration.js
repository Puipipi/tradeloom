import { createHash } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ROLE_IDS, ROLE_PRESETS } from './roles.js'
import { HOME_MARKER_VALUE, resolveOwnedHome, roleWorkspacePath, roleWorkspacePathReadOnly } from './state.js'

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

function serviceIdentity(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value
  try { return value[Symbol.for('cordis.original')] ?? value } catch { return value }
}

function sameProviderIdentity(left, right) {
  return Boolean(left && right && left.editor === right.editor && left.profile === right.profile)
}

async function accessForRole(ctx, role, dependencies) {
  const editor = contextService(ctx, 'configEditor')
  const profile = contextService(ctx, 'profileContext')
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new ConfigurationError('configuration-unavailable', 503)
  }
  let home
  try { home = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)() }
  catch { throw new ConfigurationError('profile-not-owned', 403) }
  await validateOwnedProfile(profile, home, editor)

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
  return { role, home, editor, entry: target, profile, activeFiberState,
    providerIdentity: { editor: serviceIdentity(editor), profile: serviceIdentity(profile) } }
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

async function withRoleWriteLock(home, role, callback) {
  const key = `${resolve(home).toLocaleLowerCase('en-US')}\0${role}`
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

async function rollbackManagedConfig(ctx, access, role, previousConfig, failedConfig) {
  try {
    const entry = activePresetEntry(access, role)
    await access.editor.edit(entry, (currentConfig, inherited) => {
      if (revisionOf(currentConfig) !== revisionOf(failedConfig)) throw new ConfigurationError('revision-conflict', 409)
      return restoreManagedRows(currentConfig ?? inherited, previousConfig)
    })
    const afterWrite = activePresetEntry(access, role)
    if (revisionOf(afterWrite.options.config) !== revisionOf(previousConfig)) return 'conflict'
    const resolved = await resolvePresetState(ctx, ROLE_PRESETS[role])
    if (!resolved.available) return 'failed'
    const afterResolve = activePresetEntry(access, role)
    if (revisionOf(afterResolve.options.config) !== revisionOf(previousConfig)) return 'conflict'
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

async function validateSkillPaths(value, role, home, dependencies, { readOnlyWorkspace = false } = {}) {
  if (!hasExactKeys(value, ['includeDefaultRoots', 'customSkillDirs'])
    || typeof value.includeDefaultRoots !== 'boolean'
    || !Array.isArray(value.customSkillDirs) || value.customSkillDirs.length > 32) {
    throw new ConfigurationError('invalid-configuration')
  }
  const env = dependencies.env ?? process.env
  const resolveWorkspace = readOnlyWorkspace
    ? (dependencies.roleWorkspacePathReadOnly ?? (roleId => roleWorkspacePathReadOnly(roleId, env)))
    : (dependencies.roleWorkspacePath ?? roleWorkspacePath)
  const root = await resolveWorkspace(role)
  const rootReal = await realpath(root).catch(() => undefined)
  if (!rootReal) {
    if (readOnlyWorkspace && value.customSkillDirs.length === 0) {
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

async function validateInput(input, role, home, ctx, dependencies, currentDeniedTools, { readOnlyWorkspace = false } = {}) {
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
  const skill = await validateSkillPaths(input.skill, role, home, dependencies, { readOnlyWorkspace })
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

async function readManagedConfiguration(access, role, dependencies) {
  const entry = activePresetEntry(access, role)
  const config = entry.options.config
  return {
    role,
    preset: ROLE_PRESETS[role],
    revision: revisionOf(config),
    ...projectManaged(config, role, access.home, dependencies.env ?? process.env),
  }
}

async function validateManagedUpdate(ctx, access, role, rawInput, dependencies, { readOnlyWorkspace = false } = {}) {
  validateInputEnvelope(rawInput)
  const entry = activePresetEntry(access, role)
  const current = entry.options.config
  const currentRevision = revisionOf(current)
  if (rawInput.expectedRevision !== currentRevision) throw new ConfigurationError('revision-conflict', 409)
  const projection = projectManaged(current, role, access.home, dependencies.env ?? process.env)
  if (!projection.editable) throw new ConfigurationError('unsupported-managed-config', 409)
  const input = await validateInput(rawInput, role, access.home, ctx, dependencies, projection.deniedTools, { readOnlyWorkspace })
  return { input, currentRevision, currentConfig: current }
}

async function previewManagedConfiguration(ctx, access, role, rawInput, dependencies) {
  const validated = await validateManagedUpdate(ctx, access, role, rawInput, dependencies, { readOnlyWorkspace: true })
  validateMcpServerNames(validated.currentConfig, validated.input.mcpServers)
  const presetState = await resolvePresetState(ctx, ROLE_PRESETS[role])
  if (!presetState.available) throw new ConfigurationError('configuration-unavailable', 503)
  const entry = activePresetEntry(access, role)
  const base = isRecord(entry.options.config) ? entry.options.config : { id: ROLE_PRESETS[role], plugins: [] }
  const targetConfig = pluginRows({ ...validated.input, mcpServers: validated.input.mcpServers }, base, base, role)
  const target = projectManaged(targetConfig, role, access.home, dependencies.env ?? process.env)
  if (!target.editable) throw new ConfigurationError('unsupported-managed-config', 409)
  return { ...validated, current: await readManagedConfiguration(access, role, dependencies), target }
}

function validateMcpServerNames(currentConfig, inputServers) {
  const rows = Array.isArray(currentConfig?.plugins) ? currentConfig.plugins : []
  const serverNames = new Set()
  for (const row of rows) {
    if (!isManagedRow(row) && inputServers.some(server => server.id === row?.id)) {
      throw new ConfigurationError('invalid-configuration')
    }
    if (isManagedRow(row) && row.id.startsWith(MCP_ID_PREFIX)) continue
    if (row?.name !== MCP_MODULE) continue
    const serverName = row?.config?.serverName
    if (typeof serverName !== 'string' || !SERVER_NAME.test(serverName)) {
      if (inputServers.length) throw new ConfigurationError('server-name-conflict', 409)
      continue
    }
    serverNames.add(serverName)
    if (inputServers.some(server => server.config.serverName === serverName || server.id === row.id)) {
      throw new ConfigurationError('server-name-conflict', 409)
    }
  }
  for (const server of inputServers) {
    if (serverNames.has(server.config.serverName)) throw new ConfigurationError('server-name-conflict', 409)
    serverNames.add(server.config.serverName)
  }
}

async function updateManagedConfiguration(ctx, access, role, rawInput, dependencies) {
  const { input } = await validateManagedUpdate(ctx, access, role, rawInput, dependencies)
  const entry = activePresetEntry(access, role)
  const preset = ROLE_PRESETS[role]
  const beforeState = await resolvePresetState(ctx, preset)
  if (!beforeState.available) throw new ConfigurationError('configuration-unavailable', 503)
  const expected = input.expectedRevision
  const nextValue = {
    mcpServers: input.mcpServers,
    skill: input.skill,
    deniedTools: input.deniedTools,
  }
  let previousConfig
  let updatedConfig
  await access.editor.edit(entry, (currentConfig, inherited) => {
    if (revisionOf(currentConfig) !== expected) throw new ConfigurationError('revision-conflict', 409)
    if (!projectManaged(currentConfig, role, access.home, dependencies.env ?? process.env).editable) {
      throw new ConfigurationError('unsupported-managed-config', 409)
    }
    validateMcpServerNames(currentConfig, input.mcpServers)
    const config = isRecord(currentConfig) ? currentConfig : inherited
    previousConfig = structuredClone(config)
    updatedConfig = pluginRows({ ...nextValue, mcpServers: input.mcpServers }, config, inherited, role)
    return updatedConfig
  })
  if (!updatedConfig || !previousConfig) throw new ConfigurationError('configuration-apply-failed', 503)
  const afterWrite = activePresetEntry(access, role)
  const writtenRevision = revisionOf(updatedConfig)
  if (revisionOf(afterWrite.options.config) !== writtenRevision) throw new ConfigurationError('revision-conflict', 409)

  const afterState = await resolvePresetState(ctx, preset)
  const afterResolve = activePresetEntry(access, role)
  if (revisionOf(afterResolve.options.config) !== writtenRevision) throw new ConfigurationError('revision-conflict', 409)
  if (!afterState.available || !afterState.healthy) {
    const restore = await rollbackManagedConfig(ctx, access, role, previousConfig, updatedConfig)
    if (restore === 'conflict') throw new ConfigurationError('revision-conflict', 409)
    if (restore === 'failed' || restore?.status === 'restored' && beforeState.healthy && !restore.healthy) {
      throw new ConfigurationError('configuration-restore-failed', 503)
    }
    throw new ConfigurationError('configuration-apply-failed', 503)
  }
  return {
    role,
    preset,
    revision: writtenRevision,
    appliedForNewAgents: true,
    currentSessionUnchanged: true,
  }
}

export function createAgentConfigurationController(ctx, dependencies = {}) {
  async function readWithIdentity(role) {
    const access = await accessForRole(ctx, role, dependencies)
    return { configuration: await readManagedConfiguration(access, role, dependencies), providerIdentity: access.providerIdentity }
  }

  async function read(role) {
    return (await readWithIdentity(role)).configuration
  }

  async function withRole(role, operation, preparedAccess) {
    if (typeof operation !== 'function') throw new TypeError('configuration operation must be callable')
    const access = preparedAccess ?? await accessForRole(ctx, role, dependencies)
    if (access.role !== role) throw new ConfigurationError('configuration-unavailable', 503)
    return withRoleWriteLock(access.home, role, () => operation(Object.freeze({
      read: () => readManagedConfiguration(access, role, dependencies),
      providerIdentity: access.providerIdentity,
      async assertCurrent() {
        const editor = contextService(ctx, 'configEditor')
        const profile = contextService(ctx, 'profileContext')
        const identity = { editor: serviceIdentity(editor), profile: serviceIdentity(profile) }
        if (!sameProviderIdentity(identity, access.providerIdentity)) throw new ConfigurationError('configuration-unavailable', 503)
        let currentHome
        try { currentHome = await (dependencies.resolveOwnedHome ?? resolveOwnedHome)(dependencies.env ?? process.env) }
        catch { throw new ConfigurationError('profile-not-owned', 403) }
        if (!samePath(currentHome, access.home)) throw new ConfigurationError('profile-not-owned', 403)
        await validateOwnedProfile(profile, currentHome, editor)
        activePresetEntry({ ...access, editor }, role)
      },
      validate: input => validateManagedUpdate(ctx, access, role, input, dependencies),
      preview: input => previewManagedConfiguration(ctx, access, role, input, dependencies),
      update: input => updateManagedConfiguration(ctx, access, role, input, dependencies),
    })))
  }

  async function prepare(role) { return await accessForRole(ctx, role, dependencies) }

  return Object.freeze({ read, readWithIdentity, withRole, prepare, sameProviderIdentity })
}

export function createAgentConfigurationHandler(ctx, dependencies = {}) {
  const controller = dependencies.configurationController ?? createAgentConfigurationController(ctx, dependencies)
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
    if (req.method === 'GET') {
      try { json(res, 200, await controller.read(role)) }
      catch (error) { sendFailure(res, error) }
      return
    }
    let access
    try { access = await controller.prepare(role) }
    catch (error) { sendFailure(res, error); return }
    let text
    try { text = await readRequestBody(req) }
    catch { json(res, 400, { error: 'invalid-json' }); return }
    if (text === null) { json(res, 413, { error: 'request-too-large' }); return }
    let rawInput
    try { rawInput = JSON.parse(text) }
    catch { json(res, 400, { error: 'invalid-json' }); return }
    try {
      const result = await controller.withRole(role, operations => operations.update(rawInput), access)
      json(res, 200, result)
    } catch (error) { sendFailure(res, error) }
  }
}
