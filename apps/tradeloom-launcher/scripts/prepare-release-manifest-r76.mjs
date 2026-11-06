import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../../..')
const source = path.join(repoRoot, 'release-source-manifest-r75.json')
const target = path.join(repoRoot, 'release-source-manifest-r76.json')
const adapterPath = path.join(repoRoot, 'packages/tradeloom-shell/client.replica-palette.js')
const adapterPreimageRelative = 'apps/tradeloom-launcher/accepted-build-inputs/r75/client.replica-palette.js'
const adapterPreimagePath = path.resolve(repoRoot, ...adapterPreimageRelative.split('/'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(await readFile(source, 'utf8'))
if (manifest.sourceRepository.head !== '4f56f8a1d7528e3bfcb805b2d5bb99501dfdcf34') throw new Error('unexpected R75 manifest base');
manifest.sourceRepository.head = 'f73118c6e8866ea31ab81e2d4276842ad69f89ec'
if (manifest.adoptions.length !== 300 || new Set(manifest.adoptions.map(row => row.targetPath)).size !== 300) throw new Error('R75 manifest must contain 300 unique source targets')
const preimageBytes = await readFile(adapterPreimagePath)
if (preimageBytes.length !== 6749 || sha(preimageBytes) !== 'd1ad47c2a8241a0f968016f69a6768a0177d19cc3487c56d016e2832ec56d5bc') throw new Error('R75 adapter preimage pin mismatch')
const bytes = await readFile(adapterPath)
if (bytes.length !== 6707 || sha(bytes) !== 'a086140cbb7a241a0cab30a797472bb42e707cba89c9d4e17321e454aef90b69') throw new Error('R76 adapter source pin mismatch')
const row = manifest.adoptions.find(item => item.targetPath === 'packages/tradeloom-shell/client.replica-palette.js')
if (!row || row.bytes !== 6749 || row.sha256 !== 'd1ad47c2a8241a0f968016f69a6768a0177d19cc3487c56d016e2832ec56d5bc') throw new Error('R75 adapter source preimage mismatch')
manifest.kind = 'relative-source-adoption-map-r76'
manifest.sourceRepository.adoptionBranch = 'delivery/ui18-r76-20261106'
manifest.sourceRepository.head = 'f73118c6e8866ea31ab81e2d4276842ad69f89ec'
manifest.sourceTrees.r76BusinessShell = {
  files: 57,
  bytes: 2589497,
  treeSha256: '375fa7a53b7b004537351cc1c5dd5d66b2d980e8217d9982de8a1adfeae76558',
  provenance: 'R75 external business-shell with the single R76 toast palette adapter change; 57-file canonical package tree'
}
row.sourceRoot = 'r76-business-shell-patch'
row.sourcePath = 'client.replica-palette.js'
row.bytes = bytes.length
row.sha256 = sha(bytes)
row.targetBefore = { state: 'present', bytes: 6749, sha256: 'd1ad47c2a8241a0f968016f69a6768a0177d19cc3487c56d016e2832ec56d5bc' }
manifest.releaseInputs.r75AdapterPreimage = {
  repositoryPath: adapterPreimageRelative,
  bytes: preimageBytes.length,
  sha256: sha(preimageBytes),
  purpose: 'restore-the-fixed-R75-program-tree-before-applying-R76-overlays'
}
manifest.sourcePatches = [{
  id: 'r75-to-r76-toast-palette',
  targetPath: 'packages/tradeloom-shell/client.replica-palette.js',
  before: { bytes: preimageBytes.length, sha256: sha(preimageBytes), repositoryPath: adapterPreimageRelative },
  after: { bytes: bytes.length, sha256: sha(bytes) },
  intent: 'Remove only the toast background alias override so the SDK default dark toast background remains paired with its white label.'
}]
manifest.releaseInputs.outputDeployment = {
  id: 'R76-source-build-output',
  bytes: 75753,
  sha256: '82c06b270620a22d31682c92da65fd776c7f3bb3d0d433f2066751c021a825d6',
  changedDeploymentLeavesFromR74: ['sourceBuild.appMainSha256', 'resources.businessShell.bytes', 'resources.businessShell.sha256']
}
manifest.releaseInputs.outputBusinessShell = { files: 57, bytes: 2589497, sha256: '375fa7a53b7b004537351cc1c5dd5d66b2d980e8217d9982de8a1adfeae76558' }
manifest.releaseInputs.outputAsar = { id: 'R75-validated-output-reused-unchanged-by-R76', bytes: 172823311, sha256: 'E86597AA3FE799C7F69C8B80A2C4CD3A0B45DCE1E76749322CD2024BBF2C0C8D' }
const output = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
await writeFile(target, output)
process.stdout.write(JSON.stringify({ manifest: 'release-source-manifest-r76.json', bytes: output.length, sha256: sha(output), adoptions: manifest.adoptions.length, changedSourceTargets: manifest.sourcePatches.length }) + '\n')