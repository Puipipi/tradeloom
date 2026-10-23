import { lstat, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const MAX_CONFIG_BYTES = 16 * 1024
const ERROR_MESSAGE = 'ERPNext 私密配置无效。'

function invalidConfiguration() {
  return new Error(ERROR_MESSAGE)
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function rawHostname(authority) {
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    return closingBracket > 0 ? authority.slice(1, closingBracket).toLowerCase() : ''
  }
  return authority.replace(/:\d*$/, '').toLowerCase()
}

function isLoopbackHttp(value, parsed) {
  const authority = /^http:\/\/([^/?#]*)/i.exec(value)?.[1] ?? ''
  if (!authority || authority.includes('@')) return false
  const rawHost = rawHostname(authority)
  const parsedHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (rawHost !== parsedHost) return false
  return rawHost === 'localhost' || rawHost === '::1'
    || (net.isIP(rawHost) === 4 && rawHost.startsWith('127.'))
}

function validateBaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value !== value.trim() || /[\r\n]/.test(value)) throw invalidConfiguration()
  let parsed
  try { parsed = new URL(value) } catch { throw invalidConfiguration() }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1] ?? ''
  if (!parsed.hostname || authority.includes('@') || parsed.username || parsed.password || parsed.search || parsed.hash
    || !['https:', 'http:'].includes(parsed.protocol)
    || (parsed.protocol === 'http:' && !isLoopbackHttp(value, parsed))) throw invalidConfiguration()
  return value
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'apiKey,apiSecret,baseUrl,instanceId,version'
    || value.version !== 1
    || typeof value.instanceId !== 'string' || !value.instanceId.trim() || value.instanceId !== value.instanceId.trim()
    || value.instanceId.length > 128 || /[\r\n]/.test(value.instanceId)
    || typeof value.apiKey !== 'string' || !value.apiKey.trim() || /[\r\n]/.test(value.apiKey)
    || typeof value.apiSecret !== 'string' || !value.apiSecret.trim() || /[\r\n]/.test(value.apiSecret)) {
    throw invalidConfiguration()
  }
  return {
    TRADELOOM_ERPNEXT_BASE_URL: validateBaseUrl(value.baseUrl),
    TRADELOOM_ERPNEXT_INSTANCE_ID: value.instanceId,
    TRADELOOM_ERPNEXT_API_KEY: value.apiKey,
    TRADELOOM_ERPNEXT_API_SECRET: value.apiSecret,
  }
}

async function assertOrdinaryConfigPath(dataRoot, filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !path.isAbsolute(dataRoot)) throw invalidConfiguration()
  const privateDirectory = path.resolve(dataRoot, 'private')
  const expectedFile = path.join(privateDirectory, 'erpnext.json')
  const target = path.resolve(filePath)
  const samePath = process.platform === 'win32'
    ? target.toLowerCase() === expectedFile.toLowerCase()
    : target === expectedFile
  if (!samePath || !isInside(path.resolve(dataRoot), target)) throw invalidConfiguration()

  for (const [candidate, directory] of [[path.resolve(dataRoot), true], [privateDirectory, true], [expectedFile, false]]) {
    let info
    try { info = await lstat(candidate) } catch { throw invalidConfiguration() }
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw invalidConfiguration()
    if (!directory && info.size > MAX_CONFIG_BYTES) throw invalidConfiguration()
  }
  return expectedFile
}

export async function loadErpNextConfigFile(filePath, dataRoot) {
  try {
    const configPath = await assertOrdinaryConfigPath(dataRoot, filePath)
    const content = await readFile(configPath)
    if (content.byteLength > MAX_CONFIG_BYTES) throw invalidConfiguration()
    let parsed
    try { parsed = JSON.parse(content.toString('utf8')) } catch { throw invalidConfiguration() }
    return validateConfig(parsed)
  } catch {
    throw invalidConfiguration()
  }
}

export const ERPNEXT_CONFIG_LIMIT_BYTES = MAX_CONFIG_BYTES
