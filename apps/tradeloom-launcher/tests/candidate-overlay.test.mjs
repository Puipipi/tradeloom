import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { digestInventory } from '../installed-bootstrap.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest = JSON.parse(await readFile(path.join(repo, 'candidate-source-manifest-o08.json'), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('固定manifest只描述4999候选、冻结R76基包和真实继承SDK', () => {
  assert.equal(manifest.sourceRepository.head, '4999f9e8bb079c7b69fb21982b89234963f7aa8e')
  assert.equal(manifest.sourceRepository.tree, '85803f3774a51a6096b06a1d8f2f304d4d0dc38e')
  assert.equal(manifest.base.zipPin.bytes, 797266789)
  assert.equal(manifest.base.zipPin.sha256, '868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341')
  assert.equal(manifest.base.entries, 39739)
  assert.equal(manifest.inheritedSdk.asarSha256, 'e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d')
  assert.equal(manifest.inheritedSdk.nodeSha256, 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32')
  assert.equal(manifest.provenance, 'candidate source overlay with immutable inherited R76 SDK; not an official source-build receipt')
})

test('backend和package.files源文件逐项匹配固定hash和目标根，无路径逃逸或碰撞', async () => {
  const roots = [['backend', 'resources/tradeloom/backend/'], ['businessShell', 'resources/tradeloom/business-shell/']]
  for (const [key, expectedPrefix] of roots) {
    const rows = manifest[key].files
    assert.equal(rows.length, manifest[key].fileCount)
    assert.ok(rows.length > 0)
    const targets = new Set()
    for (const row of rows) {
      assert.ok(!path.posix.isAbsolute(row.source) && !row.source.includes('\\') && !row.source.split('/').includes('..'))
      assert.ok(row.target.startsWith(expectedPrefix))
      assert.ok(!path.posix.isAbsolute(row.target) && !row.target.split('/').includes('..'))
      assert.ok(!targets.has(row.target.toLowerCase()), `case collision: ${row.target}`)
      targets.add(row.target.toLowerCase())
      const bytes = await readFile(path.join(repo, ...row.source.split('/')))
      assert.equal(bytes.length, row.bytes, row.source)
      assert.equal(sha(bytes), row.sha256, row.source)
    }
    const inventory = rows.map(row => ({ path: row.target.slice(expectedPrefix.length), bytes: row.bytes, sha256: row.sha256 }))
    assert.deepEqual(manifest[key].tree, { files: inventory.length, bytes: inventory.reduce((n,x)=>n+x.bytes,0), sha256: digestInventory(inventory) })
  }
  for (const name of manifest.canonicalBackendModules) {
    const source = await readFile(path.join(repo, 'packages/tradeloom-shell', name))
    const row = manifest.backend.files.find(x => x.source === `packages/tradeloom-shell/${name}`)
    assert.ok(row)
    assert.equal(sha(source), row.sha256)
  }
})

test('production builder固定base pins且拒绝调用方传入任意source manifest/base', async () => {
  const builder = await readFile(path.join(repo, 'apps/tradeloom-launcher/scripts/build-candidate-overlay.mjs'), 'utf8')
  assert.match(builder, /const BASE_PIN = \{ bytes: 797266789, sha256: '868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341' \}/)
  assert.match(builder, /candidate-source-manifest-o08\.json/)
  assert.doesNotMatch(builder, /--base|--manifest|--expected-hash/)
  const writer = await readFile(path.join(repo, 'apps/tradeloom-launcher/scripts/write-candidate-program-zip.py'), 'utf8')
  assert.match(writer, /len\(expected\) != len\(entry\["files"\]\)/)
  assert.match(writer, /base ZIP entry mismatch/)
  assert.match(writer, /candidate-source-overlay/)
})

async function writerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-o08-writer-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repoFixture = path.join(root, 'repo'); await mkdir(repoFixture, { recursive: true })
  const writerText = await readFile(path.join(repo, 'apps/tradeloom-launcher/scripts/write-candidate-program-zip.py'), 'utf8')
  const baseZip = path.join(root, 'base.zip'), entryPath = path.join(root, 'entries.json')
  const files = {
    'workbench/canvas_workflow_definition_api.py': 'api',
    'workbench/workflow_definition_validator.py': 'py-validator',
    'workbench/workflow_definition_validator.mjs': 'js-validator',
    'workbench/migrations/0015_canvas_workflow_definition.py': 'migration',
    'packages/tradeloom-shell/workflow-schema.js': 'schema',
    'packages/tradeloom-shell/workflow-definition.js': 'definition',
    'packages/tradeloom-shell/roles.js': 'roles',
    'packages/tradeloom-shell/package.json': JSON.stringify({ files: ['adapter.js'] }),
    'packages/tradeloom-shell/adapter.js': 'adapter',
  }
  for (const [name, text] of Object.entries(files)) { const full = path.join(repoFixture, ...name.split('/')); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, text) }
  const backendNames = Object.keys(files).filter(name => name.startsWith('workbench/') || /packages\/tradeloom-shell\/(workflow-schema|workflow-definition|roles)\.js$/.test(name))
  const shellNames = ['packages/tradeloom-shell/package.json', 'packages/tradeloom-shell/adapter.js']
  const makeRows = (names, targetRoot, shell = false) => names.map(source => {
    const body = Buffer.from(files[source]); const suffix = shell ? source.replace('packages/tradeloom-shell/', '') : source
    return { source, target: `${targetRoot}/${suffix}`, bytes: body.length, sha256: sha(body) }
  })
  const backend = makeRows(backendNames, 'resources/tradeloom/backend')
  const businessShell = makeRows(shellNames, 'resources/tradeloom/business-shell', true)
  const treePin = rows => {
    const relative = rows.map(row => ({ path: row.target.split('/').slice(3).join('/'), bytes: row.bytes, sha256: row.sha256 })).sort((a,b)=>a.path.localeCompare(b.path,'en'))
    return { files: relative.length, bytes: relative.reduce((n,x)=>n+x.bytes,0), sha256: digestInventory(relative) }
  }
  const sourceManifest = { sourceRepository: { head: '4999f9e8bb079c7b69fb21982b89234963f7aa8e', tree: '85803f3774a51a6096b06a1d8f2f304d4d0dc38e', selectedWorktreePins: [] }, backend: { files: backend, fileCount: backend.length, tree: treePin(backend) }, businessShell: { files: businessShell, fileCount: businessShell.length, tree: treePin(businessShell) } }
  const sourcePath = path.join(repoFixture, 'candidate-source-manifest-o08.json')
  const writeManifest = async () => writeFile(sourcePath, JSON.stringify(sourceManifest))
  const deployment = { resources: { business: { root:'resources/tradeloom/backend', files:[], fileCount:0,bytes:0,sha256:'' }, businessShell:{root:'resources/tradeloom/business-shell',name:'shell',version:'1',fileCount:0,bytes:0,sha256:''} }, runtime:{node:'node'}, sourceBuild:{lock:'fixed'} }
  const zipEntries = { 'app/resources/app.asar':'asar', 'app/resources/runtime/primary-runtime/dependencies/node/bin/node.exe':'node', 'app/resources/tradeloom/deployment.json':JSON.stringify(deployment), 'app/other.txt':'same' }
  const baseManifest = Object.entries(zipEntries).map(([name,text])=>{const b=Buffer.from(text);return {path:name,bytes:b.length,sha256:sha(b)}})
  const entryBytes = Buffer.from(JSON.stringify({files:baseManifest}))
  await writeFile(entryPath, entryBytes)
  const zipScript = `import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n${Object.entries(zipEntries).map(([n,v])=>` z.writestr(${JSON.stringify('TradeLoom-r76/'+n)},${JSON.stringify(v)})`).join('\n')}`
  const created = spawnSync('python', ['-c', zipScript, baseZip], { encoding: 'utf8' })
  assert.equal(created.status, 0, created.stderr)
  const baseBytes = await readFile(baseZip)
  let writer = writerText
    .replace('REPO = pathlib.Path(__file__).resolve().parents[3]', `REPO = pathlib.Path(${JSON.stringify(repoFixture)})`)
    .replace('INSTALLED_BOOTSTRAP = pathlib.Path(__file__).resolve().parents[1] / "installed-bootstrap.mjs"', `INSTALLED_BOOTSTRAP = pathlib.Path(${JSON.stringify(path.join(repo, 'apps/tradeloom-launcher/installed-bootstrap.mjs'))})`)
    .replace(/BASE_ZIP = pathlib\.Path\(r"[^"]+"\)/, `BASE_ZIP = pathlib.Path(${JSON.stringify(baseZip)})`)
    .replace(/ENTRY_MANIFEST = pathlib\.Path\(r"[^"]+"\)/, `ENTRY_MANIFEST = pathlib.Path(${JSON.stringify(entryPath)})`)
    .replace(/BASE_PIN = \(797266789, "[^"]+"\)/, `BASE_PIN = (${baseBytes.length}, "${sha(baseBytes)}")`)
    .replace(/ENTRY_PIN = \(8491236, "[^"]+"\)/, `ENTRY_PIN = (${entryBytes.length}, "${sha(entryBytes)}")`)
    .replace(/SDK = \{[^\n]+/, `SDK = {"app/resources/app.asar": "${sha(Buffer.from('asar'))}", "app/resources/runtime/primary-runtime/dependencies/node/bin/node.exe": "${sha(Buffer.from('node'))}"}`)
    .replaceAll('39739', String(baseManifest.length))
  const helper = path.join(root, 'writer.py'); await writeFile(helper, writer)
  const invoke = async (output, expected) => {
    const currentManifest = await readFile(sourcePath)
    const activeWriter = await readFile(helper, 'utf8')
    await writeFile(helper, activeWriter.replace(/SOURCE_PIN = \(\d+, "[^"]+"\)/, `SOURCE_PIN = (${currentManifest.length}, "${sha(currentManifest)}")`))
    const run = spawnSync('python', [helper, output], { encoding: 'utf8' })
    assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, expected)
    return run.stderr
  }
  await writeManifest()
  return { root, repoFixture, sourceManifest, sourcePath, baseZip, invoke }
}

test('隔离子进程拒绝错误base、缺失O08源、源hash错和禁止输出路径', async t => {
  const f = await writerFixture(t)
  const badBase = path.join(f.root, 'bad-base.zip'); await writeFile(badBase, 'wrong')
  let text = await readFile(path.join(f.root, 'writer.py'), 'utf8')
  text = text.replace(/BASE_ZIP = pathlib\.Path\([^\n]+/, `BASE_ZIP = pathlib.Path(${JSON.stringify(badBase)})`)
  await writeFile(path.join(f.root, 'wrong-base.py'), text)
  const wrongBase = spawnSync('python', [path.join(f.root, 'wrong-base.py'), path.join(f.root, 'out-wrong-base')], { encoding:'utf8' })
  assert.notEqual(wrongBase.status, 0); assert.match(wrongBase.stderr, /frozen base pin mismatch/)
  const missing = structuredClone(f.sourceManifest)
  missing.backend.files = missing.backend.files.filter(x => x.source !== 'workbench/canvas_workflow_definition_api.py'); missing.backend.fileCount--
  missing.backend.tree = (() => { const rows=missing.backend.files.map(x=>({path:x.source,bytes:x.bytes,sha256:x.sha256})); return {files:rows.length,bytes:rows.reduce((n,x)=>n+x.bytes,0),sha256:digestInventory(rows)} })()
  await writeFile(f.sourcePath, JSON.stringify(missing))
  await f.invoke(path.join(f.root,'out-missing'), /omitted required O08\/canonical source/)
  const wrongHash = structuredClone(f.sourceManifest); wrongHash.backend.files[0].sha256 = '0'.repeat(64)
  wrongHash.backend.tree = (() => { const rows=wrongHash.backend.files.map(x=>({path:x.source,bytes:x.bytes,sha256:x.sha256})); return {files:rows.length,bytes:rows.reduce((n,x)=>n+x.bytes,0),sha256:digestInventory(rows)} })()
  await writeFile(f.sourcePath, JSON.stringify(wrongHash))
  await f.invoke(path.join(f.root,'out-hash'), /source pin mismatch/)
  await writeFile(f.sourcePath, JSON.stringify(f.sourceManifest))
  await f.invoke('D:\\Codex-ICT-builds\\ui18-final-20261105-01a16e3f\\p2\\fixture-output', /forbidden output root/)
})
