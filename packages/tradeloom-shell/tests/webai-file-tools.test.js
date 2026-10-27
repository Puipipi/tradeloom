import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createWebAiFileTools } from '../webai-file-tools.js'
import { createLocalDirectoryLister } from '../webai-local-directory.js'

const runtimeRoot = process.env.TRADELOOM_NATIVE_RUNTIME
let LocalFileSystem
let Context
if (runtimeRoot) {
  ;({ LocalFileSystem } = await import(pathToFileURL(join(runtimeRoot, 'packages/fs/fs-local/lib/index.js')).href))
  ;({ Context } = await import(pathToFileURL(join(runtimeRoot, 'vendor/cordis/lib/index.js')).href))
}

const nativeTest = (name, fn) => test(name, { skip: !runtimeRoot && '设置 TRADELOOM_NATIVE_RUNTIME 后运行 DSH 集成测试' }, fn)

async function fixture(t) {
  if (!runtimeRoot) throw new Error('TRADELOOM_NATIVE_RUNTIME is required')
  const parent = await mkdtemp(join(tmpdir(), 'webai-file-tools-'))
  const root = join(parent, 'root')
  await mkdir(root)
  const fs = new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
  fs.listDirBounded = createLocalDirectoryLister(fs, LocalFileSystem)
  const tools = createWebAiFileTools({ fs })
  const grant = await tools.issueGrant({ providerId: 'provider-1', windowId: 'window-1', conversationId: 'conversation-1', root })
  t.after(async () => {
    const base = resolve(tmpdir())
    const target = resolve(parent)
    const rel = relative(base, target)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Refusing to remove a temp path outside the test temp directory')
    await rm(target, { recursive: true, force: true })
  })
  return { parent, root, fs, tools, grant, context: { providerId: 'provider-1', windowId: 'window-1', conversationId: 'conversation-1' } }
}

function req(requestId, op, path, content) {
  return content === undefined ? { requestId, op, path } : { requestId, op, path, content }
}

nativeTest('新建文件经 DSH 原子 createIfAbsent 创建，重放不执行第二次写入', async t => {
  const f = await fixture(t)
  const request = req('create-1', 'write_new', 'notes/hello.txt', '你好')
  await mkdir(join(f.root, 'notes'))
  const first = await f.tools.execute(f.grant, f.context, request)
  const second = await f.tools.execute(f.grant, f.context, request)
  const conflict = await f.tools.execute(f.grant, f.context, { ...request, content: 'different' })
  assert.deepEqual(first, { ok: true, created: true })
  assert.deepEqual(second, first)
  assert.equal(conflict.error.code, 'REQUEST_ID_REUSED')
  assert.equal(await readFile(join(f.root, 'notes/hello.txt'), 'utf8'), '你好')
})

nativeTest('拒绝现有文件覆盖、路径逃逸、绝对路径和危险 Windows 路径', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'keep.txt'), 'original')
  for (const path of ['keep.txt']) {
    assert.equal((await f.tools.execute(f.grant, f.context, req(`exists-${path}`, 'write_new', path, 'replacement'))).error.code, 'ALREADY_EXISTS')
  }
  assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), 'original')
  for (const [id, path] of [['escape', '../outside.txt'], ['absolute', 'C:/outside.txt'], ['url', 'file://outside'], ['ads', 'safe.txt:stream'], ['device', 'NUL.txt']]) {
    assert.equal((await f.tools.execute(f.grant, f.context, req(id, 'read', path))).error.code, 'INVALID_PATH')
  }
})

nativeTest('拒绝指向授权目录外的符号链接', async t => {
  const f = await fixture(t)
  const outside = join(f.parent, 'outside.txt')
  await writeFile(outside, 'secret outside text')
  await symlink(outside, join(f.root, 'linked.txt'))
  assert.equal((await f.tools.execute(f.grant, f.context, req('link-read', 'read', 'linked.txt'))).error.code, 'INVALID_PATH')
})

nativeTest('只返回有界 UTF-8 文本和目录元数据；二进制、过大和超量目录失败', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'text.txt'), 'readable')
  await writeFile(join(f.root, 'binary.bin'), Buffer.from([0xff, 0x00]))
  await writeFile(join(f.root, 'nul-utf8.txt'), Buffer.from([0x61, 0x00, 0x62]))
  await writeFile(join(f.root, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 97))
  assert.deepEqual(await f.tools.execute(f.grant, f.context, req('read-1', 'read', 'text.txt')), { ok: true, content: 'readable' })
  assert.equal((await f.tools.execute(f.grant, f.context, req('binary', 'read', 'binary.bin'))).error.code, 'BINARY_OR_INVALID_UTF8')
  assert.equal((await f.tools.execute(f.grant, f.context, req('nul', 'read', 'nul-utf8.txt'))).error.code, 'BINARY_OR_INVALID_UTF8')
  assert.equal((await f.tools.execute(f.grant, f.context, req('large', 'read', 'large.txt'))).error.code, 'TOO_LARGE')
  assert.equal((await f.tools.execute(f.grant, f.context, req('list-root', 'list', '.'))).ok, true)
  for (let i = 0; i < 201; i++) await writeFile(join(f.root, `entry-${i}.txt`), '')
  await mkdir(join(f.root, 'many'))
  for (let i = 0; i < 201; i++) await writeFile(join(f.root, 'many', `entry-${i}.txt`), '')
  assert.equal((await f.tools.execute(f.grant, f.context, req('list-many', 'list', 'many'))).error.code, 'TOO_MANY_ENTRIES')
})

nativeTest('grant 绑定会话；结构化错误不返回异常栈', async t => {
  const f = await fixture(t)
  const mismatch = await f.tools.execute(f.grant, { ...f.context, conversationId: 'other' }, req('wrong-conv', 'list', 'missing'))
  assert.equal(mismatch.error.code, 'GRANT_MISMATCH')
  assert.equal('stack' in mismatch.error, false)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await f.tools.execute(f.grant, { ...f.context, signal: controller.signal }, req('cancelled', 'list', 'missing'))
  assert.equal(cancelled.error.code, 'CANCELLED')
  let time = 100
  const expiring = createWebAiFileTools({ fs: f.fs, now: () => time, grantTtlMs: 5 })
  const grant = await expiring.issueGrant({ providerId: 'p', windowId: 'w', conversationId: 'c', root: f.root })
  time = 106
  const expired = await expiring.execute(grant, { providerId: 'p', windowId: 'w', conversationId: 'c' }, req('expired', 'list', 'missing'))
  assert.equal(expired.error.code, 'GRANT_EXPIRED')
})

nativeTest('grant 签发拒绝非绝对 processPath，目录适配器仅接受 LocalFileSystem 实例', async t => {
  const f = await fixture(t)
  const processPath = f.fs.processPath.bind(f.fs)
  f.fs.processPath = () => 'relative/root'
  await assert.rejects(f.tools.issueGrant({ providerId: 'p', windowId: 'w', conversationId: 'c', root: f.root }), /canonical absolute directory/)
  f.fs.processPath = processPath
  assert.throws(() => createLocalDirectoryLister({}, LocalFileSystem), /LocalFileSystem/)
})

nativeTest('本地目录适配最多读取 201 项并返回名字、类型、大小；不跟随符号链接', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'bounded'))
  await writeFile(join(f.root, 'bounded', 'file.txt'), '1234')
  await mkdir(join(f.root, 'bounded', 'subdir'))
  await writeFile(join(f.parent, 'outside.txt'), 'external')
  await symlink(join(f.parent, 'outside.txt'), join(f.root, 'bounded', 'external-link.txt'))
  const entries = await f.tools.execute(f.grant, f.context, req('bounded-list', 'list', 'bounded'))
  assert.deepEqual(entries.entries.find(entry => entry.name === 'file.txt'), { name: 'file.txt', type: 'file', size: 4 })
  assert.deepEqual(entries.entries.find(entry => entry.name === 'subdir'), { name: 'subdir', type: 'directory' })
  assert.deepEqual(entries.entries.find(entry => entry.name === 'external-link.txt'), { name: 'external-link.txt', type: 'symlink' })
  await mkdir(join(f.root, 'many'))
  for (let i = 0; i < 260; i++) await writeFile(join(f.root, 'many', `entry-${i}.txt`), '')
  const tooMany = await f.tools.execute(f.grant, f.context, req('bounded-many', 'list', 'many'))
  assert.equal(tooMany.error.code, 'TOO_MANY_ENTRIES')
})

nativeTest('grant revoke 与 native abort 会取消运行中的 read/write', async t => {
  const readFixture = await fixture(t)
  await writeFile(join(readFixture.root, 'wait.txt'), 'text')
  let readStarted
  const readStartedPromise = new Promise(resolve => { readStarted = resolve })
  readFixture.fs.readBytes = (_target, signal) => new Promise((_resolve, reject) => {
    readStarted()
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'FS_ABORTED' })), { once: true })
  })
  const readPending = readFixture.tools.execute(readFixture.grant, readFixture.context, req('running-read', 'read', 'wait.txt'))
  await readStartedPromise
  assert.equal(readFixture.tools.revoke(readFixture.grant), true)
  assert.equal((await readPending).error.code, 'CANCELLED')
  assert.equal((await readFixture.tools.execute(readFixture.grant, readFixture.context, req('after-revoke', 'read', 'wait.txt'))).error.code, 'INVALID_GRANT')

  const writeFixture = await fixture(t)
  let writeStarted
  const writeStartedPromise = new Promise(resolve => { writeStarted = resolve })
  writeFixture.fs.writeText = (_target, _content, _intent, signal) => new Promise((_resolve, reject) => {
    writeStarted()
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'FS_ABORTED' })), { once: true })
  })
  const writePending = writeFixture.tools.execute(writeFixture.grant, writeFixture.context, req('running-write', 'write_new', 'cancelled.txt', 'text'))
  await writeStartedPromise
  writeFixture.tools.revoke(writeFixture.grant)
  assert.equal((await writePending).error.code, 'CANCELLED')

  const abortFixture = await fixture(t)
  await writeFile(join(abortFixture.root, 'wait.txt'), 'text')
  let abortReadStarted
  const abortReadStartedPromise = new Promise(resolve => { abortReadStarted = resolve })
  abortFixture.fs.readBytes = (_target, signal) => new Promise((_resolve, reject) => {
    abortReadStarted()
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'FS_ABORTED' })), { once: true })
  })
  const nativeAbort = new AbortController()
  const abortPending = abortFixture.tools.execute(abortFixture.grant, { ...abortFixture.context, signal: nativeAbort.signal }, req('native-abort-read', 'read', 'wait.txt'))
  await abortReadStartedPromise
  nativeAbort.abort()
  assert.equal((await abortPending).error.code, 'CANCELLED')
})

nativeTest('有界 grant TTL、请求缓存上限与已用 ID 拒绝新缓存', async t => {
  const f = await fixture(t)
  assert.throws(() => createWebAiFileTools({ fs: f.fs, grantTtlMs: Number.POSITIVE_INFINITY }), /grantTtlMs/)
  assert.throws(() => createWebAiFileTools({ fs: f.fs, grantTtlMs: 0 }), /grantTtlMs/)
  for (let i = 0; i < 64; i++) assert.equal((await f.tools.execute(f.grant, f.context, req(`limit-${i}`, 'list', '.'))).ok, true)
  assert.equal((await f.tools.execute(f.grant, f.context, req('limit-over', 'list', '.'))).error.code, 'REQUEST_LIMIT')
})

