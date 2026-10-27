import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertNoReparseAncestors, sameDirectoryIdentity, trustedReleaseRoot } from './prepare-profile.mjs'

const compiledFiles8 = Object.freeze({
  'apps/desktop/lib/main.js': '9595e8152d2db58ae654edd87f527497053ecbe49da4a80f8789f7b205574e98',
  'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
})
const compiledFiles10 = Object.freeze({
  'apps/desktop/lib/main.js': 'c39e1a101f2f560dcce647bae7817de316c0427977f50d67529a4ac21d0a5626',
  'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
})
const identities = Object.freeze([
  {
    name: '0.2.1-rc.2-tradeloom-desktop-8', commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
    patchSet: '3893fc4378e95c9cbdeaed5e211dcad94a27f5202edd185e7a66ca908a94c0bb',
    bundleHash: '2355a2c8f382c5bee4d3706ec0c1f4ca81a11bee58f274eb040aa462740b9eee',
    compiledFiles: compiledFiles8, version: '0.2.1-rc.2',
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-10', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: 'ff25cc666e9533d17b70f75d600fbb17e601ed38f8836710dce10563b992ab9f',
    bundleHash: '28d4f64b2a50c69f09d2d6989ff6591d7e758550a8d982d64d370e37a2b6f08d',
    compiledFiles: compiledFiles10, version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-11', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '2da03698fc0242b540ccba7a2268ace72d2e495cfea020df6f43da7f74983eba',
    bundleHash: '782cdc08e453086c26aba6c0c93f2bfd850ac3bb005cba1ccd357fa65ec27dcd',
    compiledFiles: compiledFiles10, version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-12', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '44cef24abf17f8a86e149beb68164494045fb408681b2f3adf57291841761d60',
    bundleHash: '9c323a827bed65089d6fa2fc4edc4cc2ffe28e5f3fcb8fbe9878b7930191a8d5',
    compiledFiles: Object.freeze({
      'apps/desktop/lib/main.js': 'c79178f2d205d9d6bcbf7975d1598ab6278d4c41aaf76a05169183f3696049a8',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    }),
    version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-13', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: 'fa80229664d903da9d246497642b7580ac63619d3d4fdc63aeef0efd5b3e2224',
    bundleHash: 'c7c1164f9fd8742ca4714e177806e26c9546d8249478a61b815a2d5537140b94',
    compiledFiles: Object.freeze({
      'apps/desktop/lib/main.js': '7f107d8e446519f9aa647f0b7eb9a1c331fad025c1302c2b17225fc8eddcf7ac',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    }),
    version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-14', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '0e99a89b8ece8963cd61228d1df226374872004d65d2bb63c259bb880359928c',
    bundleHash: '2e0c2f20391feb7f8583f59591df34b61585b5ee19437855bde0714d2c08b5fd',
    compiledFiles: Object.freeze({
      'apps/desktop/lib/main.js': '1735e29bfb1a94df95fe624373d0f70fab071cc83799d515a3934654f9c8af2a',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    }),
    version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-15', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '1325ce2b6e52985095a3d72073c58a1128e262585b4389fa342d1051600fc923',
    bundleHash: 'b00164b5e4954ed2a8918cd013768c8e93528f9c1867aa51811c8909ccd6e276',
    compiledFiles: Object.freeze({
      'apps/desktop/lib/main.js': '3ef8756056ba3be1dadc43d101b9919f950716c6e4440a0b4d1fe01b680799e5',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    }),
    version: '0.2.1-rc.3', requireSourceTargetsMatched: false,
  },
  {
    name: '0.2.1-rc.3-tradeloom-desktop-16', commit: '1f81c047fc48fa190a683e469daa699857e9afe8',
    patchSet: '445dc2c4e9bb3dc745c3bdefba2374d6e8f5db7535fc6ae71f9592e10a8ecba0',
    receiptSha256: '70bbb4c532a8821bf49eb5e5d48a92a6f19ed804928cdfcbc0b973fda39b0a7e',
    bundleHash: 'ea6a7e30985d360099d39af9ca9035d718bf46d1681ff0bd7f05f10e0ccf2eca',
    migrationSupported: true,
    compiledFiles: Object.freeze({
      'apps/desktop/lib/main.js': 'd42278d60092ad90e96fdd8df18fa861722dedbb7940b22bbfe31bc91c560373',
      'apps/desktop-host/lib/index.js': '61896cd7416a9955b015e013a51b9a770272c68997fe2d9da92cb45508f4e59e',
    }),
    version: '0.2.1-rc.3', appId: 'cn.tradeloom.workbench', requireSourceTargetsMatched: false,
  },
].map(item => Object.freeze({ ...item, marker: `tradeloom-dsh-runtime-v1\n${item.commit}\n` })))

// Legacy exports remain pinned to desktop-8 for existing migration support/tests.
export const knownPreviousRuntimeName = identities[0].name
export const knownPreviousRuntimeCommit = identities[0].commit
export const knownPreviousRuntimeMarker = identities[0].marker
export const knownPreviousPatchSetSha256 = identities[0].patchSet
export const knownPreviousBundleHash = identities[0].bundleHash
export const knownPreviousCompiledFiles = identities[0].compiledFiles
export const knownPreviousRuntime10 = identities[1]
export const knownPreviousRuntime11 = identities[2]
export const knownPreviousRuntime12 = identities[3]
export const knownPreviousRuntime13 = identities[4]
export const knownPreviousRuntime14 = identities[5]
export const knownPreviousRuntime15 = identities[6]
export const knownPreviousRuntime16 = identities[7]

export function knownPreviousRuntimeIdentity(runtimePath) {
  if (typeof runtimePath !== 'string' || !path.isAbsolute(runtimePath)) return null
  return identities.find(item => path.basename(path.resolve(runtimePath)).toLowerCase() === item.name.toLowerCase()) ?? null
}

const receiptName = '.tradeloom-desktop-build-receipt.json'
const runtimeManifest = 'apps/desktop/package.json'

async function readOrdinaryFile(runtime, relative) {
  const target = path.join(runtime, relative)
  const rel = path.relative(runtime, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('previous runtime 文件越界。')
  let current = runtime
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`previous runtime 文件路径含链接：${relative}`)
    if (current !== target && !info.isDirectory()) throw new Error(`previous runtime 文件祖先无效：${relative}`)
  }
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`previous runtime 必须是普通文件：${relative}`)
  return readFile(target)
}

function readGitHead(runtime) {
  return execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
}

function sha256File(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Validate a receipt-pinned prior runtime allowed as an explicit desktop migration source. */
export async function validateKnownPreviousRuntime(runtimePath, {
  releaseRoot = trustedReleaseRoot,
  readHead = readGitHead,
  hashFile = async (_file, bytes) => sha256File(bytes),
} = {}) {
  const identity = knownPreviousRuntimeIdentity(runtimePath)
  if (!identity) throw new Error('迁移来源必须是已知且固定的 TradeLoom runtime。')
  if (identity.migrationSupported === false || typeof identity.bundleHash !== 'string') {
    throw new Error(`已知 runtime ${identity.name} 仅允许直接启动；profile 迁移不支持，因为没有核实到既有 bundleHash。`)
  }
  const root = path.resolve(releaseRoot)
  const runtime = path.resolve(runtimePath)
  if (!(await sameDirectoryIdentity(path.dirname(runtime), root))) {
    throw new Error('runtime 迁移来源必须直接位于固定 TradeLoom releases 根目录下。')
  }
  await assertNoReparseAncestors(root, path.parse(root).root)
  await assertNoReparseAncestors(runtime, path.parse(runtime).root)
  const dirInfo = await lstat(runtime)
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('runtime 迁移来源必须是普通目录。')
  const marker = (await readOrdinaryFile(runtime, '.tradeloom-runtime-owned')).toString('utf8')
  if (marker !== identity.marker) throw new Error('runtime 迁移来源 ownership marker 不匹配。')
  if (await readHead(runtime) !== identity.commit) throw new Error('runtime 迁移来源 Git commit 不匹配。')
  const resolved = await realpath(runtime)
  if (!(await sameDirectoryIdentity(resolved, runtime)) || !(await sameDirectoryIdentity(path.dirname(resolved), root))) {
    throw new Error('runtime 迁移来源 realpath 不匹配。')
  }

  let receipt
  try {
    const receiptBytes = await readOrdinaryFile(runtime, receiptName)
    if (identity.receiptSha256 && sha256File(receiptBytes) !== identity.receiptSha256) {
      throw new Error('runtime 迁移来源 desktop build receipt SHA-256 不匹配。')
    }
    receipt = JSON.parse(receiptBytes.toString('utf8'))
  }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('runtime 迁移来源缺少可信 desktop build receipt。')
    if (error instanceof SyntaxError) throw new Error('runtime 迁移来源 desktop build receipt 无效。')
    throw error
  }
  const evidence = receipt.bootstrap?.buildEvidence
  if (receipt.schemaVersion !== 1 || receipt.sourceCommit !== identity.commit
    || receipt.runtimeMarker !== identity.marker || receipt.patchSetSha256 !== identity.patchSet
    || evidence?.patchesApplied !== true || evidence?.officialBuildExitCode !== 0
    || evidence?.sourceCommit !== identity.commit || evidence?.patchSetSha256 !== identity.patchSet
    || (identity.requireSourceTargetsMatched !== false && evidence?.sourceTargetsMatched !== true)) {
    throw new Error('runtime 迁移来源 desktop build receipt 身份或官方构建证据不匹配。')
  }
  for (const [relative, expected] of Object.entries(identity.compiledFiles)) {
    const bytes = await readOrdinaryFile(runtime, relative)
    const actual = await hashFile(path.join(runtime, relative), bytes)
    if (actual.toLowerCase() !== expected) throw new Error(`runtime 迁移来源 compiled hash 不匹配：${relative}`)
    if (receipt.compiledFiles?.[relative] !== expected) throw new Error(`runtime receipt compiled hash 不匹配：${relative}`)
  }
  const manifest = JSON.parse((await readOrdinaryFile(runtime, runtimeManifest)).toString('utf8'))
  if (manifest.version !== identity.version || manifest.dshDesktopAppId !== 'cn.tradeloom.workbench') {
    throw new Error('runtime 迁移来源桌面应用版本或身份不匹配。')
  }
  return runtime
}
