import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../..')
export const BASE = Object.freeze({
  head: 'f0033ee9a377ef8e7b279d351a1353d39fc9ec2c',
  tree: 'da9cc243ff43726876d67dc30aee26274a37c051',
  zip: 'D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/portable-release-r76/TradeLoom-r76.zip',
  zipBytes: 797266789,
  zipSha256: '868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341',
  entryManifest: 'D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/portable-release-r76/program-entry-manifest.json',
  marker: 'D:/Codex-ICT-private-backups/ui18-final-20261105-01a16e3f/stage5-source-feature-additions-20261107/n01-o03-production-owner-checkpoint-20261107/implementation-mainf0033-20261108',
})

const SDK = Object.freeze([
  ['dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js', 21078, '8341045a11cabac8b653f5b8f92f59ab596510079fecd2352a39ba03a1b00ac7', 22911, 'e65f27015abbfbb0f01c9252bb0a8f259082e94d9d7442f2a7c8e908cfac8cc9'],
  ['dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js', 44434, '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684', 48241, 'f04acccc1608e1395be044b8fc00a256735eabae8d33af9fb3c4214b6da46a85'],
  ['dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js', 28257, '7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b', 28880, '19a3992a1c26045af0e02147dd2683d7be81e46ef1aebd1e2693a0cd374bd99e'],
  ['dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', 74599, 'cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033', 84141, '7718bc220318c307ffd84fa3762ad03e6b730cde0c4b8242b9fac001c596a64f'],
  ['dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js', 162201, '1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a', 163035, '6acd8bba3f69b434c5a13f80ac06d076b3c1911b77efe958d507d463ce2c51cc'],
  ['dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-D4iGkJJO.js', 1742658, '5768cc3f3f26c795a73efb6fe68195feb1928a63e25266f52c6ebacd40fa5e5b', 1742862, 'a57a794762829c4a34a038d0252efd31e6f5898fd449af34f691ff18b22aa49b'],
])
export const NEW_SDK_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/native-operation-origin-adapter.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'

function git(root = repoRoot, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  return result.stdout.trim()
}

export async function createSourceManifest(root = repoRoot) {
  const head = git(root, 'rev-parse', 'HEAD')
  const tree = git(root, 'rev-parse', 'HEAD^{tree}')
  if (head !== BASE.head || tree !== BASE.tree) throw new Error('N01 source base HEAD/tree drift')
  const branch = git(root, 'branch', '--show-current')
  const remote = git(root, 'config', '--get', 'remote.origin.url').replace(/\.git$/, '')
  if (branch !== 'integration/n01-production-origin-on-f0033-20261108' || remote !== 'https://github.com/Puipipi/tradeloom') throw new Error('N01 branch or origin identity mismatch')
  const index = spawnSync('git', ['-C', root, 'diff', '--cached', '--quiet'], { windowsHide: true })
  if (index.status !== 0) throw new Error('N01 candidate source index must remain empty')
  const sourceTemplate = JSON.parse(await fs.readFile(path.join(root, 'release-source-manifest-r76.json'), 'utf8'))
  const counts = new Map()
  for (const row of sourceTemplate.adoptions) counts.set(row.sourceRoot, (counts.get(row.sourceRoot) ?? 0) + 1)
  const expectedCounts = { 'r24-backend-freeze': 139, 'r75-accepted-asar-runtime': 96, 'r75-business-shell': 56, 'r76-business-shell-patch': 1, 'r75-plugin-program-seed': 3, 'r75-sdk-runtime-snapshot': 3, 'portable-c10-launcher-source': 2 }
  if (Object.keys(expectedCounts).some(key => counts.get(key) !== expectedCounts[key]) || [...counts.keys()].some(key => !(key in expectedCounts))) throw new Error('R76 full source-map membership drift')
  const entryManifest = JSON.parse(await fs.readFile(BASE.entryManifest, 'utf8'))
  if (entryManifest.files?.length !== 39739) throw new Error('R76 base entry mapping membership drift')
  const baseEntries = new Set(entryManifest.files.map(row => row.path))
  const sourceFiles = []
  for (const row of sourceTemplate.adoptions) {
    const sourcePath = row.targetPath.replaceAll('\\', '/')
    const bytes = await fs.readFile(path.join(root, ...sourcePath.split('/')))
    const archivePath = row.sourcePath.replaceAll('\\', '/')
    const archiveKind = row.sourceRoot === 'r24-backend-freeze' ? 'backend'
      : row.sourceRoot === 'r75-accepted-asar-runtime' || row.sourceRoot === 'r75-sdk-runtime-snapshot' ? 'asar'
        : row.sourceRoot === 'r75-business-shell' || row.sourceRoot === 'r76-business-shell-patch' ? 'businessShell'
          : row.sourceRoot === 'r75-plugin-program-seed' ? 'programResource' : 'sourceOnly'
    const output = archiveKind === 'backend' ? `app/resources/tradeloom/backend/${archivePath}`
      : archiveKind === 'businessShell' ? `app/resources/tradeloom/business-shell/${archivePath}`
        : archiveKind === 'programResource' ? `app/resources/tradeloom/plugin-seed/${archivePath}`
          : archiveKind === 'sourceOnly' ? undefined : undefined
    const baseAbsent = output === undefined ? undefined : !baseEntries.has(output)
    sourceFiles.push({ sourcePath, archiveKind, archivePath, ...(baseAbsent === undefined ? {} : { baseAbsent }), bytes: bytes.length, sha256: sha(bytes) })
  }
  const mappedBackend = new Set(sourceTemplate.adoptions.filter(row => row.sourceRoot === 'r24-backend-freeze').map(row => row.targetPath.replaceAll('\\', '/')))
  const currentBackend = git(root, 'ls-files', 'config', 'workbench').split('\n').filter(Boolean)
    .map(value => value.replaceAll('\\', '/'))
    .filter(value => !/(^|\/)(tests|docs|data|__pycache__)(\/|$)/.test(value) && !value.endsWith('.pyc'))
  for (const sourcePath of currentBackend) {
    if (mappedBackend.has(sourcePath)) continue
    const bytes = await fs.readFile(path.join(root, ...sourcePath.split('/')))
    const archivePath = sourcePath
    const output = `app/resources/tradeloom/backend/${archivePath}`
    sourceFiles.push({ sourcePath, archiveKind: 'backend', archivePath, baseAbsent: !baseEntries.has(output), bytes: bytes.length, sha256: sha(bytes) })
  }
  const shellPackagePath = 'packages/tradeloom-shell/package.json'
  const shellPackage = JSON.parse(await fs.readFile(path.join(root, ...shellPackagePath.split('/')), 'utf8'))
  if (!Array.isArray(shellPackage.files) || shellPackage.files.some(value => typeof value !== 'string' || value.includes('*'))) throw new Error('business-shell package files must be an explicit runtime-path list')
  const mappedShell = new Set(sourceTemplate.adoptions.filter(row => ['r75-business-shell', 'r76-business-shell-patch'].includes(row.sourceRoot)).map(row => row.targetPath.replaceAll('\\', '/').replace('packages/tradeloom-shell/', '')))
  for (const relative of shellPackage.files) {
    if (mappedShell.has(relative)) continue
    const sourcePath = `packages/tradeloom-shell/${relative}`
    const bytes = await fs.readFile(path.join(root, ...sourcePath.split('/')))
    const archivePath = relative
    const output = `app/resources/tradeloom/business-shell/${archivePath}`
    sourceFiles.push({ sourcePath, archiveKind: 'businessShell', archivePath, baseAbsent: !baseEntries.has(output), bytes: bytes.length, sha256: sha(bytes) })
  }
  const patchPath = path.join(root, 'apps/tradeloom-launcher/accepted-sdk-overrides/production-execution-origin.patch')
  const patchBytes = await fs.readFile(patchPath)
  const adapterPath = path.join(root, 'apps/tradeloom-launcher/production-origin/browser-transport-adapter.mjs')
  const adapterBytes = await fs.readFile(adapterPath)
  if (adapterBytes.length !== 6153 || sha(adapterBytes) !== '38c7d2f9f37621b8e9896db697d444e0113d827d159b2c7b01eaca7fc7ebdc7d') throw new Error('new adapter source pin drift')
  const postPins = Object.fromEntries(SDK.map(([entry, , , bytes, digest]) => [entry, [bytes, digest]]))
  postPins[NEW_SDK_ENTRY] = [adapterBytes.length, sha(adapterBytes)]
  const sdkDelta = SDK.map(([entry, baseBytes, baseSha256, postBytes, postSha256]) => ({ path: entry, base: [baseBytes, baseSha256], post: [postBytes, postSha256] }))
  sdkDelta.push({ path: NEW_SDK_ENTRY, baseAbsent: true, post: [adapterBytes.length, sha(adapterBytes)] })
  return {
    schema: 'n01-origin-source-manifest-v1',
    sourceRepository: { remote: 'https://github.com/Puipipi/tradeloom.git', private: true, branch: 'integration/n01-production-origin-on-f0033-20261108', head, tree },
    sourceFiles,
    sdkDelta,
    sdkPatch: { sourcePath: 'apps/tradeloom-launcher/accepted-sdk-overrides/production-execution-origin.patch', bytes: patchBytes.length, sha256: sha(patchBytes), postPins, adapterSource: { sourcePath: 'apps/tradeloom-launcher/production-origin/browser-transport-adapter.mjs', archivePath: NEW_SDK_ENTRY, bytes: adapterBytes.length, sha256: sha(adapterBytes) } },
    base: { zip: BASE.zip, zipBytes: BASE.zipBytes, zipSha256: BASE.zipSha256, entryManifest: BASE.entryManifest },
    mappingTemplate: { path: 'release-source-manifest-r76.json', usedOnlyForArchivePathMapping: true, sourceCommitNotInherited: true, sourceRoots: Object.fromEntries(counts), latestBytesRehashed: true, packageFilesList: 'packages/tradeloom-shell/package.json#files', packageFiles: shellPackage.files.length },
  }
}

export function assertMarkerOutput(outputPath) {
  const output = path.resolve(outputPath)
  const marker = path.resolve(BASE.marker)
  const relative = path.relative(marker, output)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('output must be a new directory inside the N01 private marker')
  return output
}

async function main() {
  const values = new Map()
  const flags = new Set()
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    if (arg === '--build') flags.add(arg)
    else { if (i + 1 >= process.argv.length) throw new Error(`missing value for ${arg}`); values.set(arg.slice(2), process.argv[++i]) }
  }
  const args = Object.fromEntries(values)
  if (!args.output) throw new Error('usage: build-n01-origin-candidate.mjs --output <new-marker-directory> [--build]')
  const output = assertMarkerOutput(args.output)
  try { await fs.lstat(output); throw new Error('output directory already exists; refusing to overwrite') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const manifest = await createSourceManifest()
  const inputDir = assertMarkerOutput(`${output}.source-input`)
  try { await fs.lstat(inputDir); throw new Error('source input marker already exists; refusing overwrite') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.mkdir(inputDir, { recursive: false })
  const manifestPath = path.join(inputDir, 'source-manifest.json')
  await fs.writeFile(manifestPath, json(manifest), { flag: 'wx' })
  const python = process.env.N01_PYTHON ?? 'python'
  const writer = path.join(scriptDir, 'write-n01-origin-candidate.py')
  const command = ['--manifest', manifestPath, '--repo-root', repoRoot, '--patch', path.join(repoRoot, ...manifest.sdkPatch.sourcePath.split('/'))]
  if (flags.has('--build')) command.push('--base-zip', BASE.zip, '--entry-manifest', BASE.entryManifest, '--output-dir', output)
  else command.push('--validate-only')
  const check = spawnSync(python, [writer, ...command], { encoding: 'utf8', windowsHide: true })
  if (check.status !== 0) throw new Error(`N01 source/SDK contract validation failed (${check.status}): ${check.stderr}`)
  const readback = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (sha(Buffer.from(json(readback))) !== sha(Buffer.from(json(manifest)))) throw new Error('source manifest readback mismatch')
  process.stdout.write(JSON.stringify({ status: flags.has('--build') ? 'isolated-candidate-built' : 'source-map-and-sdk-pins-validated', output, sourceFiles: manifest.sourceFiles.length, sdkEntries: manifest.sdkDelta.length, writer: check.stdout.trim() }) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
