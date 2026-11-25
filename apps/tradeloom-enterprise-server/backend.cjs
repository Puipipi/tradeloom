'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')

const simple = new Set(['status', 'start', 'open', 'manage-status', 'manage-start', 'manage-stop', 'manage-restart'])
const emailStates = new Set(['missing', 'inactive', 'unbound', 'pending', 'ready'])
const boolFields = ['installed', 'running', 'database_running', 'healthy', 'has_admin', 'smtp_configured', 'admin_binding_pending', 'binding_confirmation_required']
const primitive = (value, size) => typeof value === 'string' && value.length > 0 && value.length <= size && !/[\0\r\n]/.test(value)
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
const email = (value) => primitive(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

function payloadFor(action, value) {
  if (simple.has(action)) {
    if (value !== undefined && value !== null) throw new Error('该操作不接受参数。')
    return ['manage-stop', 'manage-restart'].includes(action) ? { confirmed: true } : null
  }
  if (action === 'create'
    && keys(value, ['username', 'email', 'password']) && primitive(value.username, 150)
    && email(value.email) && primitive(value.password, 4096)) return value
  if (action === 'mail' && value && typeof value === 'object') {
    const operation = value.operation
    if (['smtp', 'smtp-replace'].includes(operation) && keys(value, ['operation', 'smtp'])) {
      const data = value.smtp
      if (keys(data, ['host', 'port', 'security', 'username', 'password', 'from_email'])
        && primitive(data.host, 253) && /^[a-z0-9.-]+$/i.test(data.host)
        && Number.isInteger(data.port) && data.port >= 1 && data.port <= 65535
        && ['ssl', 'starttls'].includes(data.security)
        && typeof data.username === 'string' && data.username.length <= 254 && !/[\0\r\n]/.test(data.username)
        && typeof data.password === 'string' && data.password.length <= 4096 && !/[\0\r\n]/.test(data.password)
        && email(data.from_email)) return value
    }
    if (operation === 'bind-email-start' && keys(value, ['operation', 'username', 'email'])
      && primitive(value.username, 150) && email(value.email)) return value
    if (operation === 'bind-email-resend' && keys(value, ['operation', 'username'])
      && primitive(value.username, 150)) return value
    if (operation === 'bind-email-verify' && keys(value, ['operation', 'username', 'code'])
      && primitive(value.username, 150) && typeof value.code === 'string' && /^[0-9]{8}$/.test(value.code)) return value
  }
  throw new Error('操作或输入不符合服务器工作台要求。')
}

function publicResult(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') throw new Error('服务器后端未返回有效状态。')
  const result = { ok: raw.ok }
  for (const field of boolFields) if (typeof raw[field] === 'boolean') result[field] = raw[field]
  if (emailStates.has(raw.admin_email_state)) result.admin_email_state = raw.admin_email_state
  if (email(raw.smtp_from_email)) result.smtp_from_email = raw.smtp_from_email
  if (primitive(raw.message, 900)) result.message = raw.message
  return result
}

function backendConfig(args, root) {
  const names = new Map([['-dataroot', 'DataRoot'], ['-runtimesource', 'RuntimeSource'], ['-port', 'Port'], ['-postgresport', 'PostgresPort']])
  const options = { RuntimeSource: path.join(root, 'enterprise-runtime-bundle') }
  const seen = new Set()
  for (let i = 0; i < args.length; i += 2) {
    const option = names.get(args[i].toLowerCase())
    const value = args[i + 1]
    if (!option || seen.has(option) || !primitive(value, 1000)) throw new Error('启动参数无效。')
    seen.add(option)
    if (option.endsWith('Port')) {
      if (!/^[0-9]{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('启动端口无效。')
    } else if (!/^[a-z]:[\\/]/i.test(value) || /["<>|?*]/.test(value)) {
      throw new Error('数据与运行库目录须为本机绝对路径。')
    }
    options[option] = value
  }
  return options
}

function makeBackend(root, options) {
  const system = process.env.SystemRoot
  if (!system || !path.isAbsolute(system)) throw new Error('找不到本机 PowerShell。')
  const executable = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  function invoke(scriptName, args, payload, read) {
    const script = path.join(root, 'scripts', scriptName)
    return new Promise((resolve, reject) => {
      const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, ...args]
      const child = spawn(executable, argv, { cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
      let output = ''
      let done = false
      const timer = setTimeout(() => finish(null), 10 * 60 * 1000)
      function finish(line) {
        if (done) return
        done = true
        clearTimeout(timer)
        child.stdout.destroy()
        try {
          if (!line) throw new Error()
          resolve(read(line.trim()))
        } catch { reject(new Error('未取得有效结果，请刷新确认服务器状态。')) }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        output += chunk
        const nextLine = output.indexOf('\n')
        // PostgreSQL may retain the inherited pipe after the backend exits.
        if (nextLine >= 0) finish(nextLine <= 16384 ? output.slice(0, nextLine) : null)
        else if (output.length > 16384) finish(null)
      })
      child.on('error', () => finish(null))
      child.on('close', () => finish(output))
      child.stdin.on('error', () => {})
      child.stdin.end(payload ? JSON.stringify(payload) + '\n' : undefined)
    })
  }
  const backend = (action, input) => {
    const args = ['-Action', action]
    for (const [key, value] of Object.entries(options)) args.push('-' + key, value)
    return invoke('ServerGuiBackend.ps1', args, payloadFor(action, input), (line) => publicResult(JSON.parse(line)))
  }
  backend.consoleTarget = () => {
    const args = ['-PrintUrlOnly']
    if (options.DataRoot) args.push('-DataRoot', options.DataRoot)
    return invoke('Open-ServerConsole.ps1', args, null, (line) => line)
  }
  return backend
}

function localConsoleOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/enterprise\/console\/$/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024
      && url.pathname === '/enterprise/console/' && !url.search && !url.hash && !url.username && !url.password
      ? url.origin : null
  } catch { return null }
}

function permitsConsoleRequest(origin, value) {
  try {
    const url = new URL(value)
    return url.origin === origin && !url.username && !url.password && (
      ['/accounts/login/', '/accounts/logout/', '/enterprise/console'].includes(url.pathname)
      || (url.pathname === '/enterprise/capabilities/' && url.search === '?ui=1' && !url.hash)
      || ['/enterprise/console/', '/api/enterprise/operations/', '/static/', '/admin/'].some((base) => url.pathname.startsWith(base))
    )
  } catch { return false }
}

const isReady = (status) => status.ok === true && status.running === true && status.has_admin === true
  && status.smtp_configured === true && email(status.smtp_from_email) && status.admin_email_state === 'ready'

module.exports = { backendConfig, isReady, makeBackend, payloadFor, publicResult, localConsoleOrigin, permitsConsoleRequest }
