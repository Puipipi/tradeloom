import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../..')
const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'release-source-manifest-r76.json'), 'utf8'))
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : null).filter(Boolean))
for (const key of ['r74-resources', 'r75-resources', 'plugin-seed', 'output-root']) if (!args[key]) throw new Error(`missing --${key}`)
const r74 = path.resolve(args['r74-resources'])
const r75 = path.resolve(args['r75-resources'])
const seed = path.resolve(args['plugin-seed'])
const output = path.resolve(args['output-root'])
const sha = value => createHash('sha256').update(value).digest('hex').toLowerCase()
async function pin(file) {
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`not an ordinary file: ${path.basename(file)}`)
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) { hash.update(chunk); bytes += chunk.length }
  const after = await fs.lstat(file)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size) throw new Error(`input changed: ${path.basename(file)}`)
  return { bytes, sha256: hash.digest('hex').toLowerCase() }
}
async function requirePin(file, bytes, hash, label) { const actual = await pin(file); if (actual.bytes !== bytes || actual.sha256 !== hash.toLowerCase()) throw new Error(`${label} pin mismatch`); return actual }
async function inventory(root) {
  const rows = []
  async function walk(dir, rel = '') {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${item.name}` : item.name; const full = path.join(dir, item.name); const st = await fs.lstat(full)
      if (st.isSymbolicLink()) throw new Error(`reparse entry: ${name}`)
      if (st.isDirectory()) await walk(full, name)
      else if (st.isFile()) rows.push({ path: name.replaceAll('\\', '/'), ...(await pin(full)) })
      else throw new Error(`unsupported entry: ${name}`)
    }
  }
  await walk(root); rows.sort((a,b)=>a.path.localeCompare(b.path,'en'))
  const tree = sha(Buffer.from(rows.map(x=>`${x.path}\0${x.bytes}\0${x.sha256}\n`).join(''),'utf8'))
  return { rows, bytes: rows.reduce((n,x)=>n+x.bytes,0), sha256: tree }
}
if (manifest.adoptions.length !== 300 || new Set(manifest.adoptions.map(row => row.targetPath)).size !== 300) throw new Error('expected 300 unique frozen source targets')
let checkedTargets = 0
for (const row of manifest.adoptions) {
  if (path.isAbsolute(row.targetPath) || row.targetPath.split('/').some(part => !part || part === '..')) throw new Error(`invalid source path: ${row.targetPath}`)
  const target = path.resolve(repoRoot, ...row.targetPath.split('/'))
  if (!target.startsWith(`${repoRoot}${path.sep}`)) throw new Error(`source target escaped repository: ${row.targetPath}`)
  await requirePin(target, row.bytes, row.sha256, row.targetPath); checkedTargets++
}
const shellRows = manifest.adoptions.filter(row => row.sourceRoot === 'r75-business-shell' || row.sourceRoot === 'r76-business-shell-patch')
if (shellRows.length !== 57) throw new Error('expected 57 business-shell source rows')
const shellInput = shellRows.map(row => ({ path: row.sourcePath, bytes: row.bytes, sha256: row.sha256.toLowerCase() }))
shellInput.sort((a,b)=>a.path.localeCompare(b.path,'en'))
const shellBytes = shellInput.reduce((n,row)=>n+row.bytes,0)
const shellSha = sha(Buffer.from(shellInput.map(row=>`${row.path}\0${row.bytes}\0${row.sha256}\n`).join(''),'utf8'))
if (shellBytes !== 2589497 || shellSha !== '375fa7a53b7b004537351cc1c5dd5d66b2d980e8217d9982de8a1adfeae76558') throw new Error('R76 business-shell source tree mismatch')
const r74Asar = await requirePin(path.join(r74, 'app.asar'), 172819677, '1B1E56467E5FB682A7DE176385B38E63937D32DE5ED2D289BF29B4AB95D6DA15', 'R74 base ASAR')
const r74Deployment = await requirePin(path.join(r74, 'tradeloom', 'deployment.json'), 75753, '659DE9699911BAFEB6C52F71FF67F20EB6289BECEBA9E88D04727E603F6B61C7', 'R74 base deployment')
const r75Asar = await requirePin(path.join(r75, 'app.asar'), 172823311, 'E86597AA3FE799C7F69C8B80A2C4CD3A0B45DCE1E76749322CD2024BBF2C0C8D', 'reused R75 ASAR (also present unchanged in the R76 ZIP)')
const seedManifest = await requirePin(path.join(seed, 'seed-manifest.json'), 6108491, 'CD845169201FE28D194929A0D865AA8B0E1C4F34438C86439C8705C05AA4E89E', 'R75 program seed manifest (present in the R76 ZIP)')
const preimage = manifest.releaseInputs?.r75AdapterPreimage
if (!preimage || !preimage.repositoryPath || path.isAbsolute(preimage.repositoryPath) || preimage.repositoryPath.split('/').some(part => !part || part === '..')) throw new Error('R75 adapter preimage manifest entry missing or unsafe')
await requirePin(path.resolve(repoRoot, ...preimage.repositoryPath.split('/')), preimage.bytes, preimage.sha256, 'R75 adapter build-only preimage')
try { await fs.lstat(output); throw new Error('R76 output root already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
await fs.mkdir(output)
const resources = path.join(output, 'resources')
const shellRoot = path.join(resources, 'tradeloom', 'business-shell')
await fs.mkdir(path.join(resources, 'tradeloom'), { recursive: true })
await fs.mkdir(shellRoot)
await fs.copyFile(path.join(r75, 'app.asar'), path.join(resources, 'app.asar'), constants.COPYFILE_EXCL)
for (const row of shellRows) {
  const source = path.resolve(repoRoot, ...row.targetPath.split('/'))
  const target = path.join(shellRoot, ...row.sourcePath.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await requirePin(source, row.bytes, row.sha256, row.targetPath)
  await fs.copyFile(source, target, constants.COPYFILE_EXCL)
}
const shellActual = await inventory(shellRoot)
if (shellActual.rows.length !== 57 || shellActual.bytes !== 2589497 || shellActual.sha256 !== '375fa7a53b7b004537351cc1c5dd5d66b2d980e8217d9982de8a1adfeae76558') throw new Error('R76 copied business-shell mismatch')
const r74DeploymentBytes = await fs.readFile(path.join(r74, 'tradeloom', 'deployment.json'))
const deployment = JSON.parse(r74DeploymentBytes.toString('utf8'))
const mainRow = manifest.adoptions.find(row => row.sourceRoot === 'r75-accepted-asar-runtime' && row.sourcePath === 'lib/main.js')
if (!mainRow || mainRow.sha256.toLowerCase() !== '5707d9e47febe6ce7c4b369cca13797e69f630eb6b76662c52f8e7a1fa254a07') throw new Error('R75 Main source pin missing or unexpected')
deployment.sourceBuild.appMainSha256 = mainRow.sha256.toLowerCase()
const derivedR75DeploymentBytes = Buffer.from(JSON.stringify(deployment,null,2)+'\n','utf8')
if(derivedR75DeploymentBytes.length!==75753||sha(derivedR75DeploymentBytes)!=='6847189104017cc29cf292361e70a2568db6a824b965562aa36a89a1c91586aa') throw new Error('derived R75 deployment mismatch')
const derivedR75Deployment = { bytes: derivedR75DeploymentBytes.length, sha256: sha(derivedR75DeploymentBytes) }
const beforeShellPatch = structuredClone(deployment)
deployment.resources.businessShell.bytes = shellActual.bytes
deployment.resources.businessShell.sha256 = shellActual.sha256
function changedLeaves(a,b,prefix='') { const out=[]; for(const k of new Set([...Object.keys(a),...Object.keys(b)])){const p=prefix?`${prefix}.${k}`:k;if(a[k]&&b[k]&&typeof a[k]==='object'&&typeof b[k]==='object'&&!Array.isArray(a[k]))out.push(...changedLeaves(a[k],b[k],p));else if(JSON.stringify(a[k])!==JSON.stringify(b[k]))out.push(p)} return out }
const changes = changedLeaves(beforeShellPatch,deployment)
const allowed = new Set(['resources.businessShell.bytes', 'resources.businessShell.sha256'])
if (changes.length !== 2 || changes.some(key => !allowed.has(key))) throw new Error(`R76 deployment changed unexpected shell leaves: ${changes.join(',')}`)
const depBytes = Buffer.from(JSON.stringify(deployment,null,2)+'\n','utf8')
if(depBytes.length!==75753||sha(depBytes)!=='82c06b270620a22d31682c92da65fd776c7f3bb3d0d433f2066751c021a825d6') throw new Error('R76 deployment output pin mismatch')
await fs.writeFile(path.join(resources,'tradeloom','deployment.json'),depBytes,{flag:'wx'})
const asarPin = await pin(path.join(resources,'app.asar'))
if(asarPin.bytes!==r75Asar.bytes||asarPin.sha256!==r75Asar.sha256) throw new Error('reused ASAR changed during copy')
const receipt={schemaVersion:1,status:'r76-source-overlay-built-asar-reused',manifestSha256:sha(await fs.readFile(path.join(repoRoot,'release-source-manifest-r76.json')),),sourceTargets:{files:checkedTargets,changedFromR75:1},r74Base:{asar:r74Asar,deployment:r74Deployment},r75ValidatedReuse:{asar:asarPin,derivedDeployment:derivedR75Deployment,seedManifest},outputs:{appAsar:asarPin,deployment:{bytes:depBytes.length,sha256:sha(depBytes)},businessShell:{files:shellActual.rows.length,bytes:shellActual.bytes,sha256:shellActual.sha256}},changedDeploymentLeaves:changes,sidecar:'Preserved from pristine p2 R74 program base; verified by full package-base tree in ZIP stage.'}
await fs.writeFile(path.join(output,'build-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
process.stdout.write(JSON.stringify({output,receipt:'build-receipt.json',asar:asarPin,deployment:{bytes:depBytes.length,sha256:sha(depBytes)},shell:{files:shellActual.rows.length,bytes:shellActual.bytes,sha256:shellActual.sha256},sourceTargets:checkedTargets,changedTargets:1})+'\n')