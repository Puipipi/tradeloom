
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const replayRoot = process.env.TL_RC3_REPLAY_ROOT
const primaryRuntime = process.env.TL_RC3_PRIMARY_RUNTIME
const probeRoot = process.env.TL_RC3_PROBE_ROOT

function withDeadline(promise, description, duration = 45_000) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), duration) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runProfileProbe(legacy) {
  const root = await mkdtemp(join(probeRoot, 'rc3-scenes-'))
  const home = join(root, 'dsh')
  const profile = join(home, 'profiles', 'desktop')
  const workspace = join(root, 'workspace')
  const runtime = join(replayRoot, 'sdk/dsh')
  const hostEntry = join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')
  const ownedCore = await import(pathToFileURL(join(replayRoot, 'desktop/lib/tradeloom/core.mjs')).href)
  const require = createRequire(pathToFileURL(join(runtime, 'package.json')))
  assert.equal(require('./package.json').version, '0.2.2-rc.3')
  await ownedCore.ensureOwnedHome(home)
  for (const directory of [profile, workspace, ...['local', 'roaming', 'temp', 'agents', 'xdg'].map(item => join(root, item))]) {
    await mkdir(directory, { recursive: true })
  }
  const bundle = '@tradeloom/dsh-business-shell'
  await require('@deepseek-ai/dsh-app-boot').initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', bundle])
  const destination = join(profile, 'node_modules', bundle)
  await cp(join(replayRoot, 'business-shell'), destination, { recursive: true, errorOnExist: true, force: false })
  const packagePath = join(destination, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const peer = '@deepseek-ai/dsh-scope'
  assert.equal(packageJson.peerDependencies[peer], '0.2.2-rc.2 || 0.2.2-rc.3')
  if (legacy) {
    packageJson.peerDependencies[peer] = '0.2.2-rc.2'
    await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n')
  }
  const env = Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','COMSPEC','PROCESSOR_ARCHITECTURE']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, {
    DSH_HOME: home, TRADELOOM_DSH_APP_HOME: home, DSH_WORKSPACE: workspace, DSH_AGENTS_HOME: join(root, 'agents'),
    LOCALAPPDATA: join(root, 'local'), APPDATA: join(root, 'roaming'), TMP: join(root, 'temp'), TEMP: join(root, 'temp'),
    XDG_CACHE_HOME: join(root, 'xdg'), XDG_CONFIG_HOME: join(root, 'xdg'), XDG_DATA_HOME: join(root, 'xdg'),
    NODE_USE_SYSTEM_CA: '1', DSH_TELEMETRY_DISABLED: '1',
  })
  const child = fork(hostEntry, [runtime, profile, primaryRuntime], { cwd: profile, execArgv: ['--expose-internals'], env, silent: true })
  let exited = false
  const completion = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) }))
  let stderr = ''
  child.stdout?.resume()
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'ready') resolve(message.url)
      if (message?.type === 'fatal') reject(new Error('owned Host reported fatal startup'))
    })
    child.once('error', () => reject(new Error('owned Host could not spawn')))
    child.once('exit', () => reject(new Error('owned Host exited before ready')))
  })
  try {
    const tokenUrl = new URL(await withDeadline(ready, 'owned Host did not report ready'))
    assert.ok(tokenUrl.protocol === 'http:' && tokenUrl.hostname === '127.0.0.1'
      && !['', '3088','3090','55432'].includes(tokenUrl.port), 'probe must bind only an ephemeral loopback port')
    const request = options => ({ redirect: 'manual', signal: AbortSignal.timeout(12_000), ...options })
    const auth = await fetch(tokenUrl, request())
    const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
    await auth.body?.cancel()
    assert.equal(auth.status, 303)
    assert.ok(cookie, 'the existing Host authentication must issue a cookie')
    const scenesUrl = new URL('/tradeloom/scenes', tokenUrl.origin)
    const unauthenticated = await fetch(scenesUrl, request())
    await unauthenticated.body?.cancel()
    const scenes = await fetch(scenesUrl, request({ headers: { cookie } }))
    const bundleSkipped = stderr.includes(bundle + '@0.1.0') && stderr.includes(peer) && stderr.includes('incompatible')
    assert.equal(bundleSkipped, legacy)
    if (legacy) {
      await scenes.body?.cancel()
      assert.equal(scenes.status, 404)
      return
    }
    assert.equal(unauthenticated.status, 401)
    assert.equal(scenes.status, 200)
    const configuration = await scenes.json()
    assert.ok(Array.isArray(configuration.scenes) && configuration.scenes.length > 0)
    assert.ok(Array.isArray(configuration.roles) && configuration.roles.length > 0)
    assert.ok(configuration.sessionBindings && typeof configuration.sessionBindings === 'object'
      && !Array.isArray(configuration.sessionBindings))
  } finally {
    if (!exited && child.connected) child.send({ type: 'shutdown' })
    const { code, signal } = await withDeadline(completion, 'owned probe Host did not shut down normally')
    assert.equal(code, 0)
    assert.equal(signal, null)
  }
}

test('rc.3 Host mounts the exact-compatible shell and protects the live scenes route', {
  skip: !(replayRoot && primaryRuntime && probeRoot) && 'requires staged rc.3, pinned Node runtime and an isolated scratch root',
}, async () => {
  await runProfileProbe(true)
  await runProfileProbe(false)
})
