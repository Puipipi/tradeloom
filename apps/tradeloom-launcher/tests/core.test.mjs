import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import {
  assertPortsAvailable, buildChildEnvironment, buildDesktopChildEnvironment, chooseAddress, ensureOwnedDirectory, ensureOwnedHome,
  isPrivateIPv4, networkCandidates, startOwnedChild, startTransaction,
  reserveNamedPipe, serveStopRequest,
} from '../core.mjs'

const adapters = [
  { name: 'Wi-Fi', interfaceDescription: 'Wireless adapter', kind: 'wifi', status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '192.168.1.23' }] },
  { name: 'Ethernet 2', interfaceDescription: 'Realtek PCIe GbE Family Controller', kind: 'ethernet', status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '10.0.0.4' }] },
  { name: 'VPN', interfaceDescription: 'Ethernet tunnel', kind: 'ethernet', status: 'Up', hardwareInterface: false, addresses: [{ addressFamily: 'IPv4', address: '172.16.0.7' }] },
  { name: 'Ethernet down', interfaceDescription: 'Ethernet', kind: 'ethernet', status: 'Down', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '192.168.1.9' }] },
  { name: 'Virtual', interfaceDescription: 'Ethernet', kind: 'ethernet', status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '203.0.113.5' }] },
  { name: '以太网', interfaceDescription: 'Realtek PCIe GbE Family Controller', interfaceType: 6, status: 'Up', hardwareInterface: true, addresses: [{ addressFamily: 'IPv4', address: '192.168.8.12' }] },
]

test('LAN candidate selection requires an explicit choice when Wi-Fi and Ethernet are both active', () => {
  const candidates = networkCandidates(adapters)
  assert.deepEqual(new Set(candidates.map(candidate => candidate.address)), new Set(['192.168.1.23', '10.0.0.4', '192.168.8.12']))
  assert.equal(candidates[0].kind, 'wifi')
  assert.throws(() => chooseAddress(candidates), /多个局域网地址/)
  assert.equal(chooseAddress(candidates, '10.0.0.4'), '10.0.0.4')
  assert.equal(candidates.find(candidate => candidate.address === '192.168.8.12')?.kind, 'ethernet')
  assert.throws(() => chooseAddress(candidates, '203.0.113.5'), /不是当前活动物理网卡/)
  assert.throws(() => chooseAddress([], undefined), /尚未启动/)
  for (const ip of ['127.0.0.1', '169.254.1.2', '8.8.8.8', '172.15.1.2', '172.32.1.2', '192.169.1.2']) assert.equal(isPrivateIPv4(ip), false)
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(isPrivateIPv4(ip), true)
})

test('port preflight rejects a real loopback listener without disturbing it', async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await assert.rejects(assertPortsAvailable([['127.0.0.1', port]]), /端口/)
  assert.equal(server.listening, true)
  await new Promise(resolve => server.close(resolve))
})

test('named-pipe ownership rejects a concurrent launcher and releases for the next launch', async () => {
  const address = `\\\\.\\pipe\\tradeloom-lock-test-${process.pid}-${Date.now()}`
  const owner = await reserveNamedPipe(address)
  try { await assert.rejects(reserveNamedPipe(address)) }
  finally { await new Promise(resolve => owner.close(resolve)) }
  const nextOwner = await reserveNamedPipe(address)
  await new Promise(resolve => nextOwner.close(resolve))
})

test('child environment skips secret getters and points all fallback stores to owned paths', () => {
  const inherited = { PATH: 'safe', DSH_HOME: 'foreign', OPENAI_BASE_URL: 'never-read', TRADELOOM_DB_PASSWORD: 'db-secret', ROUTER_PROVIDER: 'foreign' }
  Object.defineProperty(inherited, 'DEEPSEEK_API_KEY', { enumerable: true, get() { throw new Error('secret value was read') } })
  const env = buildChildEnvironment(inherited, {
    home: 'C:\\owned\\harness-home', agentsHome: 'C:\\owned\\agents',
    appData: 'C:\\owned\\appdata', localAppData: 'C:\\owned\\local', xdgCache: 'C:\\owned\\cache',
    xdgConfig: 'C:\\owned\\config', xdgData: 'C:\\owned\\data',
  })
  assert.equal(env.PATH, 'safe')
  assert.equal(env.DSH_HOME, path.resolve('C:\\owned\\harness-home'))
  assert.equal(env.DSH_AGENTS_HOME, path.resolve('C:\\owned\\agents'))
  assert.equal(env.TRADELOOM_DSH_APP_HOME, env.DSH_HOME)
  assert.equal(env.APPDATA, path.resolve('C:\\owned\\appdata'))
  assert.equal(env.LOCALAPPDATA, path.resolve('C:\\owned\\local'))
  assert.equal(env.XDG_CACHE_HOME, path.resolve('C:\\owned\\cache'))
  for (const key of ['DSH_HOME', 'OPENAI_BASE_URL', 'TRADELOOM_DB_PASSWORD', 'ROUTER_PROVIDER', 'DEEPSEEK_API_KEY']) {
    if (key !== 'DSH_HOME') assert.equal(Object.hasOwn(env, key), false)
  }
})

test('desktop child gets its primary runtime path from the selected managed runtime', () => {
  const inherited = {
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: 'foreign', DSH_DESKTOP_OPEN_DEVTOOLS: '1', DSH_HOME: 'foreign',
    ELECTRON_RUN_AS_NODE: '1',
  }
  Object.defineProperty(inherited, 'DEEPSEEK_API_KEY', { enumerable: true, get() { throw new Error('secret value was read') } })
  const env = buildDesktopChildEnvironment(inherited, {
    home: 'C:\\owned\\harness-home', agentsHome: 'C:\\owned\\agents',
    appData: 'C:\\owned\\appdata', localAppData: 'C:\\owned\\local', xdgCache: 'C:\\owned\\cache',
    xdgConfig: 'C:\\owned\\config', xdgData: 'C:\\owned\\data',
  }, { runtimePath: 'C:\\owned\\runtime', host: '192.168.1.10', port: 3088 })

  assert.equal(env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR, path.resolve('C:\\owned\\runtime\\apps\\desktop\\.desktop-build\\targets\\win-x64\\runtime\\primary-runtime'))
  assert.equal(env.DSH_HOME, path.resolve('C:\\owned\\harness-home'))
  assert.equal(env.TRADELOOM_DSH_BIND_HOST, '192.168.1.10')
  assert.equal(env.TRADELOOM_DSH_BIND_PORT, '3088')
  assert.equal(env.DSH_DESKTOP_OPEN_DEVTOOLS, '0')
  assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false)
  assert.equal(Object.hasOwn(env, 'DEEPSEEK_API_KEY'), false)
})

test('explicit data root relocates owned stores but keeps Python in the dedicated LocalAppData runtime', async () => {
  const { getDefaultPaths } = await import('../core.mjs')
  const paths = getDefaultPaths({
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    TRADELOOM_DATA_ROOT: 'C:\\Users\\tester\\Desktop\\tradeloom-app-data',
  })
  assert.equal(paths.dataRoot, path.resolve('C:\\Users\\tester\\Desktop\\tradeloom-app-data'))
  assert.equal(paths.explicitDataRoot, true)
  assert.equal(paths.home, path.join(paths.dataRoot, 'harness-home'))
  assert.equal(paths.logs, path.join(paths.dataRoot, 'logs'))
  assert.equal(paths.xdgCache, path.join(paths.dataRoot, 'xdg', 'cache'))
  assert.equal(paths.python, path.join('C:\\Users\\tester\\AppData\\Local', 'TradeLoom', 'python-env', 'Scripts', 'python.exe'))
  assert.throws(() => getDefaultPaths({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', TRADELOOM_DATA_ROOT: 'relative-data' }), /必须是绝对路径/)
  const defaults = getDefaultPaths({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' })
  assert.equal(defaults.dataRoot, path.join('C:\\Users\\tester\\AppData\\Local', 'TradeLoom'))
  assert.equal(defaults.explicitDataRoot, false)
})

test('owned directories require an empty first use or exact ordinary-file marker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-home-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'harness-home')
  assert.equal(await ensureOwnedHome(home), home)
  assert.equal(await readFile(path.join(home, '.tradeloom-owned'), 'utf8'), 'tradeloom-dsh-apphome-v1\n')
  assert.equal(await ensureOwnedHome(home), home)
  const foreign = path.join(root, 'foreign')
  await mkdir(foreign)
  await writeFile(path.join(foreign, 'keep.txt'), 'untouched')
  await assert.rejects(ensureOwnedHome(foreign), /非空目录/)
  const linkedMarkerHome = path.join(root, 'linked-marker')
  const outsideMarker = path.join(root, 'marker-target')
  await mkdir(linkedMarkerHome)
  await writeFile(outsideMarker, 'tradeloom-dsh-apphome-v1\n')
  try {
    await symlink(outsideMarker, path.join(linkedMarkerHome, '.tradeloom-owned'), 'file')
    await assert.rejects(ensureOwnedHome(linkedMarkerHome), /marker/)
  } catch (error) {
    if (error.code !== 'EPERM') throw error
    await writeFile(path.join(linkedMarkerHome, '.tradeloom-owned'), 'wrong marker')
    await assert.rejects(ensureOwnedHome(linkedMarkerHome), /标记/)
  }
  assert.equal(await readFile(outsideMarker, 'utf8'), 'tradeloom-dsh-apphome-v1\n')
  const separate = path.join(root, 'agents')
  await ensureOwnedDirectory(separate, '.tradeloom-agents-owned', 'tradeloom-agents-home-v1\n')
})

test('Windows case-variant spelling resolves to the same owned directory', async t => {
  if (process.platform !== 'win32') return t.skip('Windows path case behavior only')
  const root = await mkdtemp(path.join(os.tmpdir(), 'tradeloom-case-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const actual = path.join(root, 'OwnedData')
  await ensureOwnedDirectory(actual, '.tradeloom-data-root-owned', 'tradeloom-app-data-v1\n')
  const alias = path.join(root, 'owneddata')
  assert.equal(await ensureOwnedDirectory(alias, '.tradeloom-data-root-owned', 'tradeloom-app-data-v1\n'), actual)
})

test('a real harmless child is stopped only through its launcher handle', async () => {
  const child = startOwnedChild(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { cwd: process.cwd(), env: process.env })
  await child.spawned
  const result = await child.stop()
  assert.notEqual(result.code, 0)
  assert.ok(child.handle.child.killed)
})

test('startup failure rolls back only children already returned by owned spawn', async () => {
  let child
  await assert.rejects(startTransaction([
    async () => {
      child = startOwnedChild(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { cwd: process.cwd(), env: process.env })
      return child
    },
    async () => { throw new Error('deliberate fixture failure') },
  ]), /deliberate fixture failure/)
  assert.ok(child.handle.stopped)
  const result = await child.exited
  assert.ok(result.signal || result.code !== null)
})

test('a missing executable reports spawn failure and does not leave a hanging handle', async () => {
  const child = startOwnedChild(path.join(os.tmpdir(), 'missing-tradeloom-executable.exe'), [], { cwd: process.cwd(), env: process.env })
  await assert.rejects(child.spawned)
  const result = await child.exited
  assert.match(result.error.message, /ENOENT/)
})

test('STOP socket acknowledges only after the owned child exits', async t => {
  const server = net.createServer({ allowHalfOpen: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const child = startOwnedChild(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: process.cwd(), env: process.env })
  await child.spawned
  server.on('connection', socket => serveStopRequest(socket, async () => {
    const exit = await child.stop()
    assert.ok(exit.signal || exit.code !== null)
  }))
  const response = await new Promise((resolve, reject) => {
    const client = net.createConnection(server.address(), () => client.end('STOP\n'))
    let text = ''
    client.setEncoding('utf8')
    client.on('data', chunk => { text += chunk })
    client.on('end', () => resolve(text))
    client.on('error', reject)
  })
  assert.equal(response, '织贸助手已停止。\n')
  assert.ok((await child.exited).signal || (await child.exited).code !== null)
})
