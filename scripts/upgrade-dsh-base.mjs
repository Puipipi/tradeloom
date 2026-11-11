#!/usr/bin/env node
/**
 * DSH 基座一键升级工具（TradeLoom）
 *
 * 用法：
 *   node scripts/upgrade-dsh-base.mjs --source <app.asar|dsh目录> --version 0.2.2-rc.1 --dry-run
 *   node scripts/upgrade-dsh-base.mjs --source <...> --version 0.2.2-rc.1 --stage D:/staging/dsh-0.2.2
 *
 * 做四件事：
 *   1. 从新版基座取 dsh/**（asar 里读，或直接拷目录）
 *   2. 把 accepted-sdk-overrides 里的补丁配方打到干净基座上（GNU patch，fuzz=3），逐 hunk 统计
 *   3. 修正打包截断瑕疵（部分旧包首行多 '>'、sourceMappingURL 被截断），新基座若已正常则跳过
 *   4. 改写三处引擎版本钉 + dsh-base.manifest.json
 *
 * 任何 hunk 打不上 -> 非零退出，不产出半成品。这是“一键”的安全边界：
 * 宁可红着停，也不要生成一个偷偷少了功能的基座。
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const overridesDir = join(repoRoot, 'apps/tradeloom-launcher/accepted-sdk-overrides')
const PATCH_FILES = ['production-execution-origin.patch', 'session-list-failure-phase.patch']
const TRUNCATION_TARGETS = [
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
  'dsh/node_modules/@deepseek-ai/dsh-client-ui-attachment/lib/client.js',
]

export function parseArgs(argv) {
  const args = { dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--source') args.source = argv[++index]
    else if (token === '--version') args.version = argv[++index]
    else if (token === '--stage') args.stage = argv[++index]
    else if (token === '--dry-run') args.dryRun = true
    else if (token === '--keep-temp') args.keepTemp = true
  }
  if (!args.source) throw new Error('缺少 --source（新版基座的 app.asar 或 dsh 目录）')
  if (!args.version) throw new Error('缺少 --version（例如 0.2.2-rc.1）')
  return args
}

async function readAsarHeader(handle) {
  const head = await readFileFrom(handle, 0, 64)
  const offset = head.indexOf('{"files"')
  if (offset < 0) throw new Error('不是有效的 asar：找不到 JSON 头')
  const buffer = await readFileFrom(handle, offset, 96 * 1024 * 1024)
  const jsonBytes = scanJsonObject(buffer)
  if (jsonBytes <= 0) throw new Error('不是有效的 asar：JSON 头括号不配对')
  const header = JSON.parse(buffer.subarray(0, jsonBytes).toString('utf8'))
  return { header, baseOffset: offset, jsonBytes }
}

function scanJsonObject(buffer) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true
      else if (byte === 0x22) inString = false
      continue
    }
    if (byte === 0x22) { inString = true; continue }
    if (byte === 0x7b) depth += 1
    else if (byte === 0x7d) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

async function readFileFrom(handle, start, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, start)
  return buffer.subarray(0, bytesRead)
}

function* walkAsar(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (child.files) yield* walkAsar(child, path)
    else yield [path, child]
  }
}

async function readAsarTreeIndex(sourcePath) {
  const { open } = await import('node:fs/promises')
  const handle = await open(sourcePath)
  try {
    const { header, baseOffset, jsonBytes } = await readAsarHeader(handle)
    const entries = new Map()
    for (const [path, meta] of walkAsar(header)) {
      if (!path.startsWith('/dsh/')) continue
      entries.set(path.slice(1), meta)
    }
    return { handle, baseOffset: baseOffset + jsonBytes, entries }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function probeSource(source) {
  const stat = await run('node', ['-e', `require('node:fs').statSync(${JSON.stringify(source)});console.log(1)`])
    .then(() => true).catch(() => false)
  if (!stat) throw new Error(`基座来源不存在：${source}`)
  return source.endsWith('.asar') ? 'asar' : 'dir'
}

async function extractTargetsFromAsar(sourcePath, relPaths, destination) {
  const { open } = await import('node:fs/promises')
  const handle = await open(sourcePath)
  try {
    const { header, baseOffset, jsonBytes } = await readAsarHeader(handle)
    const dataStart = baseOffset + jsonBytes
    const entries = new Map()
    for (const [path, meta] of walkAsar(header)) entries.set(path.slice(1), meta)
    const missing = []
    for (const rel of relPaths) {
      const meta = entries.get(rel)
      if (!meta) { missing.push(rel); continue }
      const target = join(destination, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFileFrom(handle, dataStart + Number(meta.offset), meta.size))
    }
    return missing
  } finally {
    await handle.close()
  }
}

async function readPatchTargets() {
  const targets = new Set()
  for (const name of PATCH_FILES) {
    const body = await readFile(join(overridesDir, name), 'utf8')
    for (const line of body.split(/\r?\n/)) {
      const match = /^diff --git a\/(\S+) b\//.exec(line)
      if (match) targets.add(match[1])
    }
  }
  return [...targets]
}

async function probePatches(workDir) {
  const results = []
  for (const name of PATCH_FILES) {
    const patchPath = join(overridesDir, name)
    let output = ''
    let failed = false
    try {
      const { stdout, stderr } = await run('patch', ['-p1', '--dry-run', '--batch', '--forward', '--fuzz=3', '-i', patchPath], { cwd: workDir })
      output = `${stdout}${stderr}`
    } catch (error) {
      failed = true
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const failedHunks = [...output.matchAll(/Hunk #(\d+) FAILED at (\d+)/g)].map(match => ({ hunk: Number(match[1]), line: Number(match[2]) }))
    const files = [...output.matchAll(/checking file (\S+)/g)].map(match => match[1])
    results.push({ patch: name, filesChecked: files.length, failedHunks, ok: !failed && failedHunks.length === 0 })
  }
  return results
}

async function detectTruncation(workDir) {
  const rows = []
  for (const rel of TRUNCATION_TARGETS) {
    const path = join(workDir, rel)
    let bytes
    try { bytes = await readFile(path) } catch { rows.push({ path: rel, status: 'missing' }); continue }
    const brokenHead = bytes[0] === 0x3e
    const tail = bytes.subarray(Math.max(0, bytes.length - 80)).toString('utf8').trimEnd()
    const brokenMap = /sourceMappingURL=client\.js\.m$/.test(tail)
    rows.push({ path: rel, brokenHead, brokenMap, status: brokenHead || brokenMap ? 'needs-repair' : 'intact' })
  }
  return rows
}

async function repairTruncation(workDir) {
  const repaired = []
  for (const rel of TRUNCATION_TARGETS) {
    const path = join(workDir, rel)
    let bytes
    try { bytes = await readFile(path) } catch { continue }
    let changed = false
    if (bytes[0] === 0x3e) { bytes = bytes.subarray(bytes[1] === 0x0a ? 2 : 1); changed = true }
    const text = bytes.toString('utf8')
    if (/sourceMappingURL=client\.js\.m$/.test(text.trimEnd())) {
      bytes = Buffer.from(text.replace(/sourceMappingURL=client\.js\.m$/, 'sourceMappingURL=client.js.map'))
      changed = true
    }
    if (changed) { await writeFile(path, bytes); repaired.push(rel) }
  }
  return repaired
}

async function rewritePins(version) {
  const writes = []
  const renderers = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/renderers.js')
  const main = join(repoRoot, 'apps/tradeloom-launcher/accepted-runtime/lib/main.js')
  const shellPkg = join(repoRoot, 'packages/tradeloom-shell/package.json')
  const manifestPath = join(repoRoot, 'dsh-base.manifest.json')

  const renderersText = await readFile(renderers, 'utf8')
  const nextRenderers = renderersText.replace(/(var ADAPTED_ENGINE = ')([^']+)(')/, `$1${version}$3`)
  if (nextRenderers !== renderersText) { await writeFile(renderers, nextRenderers); writes.push(renderers) }

  const mainText = await readFile(main, 'utf8')
  const nextMain = mainText.replace(/(function desktopClientVersion\(\) \{\s*return ")([^"]+)(")/, `$1${version}$3`)
  if (nextMain !== mainText) { await writeFile(main, nextMain); writes.push(main) }

  const pkg = JSON.parse(await readFile(shellPkg, 'utf8'))
  if (pkg.peerDependencies?.['@deepseek-ai/dsh-scope'] !== version) {
    pkg.peerDependencies = { ...(pkg.peerDependencies ?? {}), '@deepseek-ai/dsh-scope': version }
    await writeFile(shellPkg, `${JSON.stringify(pkg, null, 2)}\n`); writes.push(shellPkg)
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.base.version !== version) {
    manifest.base.version = version
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); writes.push(manifestPath)
  }
  return writes
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const kind = await probeSource(args.source)
  const targets = await readPatchTargets()
  const workDir = args.stage && !args.dryRun ? resolve(args.stage) : await mkdtemp(join(tmpdir(), 'dsh-base-'))
  const report = { source: args.source, sourceKind: kind, targetVersion: args.version, workDir, patchTargets: targets.length }

  try {
    const extractList = [...new Set([...targets, ...TRUNCATION_TARGETS])]
    if (kind === 'asar') {
      const missing = await extractTargetsFromAsar(args.source, extractList, workDir)
      report.missingPatchTargets = missing
    } else {
      const missing = []
      for (const rel of extractList) {
        try { await mkdir(dirname(join(workDir, rel)), { recursive: true }); await cp(join(args.source, rel), join(workDir, rel)) }
        catch { missing.push(rel) }
      }
      report.missingPatchTargets = missing
    }

    report.patches = args.dryRun || kind === 'asar' ? await probePatches(workDir) : await probePatches(workDir)
    report.truncation = await detectTruncation(workDir)

    const blocking = report.patches.filter(item => !item.ok)
    if (!args.dryRun && !blocking.length) {
      report.repaired = await repairTruncation(workDir)
      report.pinsRewritten = await rewritePins(args.version)
    }
    report.status = blocking.length ? 'blocked-unresolved-hunks' : (args.dryRun ? 'dry-run-clean' : 'stage-ready')
    report.nextSteps = blocking.length
      ? blocking.flatMap(item => item.failedHunks.map(h => `${item.patch}: hunk #${h.hunk} @${h.line} 需要在 dsh-base.manifest.json 里补一条语义锚点后重试`))
      : ['跑 node scripts/check-dsh-base-boundary.mjs', '全量 Shell 回归', '打包到隔离候选包后真机验证']
    console.log(JSON.stringify(report, null, 1))
    if (blocking.length) process.exitCode = 1
  } finally {
    if (!args.keepTemp && !(args.stage && !args.dryRun)) await rm(workDir, { recursive: true, force: true })
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return pathToFileURL(entry).href === import.meta.url } catch { return false }
})()

if (invokedDirectly) await main()