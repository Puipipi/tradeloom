import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, constants as fsConstants } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, copyFile, rename, symlink, writeFile, rmdir } from 'node:fs/promises'
import path from 'node:path'

// Filled from the sealed program-only seed manifest during candidate preparation.
export const PROGRAM_SEED_MANIFEST_SHA256 = 'ce6f03e89a87c60b79f611392e82822a8e7a57113559b359579233d90fd4703e'
const PROFILE_PREFIX = 'harness-home/profiles/desktop/'
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@tradeloom/dsh-business-shell']
const SEED_MANIFEST_NAME = 'seed-manifest.json'
const OFFICIAL_PROFILE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n'
const CACHE_SANDBOX_PATCH = "- insert:\n    - id: cache-sandbox\n      name: './local-plugins/cache-sandbox/index.mjs'\n"

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`invalid ${label} path`)
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`invalid ${label} path`)
  return value
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function digestFile(filename) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function assertOrdinaryPath(root, target, fs) {
  const absoluteRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  if (!isInside(absoluteRoot, absoluteTarget)) throw new Error('program seed path escaped its owned root')
  const relative = path.relative(absoluteRoot, absoluteTarget)
  let current = absoluteRoot
  const rootInfo = await fs.lstat(current)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('program seed root is not an ordinary directory')
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error('reparse point in program seed path')
    if (current !== absoluteTarget && !info.isDirectory()) throw new Error('non-directory component in program seed path')
  }
  return relative
}

function validateManifest(manifest, expectedSha256, rawBytes) {
  if (digestBytes(rawBytes).toLowerCase() !== expectedSha256.toLowerCase()) throw new Error('plugin seed manifest pin mismatch')
  const keys = Object.keys(manifest ?? {}).sort().join(',')
  if (manifest?.schemaVersion !== 1 || keys !== 'appendBundles,baseBundles,dependencies,files,links,schemaVersion') throw new Error('plugin seed manifest schema invalid')
  if (JSON.stringify(manifest.baseBundles) !== JSON.stringify(BASE_BUNDLES)) throw new Error('plugin seed base bundles differ from official profile')
  if (!Array.isArray(manifest.appendBundles) || manifest.appendBundles.length !== 19
    || new Set(manifest.appendBundles).size !== 19 || manifest.appendBundles.some(name => typeof name !== 'string' || !name || BASE_BUNDLES.includes(name))) {
    throw new Error('plugin seed selected bundle list invalid')
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)
    || Object.keys(manifest.dependencies).length !== 20) throw new Error('plugin seed dependency map invalid')
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    if (typeof name !== 'string' || !name || typeof spec !== 'string' || !/^link:\.plugins\/p\/\d{3}$/.test(spec)) throw new Error('plugin seed dependency entry invalid')
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.links) || manifest.links.length !== 639) throw new Error('plugin seed file/link list invalid')
  const seenSource = new Set()
  const seenTarget = new Set()
  for (const file of manifest.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,path,profilePath,sha256') throw new Error('plugin seed file record schema invalid')
    const source = safeRelative(file.path, 'seed file')
    const target = safeRelative(file.profilePath, 'profile file')
    const expectedTarget = source.startsWith('p/') ? `.plugins/${source}` : source === 'loose/cache-sandbox/index.mjs' ? 'local-plugins/cache-sandbox/index.mjs' : ''
    if (!expectedTarget || target !== expectedTarget || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('plugin seed file record invalid')
    if (seenSource.has(source) || seenTarget.has(target)) throw new Error('duplicate plugin seed file')
    seenSource.add(source)
    seenTarget.add(target)
  }
  const seenLinks = new Set()
  for (const link of manifest.links) {
    if (!link || Object.keys(link).sort().join(',') !== 'path,target') throw new Error('plugin seed link schema invalid')
    const linkPath = safeRelative(link.path, 'profile link')
    const targetPath = safeRelative(link.target, 'profile link target')
    const targetMatch = /^\.plugins\/p\/\d{3}$/.test(targetPath)
    const validLink = linkPath.startsWith('node_modules/') || /^\.plugins\/p\/\d{3}\/node_modules\//.test(linkPath)
    if (!validLink || !targetMatch || seenLinks.has(linkPath)) throw new Error('plugin seed link record invalid')
    seenLinks.add(linkPath)
  }
  return manifest
}

async function enumerateSeedFiles(root, manifest, fs) {
  const actual = new Set()
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name
      const filename = path.join(directory, entry.name)
      const info = await fs.lstat(filename)
      if (info.isSymbolicLink()) throw new Error('reparse point in packaged plugin seed')
      if (info.isDirectory()) await visit(filename, next)
      else if (info.isFile()) {
        if (next !== SEED_MANIFEST_NAME) actual.add(next)
        else if (relative) throw new Error('nested seed manifest is not allowed')
      } else throw new Error('unsupported entry in packaged plugin seed')
    }
  }
  await visit(root)
  const expected = new Set(manifest.files.map(file => file.path))
  if (actual.size !== expected.size || [...actual].some(filename => !expected.has(filename))) throw new Error('packaged plugin seed files differ from pinned manifest')
}

async function requireAbsent(filename, fs, label) {
  try {
    await fs.lstat(filename)
    throw new Error(`${label} already exists in fresh profile`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function assertOfficialBaseProfile(profileDir, baseManifest, fs) {
  if (!baseManifest || JSON.stringify(baseManifest.dsh?.profile?.bundles) !== JSON.stringify(BASE_BUNDLES)
    || !baseManifest.dependencies || Array.isArray(baseManifest.dependencies) || Object.keys(baseManifest.dependencies).length !== 0) {
    throw new Error('fresh profile is not the untouched official three-bundle base')
  }
  for (const name of ['.plugins', 'node_modules', 'local-plugins']) await requireAbsent(path.join(profileDir, name), fs, name)
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  await assertOrdinaryPath(profileDir, patchPath, fs)
  const patch = await fs.readFile(patchPath, 'utf8')
  if (patch !== OFFICIAL_PROFILE_PATCH) throw new Error('fresh profile Cordis patch is not the untouched official empty template')
}

export async function installFreshPluginSeed({ resourcesPath, profileDir, fs = { lstat, mkdir, readFile, readdir, realpath, copyFile, rename, symlink, writeFile, rmdir }, expectedManifestSha256 = PROGRAM_SEED_MANIFEST_SHA256 } = {}) {
  const resourceRoot = path.join(path.resolve(resourcesPath), 'tradeloom')
  const seedRoot = path.join(resourceRoot, 'plugin-seed')
  await assertOrdinaryPath(path.resolve(resourcesPath), resourceRoot, fs)
  await assertOrdinaryPath(resourceRoot, seedRoot, fs)
  const manifestPath = path.join(seedRoot, SEED_MANIFEST_NAME)
  await assertOrdinaryPath(seedRoot, manifestPath, fs)
  const rawManifest = await fs.readFile(manifestPath)
  const manifest = validateManifest(JSON.parse(rawManifest.toString('utf8')), expectedManifestSha256, rawManifest)

  const profileInfo = await fs.lstat(profileDir)
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) throw new Error('fresh profile root is not an ordinary directory')
  await assertOrdinaryPath(path.dirname(profileDir), profileDir, fs)
  const packagePath = path.join(profileDir, 'package.json')
  await assertOrdinaryPath(profileDir, packagePath, fs)
  const baseManifest = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  await assertOfficialBaseProfile(profileDir, baseManifest, fs)
  await enumerateSeedFiles(seedRoot, manifest, fs)

  const profileReal = await fs.realpath(profileDir)
  const stageName = `.tradeloom-plugin-seed-stage-${randomBytes(8).toString('hex')}`
  const stageRoot = path.join(profileDir, stageName)
  await fs.mkdir(stageRoot)
  for (const file of manifest.files) {
    const source = path.resolve(seedRoot, ...file.path.split('/'))
    await assertOrdinaryPath(seedRoot, source, fs)
    const sourceDigest = await digestFile(source)
    if (sourceDigest.bytes !== file.bytes || sourceDigest.sha256 !== file.sha256) throw new Error(`plugin seed file integrity mismatch: ${file.path}`)
    const stageRelative = file.profilePath
    const destination = path.resolve(stageRoot, ...stageRelative.split('/'))
    if (!isInside(stageRoot, destination)) throw new Error('plugin seed staging path escaped')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    const copied = await digestFile(destination)
    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error(`copied plugin file integrity mismatch: ${file.path}`)
  }

  const stagePlugins = path.join(stageRoot, '.plugins')
  const stageLocal = path.join(stageRoot, 'local-plugins')
  const profilePlugins = path.join(profileDir, '.plugins')
  const profileLocal = path.join(profileDir, 'local-plugins')
  await fs.rename(stagePlugins, profilePlugins)
  await fs.rename(stageLocal, profileLocal)

  const orderedLinks = [...manifest.links].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path, 'en'))
  for (const item of orderedLinks) {
    const linkPath = path.resolve(profileDir, ...item.path.split('/'))
    const targetPath = path.resolve(profileDir, ...item.target.split('/'))
    if (!isInside(profileReal, linkPath) || !isInside(profileReal, targetPath)) throw new Error('plugin link escaped fresh profile')
    const targetInfo = await fs.lstat(targetPath)
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('plugin link target is not an ordinary profile package directory')
    await fs.mkdir(path.dirname(linkPath), { recursive: true })
    await fs.symlink(targetPath, linkPath, 'junction')
    const linkInfo = await fs.lstat(linkPath)
    const linkReal = await fs.realpath(linkPath)
    const targetReal = await fs.realpath(targetPath)
    if (!linkInfo.isSymbolicLink() || path.resolve(linkReal).toLowerCase() !== path.resolve(targetReal).toLowerCase()
      || !isInside(profileReal, linkReal)) throw new Error('created plugin link does not resolve to its declared internal target')
  }

  const nextManifest = {
    ...baseManifest,
    dependencies: { ...baseManifest.dependencies, ...manifest.dependencies },
    dsh: {
      ...baseManifest.dsh,
      profile: {
        ...baseManifest.dsh.profile,
        bundles: [...BASE_BUNDLES, ...manifest.appendBundles, '@deepseek-ai/dsh-experimental-voice-input-bundle'],
      },
    },
  }
  const stagedPackage = path.join(stageRoot, 'package.json')
  const stagedPatch = path.join(stageRoot, 'cordis.patch.yml')
  const patchBytes = OFFICIAL_PROFILE_PATCH.replace('[]\n', CACHE_SANDBOX_PATCH)
  if (patchBytes === OFFICIAL_PROFILE_PATCH || (patchBytes.match(/id: cache-sandbox/g) ?? []).length !== 1) throw new Error('cache-sandbox fresh profile insert patch invalid')
  await fs.writeFile(stagedPatch, patchBytes, { flag: 'wx' })
  await fs.writeFile(stagedPackage, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(stagedPatch, path.join(profileDir, 'cordis.patch.yml'))
  await fs.rename(stagedPackage, packagePath)
  await fs.rmdir(stageRoot)
  return { bundles: nextManifest.dsh.profile.bundles.length, dependencies: Object.keys(nextManifest.dependencies).length, files: manifest.files.length, links: manifest.links.length }
}

export async function initializeFreshPluginProfile({ appPath, profileDir, resourcesPath, bundles, fs = { lstat, mkdir, rename }, initializeOfficialProfile, seedProfile = installFreshPluginSeed } = {}) {
  if (typeof initializeOfficialProfile !== 'function' || typeof seedProfile !== 'function' || !Array.isArray(bundles)) throw new TypeError('fresh profile initializer dependencies are required')
  const existing = await fs.lstat(profileDir).then(info => info, error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing) throw new Error('refusing to seed an existing profile')
  try {
    await initializeOfficialProfile(appPath, profileDir, bundles)
    await seedProfile({ resourcesPath, profileDir })
  } catch (cause) {
    const created = await fs.lstat(profileDir).then(info => info, error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (created) {
      if (!created.isDirectory() || created.isSymbolicLink()) throw new AggregateError([cause], 'fresh profile seed failed and created path cannot be safely quarantined')
      const failedPath = `${profileDir}.plugin-seed-failed-${Date.now()}-${randomBytes(8).toString('hex')}`
      await fs.rename(profileDir, failedPath)
    }
    throw cause
  }
}
