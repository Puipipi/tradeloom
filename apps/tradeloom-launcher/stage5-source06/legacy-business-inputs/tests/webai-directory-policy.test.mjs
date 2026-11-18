import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebAiDirectoryPolicies } from '../webai-directory-policy.js'

test('Main directory grant requires actual target identity, explicit dialog/confirmation, defaults to no write and revokes pending access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tl-directory-policy-')); t.after(() => rm(root, { recursive: true, force: true }))
  const owner = { guestId: 1, generation: 2, sceneId: 'one', panelId: 'chat', roleId: 'center', sessionId: 'session-one', bindingRevision: '3', operationId: 'operation-one' }
  const original = { targetId: 'target', providerId: 'deepseek', windowId: 'window', conversationId: 'conversation', generation: 4, available: true }
  let target = { ...original }, alive = true, confirms = 0
  const policy = createWebAiDirectoryPolicies({ readTarget: async () => target,
    assertOwner: value => { assert.deepEqual(value, owner); if (!alive) throw Error('owner_revoked') },
    chooseDirectory: async () => root, confirmAccess: async (_owner, _target, _root, permissions) => { confirms++; assert.equal(permissions.write, false); return true } })
  const grant = await policy.select(owner, original.targetId)
  assert.equal(grant.write, false); assert.equal(confirms, 1)
  await assert.rejects(policy.resolve(grant.id, owner, original, 'write_new'), { code: 'webai_directory_grant_denied' })
  const read = await policy.resolve(grant.id, owner, original, 'read'); assert.equal(read.rootPath, root)
  target = { ...target, generation: 5 }
  await assert.rejects(read.assertCurrent(), { code: 'webai_directory_target_changed' })
  policy.revokeTarget(original.targetId); assert.equal(read.signal.aborted, true)
  await assert.rejects(policy.resolve(grant.id, owner, original, 'read'), { code: 'webai_directory_grant_denied' })
  target = { ...original }; alive = false
  await assert.rejects(policy.select(owner, original.targetId), /owner_revoked/)
  policy.dispose()
})

test('window-only/no conversation is not a live target; cancel creates no grant', async () => {
  const policy = createWebAiDirectoryPolicies({ readTarget: async () => ({ providerId: 'doubao', windowId: 'one', available: true }),
    assertOwner() {}, chooseDirectory() { throw Error('must not open picker') }, confirmAccess() { throw Error('must not confirm') } })
  const owner = Object.fromEntries(['guestId', 'generation', 'sceneId', 'panelId', 'roleId', 'sessionId', 'bindingRevision', 'operationId'].map(key => [key, 1]))
  await assert.rejects(policy.select(owner, 'target'), { code: 'webai_target_unavailable' })
})
