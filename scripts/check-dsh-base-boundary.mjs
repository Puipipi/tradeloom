import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const manifestPath = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dsh-base.manifest.json')

async function exists(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readEnginePins(repoRoot, manifest) {
  const pins = manifest.base.enginePins
  const renderers = await readFile(join(repoRoot, Object.keys(pins)[0]), 'utf8')
  const adapted = /var ADAPTED_ENGINE = '([^']+)'/.exec(renderers)?.[1]
  const main = await readFile(join(repoRoot, Object.keys(pins)[1]), 'utf8')
  const desktop = /function desktopClientVersion\(\) \{\s*return "([^"]+)"/.exec(main)?.[1]
  const shellPkg = await readJson(join(repoRoot, Object.keys(pins)[2]))
  const scope = shellPkg.peerDependencies?.['@deepseek-ai/dsh-scope']
  return { adapted, desktop, scope }
}

export async function checkBoundary(repoRoot) {
  const manifest = await readJson(manifestPath)
  const problems = []
  const checks = []

  const pins = await readEnginePins(repoRoot, manifest)
  const expected = manifest.base.version
  for (const [label, value] of Object.entries(pins)) {
    checks.push(`engine pin ${label}=${value}`)
    if (value !== expected) problems.push(`引擎版本钉 ${label} 是 ${value}，manifest 基座版本是 ${expected}`)
  }

  for (const patch of manifest.base.sanctionedPatches) {
    if (!await exists(join(repoRoot, patch))) problems.push(`已登记的基座补丁不存在：${patch}`)
  }
  checks.push(`sanctioned patches ${manifest.base.sanctionedPatches.length}`)

  const sdkOverrideRoot = join(repoRoot, 'apps/tradeloom-launcher/accepted-sdk-overrides')
  const allowed = new Set([...manifest.base.sanctionedPatches, ...(manifest.base.sanctionedDocs ?? [])])
  const found = []
  async function walk(dir, prefix = 'apps/tradeloom-launcher/accepted-sdk-overrides') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childPrefix = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), childPrefix)
      else found.push(childPrefix)
    }
  }
  await walk(sdkOverrideRoot)
  for (const file of found) {
    if (!allowed.has(file)) problems.push(`未登记的基座补丁：${file}（必须先在 dsh-base.manifest.json 登记）`)
  }
  checks.push(`override files ${found.length}`)

  const bootstrap = await readFile(join(repoRoot, 'apps/tradeloom-launcher/installed-bootstrap.mjs'), 'utf8')
  const bundleMatch = /INSTALLED_PROFILE_BUNDLES = \[([^\]]*)\]/.exec(bootstrap)
  const bundles = bundleMatch ? bundleMatch[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
  const expectedBundles = manifest.pluginImportContract.profileBundles
  if (bundles.join(',') !== expectedBundles.join(',')) {
    problems.push(`profile bundle 顺序或内容变了：[${bundles.join(', ')}] ≠ [${expectedBundles.join(', ')}]`)
  }
  checks.push(`profile bundles ${bundles.length}`)

  const shellPkg = await readJson(join(repoRoot, manifest.pluginImportContract.tradeLoomPlugin.manifest))
  if (shellPkg.name !== manifest.pluginImportContract.tradeLoomPlugin.name) {
    problems.push(`插件包名变了：${shellPkg.name}`)
  }
  const exportKeys = Object.keys(shellPkg.exports ?? {})
  const expectedKeys = manifest.pluginImportContract.tradeLoomPlugin.exportKeys
  const missingKeys = expectedKeys.filter(key => !exportKeys.includes(key))
  if (missingKeys.length) problems.push(`插件 exports 缺键：${missingKeys.join(', ')}（会破坏直接导入）`)
  for (const key of expectedKeys) {
    const target = shellPkg.exports?.[key]
    const rel = typeof target === 'string' ? target : target?.default
    if (!rel) { problems.push(`插件 exports["${key}"] 没有目标文件`); continue }
    if (!await exists(join(repoRoot, dirname(manifest.pluginImportContract.tradeLoomPlugin.manifest), rel))) {
      problems.push(`插件 exports["${key}"] 指向的文件不存在：${rel}`)
    }
  }
  checks.push(`plugin exports ${exportKeys.length}/${expectedKeys.length}`)

  for (const entry of manifest.pluginImportContract.tradeLoomPlugin.hostEntry
    ? [manifest.pluginImportContract.tradeLoomPlugin.hostEntry, manifest.pluginImportContract.tradeLoomPlugin.clientEntry]
    : []) {
    if (!await exists(join(repoRoot, entry))) problems.push(`插件入口缺失：${entry}`)
  }

  return { ok: problems.length === 0, problems, checks, manifest }
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return pathToFileURL(entry).href === import.meta.url } catch { return false }
})()

if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const result = await checkBoundary(repoRoot)
  console.log(JSON.stringify({ status: result.ok ? 'dsh-base-boundary-ok' : 'dsh-base-boundary-violations', ...result, manifest: undefined }, null, 1))
  if (!result.ok) process.exitCode = 1
}