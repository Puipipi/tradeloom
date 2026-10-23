import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ROLE_IDS } from './roles.js'

export const HOME_MARKER = '.tradeloom-owned'
export const HOME_MARKER_VALUE = 'tradeloom-dsh-apphome-v1\n'
export { ROLE_IDS } from './roles.js'

const initialState = () => ({ version: 1, roles: {}, budgets: {}, sessionCreateOperations: {}, pendingSessionCreateByRole: {}, userProfile: { displayName: '演示资料（待配置）', notes: '' }, sceneWorkbench: null, dockLayouts: { version: 2, scenes: {} } })
const samePath = (left, right) => resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
const writeQueues = new Map()

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

  async function read() {
    await assertNoLinks(statePath, home)
    const text = await readFile(statePath, 'utf8').catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (text === null) return initialState()
    const value = JSON.parse(text)
    if (value?.version !== 1 || typeof value.roles !== 'object' || typeof value.budgets !== 'object') {
      throw new Error('TradeLoom state file has an unsupported or corrupt format')
    }
    if (value.dockLayouts === undefined) value.dockLayouts = { version: 2, scenes: {} }
    return value
  }

  const queueKey = resolve(statePath).toLocaleLowerCase('en-US')

  return Object.freeze({
    async read() { return await read() },
    async transact(mutator) {
      const previous = writeQueues.get(queueKey) ?? Promise.resolve()
      let release
      const gate = new Promise(resolveGate => { release = resolveGate })
      const tail = previous.then(() => gate)
      writeQueues.set(queueKey, tail)
      await previous
      try {
        const state = await read()
        const result = await mutator(state)
        const temporary = join(directory, `.state-${randomUUID()}.tmp`)
        await assertNoLinks(temporary, home)
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
          await handle.sync()
        } finally { await handle.close() }
        if (process.platform === 'win32') {
          const retryDelays = [20, 50, 100]
          let initialRenameError
          for (let attempt = 0; ; attempt += 1) {
            try {
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
          await rename(temporary, statePath)
        }
        return result
      } finally {
        release()
        if (writeQueues.get(queueKey) === tail) writeQueues.delete(queueKey)
      }
    },
    paths: Object.freeze({ home, statePath }),
  })
}
