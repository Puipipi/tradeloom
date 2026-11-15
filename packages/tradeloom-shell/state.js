import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ROLE_IDS } from './roles.js'

export const HOME_MARKER = '.tradeloom-owned'
export const HOME_MARKER_VALUE = 'tradeloom-dsh-apphome-v1\n'
export { ROLE_IDS } from './roles.js'

const initialState = () => ({ version: 1, roles: {}, roleBindingRevisions: Object.fromEntries(ROLE_IDS.map(role => [role, '0'])), budgets: {}, sessionCreateOperations: {}, pendingSessionCreateByRole: {}, userProfile: { displayName: '演示资料（待配置）', notes: '' }, sceneWorkbench: null, dockLayouts: { version: 2, scenes: {} } })
const samePath = (left, right) => resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
const writeQueues = new Map()
const ROLE_BINDING_REVISION = /^(?:0|[1-9][0-9]{0,63})$/

function roleBindingTuple(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || typeof binding.sessionId !== 'string' || binding.sessionId.length === 0) return null
  return JSON.stringify([
    binding.sessionId,
    binding.workspaceId ?? null,
    binding.workspacePath ?? null,
    binding.agentPreset ?? null,
  ])
}

function initialRoleBindingRevision(binding) {
  return roleBindingTuple(binding) === null ? '0' : '1'
}

function normalizedRoleBindingRevisions(state) {
  const stored = state.roleBindingRevisions
  if (stored !== undefined && (stored === null || typeof stored !== 'object' || Array.isArray(stored))) {
    throw new Error('TradeLoom state file has an invalid role binding revision map')
  }
  return Object.fromEntries(ROLE_IDS.map(role => {
    if (stored === undefined) return [role, initialRoleBindingRevision(state.roles?.[role])]
    if (!Object.hasOwn(stored, role) || typeof stored[role] !== 'string' || !ROLE_BINDING_REVISION.test(stored[role])) {
      throw new Error('TradeLoom state file has an invalid role binding revision')
    }
    const revision = stored[role]
    return [role, revision === '0' && roleBindingTuple(state.roles?.[role]) !== null ? '1' : revision]
  }))
}

function nextRoleBindingRevision(revision) {
  const next = (BigInt(revision) + 1n).toString()
  if (!ROLE_BINDING_REVISION.test(next)) throw new Error('TradeLoom role binding revision is exhausted')
  return next
}

function stripRoleBindingRevisionFields(state) {
  for (const role of ROLE_IDS) {
    const binding = state.roles?.[role]
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) delete binding.bindingRevision
  }
}

/** Read the stable persisted revision, or the deterministic legacy seed for an unmigrated state. */
export function getRoleBindingRevision(state, role) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  const revision = state?.roleBindingRevisions?.[role]
  if (typeof revision === 'string' && ROLE_BINDING_REVISION.test(revision)) {
    return revision === '0' && roleBindingTuple(state?.roles?.[role]) !== null ? '1' : revision
  }
  return initialRoleBindingRevision(state?.roles?.[role])
}

/** Replace one Host-owned role binding and return its transaction-local revision. */
export function replaceRoleBinding(state, role, binding) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('invalid TradeLoom role binding')
  const revisions = normalizedRoleBindingRevisions(state)
  const previousTuple = roleBindingTuple(state.roles?.[role])
  const replacement = {
    sessionId: binding.sessionId,
    workspaceId: binding.workspaceId ?? null,
    workspacePath: binding.workspacePath ?? null,
    agentPreset: binding.agentPreset ?? null,
  }
  const changed = previousTuple !== roleBindingTuple(replacement)
  const revision = changed ? nextRoleBindingRevision(revisions[role]) : revisions[role]
  state.roles[role] = replacement
  state.roleBindingRevisions = { ...revisions, [role]: revision }
  return revision
}

async function assertNoLinks(path, stopAt) {
  const target = resolve(path)
  const stop = resolve(stopAt)
  const rel = relative(stop, target)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('path is outside the configured TradeLoom DSH_HOME')
  let cursor = target
  while (true) {
    const info = await lstat(cursor).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error('reparse points are not allowed below the configured TradeLoom DSH_HOME')
    if (cursor === stop || cursor === parse(cursor).root) break
    cursor = dirname(cursor)
  }
}

export async function resolveOwnedHome(env = process.env) {
  const configured = env.TRADELOOM_DSH_APP_HOME
  const dshHome = env.DSH_HOME
  if (typeof configured !== 'string' || configured.length === 0 || !isAbsolute(configured)
    || typeof dshHome !== 'string' || dshHome.length === 0 || !isAbsolute(dshHome)) {
    throw new Error('TradeLoom state is disabled: explicit TRADELOOM_DSH_APP_HOME and DSH_HOME are required')
  }
  if (!samePath(configured, dshHome)) throw new Error('TradeLoom state is disabled: configured app home must equal DSH_HOME')
  const home = resolve(configured)
  await assertNoLinks(home, dirname(home))
  const canonical = await realpath(home).catch(() => undefined)
  if (canonical === undefined || !samePath(canonical, home)) throw new Error('TradeLoom state is disabled: DSH_HOME is missing or resolves through a reparse point')
  const markerPath = join(home, HOME_MARKER)
  await assertNoLinks(markerPath, home)
  const marker = await readFile(markerPath, 'utf8').catch(() => '')
  if (marker !== HOME_MARKER_VALUE) throw new Error('TradeLoom state is disabled: app-owned DSH_HOME marker is missing or invalid')
  await assertNoLinks(home, home)
  return home
}

export async function roleWorkspacePath(role, env = process.env) {
  if (!ROLE_IDS.includes(role)) throw new Error('unknown TradeLoom role')
  const home = await resolveOwnedHome(env)
  const parent = join(home, 'tradeloom-workspaces')
  const target = join(parent, role)
  await assertNoLinks(parent, home)
  await assertNoLinks(target, home)
  await mkdir(target, { recursive: true })
  await assertNoLinks(target, home)
  return target
}

export async function createStateStore(options = {}) {
  const env = options.env ?? process.env
  const home = await resolveOwnedHome(env)
  const directory = join(home, 'tradeloom-state')
  await assertNoLinks(directory, home)
  await mkdir(directory, { recursive: true })
  await assertNoLinks(directory, home)
  const statePath = join(directory, 'state.json')

  async function readSnapshot() {
    await assertNoLinks(statePath, home)
    const bytes = await readFile(statePath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (bytes === null) return { state: initialState(), bytes: null }
    const text = bytes.toString('utf8')
    const value = JSON.parse(text)
    if (value?.version !== 1 || typeof value.roles !== 'object' || typeof value.budgets !== 'object') {
      throw new Error('TradeLoom state file has an unsupported or corrupt format')
    }
    if (value.dockLayouts === undefined) value.dockLayouts = { version: 2, scenes: {} }
    stripRoleBindingRevisionFields(value)
    value.roleBindingRevisions = normalizedRoleBindingRevisions(value)
    return { state: value, bytes }
  }

  async function read() { return (await readSnapshot()).state }

  async function writeImmutableBackup(name, bytes) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) throw new TypeError('invalid immutable backup name')
    const backupDirectory = join(directory, 'scene-memory-backups')
    await assertNoLinks(backupDirectory, home)
    await mkdir(backupDirectory, { recursive: true })
    await assertNoLinks(backupDirectory, home)
    const backupPath = join(backupDirectory, name)
    await assertNoLinks(backupPath, home)
    try {
      const handle = await open(backupPath, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readFile(backupPath)
      if (!existing.equals(bytes)) throw new Error('immutable scene-memory backup name collision')
    }
    const readback = await readFile(backupPath)
    if (!readback.equals(bytes)) throw new Error('immutable scene-memory backup readback failed')
    return backupPath
  }

  async function verifyImmutableBackup(name, expectedDigest) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)
      || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)
      || name !== `legacy-${expectedDigest}.json`) throw new TypeError('invalid immutable backup identity')
    const backupDirectory = join(directory, 'scene-memory-backups')
    const backupPath = join(backupDirectory, name)
    await assertNoLinks(backupDirectory, home)
    await assertNoLinks(backupPath, home)
    const bytes = await readFile(backupPath)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
      throw Object.assign(new Error('immutable scene-memory backup digest mismatch'), { code: 'legacy_backup_mismatch' })
    }
    return Buffer.from(bytes)
  }

  const queueKey = resolve(statePath).toLocaleLowerCase('en-US')

  return Object.freeze({
    async read() { return await read() },
    async transact(mutator, options = {}) {
      const previous = writeQueues.get(queueKey) ?? Promise.resolve()
      let release
      const gate = new Promise(resolveGate => { release = resolveGate })
      const tail = previous.then(() => gate)
      writeQueues.set(queueKey, tail)
      await previous
      let temporary
      let committed = false
      try {
        const snapshot = await readSnapshot()
        const state = snapshot.state
        if (options.onSnapshot) await options.onSnapshot(Object.freeze({ state, previousBytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes), statePath }))
        const previousTuples = Object.fromEntries(ROLE_IDS.map(role => [role, roleBindingTuple(state.roles?.[role])]))
        const previousRevisions = { ...state.roleBindingRevisions }
        const result = await mutator(state)
        stripRoleBindingRevisionFields(state)
        state.roleBindingRevisions = Object.fromEntries(ROLE_IDS.map(role => [
          role,
          previousTuples[role] === roleBindingTuple(state.roles?.[role])
            ? previousRevisions[role]
            : nextRoleBindingRevision(previousRevisions[role]),
        ]))
        if (options.readOnly === true) return result
        const serialized = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
        temporary = join(directory, `.state-${randomUUID()}.tmp`)
        await assertNoLinks(temporary, home)
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(serialized)
          await handle.sync()
        } finally { await handle.close() }
        if (options.beforeRename) await options.beforeRename(Object.freeze({
          previousBytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes),
          nextBytes: Buffer.from(serialized),
          statePath,
        }))
        const beforeCommitAttempt = async () => {
          if (options.beforeCommitAttempt) await options.beforeCommitAttempt(Object.freeze({
            previousBytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes),
            nextBytes: Buffer.from(serialized),
            statePath,
          }))
          if (options.compareBeforeRename) {
            const currentBytes = await readFile(statePath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
            if (snapshot.bytes === null ? currentBytes !== null : currentBytes === null || !currentBytes.equals(snapshot.bytes)) {
              throw Object.assign(new Error('TradeLoom state changed before transaction commit'), { code: 'state_cas_conflict' })
            }
          }
          if (options.validateCommit) options.validateCommit(Object.freeze({ statePath }))
        }
        if (process.platform === 'win32') {
          const retryDelays = [20, 50, 100]
          let initialRenameError
          for (let attempt = 0; ; attempt += 1) {
            try {
              await beforeCommitAttempt()
              if (options.validateCommit) options.validateCommit(Object.freeze({ statePath }))
              await rename(temporary, statePath)
              break
            } catch (error) {
              if (!['EPERM', 'EBUSY'].includes(error?.code)) throw error
              initialRenameError ??= error
              if (attempt >= retryDelays.length) throw initialRenameError
              await delay(retryDelays[attempt])
            }
          }
        } else {
          await beforeCommitAttempt()
          if (options.validateCommit) options.validateCommit(Object.freeze({ statePath }))
          await rename(temporary, statePath)
        }
        committed = true
        temporary = undefined
        if (options.readback) {
          try {
            if (options.afterRename) await options.afterRename(Object.freeze({
              previousBytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes),
              nextBytes: Buffer.from(serialized),
              statePath,
            }))
            const readback = await readFile(statePath)
            if (!readback.equals(serialized)) throw new Error('state bytes differ after rename')
          } catch (cause) {
            throw Object.assign(new Error('TradeLoom state commit outcome is unknown after rename', { cause }), { code: 'state_commit_unknown', committed: true })
          }
        }
        return result
      } finally {
        if (!committed && temporary) await unlink(temporary).catch(() => {})
        release()
        if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey)
      }
    },
    writeImmutableBackup,
    verifyImmutableBackup,
    paths: Object.freeze({ home, statePath }),
  })
}
