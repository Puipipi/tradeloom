import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('role widget references share and retry without retaining the navigation main source', async () => {
  let registration
  runInNewContext(await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { registration = value } } },
  })
  const scenes = registration.factory(() => ({ createElement() {} }))
  const counts = new Map(), references = [], listeners = new Set()
  const count = (id, source) => counts.get(id)?.get(source) ?? 0
  let failOther = true
  const sessions = {
    list: { getSnapshot: () => ({ phase: 'ready', ids: ['seed', 'other', 'replacement'] }),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
    refresh: async () => {},
    retain(id, { source }) {
      const bySource = counts.get(id) ?? new Map(); counts.set(id, bySource)
      bySource.set(source, (bySource.get(source) ?? 0) + 1)
      const fail = id === 'other' && failOther
      failOther = fail ? false : failOther
      const reference = { id, source, ready: fail ? Promise.reject(new Error('isolated open failure')) : Promise.resolve(), releases: 0,
        release() { assert.equal(++reference.releases, 1, 'every owned reference releases exactly once'); bySource.set(source, bySource.get(source) - 1) } }
      references.push(reference)
      // The real catalog also notifies retainedBy changes synchronously.
      for (const listener of [...listeners]) listener()
      return reference
    },
  }
  const navigation = sessions.retain('seed', { source: 'mainView' })
  const center = scenes.retainRoleSession(sessions, 'center', 'seed')
  const product = scenes.retainRoleSession(sessions, 'product', 'seed')
  assert.strictEqual(scenes.retainRoleSession(sessions, 'center', 'seed'), center)
  assert.notStrictEqual(center, product)
  assert.equal(count('seed', 'mainView'), 1, 'widget owners must not increment the navigation main-source count')
  assert.equal(count('seed', 'tradeloomRoleWidget'), 2)
  navigation.release()
  assert.equal(count('seed', 'mainView'), 0, 'navigation can fully relinquish seed while widget scopes remain alive')
  assert.equal(count('seed', 'tradeloomRoleWidget'), 2)
  const errors = [], ready = []
  const stopFailed = scenes.retainListedRoleSession(sessions, 'delivery', 'other', {
    onReady: reference => ready.push(reference), onUnavailable: error => errors.push(error),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(errors.length, 1)
  const stopRetry = scenes.retainListedRoleSession(sessions, 'delivery', 'other', { refresh: true,
    onReady: reference => ready.push(reference), onUnavailable: error => errors.push(error),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready.length, 1)
  assert.equal(count('other', 'mainView'), 0, 'retry must not reintroduce sticky main navigation retention')
  assert.equal(count('other', 'tradeloomRoleWidget'), 2, 'failed and retried references retain their original tracked lifecycle')
  assert.strictEqual(scenes.retainRoleSession(sessions, 'delivery', 'other'), ready[0])
  stopFailed(); stopRetry()
  assert.equal(listeners.size, 0)
  assert.equal(count('other', 'tradeloomRoleWidget'), 2, 'panel cleanup does not cross-release the shared pool')
  scenes.retainRoleSession(sessions, 'center', 'replacement')
  assert.equal(center.releases, 1, 'rebind releases that role previous reference')
  assert.equal(product.releases, 0, 'rebind does not release the other role sharing the session')
  scenes.releaseRoleSessions(); scenes.releaseRoleSessions()
  assert(references.every(reference => reference.releases === 1))
  for (const bySource of counts.values()) for (const value of bySource.values()) assert.equal(value, 0)
})
