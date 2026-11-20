import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'

test('real Host binding → final controller → Main/preload full tuple, same notification and ACK fences', async t => {
  const f = await sourceRoleIdentity(t), original = await f.descriptor()
  assert.equal(original.roleId, 'center'); assert.equal(original.bindingRevision, '1'); assert.equal(original.sessionId, 'one')
  assert.deepEqual(Object.keys(f.accountDescriptor).sort(), ['businessNavigation', 'generation', 'kind'])
  const notices = [], stop = f.bridge.onNativeSurfaceChanged(value => notices.push(value)); t.after(stop)
  await f.bridge.nativeSurfaceMounted(original)
  f.notifyLayout()
  assert.deepEqual(notices.at(-1), original); assert.deepEqual(await f.descriptor(), original)
  const rebound = await f.rotateSameSession()
  assert.equal(rebound.roleId, 'center'); assert.equal(rebound.sessionId, original.sessionId); assert.equal(rebound.bindingRevision, '2')
  assert.ok(rebound.generation > original.generation); assert.deepEqual(notices.at(-1), rebound)
  await assert.rejects(f.bridge.nativeSurfaceMounted(original), /rejected mounted acknowledgement/)
  await assert.rejects(f.bridge.nativeSurfaceMounted({ ...rebound, roleId: 'product' }), /rejected mounted acknowledgement/)
  await assert.rejects(f.bridge.nativeSurfaceMounted(Object.fromEntries(Object.entries(rebound).filter(([key]) => key !== 'bindingRevision'))), /rejected mounted acknowledgement/)
  await f.bridge.nativeSurfaceMounted(rebound)
  const oldView = f.view(), changed = await f.changeRole()
  assert.equal(notices.at(-1).roleId, 'center'); assert.equal(notices.at(-1).sessionId, 'one'); assert.equal(notices.at(-1).bindingRevision, '2')
  assert.equal(changed.roleId, 'product'); assert.equal(changed.sessionId, 'two'); assert.equal(changed.bindingRevision, '7')
  assert.equal(oldView.webContents.isDestroyed(), true)
  assert.throws(() => f.controller.nativeMounted(f.view().webContents, f.view().webContents.mainFrame, rebound), /rejected mounted acknowledgement/)
  await assert.rejects(f.bridge.nativeSurfaceDescriptor(), /unowned sender/)
})

test('actual directory Main owner check consumes producer fields and rejects old binding/role/frame', async t => {
  const f = await sourceRoleIdentity(t), tuple = await f.descriptor(), contents = f.view().webContents
  const owner = { ...tuple, guestId: contents.id, operationId: 'controlled-pending-operation' }
  const ownerFrames = new Map([[owner.operationId, { contents, frame: contents.mainFrame, controller: f.controller }]])
  const start = f.mainSource.indexOf('\t\tconst assertOwner = async owner => {', f.mainSource.indexOf('const webAiDirectory ='))
  const end = f.mainSource.indexOf('\n\t\tconst policies =', start)
  assert.ok(start > 0 && end > start)
  const assertOwner = new Function('ownerFrames', 'webContents', 'sourceController', 'targets', `${f.mainSource.slice(start, end)};return assertOwner`)(
    ownerFrames, { fromId: id => id === contents.id ? contents : undefined }, f.controller, { async assertOwner(value) { assert.equal(value.operationId, owner.operationId) } })
  await assertOwner(owner)
  await assert.rejects(assertOwner({ ...owner, roleId: 'product' }), /owner changed/)
  await f.rotateSameSession()
  await assert.rejects(assertOwner(owner), /owner changed/)
  const fresh = { ...await f.descriptor(), guestId: contents.id, operationId: owner.operationId }
  await assertOwner(fresh)
  contents.mainFrame = { url: 'dsh-app://app/' }
  await assert.rejects(assertOwner(fresh), /owner changed/)
})
