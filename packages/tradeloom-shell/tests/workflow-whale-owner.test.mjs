import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../../../apps/tradeloom-launcher/accepted-plugin-overrides/p/202/assets/whale-widget.js', import.meta.url), 'utf8')
const init = 'function dshwInit() {'
const probe = source.replace(init, init + ' recordInitialization(); return;')
assert.notEqual(probe, source)

function evaluate({ descriptor, composer, textarea } = {}) {
  let initializations = 0
  const timers = []
  const root = {
    querySelector: selector => composer && selector === '[data-composer-input]' ? {} : null,
    querySelectorAll: () => textarea ? [{ closest: selector => selector === '.tl-wf' ? {} : null }] : [],
  }
  const window = { dshDesktop: descriptor && { nativeSurfaceDescriptor: descriptor } }
  const context = {
    window,
    document: { getElementById: id => id === 'root' ? root : null },
    recordInitialization: () => initializations++,
    setInterval: fn => { timers.push(fn); return timers.length },
    clearInterval() {},
  }
  vm.runInNewContext(probe, context)
  return { count: () => initializations, timers, reload: () => vm.runInNewContext(probe, context) }
}

test('workflow guest cannot initialize a second whale while the actual assistant composer initializes once', async () => {
  let resolveOwner
  const descriptor = () => new Promise(resolve => { resolveOwner = resolve })
  const workflow = evaluate({ descriptor, textarea: true, composer: true })
  const assistant = evaluate({ descriptor: async () => ({ kind:'role', surface:'chat' }), composer: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workflow.count(), 0)
  resolveOwner({ kind:'scene-component', componentKey:'workflow-canvas-native' })
  await new Promise(resolve => setImmediate(resolve))
  workflow.reload()
  assistant.reload()
  assert.equal(workflow.count(), 0)
  assert.equal(workflow.timers.length, 0)
  assert.equal(assistant.count(), 1)
})

test('browser workflow textarea is ignored and descriptor failure preserves a real composer', async () => {
  const workflow = evaluate({ textarea:true })
  const assistant = evaluate({ descriptor:async () => { throw Error('fixture unavailable') }, composer:true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workflow.count(), 0)
  workflow.timers[0]()
  assert.equal(workflow.count(), 0)
  assert.equal(assistant.count(), 1)
})
