import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../..')
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : null).filter(Boolean))
for (const key of ['p2-root', 'r75-resources', 'output-root', 'python']) if (!args[key]) throw new Error(`missing --${key}`)
const p2Root = path.resolve(args['p2-root'])
const r75Resources = path.resolve(args['r75-resources'])
const outputRoot = path.resolve(args['output-root'])
const outputRelative = path.relative(repoRoot, outputRoot)
const outputInsideRepo = outputRelative === '' || (!path.isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${path.sep}`))
if (outputInsideRepo) throw new Error('portable ZIP output must be outside the source repository')
const outputStat = await fs.lstat(outputRoot)
if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error('portable ZIP output root must be an existing ordinary directory')
const partPath = path.join(outputRoot, 'TradeLoom-r75.zip.part')
const finalZip = path.join(outputRoot, 'TradeLoom-r75.zip')
const rowsPath = path.join(outputRoot, 'pack-rows.json')
const entryManifestPath = path.join(outputRoot, 'program-entry-manifest.json')
const receiptPath = path.join(outputRoot, 'packaging-receipt.json')
const expected = {
  baseTree: { files: 39739, bytes: 2218773644, sha256: 'c7c5c0e3fdddce08e6cddbb251edc14088d67a92c740a40c3b13669c356651a8' },
  finalFiles: 39739,
  finalBytes: 2218777278,
  oldAsar: { bytes: 172819677, sha256: '1B1E56467E5FB682A7DE176385B38E63937D32DE5ED2D289BF29B4AB95D6DA15' },
  newAsar: { bytes: 172823311, sha256: 'E86597AA3FE799C7F69C8B80A2C4CD3A0B45DCE1E76749322CD2024BBF2C0C8D' },
  oldDeployment: { bytes: 75753, sha256: '659DE9699911BAFEB6C52F71FF67F20EB6289BECEBA9E88D04727E603F6B61C7' },
  newDeployment: { bytes: 75753, sha256: '6847189104017CC29CF292361E70A2568DB6A824B965562AA36A89A1C91586AA' },
  launcher: { bytes: 9728, sha256: 'E6E5BE730BDFA8120E27E6BB33897B75977003860558321E027FAAAA1FE990D5' },
  launcherConfig: { bytes: 125, sha256: '3761A3BC498F35824EE895D8A4EA1B26CCC3C659BA02080BE5EC332294354573' },
}
const sha256 = value => createHash('sha256').update(value).digest('hex').toLowerCase()
async function hashFile(file) {
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`not a regular file: ${path.basename(file)}`)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); bytes += chunk.length }
  const after = await fs.lstat(file)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size) throw new Error(`file changed while hashing: ${path.basename(file)}`)
  return { bytes, sha256: hash.digest('hex') }
}
function canonicalTree(rows) {
  const ordered = [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return sha256(Buffer.from(ordered.map(row => `${row.path}\0${row.bytes}\0${row.sha256.toLowerCase()}\n`).join(''), 'utf8'))
}
async function requirePin(file, pin, label) {
  const actual = await hashFile(file)
  if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256.toLowerCase()) throw new Error(`${label} pin mismatch`)
  return actual
}
for (const file of [partPath, finalZip, rowsPath, entryManifestPath, receiptPath]) {
  try { await fs.lstat(file); throw new Error(`output already exists: ${path.basename(file)}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
const top = await fs.readdir(p2Root, { withFileTypes: true })
const topNames = top.map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en'))
if (topNames.length !== 3 || !topNames.includes('app') || !topNames.includes('launcher.json') || !topNames.includes('启动工作台.exe')) throw new Error('p2 top-level program-only layout changed')
for (const entry of top) if (entry.isSymbolicLink()) throw new Error('p2 root contains reparse entry')
const oldAsarPath = path.join(p2Root, 'app', 'resources', 'app.asar')
const oldDeploymentPath = path.join(p2Root, 'app', 'resources', 'tradeloom', 'deployment.json')
const oldAsar = await requirePin(oldAsarPath, expected.oldAsar, 'R74 p2 ASAR')
const oldDeployment = await requirePin(oldDeploymentPath, expected.oldDeployment, 'R74 p2 deployment')
await requirePin(path.join(p2Root, '启动工作台.exe'), expected.launcher, 'portable C10 launcher')
await requirePin(path.join(p2Root, 'launcher.json'), expected.launcherConfig, 'portable C10 launcher config')
await requirePin(path.join(r75Resources, 'app.asar'), expected.newAsar, 'R75 source-build ASAR')
await requirePin(path.join(r75Resources, 'tradeloom', 'deployment.json'), expected.newDeployment, 'R75 source-build deployment')
console.log(JSON.stringify({ phase: 'preflight-complete', p2Entries: topNames.length, oldAsar: oldAsar.sha256, newAsar: expected.newAsar.sha256 }))

const worker = path.join(scriptDir, 'write-portable-program-zip-r75.py')
const child = spawn(args.python, [worker, p2Root, r75Resources, outputRoot, partPath], { stdio: 'inherit', windowsHide: true })
const childExit = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve(0) : reject(new Error(`zip worker failed: exit=${code} signal=${signal}`)))
})
if (childExit !== 0) throw new Error('zip worker failed')

const rowsDoc = JSON.parse(await fs.readFile(rowsPath, 'utf8'))
const baseRows = rowsDoc.baseRows
const finalRows = rowsDoc.finalRows
if (baseRows.length !== expected.baseTree.files || finalRows.length !== expected.finalFiles) throw new Error('entry manifest file count mismatch')
if (new Set(baseRows.map(row => row.path)).size !== baseRows.length || new Set(finalRows.map(row => row.path)).size !== finalRows.length) throw new Error('duplicate program entry path')
const baseBytes = baseRows.reduce((sum, row) => sum + row.bytes, 0)
const finalBytes = finalRows.reduce((sum, row) => sum + row.bytes, 0)
const baseTreeSha256 = canonicalTree(baseRows)
const finalTreeSha256 = canonicalTree(finalRows)
if (baseBytes !== expected.baseTree.bytes || baseTreeSha256 !== expected.baseTree.sha256) throw new Error('p2 base program tree does not match accepted receipt')
if (finalBytes !== expected.finalBytes) throw new Error('R75 program tree byte count mismatch')

const zipInfo = await hashFile(partPath)
const entryManifest = {
  schemaVersion: 1,
  kind: 'portable-program-entry-manifest',
  zipRoot: 'TradeLoom-r75/',
  files: finalRows.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  tree: { files: finalRows.length, bytes: finalBytes, sha256: finalTreeSha256 },
}
const entryManifestBytes = Buffer.from(JSON.stringify(entryManifest, null, 2) + '\n', 'utf8')
const receipt = {
  schemaVersion: 1,
  status: 'portable-program-zip-readback-verified-not-launched',
  zip: { file: 'TradeLoom-r75.zip', bytes: zipInfo.bytes, sha256: zipInfo.sha256, zipRoot: 'TradeLoom-r75/' },
  baseProgram: { files: baseRows.length, bytes: baseBytes, treeSha256: baseTreeSha256 },
  finalProgram: { files: finalRows.length, bytes: finalBytes, treeSha256: finalTreeSha256 },
  overlays: {
    appAsar: { before: oldAsar, after: expected.newAsar },
    deployment: { before: oldDeployment, after: expected.newDeployment },
  },
  preservedInputs: {
    launcher: expected.launcher,
    launcherConfig: expected.launcherConfig,
    sidecar: { files: 1583, bytes: 255019766, sha256: 'dff1b37d32b0e917f25c6b887552fd8fbbee61564dc6e17519ae171733ec34f0' },
    businessShell: { files: 57, bytes: 2589539, sha256: '0566e92704d91d415e93672227d0776f62c7364512cde6c84c77470ff5c13784' },
    pluginSeed: { files: 25170, bytes: 933546613, sha256: 'fec8b9f630e4517fb4f2e727f3229c2757aaeaa51b2ee4b98d8b37a1824e7107' },
    bundledProgramAssets: 'Includes the frozen 14 backend/data program assets; no profile/DataRoot was added.',
  },
  verification: { baseTreeMatched: true, zipReadbackMatchedEveryEntry: true, memberCount: finalRows.length, dataRootCreated: false, installed: false, launched: false, published: false },
}
await fs.rename(partPath, finalZip)
await fs.writeFile(entryManifestPath, entryManifestBytes, { flag: 'wx' })
await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify({ phase: 'complete', zip: receipt.zip, baseProgram: receipt.baseProgram, finalProgram: receipt.finalProgram, manifest: 'program-entry-manifest.json', receipt: 'packaging-receipt.json' }) + '\n')
