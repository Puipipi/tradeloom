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
 *   2. 按目标版本配方验证完整前像并顺序应用补丁（git apply，严格上下文匹配）
 *   3. 修正打包截断瑕疵（部分旧包首行多 '>'、sourceMappingURL 被截断），新基座若已正常则跳过
 *   4. 输出完整候选基座；版本钉待运行验收后再更新，不改当前仓库
 *
 * 任何 hunk 打不上 -> 非零退出，不产出半成品。这是“一键”的安全边界：
 * 宁可红着停，也不要生成一个偷偷少了功能的基座。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recipesDir = join(repoRoot, 'apps/tradeloom-launcher/dsh-upgrades')
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
  const head = await readFileFrom(handle, 0, 16)
  if (head.length !== 16 || head.readUInt32LE(0) !== 4) throw new Error('invalid_asar_header')
  const headerSize = head.readUInt32LE(4)
  const jsonBytes = head.readUInt32LE(12)
  if (headerSize < 8 || jsonBytes > headerSize - 8 || headerSize > 96 * 1024 * 1024) {
    throw new Error('invalid_asar_header_size')
  }
  const buffer = await readFileFrom(handle, 16, jsonBytes)
  if (buffer.length !== jsonBytes) throw new Error('truncated_asar_header')
  const header = JSON.parse(buffer.toString('utf8'))
  // The Pickle size includes alignment bytes after JSON. Payload starts after
  // the complete header, rather than immediately after the final JSON brace.
  return { header, dataOffset: 8 + headerSize }
}

function safeTarget(destination, rel) {
  const target = resolve(destination, rel)
  const inside = relative(resolve(destination), target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('invalid_archive_path')
  return target
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
    const { header, dataOffset } = await readAsarHeader(handle)
    const entries = new Map()
    for (const [path, meta] of walkAsar(header)) {
      if (!path.startsWith('/dsh/')) continue
      entries.set(path.slice(1), meta)
    }
    return { handle, dataOffset, entries }
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
    const { header, dataOffset } = await readAsarHeader(handle)
    const dataStart = dataOffset
    const entries = new Map()
    for (const [path, meta] of walkAsar(header)) entries.set(path.slice(1), meta)
    const missing = []
    for (const rel of relPaths) {
      const meta = entries.get(rel)
      if (!meta) { missing.push(rel); continue }
      const target = safeTarget(destination, rel)
      if (meta.link) throw new Error(`unsupported_asar_link: ${rel}`)
      await mkdir(dirname(target), { recursive: true })
      if (meta.unpacked) {
        await cp(safeTarget(`${sourcePath}.unpacked`, rel), target, { errorOnExist: true, force: false })
      } else {
        const bytes = await readFileFrom(handle, dataStart + Number(meta.offset), meta.size)
        if (bytes.length !== meta.size) throw new Error(`truncated_asar_payload: ${rel}`)
        await writeFile(target, bytes, { flag: 'wx' })
      }
    }
    return missing
  } finally {
    await handle.close()
  }
}

async function loadRecipe(version) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(version)) throw new Error('invalid_recipe_version')
  const directory = join(recipesDir, version)
  let recipe
  try { recipe = JSON.parse(await readFile(join(directory, 'recipe.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`missing_version_recipe: ${version}`); throw error }
  if (recipe.schemaVersion !== 1 || recipe.version !== version) throw new Error('recipe_version_mismatch')
  if (!Array.isArray(recipe.patches) || !recipe.patches.length || new Set(recipe.patches).size !== recipe.patches.length) throw new Error('invalid_recipe_patches')
  for (const name of recipe.patches) safeTarget(directory, name)
  for (const phase of ['preimages', 'postimages']) {
    if (!recipe[phase] || !Object.keys(recipe[phase]).length) throw new Error(`missing_recipe_${phase}`)
    for (const [path, pin] of Object.entries(recipe[phase])) {
      if (!path.startsWith('dsh/')) throw new Error('invalid_recipe_target')
      safeTarget(repoRoot, path)
      if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('invalid_recipe_pin')
    }
  }
  const copies = recipe.copies ?? []
  for (const copy of copies) {
    safeTarget(repoRoot, copy.source)
    const postimage = recipe.postimages[copy.destination]
    if (!postimage || copy.sha256 !== postimage.sha256) throw new Error('invalid_recipe_copy')
  }
  if (recipe.browserBootstrap && (!recipe.preimages[recipe.browserBootstrap.entry] || !recipe.postimages[recipe.browserBootstrap.entry])) throw new Error('untracked_browser_bootstrap')
  return { ...recipe, directory, copies }
}

async function verifyImages(workDir, images, phase) {
  for (const [rel, pin] of Object.entries(images)) {
    const bytes = await readFile(safeTarget(workDir, rel)).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`${phase}_mismatch: ${rel} (missing)`)
      throw error
    })
    if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`${phase}_mismatch: ${rel}`)
  }
  return Object.keys(images).length
}

async function installBrowserBootstrap(workDir, recipe) {
  const hook = recipe.browserBootstrap
  if (hook) {
    const target = safeTarget(workDir, hook.entry)
    const before = await readFile(target, 'utf8')
    if (typeof hook.needle !== 'string' || !hook.needle || typeof hook.replacement !== 'string' || before.split(hook.needle).length !== 2) throw new Error('browser_bootstrap_anchor_count')
    if (hook.html) {
      const html = await readFile(safeTarget(workDir, hook.html), 'utf8')
      const entry = relative(dirname(hook.html), hook.entry).replaceAll('\\', '/')
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)]
      if (scripts.filter(([, src]) => [entry, `./${entry}`, `/${entry}`].includes(src)).length !== 1) throw new Error('browser_bootstrap_entry_not_loaded')
    }
    await writeFile(target, before.replace(hook.needle, () => hook.replacement))
  }
  for (const copy of recipe.copies) {
    const bytes = await readFile(safeTarget(repoRoot, copy.source))
    if (createHash('sha256').update(bytes).digest('hex') !== copy.sha256) throw new Error(`canonical_copy_mismatch: ${copy.source}`)
    const target = safeTarget(workDir, copy.destination)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: recipe.preimages[copy.destination] ? 'w' : 'wx' })
  }
}

async function readPatchTargets(recipe) {
  const targets = new Set()
  for (const name of recipe.patches) {
    const body = await readFile(safeTarget(recipe.directory, name), 'utf8')
    for (const line of body.split(/\r?\n/)) {
      const match = /^diff --git a\/(\S+) b\//.exec(line)
      if (match) {
        if (!recipe.preimages[match[1]] || !recipe.postimages[match[1]]) throw new Error(`untracked_patch_target: ${match[1]}`)
        targets.add(match[1])
      }
    }
  }
  return [...targets]
}

async function applyPatches(workDir, recipe) {
  const results = []
  for (const name of recipe.patches) {
    const patchPath = safeTarget(recipe.directory, name)
    let output = ''
    let failed = false
    try {
      const { stdout, stderr } = await run('git', ['-c', 'core.autocrlf=false', 'apply', '--check', patchPath], { cwd: workDir })
      output = `${stdout}${stderr}`
      await run('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], { cwd: workDir })
    } catch (error) {
      failed = true
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    const failedHunks = [...output.matchAll(/Hunk #(\d+) FAILED at (\d+)/g)].map(match => ({ hunk: Number(match[1]), line: Number(match[2]) }))
    const files = [...(await readFile(patchPath, 'utf8')).matchAll(/^diff --git /gm)]
    results.push({ patch: name, filesChecked: files.length, failedHunks, ok: !failed && failedHunks.length === 0, ...(failed ? { diagnostic: output.slice(0, 4000) } : {}) })
    if (failed) break
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

async function materializeBase(kind, source, destination) {
  if (kind === 'dir') {
    await mkdir(destination, { recursive: true })
    await cp(join(source, 'dsh'), join(destination, 'dsh'), { recursive: true, errorOnExist: true, force: false })
    return
  }
  const index = await readAsarTreeIndex(source)
  let paths
  try { paths = [...index.entries.keys()] } finally { await index.handle.close() }
  if (!paths.length) throw new Error('empty_dsh_base')
  await extractTargetsFromAsar(source, paths, destination)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const recipe = await loadRecipe(args.version)
  const kind = await probeSource(args.source)
  const targets = await readPatchTargets(recipe)
  if (!args.dryRun && !args.stage) throw new Error('缺少 --stage；仅 --dry-run 可省略输出目录')
  const stage = args.stage && !args.dryRun ? resolve(args.stage) : null
  if (stage && await stat(stage).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) {
    throw new Error('destination_exists: 拒绝覆盖既有候选目录')
  }
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-base-'))
  const report = { source: args.source, sourceKind: kind, targetVersion: args.version, recipeVersion: recipe.version, recipeStatus: recipe.status, workDir, patchTargets: targets.length }

  try {
    const extractList = [...new Set([...targets, ...Object.keys(recipe.preimages), ...(recipe.browserBootstrap?.html ? [recipe.browserBootstrap.html] : []), ...TRUNCATION_TARGETS])]
    if (stage) {
      await materializeBase(kind, args.source, workDir)
    } else if (kind === 'asar') {
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

    report.preimagesVerified = await verifyImages(workDir, recipe.preimages, 'preimage')
    report.truncation = await detectTruncation(workDir)
    for (const row of report.truncation) {
      if (row.status === 'needs-repair' && (!recipe.preimages[row.path] || !recipe.postimages[row.path])) throw new Error(`untracked_truncation_repair: ${row.path}`)
    }
    report.patches = await applyPatches(workDir, recipe)

    const blocking = report.patches.filter(item => !item.ok)
    if (!blocking.length) {
      await installBrowserBootstrap(workDir, recipe)
      report.appliedPatches = [...recipe.patches]
      report.repaired = await repairTruncation(workDir)
      report.postimagesVerified = await verifyImages(workDir, recipe.postimages, 'postimage')
      report.requiredPinVersion = args.version
      report.pinsRewritten = []
    }
    if (stage && !blocking.length) {
      // Publish only after every patch succeeds. Repository pins stay on the
      // accepted version until runtime verification approves the candidate.
      await mkdir(dirname(stage), { recursive: true })
      await mkdir(stage)
      await cp(join(workDir, 'dsh'), join(stage, 'dsh'), { recursive: true, errorOnExist: true, force: false })
      report.workDir = stage
    }
    report.status = blocking.length ? 'blocked-unresolved-hunks' : (args.dryRun ? 'dry-run-clean' : 'stage-ready')
    report.nextSteps = blocking.length
      ? blocking.map(item => `${item.patch}: 配方补丁不匹配，必须人工审核新版合同并重写配方`)
      : ['跑 node scripts/check-dsh-base-boundary.mjs', '全量 Shell 回归', '打包到隔离候选包后真机验证']
    console.log(JSON.stringify(report, null, 1))
    if (blocking.length) process.exitCode = 1
  } finally {
    if (!args.keepTemp) await rm(workDir, { recursive: true, force: true })
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return pathToFileURL(entry).href === import.meta.url } catch { return false }
})()

if (invokedDirectly) await main()
