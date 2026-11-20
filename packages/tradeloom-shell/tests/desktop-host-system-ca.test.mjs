import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

test('actual DesktopHostProcess.start opts only its child into system CA without changing other children or parent environment', async () => {
  const inputs = JSON.parse(await readFile(process.env.TL_SEVEN_DESKTOP_INPUTS, 'utf8'))
  const sourceBytes = await readFile(inputs.main.path), source = sourceBytes.toString('utf8')
  assert.equal(sourceBytes.length, inputs.main.bytes)
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), inputs.main.sha256)
  const environmentStart = source.indexOf('function desktopNodeEnvironment(')
  const environmentEnd = source.indexOf('\n//#endregion', environmentStart)
  const bridgeStart = source.indexOf('function resolveDesktopHostBridge(')
  const classStart = source.indexOf('var DesktopHostProcess = class {', bridgeStart)
  const classEnd = source.indexOf('\n//#endregion', classStart)
  assert.ok(environmentStart > 0 && bridgeStart > 0 && classStart > bridgeStart && classEnd > classStart)
  const calls = [], child = new EventEmitter()
  child.connected = true
  child.stdout = new EventEmitter(); child.stdout.pipe = () => process.stdout
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  const collector = () => ({ push() {}, reset() {} })
  // Actual Host constructor/start, argument construction, SDK version bridge,
  // child readiness event validation and ready promise execute. OS spawning,
  // inactive diagnostic collectors and unused confirmation UI are controlled.
  // This does not call the external model URL or claim prepare/download success.
  const factory = new Function('createRequire', 'pathToFileURL', 'join', 'spawn', 'createNativeImportConfirmationRequests', 'createUi18ThemeReceiptLineCollector', 'createUi18RootIdentityLineCollector', 'observeStartup', `
    ${source.slice(environmentStart, environmentEnd)}
    ${source.slice(bridgeStart, classEnd)}
    return {DesktopHostProcess,desktopNodeEnvironment};
  `)
  const { DesktopHostProcess, desktopNodeEnvironment } = factory(createRequire, pathToFileURL, join,
    (...args) => { calls.push(args); return child }, () => ({ dispose() {} }), collector, collector, () => {})
  const parent = { NODE_USE_SYSTEM_CA: '0', CUSTOM_PARENT_VALUE: 'preserved' }, before = { ...parent }
  const actualParentFlag = process.env.NODE_USE_SYSTEM_CA
  const sdk = process.env.TL_SEVEN_SDK_RUNTIME
  const host = new DesktopHostProcess('controlled-electron.exe', sdk, 'controlled-profile', undefined, parent, () => {})
  const ready = host.start()
  assert.equal(calls.length, 1)
  const [executable, argv, options] = calls[0]
  assert.equal(executable, 'controlled-electron.exe')
  assert.deepEqual(argv, ['--expose-internals', join(sdk, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'), sdk, 'controlled-profile', join(sdk, '..', 'runtime', 'primary-runtime')])
  assert.equal(options.cwd, 'controlled-profile')
  assert.equal(options.env.NODE_USE_SYSTEM_CA, '1', 'only actual Host spawn must opt into system CA')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(options.env.CUSTOM_PARENT_VALUE, 'preserved')
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
  assert.deepEqual(parent, before); assert.equal(process.env.NODE_USE_SYSTEM_CA, actualParentFlag)
  assert.equal(desktopNodeEnvironment('other.exe', undefined, parent).NODE_USE_SYSTEM_CA, '0', 'shared helper and unrelated children must retain their existing trust policy')
  child.emit('message', { type: 'ready', url: 'http://127.0.0.1:12345', injections: {} })
  assert.deepEqual(await ready, { url: 'http://127.0.0.1:12345', injections: {} })
  await host.start(); assert.equal(calls.length, 1)
  host.cancelNativeImportConfirmations()
  child.removeAllListeners(); child.stdout.removeAllListeners(); child.stderr.removeAllListeners()
})
