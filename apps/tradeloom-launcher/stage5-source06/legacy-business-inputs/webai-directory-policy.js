import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

const fail = code => Object.assign(new Error(code), { code })
const targetKeys = ['targetId', 'providerId', 'windowId', 'conversationId', 'generation']
const ownerKeys = ['sceneId', 'panelId', 'roleId', 'sessionId', 'bindingRevision', 'operationId', 'generation', 'guestId']
const same = (left, right, keys) => left && right && keys.every(key => left[key] === right[key])
function target(value) {
  if (!value || !['deepseek', 'doubao'].includes(value.providerId)
    || targetKeys.filter(key => key !== 'generation').some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || value.available !== true) throw fail('webai_target_unavailable')
  return Object.freeze(Object.fromEntries(targetKeys.map(key => [key, value[key]])))
}
async function ordinaryDirectory(path) {
  if (!isAbsolute(path)) throw fail('webai_directory_unavailable')
  const absolute = resolve(path)
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('webai_directory_unavailable')
    if (dirname(cursor) === cursor) break
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw fail('webai_directory_unavailable')
  return absolute
}

/** Main owns this registry. No renderer root, owner or target descriptor is
 * accepted. A real site adapter must already provide the current conversation;
 * a browser window/URL alone cannot satisfy readTarget and cannot grant files. */
export function createWebAiDirectoryPolicies({ readTarget, assertOwner, chooseDirectory, confirmAccess,
  now = Date.now, lifetimeMs = 15 * 60_000 } = {}) {
  if ([readTarget, assertOwner, chooseDirectory, confirmAccess].some(value => typeof value !== 'function')) throw new TypeError('Main directory policy requires real owned target/dialog dependencies')
  const grants = new Map()
  let closed = false
  async function current(owner, expected) {
    if (closed) throw fail('webai_directory_policy_closed')
    await assertOwner(owner)
    const actual = target(await readTarget(expected.targetId))
    if (!same(actual, expected, targetKeys)) throw fail('webai_directory_target_changed')
    return actual
  }
  return Object.freeze({
    async select(owner, targetId, { write = false } = {}) {
      if (typeof write !== 'boolean' || ownerKeys.some(key => owner?.[key] === undefined)) throw fail('webai_directory_owner_unavailable')
      const capturedOwner = Object.freeze(Object.fromEntries(ownerKeys.map(key => [key, owner[key]])))
      await assertOwner(capturedOwner)
      const capturedTarget = target(await readTarget(targetId))
      const selected = await chooseDirectory(capturedOwner, capturedTarget)
      if (selected === null) return { cancelled: true }
      const rootPath = await ordinaryDirectory(selected)
      await current(capturedOwner, capturedTarget)
      if (!await confirmAccess(capturedOwner, capturedTarget, rootPath, { read: true, write })) return { cancelled: true }
      await current(capturedOwner, capturedTarget)
      await ordinaryDirectory(rootPath)
      const id = randomUUID(), controller = new AbortController()
      const grant = { id, owner: capturedOwner, target: capturedTarget, rootPath, write, controller, expiresAt: now() + lifetimeMs }
      grants.set(id, grant)
      // Only this opaque id and permission summary may cross to the renderer.
      return { id, read: true, write, expiresAt: grant.expiresAt }
    },
    async resolve(id, owner, expectedTarget, operation) {
      const grant = grants.get(id)
      if (!grant || grant.controller.signal.aborted || grant.expiresAt <= now()
        || !same(owner, grant.owner, ownerKeys) || !same(expectedTarget, grant.target, targetKeys)
        || !['list', 'read', 'write_new'].includes(operation) || operation === 'write_new' && !grant.write) throw fail('webai_directory_grant_denied')
      await current(grant.owner, grant.target)
      await ordinaryDirectory(grant.rootPath)
      if (grants.get(id) !== grant || grant.controller.signal.aborted) throw fail('webai_directory_grant_denied')
      return Object.freeze({ rootPath: grant.rootPath, withFiles: true, allowWrite: grant.write,
        owner: grant.owner, target: grant.target, signal: grant.controller.signal,
        assertCurrent: async () => { await current(grant.owner, grant.target); if (grants.get(id) !== grant || grant.expiresAt <= now() || grant.controller.signal.aborted) throw fail('webai_directory_grant_denied') } })
    },
    revoke(id) { const grant = grants.get(id); if (!grant) return false; grants.delete(id); grant.controller.abort(); return true },
    revokeTarget(targetId) { for (const [id, grant] of grants) if (grant.target.targetId === targetId) { grants.delete(id); grant.controller.abort() } },
    dispose() { closed = true; for (const grant of grants.values()) grant.controller.abort(); grants.clear() },
  })
}
