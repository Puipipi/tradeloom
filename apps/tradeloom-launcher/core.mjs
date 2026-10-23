import os from 'node:os'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export const OWNED_MARKER = '.tradeloom-owned'
export const OWNED_MARKER_CONTENT = 'tradeloom-dsh-apphome-v1\n'
export const NATIVE_BRIDGE_ENV = 'TRADELOOM_NATIVE_BRIDGE_KEY'

export function createNativeBridgeKey(randomBytesFactory = randomBytes) {
  const bytes = randomBytesFactory(32)
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError('Native bridge key generator must return exactly 32 bytes.')
  }
  return Buffer.from(bytes).toString('hex')
}

export function isPrivateIPv4(value) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value ?? '')
  if (!m || m.slice(1).some(part => Number(part) > 255)) return false
  const [a, b] = m.slice(1).map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function networkCandidates(adapters) {
  const candidates = []
  for (const adapter of adapters) {
    if (adapter.status !== 'Up' || adapter.hardwareInterface !== true) continue
    const media = `${adapter.mediaType ?? ''} ${adapter.physicalMediaType ?? ''} ${adapter.name ?? ''} ${adapter.interfaceDescription ?? ''}`.toLowerCase()
    const kind = adapter.kind === 'wifi' || adapter.kind === 'ethernet' ? adapter.kind
      : Number(adapter.interfaceType) === 71 || /wi-?fi|wireless|802\.11|native 802\.11/.test(media) ? 'wifi'
        : Number(adapter.interfaceType) === 6 || /ethernet|802\.3/.test(media) ? 'ethernet' : null
    if (!kind) continue
    for (const address of adapter.addresses ?? []) {
      if (address.addressFamily === 'IPv4' && isPrivateIPv4(address.address)) {
        candidates.push({ name: adapter.name, description: adapter.interfaceDescription, kind, address: address.address })
      }
    }
  }
  return candidates.sort((a, b) => (a.kind === 'wifi' ? 0 : 1) - (b.kind === 'wifi' ? 0 : 1) || a.name.localeCompare(b.name))
}

export function chooseAddress(candidates, requested) {
  if (!candidates.length) throw new Error('没有可用的 Wi-Fi 或以太网私有 IPv4 地址，织贸助手尚未启动。')
  if (requested) {
    if (!isPrivateIPv4(requested) || !candidates.some(candidate => candidate.address === requested)) {
      throw new Error('指定的地址不是当前活动物理网卡上的私有 IPv4 地址。')
    }
    return requested
  }
  if (candidates.length === 1) return candidates[0].address
  throw Object.assign(new Error('检测到多个局域网地址，需要用户明确选择。'), { candidates })
}

export async function assertPortsAvailable(ports, defaultHost = '127.0.0.1') {
  for (const item of ports) {
    const [host, port] = Array.isArray(item) ? item : [defaultHost, item]
    await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', error => reject(new Error(`端口 ${port} 无法使用：${error.code ?? error.message}`)))
      server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()))
    })
  }
}

export function reserveNamedPipe(address) {
  const server = net.createServer({ allowHalfOpen: true })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => { server.removeListener('error', reject); resolve(server) })
  })
}

export function launcherPipeName(home) {
  return '\\\\.\\pipe\\tradeloom-launcher-' + createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 24)
}

export function requestStop(home, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(launcherPipeName(home))
    socket.setEncoding('utf8')
    let connected = false
    let settled = false
    let response = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        socket.end()
        resolve(value)
      }
    }
    const onConnect = () => {
      connected = true
      socket.write('STOP\n', error => {
        if (error) finish(new Error(`无法连接启动器：${error.message}`))
      })
    }
    const onData = chunk => {
      response += chunk
      const newline = response.indexOf('\n')
      if (newline < 0) return
      const acknowledgement = response.slice(0, newline).trim()
      if (acknowledgement === '织贸助手已停止。') finish(null, acknowledgement)
      else finish(new Error(acknowledgement || '启动器返回了空停止响应。'))
    }
    const onEnd = () => finish(new Error('启动器关闭了停止请求，但未返回确认。'))
    const onClose = () => {
      if (!settled) finish(new Error('启动器关闭了停止请求，但未返回确认。'))
      socket.removeListener('error', onError)
    }
    const onError = error => {
      const message = !connected && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
        ? '未找到由本启动器管理的运行实例。'
        : `无法连接启动器：${error.message}`
      finish(new Error(message))
    }
    const timer = setTimeout(() => finish(new Error('等待启动器停止确认超时。')), timeoutMs)
    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

export function serveStopRequest(socket, stopAll, onStopped = () => {}) {
  let payload = ''
  let handled = false
  socket.on('data', chunk => {
    if (handled) return
    payload += chunk.toString('utf8')
    if (!payload.includes('\n')) return
    handled = true
    if (payload.trim() !== 'STOP') { socket.end('拒绝\n'); return }
    void stopAll().then(() => {
      socket.end('织贸助手已停止。\n')
      onStopped()
    }, error => socket.end(`停止失败：${error.message}\n`))
  })
}

function canonical(p) { return path.resolve(p) }

async function rejectReparseAncestors(target) {
  let current = canonical(target)
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`拒绝链接路径：${current}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function ensureOwnedDirectory(home, markerName = OWNED_MARKER, markerContent = OWNED_MARKER_CONTENT) {
  const target = canonical(home)
  await rejectReparseAncestors(target)
  await mkdir(target, { recursive: true })
  const marker = path.join(target, markerName)
  try {
    const markerInfo = await lstat(marker)
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error(`拒绝非普通 ownership marker：${marker}`)
    if (await readFile(marker, 'utf8') !== markerContent) throw new Error(`目录已有非织贸助手 ownership 标记：${target}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const entries = await (await import('node:fs/promises')).readdir(target)
    if (entries.length) throw new Error(`拒绝占用非空目录：${target}`)
    await writeFile(marker, markerContent, { flag: 'wx' })
  }
  const resolved = await realpath(target)
  const equivalent = process.platform === 'win32'
    ? path.win32.resolve(resolved).toLowerCase() === path.win32.resolve(target).toLowerCase()
    : resolved === target
  if (!equivalent) throw new Error(`目录 realpath 不匹配：${target}`)
  return resolved
}

export function ensureOwnedHome(home) {
  return ensureOwnedDirectory(home)
}

const secretPattern = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE_OPENAI|MISTRAL|GROQ|TOGETHER|FIREWORKS|CEREBRAS|XAI|OPENROUTER|OLLAMA)_(?:.*(?:API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|ENDPOINT).*)$/i
export function buildChildEnvironment(source, paths, extra = {}) {
  const env = {}
  for (const name of Object.keys(source)) {
    if (/^DSH_/i.test(name) || name.toUpperCase() === NATIVE_BRIDGE_ENV || secretPattern.test(name) || /^TRADELOOM_.*(?:API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|ENDPOINT)$/i.test(name)
      || /^TRADELOOM_(?:DATA_ROOT|INTAKE_ROOT)$/i.test(name)
      || /^(?:ROUTER|CAVEMAN|LLM)_(?:.*(?:API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|ENDPOINT|PROVIDER|MODEL).*)$/i.test(name)) continue
    env[name] = source[name]
  }
  Object.assign(env, extra, {
    DSH_HOME: canonical(paths.home),
    DSH_AGENTS_HOME: canonical(paths.agentsHome),
    TRADELOOM_DSH_APP_HOME: canonical(paths.home),
    APPDATA: canonical(paths.appData),
    LOCALAPPDATA: canonical(paths.localAppData),
    XDG_CACHE_HOME: canonical(paths.xdgCache),
    XDG_CONFIG_HOME: canonical(paths.xdgConfig),
    XDG_DATA_HOME: canonical(paths.xdgData),
  })
  return env
}

export function buildNativeBridgeChildEnvironment(source, paths, extra = {}, keyFactory = createNativeBridgeKey, environmentBuilder = buildChildEnvironment) {
  const key = keyFactory()
  if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('Native bridge key generator returned an invalid key.')
  return {
    key,
    env: environmentBuilder(source, paths, { ...extra, [NATIVE_BRIDGE_ENV]: key }),
  }
}

export function buildDjangoChildEnvironment(source, paths, extra = {}) {
  const dataRoot = canonical(paths.dataRoot)
  return buildChildEnvironment(source, paths, {
    ...extra,
    TRADELOOM_DATA_ROOT: dataRoot,
    TRADELOOM_INTAKE_ROOT: path.join(dataRoot, 'private', 'intake'),
  })
}

export function buildDesktopChildEnvironment(source, paths, { runtimePath, host, port, nativeBridgeKey }) {
  const primaryRuntimeDir = path.resolve(runtimePath, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'runtime', 'primary-runtime')
  const env = buildChildEnvironment(source, paths, {
    TRADELOOM_MANAGED_DESKTOP: '1',
    TRADELOOM_EXTERNAL_SUPERVISOR: '1',
    TRADELOOM_DSH_BIND_HOST: host,
    TRADELOOM_DSH_BIND_PORT: String(port),
    ...(nativeBridgeKey ? { [NATIVE_BRIDGE_ENV]: nativeBridgeKey } : {}),
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: primaryRuntimeDir,
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  })
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function safeLogLine(line) {
  return line
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL omitted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g, '[secret omitted]')
}

export function startOwnedChild(command, args, options) {
  const { logPath, logLabel = 'child', windowsHide = true, ...spawnOptions } = options
  const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'], windowsHide })
  const handle = { child, stopped: false }
  let writeQueue = Promise.resolve()
  const appendSafeLine = text => {
    if (!logPath) return
    writeQueue = writeQueue.then(() => import('node:fs/promises').then(fs => fs.appendFile(logPath, `[${new Date().toISOString()}] ${logLabel}: ${safeLogLine(text)}\n`)))
  }
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) appendSafeLine(line)
    })
    stream.on('end', () => { if (pending) appendSafeLine(pending) })
  }
  let spawnError
  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', error => { spawnError = error; reject(error) })
  })
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal, error: spawnError }))
    child.once('error', error => resolve({ code: null, signal: null, error }))
  })
  return {
    handle,
    spawned,
    exited,
    async flushLogs() { await writeQueue },
    async stop() {
      if (handle.stopped) return exited
      if (child.exitCode !== null || spawnError) return exited
      handle.stopped = true
      child.kill()
      const result = await exited
      await writeQueue
      return result
    },
  }
}

export async function startTransaction(startSteps) {
  const handles = []
  try {
    for (const start of startSteps) {
      const handle = await start()
      handles.push(handle)
      if (handle.spawned) await handle.spawned
      if (handle.ready) await handle.ready
    }
    return handles
  } catch (error) {
    await Promise.allSettled(handles.reverse().map(handle => handle.stop()))
    throw error
  }
}

export function getDefaultPaths(env = process.env) {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) throw new Error('Windows LOCALAPPDATA 不可用，无法确定织贸助手专属数据目录。')
  const dataRoot = env.TRADELOOM_DATA_ROOT ?? path.join(localAppData, 'TradeLoom')
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw new Error('TRADELOOM_DATA_ROOT 必须是绝对路径。')
  }
  const product = path.resolve(dataRoot)
  return {
    dataRoot: product,
    explicitDataRoot: env.TRADELOOM_DATA_ROOT !== undefined,
    home: path.join(product, 'harness-home'),
    agentsHome: path.join(product, 'agents-home'),
    workspace: path.join(product, 'workspace'),
    logs: path.join(product, 'logs'),
    appData: path.join(product, 'appdata'),
    localAppData: path.join(product, 'local-appdata'),
    xdgCache: path.join(product, 'xdg', 'cache'),
    xdgConfig: path.join(product, 'xdg', 'config'),
    xdgData: path.join(product, 'xdg', 'data'),
    python: path.join(localAppData, 'TradeLoom', 'python-env', 'Scripts', 'python.exe'),
  }
}

export function localInterfaces() {
  return os.networkInterfaces()
}
