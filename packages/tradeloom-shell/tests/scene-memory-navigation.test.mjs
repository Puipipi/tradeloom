import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSceneMemoryCatalog, sceneMemoryDocument } from '../scene-memory.js'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'

test('real catalog resolution feeds the actual client native navigation/detail consumer; references are not authority', async t => {
  const producer = await sourceRoleIdentity(t), expected = await producer.descriptor()
  const origin = { ...expected, operationId: 'controlled' }, value = sceneMemoryDocument(null)
  value.profile.assetRefs.push({ kind: 'role', id: 'center' }, { kind: 'scene', id: 'other' })
  value.progress.push({ entryId: 'progress-one', text: 'synthetic record', sourceSessionId: 'old', createdAt: 'controlled' })
  const catalog = createSceneMemoryCatalog({ async transactSceneMemory(owner) { assert.equal(owner, origin); return { value, revision: 1 } }, updateSceneMemory() {} })
  const view = await catalog.execute(origin, { action: 'graph' })
  const source = await readFile(new URL('../client.scene-memory.js', import.meta.url), 'utf8')
  const start = source.indexOf('        async function resolve(node)'), end = source.indexOf('        if (sessionId !== expected.sessionId)', start)
  assert.ok(start > 0 && end > start)
  const commands = [], errors = [], records = []; let open = true
  const matchesSurfaceDescriptor = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key])
  const resolve = new Function('request', 'view', 'expected', 'bridge', 'matchesSurfaceDescriptor', 'lifetime', 'setBusy', 'setError', 'setOpen', 'setSelectedRecord', `${source.slice(start, end)};return resolve`)(
    input => catalog.execute(origin, input), view, expected, { nativeSurfaceDescriptor: () => producer.bridge.nativeSurfaceDescriptor(), accountSidebarCommand: async command => { commands.push(command); return producer.bridge.accountSidebarCommand(command) } },
    matchesSurfaceDescriptor, { current: { signal: { aborted: false } } }, () => {}, error => { if (error) errors.push(error) }, state => { open = state }, record => records.push(record))
  await resolve(view.graph.nodes.find(node => node.kind === 'scene'))
  assert.equal(open, false); assert.equal(commands.length, 1)
  assert.deepEqual(commands[0], { generation: expected.generation, accountGeneration: expected.accountGeneration, command: { action: 'openSession', target: expected.sessionId } })
  assert.ok(producer.primary.webContents.messages.some(message => message.channel === 'source-shell:show-account-chat' && message.args[0].action === 'openBoundSession'))
  await resolve(view.graph.nodes.find(node => node.kind === 'asset_ref' && node.data.id === 'center'))
  assert.equal(commands.length, 2)
  await resolve(view.graph.nodes.find(node => node.kind === 'asset_ref' && node.data.id === 'other'))
  assert.equal(commands.length, 2); assert.match(errors.at(-1), /尚无已授权/)
  await resolve(view.graph.nodes.find(node => node.kind === 'progress'))
  assert.equal(records.at(-1).data.text, 'synthetic record'); assert.equal(commands.length, 2)
  await producer.rotateSameSession()
  await resolve(view.graph.nodes.find(node => node.kind === 'session_binding'))
  assert.equal(commands.length, 2); assert.match(errors.at(-1), /目标已变化/)
})
