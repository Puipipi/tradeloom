import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function exists(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readExactSource(repoRoot, relative, pin) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('exact-source path must stay inside checkout')
  }
  if (!Number.isSafeInteger(pin?.bytes) || pin.bytes < 0 || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) {
    throw new Error('exact-source pin missing or invalid')
  }
  let path = repoRoot
  for (const part of relative.split('/')) {
    path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('exact-source path is a link')
  }
  const bytes = await readFile(path)
  if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error('exact-source bytes or SHA-256 drift')
  }
  return bytes
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
  const manifest = await readJson(join(repoRoot, 'dsh-base.manifest.json'))
  const problems = []
  const checks = []

  const pins = await readEnginePins(repoRoot, manifest)
  const shellContract = manifest.pluginImportContract.tradeLoomPlugin
  const scopeVersions = shellContract.peerScopeVersions
  const scopeVersionsValid = Array.isArray(scopeVersions) && scopeVersions.length > 0
    && new Set(scopeVersions).size === scopeVersions.length
    && scopeVersions.every(version => typeof version === 'string' && /^\d+\.\d+\.\d+-rc\.\d+$/.test(version)
      && Object.hasOwn(manifest.base.upgrade.recipes, version))
  if (!scopeVersionsValid) problems.push('invalid registered shell peer scope versions')
  for (const [label, value] of Object.entries(pins)) {
    const expected = label === 'scope' ? (scopeVersionsValid ? scopeVersions.join(' || ') : undefined) : manifest.base.version
    checks.push(`engine pin ${label}=${value}`)
    if (!expected || value !== expected) problems.push(`引擎版本钉 ${label} 是 ${value}，对应清单版本是 ${expected}`)
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
  const recipes = manifest.base.upgrade.recipes ?? {}
  for (const [version, recipePath] of Object.entries(recipes)) {
    allowed.add(recipePath)
    if (!await exists(join(repoRoot, recipePath))) {
      problems.push(`已登记的升级配方不存在：${recipePath}`)
      continue
    }
    const recipe = await readJson(join(repoRoot, recipePath))
    if (recipe.schemaVersion !== 1 || recipe.version !== version) problems.push(`recipe version 不匹配：${recipePath}`)
    for (const patch of recipe.patches ?? []) {
      const path = join(dirname(recipePath), patch).replaceAll('\\', '/')
      if (!manifest.base.sanctionedPatches.includes(path)) problems.push(`配方引用未登记的基座补丁：${path}`)
    }
    if (recipe.desktopRecipe) {
      const path = join(dirname(recipePath), recipe.desktopRecipe).replaceAll('\\', '/')
      allowed.add(path)
      if (!await exists(join(repoRoot, path))) problems.push(`已声明的 desktop 配方不存在：${path}`)
      else {
        const desktop = await readJson(join(repoRoot, path))
        if (desktop.schemaVersion !== 1 || desktop.version !== version) problems.push(`desktop recipe version 不匹配：${path}`)
        const overlay = desktop.finalOverlay
        for (const name of [desktop.patch, ...(overlay ? [overlay.patch] : [])]) {
          const patch = typeof name === 'string' ? join(dirname(path), name).replaceAll('\\', '/') : ''
          if (!patch || !manifest.base.sanctionedPatches.includes(patch)) {
            problems.push(`desktop 配方引用未登记的基座补丁：${patch}`)
          }
        }
      }
    }
    if (recipe.programRecipe) {
      const path = join(dirname(recipePath), recipe.programRecipe).replaceAll('\\', '/')
      allowed.add(path)
      if (!await exists(join(repoRoot, path))) problems.push(`已声明的 program 配方不存在：${path}`)
      else {
        const program = await readJson(join(repoRoot, path))
        if (program.schemaVersion !== 1 || program.version !== version) problems.push(`program recipe version 不匹配：${path}`)
        const launcher = program.launcher
        if (launcher?.sourceMode === 'exact-source') {
          try {
            if ('patch' in launcher || 'preimage' in launcher) throw new Error('mixed launcher source mode')
            await readExactSource(repoRoot, launcher.source, launcher.postimage)
          } catch (error) { problems.push(`launcher exact-source: ${error.message}`) }
        } else {
          const patch = typeof launcher?.patch === 'string' ? join(dirname(path), launcher.patch).replaceAll('\\', '/') : ''
          if ((launcher?.sourceMode ?? 'patch') !== 'patch' || !patch || !manifest.base.sanctionedPatches.includes(patch)) {
            problems.push(`program 配方引用未登记的 launcher 补丁：${patch}`)
          }
        }
      }
    }
    if (recipe.businessShell) {
      const business = recipe.businessShell
      if (business.sourceMode === 'exact-source') {
        try {
          if ('patch' in business || 'packageSource' in business) throw new Error('mixed business source mode')
          const packageBytes = await readExactSource(repoRoot, `${business.sourceRoot}/package.json`, business.sourcePackage)
          const pkg = JSON.parse(packageBytes)
          const paths = ['package.json', ...pkg.files]
          if (new Set(paths).size !== paths.length || Object.keys(business.preimages).length !== paths.length
              || Object.keys(business.postimages).length !== paths.length) throw new Error('exact-source business pins must cover the complete package')
          for (const name of paths) {
            const before = business.preimages[name]
            const after = business.postimages[name]
            if (!before || !after || before.bytes !== after.bytes || before.sha256 !== after.sha256) {
              throw new Error('exact-source business pin missing or mismatched')
            }
            await readExactSource(repoRoot, `${business.sourceRoot}/${name}`, before)
          }
        } catch (error) { problems.push(`business exact-source: ${error.message}`) }
      } else {
        const packagePath = typeof business.packageSource === 'string' ? join(dirname(recipePath), business.packageSource).replaceAll('\\', '/') : ''
        if (packagePath) allowed.add(packagePath)
        if (!packagePath || !await exists(join(repoRoot, packagePath))) problems.push(`已声明的候选 package 不存在：${packagePath}`)
        const patch = typeof business.patch === 'string' ? join(dirname(recipePath), business.patch).replaceAll('\\', '/') : ''
        if ((business.sourceMode ?? 'patch') !== 'patch' || !patch || !manifest.base.sanctionedPatches.includes(patch)) {
          problems.push(`business 配方引用未登记的基座补丁：${patch}`)
        }
      }
    }
  }
  const upgradeRoot = join(repoRoot, 'apps/tradeloom-launcher/dsh-upgrades')
  if (await stat(upgradeRoot).then(value => value.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error })) {
    await walk(upgradeRoot, 'apps/tradeloom-launcher/dsh-upgrades')
  }
  for (const file of found) {
    if (!allowed.has(file)) problems.push(`未登记的基座补丁：${file}（必须先在 dsh-base.manifest.json 登记）`)
  }
  checks.push(`override files ${found.length}`)
  checks.push(`versioned upgrade recipes ${Object.keys(recipes).length}`)

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
  const actualExports = shellPkg.exports ?? {}
  const expectedExports = shellContract.exportTargets
  for (const key of Object.keys(actualExports)) {
    if (!Object.hasOwn(expectedExports, key)) problems.push(`插件 exports 新增未登记入口：${key}`)
  }
  for (const [key, relative] of Object.entries(expectedExports)) {
    const target = actualExports[key]
    const actual = typeof target === 'string' ? target : target?.default
    if (actual !== relative) {
      problems.push(`插件 exports["${key}"] 目标失配：${actual} ≠ ${relative}`)
      continue
    }
    if (!await exists(join(repoRoot, dirname(shellContract.manifest), relative))) {
      problems.push(`插件 exports["${key}"] 指向的文件不存在：${relative}`)
    }
  }
  checks.push(`plugin exports ${Object.keys(actualExports).length}/${Object.keys(expectedExports).length}`)

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
