import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const manifestPath = path.join(repo, 'candidate-source-manifest-o08.json')
const BASE_ZIP = 'D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/portable-release-r76/TradeLoom-r76.zip'
const ENTRY_MANIFEST = 'D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/portable-release-r76/program-entry-manifest.json'
const BASE_PIN = { bytes: 797266789, sha256: '868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341' }
const ENTRY_PIN = { bytes: 8491236, sha256: '8b87366fdd62c178e3cdadb3fd23954ffaf2aa2736b73b61ac9f8c6ec438a12b' }
const SOURCE_MANIFEST_PIN = { bytes: 69138, sha256: '78ac33f7f256719357453b48ddb170b478717aff8740a2633a1960e6e4a57bcb' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function pin(file) {
  const st = await fs.lstat(file)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`输入不是普通文件：${path.basename(file)}`)
  const h = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(file)) { h.update(chunk); bytes += chunk.length }
  const after = await fs.lstat(file)
  if (bytes !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error(`输入在校验期间变化：${path.basename(file)}`)
  return { bytes, sha256: h.digest('hex') }
}
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
if (manifest.kind !== 'tradeloom-o08-candidate-source-manifest' || manifest.sourceRepository.head !== '4999f9e8bb079c7b69fb21982b89234963f7aa8e' || manifest.sourceRepository.tree !== '85803f3774a51a6096b06a1d8f2f304d4d0dc38e') throw new Error('候选源码清单身份无效')
for (const [file, expected, label] of [[manifestPath, SOURCE_MANIFEST_PIN, 'candidate source manifest'], [BASE_ZIP, BASE_PIN, 'R76 ZIP'], [ENTRY_MANIFEST, ENTRY_PIN, 'R76 entry manifest']]) {
  const actual = await pin(file)
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`${label}固定摘要不匹配`)
}
const entryManifest = JSON.parse(await fs.readFile(ENTRY_MANIFEST, 'utf8'))
if (entryManifest.files.length !== 39739) throw new Error('R76 entry manifest条目数变化')
const outputArg = process.argv[2]
if (!outputArg || process.argv.length !== 3) throw new Error('用法：node build-candidate-overlay.mjs <new-output-directory>')
const output = path.resolve(outputArg)
if (await fs.lstat(output).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) throw new Error('输出目录必须尚不存在')
const forbidden = ['D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/p2', 'D:/Codex-ICT-builds/ui18-final-20261105-01a16e3f/portable-release-r76', 'C:/Users/23825/Desktop/ICT']
if (forbidden.some(root => output.toLowerCase().startsWith(path.resolve(root).toLowerCase()))) throw new Error('输出目录落入禁止路径')
const helper = path.join(here, 'write-candidate-program-zip.py')
const child = spawn('python', [helper, output], { cwd: repo, stdio: 'inherit', windowsHide: true })
await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`装配器退出：${code ?? signal}`))) })
process.stdout.write(JSON.stringify({ status: 'candidate-overlay-assembled', output, sourceHead: manifest.sourceRepository.head, inheritedSdk: manifest.inheritedSdk, entryCount: entryManifest.files.length }) + '\n')
