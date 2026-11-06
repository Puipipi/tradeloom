import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../..')
const manifestPath = path.resolve(repoRoot, 'release-source-manifest-r75.json')
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : null).filter(Boolean))
for (const name of ['base-resources', 'plugin-seed', 'output-root', 'asar-tools']) if (!args[name]) throw new Error(`missing --${name}`)
const baseResources = path.resolve(args['base-resources'])
const pluginSeedRoot = path.resolve(args['plugin-seed'])
const outputRoot = path.resolve(args['output-root'])
const toolsRoot = path.resolve(args['asar-tools'])
const requireFromTools = createRequire(path.join(toolsRoot, 'package.json'))
let asarPackageDirectory = path.dirname(requireFromTools.resolve('@electron/asar'))
let asarPackage
for (let depth = 0; depth < 6; depth++) {
  try {
    const candidate = JSON.parse(await fs.readFile(path.join(asarPackageDirectory, 'package.json'), 'utf8'))
    if (candidate.name === '@electron/asar') { asarPackage = candidate; break }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  asarPackageDirectory = path.dirname(asarPackageDirectory)
}
if (!asarPackage || asarPackage.version !== '4.3.1') throw new Error('expected pinned @electron/asar 4.3.1')
const { createPackageWithOptions, extractAll, getRawHeader } = requireFromTools('@electron/asar')
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
if (manifest.adoptions.length !== 300 || new Set(manifest.adoptions.map(row => row.targetPath)).size !== 300) throw new Error('source adoption manifest must contain 300 unique targets')
const expected = {
  baseAsar: { bytes: 172819677, sha256: '1B1E56467E5FB682A7DE176385B38E63937D32DE5ED2D289BF29B4AB95D6DA15' },
  baseDeployment: { bytes: 75753, sha256: '659DE9699911BAFEB6C52F71FF67F20EB6289BECEBA9E88D04727E603F6B61C7' },
  sidecar: { files: 1583, bytes: 255019766, sha256: 'dff1b37d32b0e917f25c6b887552fd8fbbee61564dc6e17519ae171733ec34f0' },
  asar: { files: 18286, bytes: 172823311, sha256: 'E86597AA3FE799C7F69C8B80A2C4CD3A0B45DCE1E76749322CD2024BBF2C0C8D' },
  deployment: { bytes: 75753, sha256: '6847189104017CC29CF292361E70A2568DB6A824B965562AA36A89A1C91586AA' },
  seed: { files: 25170, bytes: 933546613, sha256: 'fec8b9f630e4517fb4f2e727f3229c2757aaeaa51b2ee4b98d8b37a1824e7107', manifestBytes: 6108491, manifestSha256: 'CD845169201FE28D194929A0D865AA8B0E1C4F34438C86439C8705C05AA4E89E' },
}
const sha256 = value => createHash('sha256').update(value).digest('hex').toLowerCase()
const canonicalTree = rows => sha256(Buffer.from([...rows].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(row => `${row.path}\0${row.bytes}\0${row.sha256.toLowerCase()}\n`).join(''), 'utf8'))
async function filePin(file) { const before = await fs.lstat(file); if (!before.isFile() || before.isSymbolicLink()) throw new Error(`not a regular file: ${path.basename(file)}`); const bytes = await fs.readFile(file); const after = await fs.lstat(file); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error(`file changed while reading: ${path.basename(file)}`); return { bytes: bytes.length, sha256: sha256(bytes), data: bytes } }
async function treeInventory(root) {
  const rows = []
  async function walk(dir, relative = '') {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${item.name}` : item.name
      const full = path.join(dir, item.name)
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) throw new Error(`reparse entry rejected: ${rel}`)
      if (stat.isDirectory()) await walk(full, rel)
      else if (stat.isFile()) { const pin = await filePin(full); rows.push({ path: rel.replaceAll('\\', '/'), bytes: pin.bytes, sha256: pin.sha256 }) }
      else throw new Error(`unsupported tree entry: ${rel}`)
    }
  }
  await walk(root)
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { rows, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), sha256: canonicalTree(rows) }
}
async function ensureDirectory(directory) {
  try {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe destination directory: ${directory}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(directory)
    if (parent === directory) throw error
    await ensureDirectory(parent)
    await fs.mkdir(directory)
  }
}
async function copyPinned(source, destination, bytes, hash, replace = false) {
  const pin = await filePin(source)
  if (pin.bytes !== bytes || pin.sha256 !== hash.toLowerCase()) throw new Error(`source pin mismatch: ${path.basename(source)}`)
  await ensureDirectory(path.dirname(destination))
  if (replace) {
    const target = await fs.lstat(destination)
    if (!target.isFile() || target.isSymbolicLink()) throw new Error(`overlay destination is not a regular file: ${path.basename(destination)}`)
    await fs.writeFile(destination, pin.data, { flag: 'w' })
  } else await fs.writeFile(destination, pin.data, { flag: 'wx' })
}
for (const row of manifest.adoptions) {
  if (path.isAbsolute(row.targetPath) || row.targetPath.split('/').some(part => part === '..' || part === '')) throw new Error(`invalid relative source target: ${row.targetPath}`)
  const target = path.resolve(repoRoot, ...row.targetPath.split('/'))
  if (!target.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`source target escapes repository: ${row.targetPath}`)
  const pin = await filePin(target)
  if (pin.bytes !== row.bytes || pin.sha256 !== row.sha256.toLowerCase()) throw new Error(`repository source pin mismatch: ${row.targetPath}`)
}
function flattenHeader(header) {
  const entries = new Map()
  const visit = (node, prefix = '') => { for (const [name, record] of Object.entries(node.files ?? {})) { const rel = prefix ? `${prefix}/${name}` : name; if (record.files) visit(record, rel); else entries.set(rel, record) } }
  visit(header.header)
  return entries
}
function unpackPlan(sourceRoot, entries) {
  const dirs = new Map()
  for (const [name, record] of entries) for (let i = 1; i < name.split('/').length; i++) {
    const directory = name.split('/').slice(0, i).join('/')
    const counts = dirs.get(directory) ?? { total: 0, unpacked: 0 }
    counts.total++; if (record.unpacked) counts.unpacked++; dirs.set(directory, counts)
  }
  const fullDirs = [...dirs].filter(([, count]) => count.total > 0 && count.total === count.unpacked).map(([dir]) => dir).sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'))
  const roots = []
  for (const dir of fullDirs) if (!roots.some(parent => dir.startsWith(`${parent}/`))) roots.push(dir)
  const loose = [...entries].filter(([name, record]) => record.unpacked && (!roots.some(dir => name.startsWith(`${dir}/`)) || name.split('/').some(part => part.startsWith('.')))).map(([name]) => name)
  const patterns = [...roots.map(dir => `${dir}/**`), ...loose].map(rel => path.resolve(sourceRoot, ...rel.split('/')).replaceAll('\\', '/'))
  const pattern = patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`
  if (!patterns.length || pattern.length > 64 * 1024) throw new Error('unpacked pattern is invalid')
  return { pattern, files: [...entries.values()].filter(record => record.unpacked).length }
}
const baseAsar = path.join(baseResources, 'app.asar')
const baseSidecar = `${baseAsar}.unpacked`
const baseDeploymentPath = path.join(baseResources, 'tradeloom', 'deployment.json')
const baseAsarPin = await filePin(baseAsar)
const baseDeploymentPin = await filePin(baseDeploymentPath)
if (baseAsarPin.bytes !== expected.baseAsar.bytes || baseAsarPin.sha256 !== expected.baseAsar.sha256.toLowerCase()) throw new Error('R74 base ASAR pin mismatch')
if (baseDeploymentPin.bytes !== expected.baseDeployment.bytes || baseDeploymentPin.sha256 !== expected.baseDeployment.sha256.toLowerCase()) throw new Error('R74 deployment pin mismatch')
const seedManifestPath = path.join(pluginSeedRoot, 'seed-manifest.json')
const seedManifestPin = await filePin(seedManifestPath)
if (seedManifestPin.bytes !== expected.seed.manifestBytes || seedManifestPin.sha256 !== expected.seed.manifestSha256.toLowerCase()) throw new Error('plugin seed manifest pin mismatch')
const seedManifest = JSON.parse(seedManifestPin.data.toString('utf8'))
if (seedManifest.files.length !== expected.seed.files - 1 || seedManifest.links.length !== 639 || seedManifest.baseBundles.length !== 3 || seedManifest.appendBundles.length !== 19 || Object.keys(seedManifest.dependencies).length !== 20) throw new Error('plugin seed manifest shape mismatch')
const seedRows = []
for (const row of seedManifest.files) {
  const source = path.join(pluginSeedRoot, ...row.path.split('/'))
  const pin = await filePin(source)
  if (pin.bytes !== row.bytes || pin.sha256 !== row.sha256.toLowerCase()) throw new Error(`plugin seed file pin mismatch: ${row.path}`)
  seedRows.push({ path: row.path, bytes: pin.bytes, sha256: pin.sha256, source })
}
seedRows.push({ path: 'seed-manifest.json', bytes: seedManifestPin.bytes, sha256: seedManifestPin.sha256, source: seedManifestPath })
const seedInventory = { rows: seedRows, bytes: seedRows.reduce((sum, row) => sum + row.bytes, 0), sha256: canonicalTree(seedRows) }
if (seedInventory.rows.length !== expected.seed.files || seedInventory.bytes !== expected.seed.bytes || seedInventory.sha256 !== expected.seed.sha256.toLowerCase()) throw new Error('plugin seed tree pin mismatch')
for (const rel of ['loose/cache-sandbox/index.mjs', 'p/202/lib/index.js', 'p/202/assets/whale-widget.js']) {
  const override = manifest.adoptions.find(row => row.sourceRoot === 'r75-plugin-program-seed' && row.sourcePath === rel)
  const seeded = seedManifest.files.find(row => row.path === rel)
  if (!override || !seeded || override.bytes !== seeded.bytes || override.sha256 !== seeded.sha256.toLowerCase()) throw new Error(`plugin override snapshot differs from release seed: ${rel}`)
}
const shellRows = manifest.adoptions.filter(row => row.sourceRoot === 'r75-business-shell')
const shellInventory = { rows: shellRows.map(row => ({ path: row.sourcePath, bytes: row.bytes, sha256: row.sha256 })), bytes: shellRows.reduce((sum, row) => sum + row.bytes, 0) }
shellInventory.sha256 = canonicalTree(shellInventory.rows)
if (shellInventory.rows.length !== 57 || shellInventory.bytes !== 2589539 || shellInventory.sha256 !== '0566e92704d91d415e93672227d0776f62c7364512cde6c84c77470ff5c13784') throw new Error('business-shell source tree pin mismatch')
try { await fs.lstat(outputRoot); throw new Error('output root already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
await fs.mkdir(outputRoot)
const workRoot = path.join(outputRoot, 'work')
const extractedRoot = path.join(workRoot, 'extracted')
const resourcesRoot = path.join(outputRoot, 'resources')
await fs.mkdir(workRoot)
await extractAll(baseAsar, extractedRoot)
const asarRows = manifest.adoptions.filter(row => row.sourceRoot === 'r75-accepted-asar-runtime')
if (asarRows.length !== 96) throw new Error('R75 source runtime row count mismatch')
for (const row of asarRows) await copyPinned(path.join(repoRoot, ...row.targetPath.split('/')), path.join(extractedRoot, ...row.sourcePath.split('/')), row.bytes, row.sha256, true)
for (const row of manifest.adoptions.filter(item => item.sourceRoot === 'r75-sdk-runtime-snapshot')) await copyPinned(path.join(repoRoot, ...row.targetPath.split('/')), path.join(extractedRoot, ...row.asarMember.split('/')), row.bytes, row.sha256, true)
const sourceMain = asarRows.find(row => row.sourcePath === 'lib/main.js')
if (!sourceMain) throw new Error('R75 main source is missing')
const deployment = JSON.parse(baseDeploymentPin.data.toString('utf8'))
const mainHash = sourceMain.sha256.toLowerCase()
deployment.sourceBuild.appMainSha256 = mainHash
const deploymentBytes = Buffer.from(JSON.stringify(deployment, null, 2) + '\n', 'utf8')
const nextDeployment = path.join(resourcesRoot, 'tradeloom', 'deployment.json')
await ensureDirectory(path.dirname(nextDeployment))
await fs.writeFile(nextDeployment, deploymentBytes, { flag: 'wx' })
const outputShell = path.join(resourcesRoot, 'tradeloom', 'business-shell')
for (const row of shellRows) await copyPinned(path.join(repoRoot, ...row.targetPath.split('/')), path.join(outputShell, ...row.sourcePath.split('/')), row.bytes, row.sha256)
const outputSeed = path.join(resourcesRoot, 'tradeloom', 'plugin-seed')
for (const row of seedRows) await copyPinned(row.source, path.join(outputSeed, ...row.path.split('/')), row.bytes, row.sha256)
const stagedAsar = path.join(workRoot, 'app.asar.stage')
const baseEntries = flattenHeader(getRawHeader(baseAsar))
if (baseEntries.size !== 18286) throw new Error('R74 ASAR entry count mismatch')
const unpack = unpackPlan(extractedRoot, baseEntries)
if (unpack.files !== 1583) throw new Error('R74 unpacked member count mismatch')
await createPackageWithOptions(extractedRoot, stagedAsar, { dot: true, unpack: unpack.pattern })
const stagedPin = await filePin(stagedAsar)
if (stagedPin.bytes !== expected.asar.bytes || stagedPin.sha256 !== expected.asar.sha256.toLowerCase()) throw new Error('built ASAR does not match frozen R75 output')
if (deploymentBytes.length !== expected.deployment.bytes || sha256(deploymentBytes) !== expected.deployment.sha256.toLowerCase()) throw new Error('built deployment does not match frozen R75 output')
const stagedSidecar = `${stagedAsar}.unpacked`
const sidecarInventory = await treeInventory(stagedSidecar)
if (sidecarInventory.rows.length !== expected.sidecar.files || sidecarInventory.bytes !== expected.sidecar.bytes || sidecarInventory.sha256 !== expected.sidecar.sha256) throw new Error('rebuilt unpacked sidecar changed')
const finalAsar = path.join(resourcesRoot, 'app.asar')
const finalSidecar = `${finalAsar}.unpacked`
await fs.rename(stagedAsar, finalAsar)
await fs.rename(stagedSidecar, finalSidecar)
const receipt = {
  schemaVersion: 1,
  kind: 'offline-r75-source-adoption-build',
  claims: { built: true, installed: false, launched: false, nativeAccepted: false, published: false },
  inputs: { manifestSha256: sha256(await fs.readFile(manifestPath)), baseAsar: expected.baseAsar, baseDeployment: expected.baseDeployment, pluginSeed: expected.seed },
  outputs: { asar: { bytes: stagedPin.bytes, sha256: stagedPin.sha256 }, deployment: { bytes: deploymentBytes.length, sha256: sha256(deploymentBytes) }, sidecar: { files: sidecarInventory.rows.length, bytes: sidecarInventory.bytes, sha256: sidecarInventory.sha256 }, businessShell: { files: shellInventory.rows.length, bytes: shellInventory.bytes, sha256: shellInventory.sha256 }, pluginSeed: { files: seedInventory.rows.length, bytes: seedInventory.bytes, sha256: seedInventory.sha256 } },
  changedDeploymentLeaf: 'sourceBuild.appMainSha256',
}
await fs.writeFile(path.join(outputRoot, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify({ outputRoot, asar: receipt.outputs.asar, deployment: receipt.outputs.deployment, sidecar: receipt.outputs.sidecar, shell: receipt.outputs.businessShell, pluginSeed: receipt.outputs.pluginSeed }) + '\n')
