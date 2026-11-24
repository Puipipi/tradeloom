import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createStateStore, getRoleBindingRevision } from './state.js'
import { ROLE_PRESETS } from './roles.js'
import { readAuthorizedCenterBinding } from './workflow-native-binding.js'

const MAX_ENTRIES = 500
const MAX_PREVIEW = 1024 * 1024
const MAX_DOWNLOAD = 20 * 1024 * 1024
const uuid = /^[0-9a-f-]{36}$/
const reject = () => new Error('工作流目录不可用或已变更。')
const samePath = (a, b) => path.relative(a, b) === ''
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
const inspect = name => lstat(name, { bigint: true })

async function ordinary(target) {
  const root = path.parse(target).root
  let current = root
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if ((await inspect(current)).isSymbolicLink()) throw reject()
  }
  if (!samePath(await realpath(target), target)) throw reject()
  return inspect(target)
}

function preview(bytes, name) {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { type: 'image/png', data: bytes.toString('base64') }
  }
  if (['.jpg', '.jpeg'].includes(ext) && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    return { type: 'image/jpeg', data: bytes.toString('base64') }
  }
  if (ext === '.pdf' && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return { type: 'application/pdf', data: bytes.toString('base64') }
  }
  if (!['.txt', '.md', '.json', '.csv', '.log'].includes(ext) || bytes.includes(0)) return null
  try { return { type: 'text/plain', data: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
  catch { return null }
}

function createWorkflowFiles() {
  const scopes = new WeakMap()
  const fresh = async (owner, record, assertOwner) => {
    await assertOwner()
    if (scopes.get(owner) !== record) throw reject()
  }

  async function verify(grant, target, expected) {
    const relative = path.relative(grant.root, target)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw reject()
    const root = await ordinary(grant.root)
    if (!root.isDirectory() || !identity(root, grant.rootIdentity)) throw reject()
    const result = relative === '' ? root : await ordinary(target)
    if (expected && !identity(result, expected)) throw reject()
    return result
  }

  async function directory(grant, target, expected) {
    const before = await verify(grant, target, expected)
    if (!before.isDirectory()) throw reject()
    const names = []
    const entries = new Map()
    let truncated = false
    const dir = await opendir(target)
    try {
      for (let scanned = 0; ; scanned++) {
        const item = await dir.read()
        if (!item) break
        if (scanned >= MAX_ENTRIES) { truncated = true; break }
        if (!item.isDirectory() && !item.isFile()) continue
        const child = path.join(target, item.name)
        const info = await inspect(child).catch(() => undefined)
        if (!info || (!info.isDirectory() && !info.isFile())) continue
        const id = randomUUID(), kind = info.isDirectory() ? 'folder' : 'file'
        entries.set(id, { name: item.name, kind, target: child, identity: info })
        names.push({ id, name: item.name, kind, size: Number(info.size), modifiedAt: Number(info.mtimeMs) })
      }
    } finally {
      await dir.close()
    }
    await verify(grant, target, before)
    names.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)
    return { target, identity: before, entries, view: { path: target, canGoUp: !samePath(target, grant.root), entries: names, truncated } }
  }

  async function file(grant, item, download) {
    const before = await verify(grant, item.target, item.identity)
    if (!before.isFile()) throw reject()
    const limit = download ? MAX_DOWNLOAD : MAX_PREVIEW
    if (before.size > BigInt(limit)) {
      if (download) throw new Error('文件超过下载大小限制。')
      return { name: item.name, preview: null }
    }
    const handle = await open(item.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !identity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) throw reject()
      await verify(grant, item.target, opened)
      const buffer = Buffer.alloc(Number(opened.size) + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (chunk.bytesRead === 0) break
        bytesRead += chunk.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      if (bytesRead !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw reject()
      await verify(grant, item.target, opened)
      const bytes = buffer.subarray(0, bytesRead)
      return download ? { name: item.name, data: bytes.toString('base64') } : { name: item.name, preview: preview(bytes, item.name) }
    } finally {
      await handle.close()
    }
  }

  return async (owner, request, assertOwner, chosen) => {
    await assertOwner()
    const operation = request?.operation
    const hasEntry = ['enter', 'preview', 'download', 'open', 'reveal'].includes(operation)
    const opensRoot = operation === 'open-root'
    if (!['pick', 'current', 'revoke', 'up', 'enter', 'preview', 'download', 'open', 'reveal', 'open-directory', 'open-root'].includes(operation)
      || Object.keys(request).sort().join(',') !== (hasEntry ? 'id,operation' : opensRoot ? 'expectedPath,operation' : 'operation')
      || hasEntry && (typeof request.id !== 'string' || !uuid.test(request.id))) throw reject()
    if (operation === 'revoke') {
      scopes.delete(owner)
      return null
    }
    if (operation === 'current') {
      // A directory listing reads the committed snapshot. It must not block an
      // unrelated preview or acquire the lock used by grant and navigation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { grant, stack } = scopes.get(owner) ?? {}
        const current = stack?.at(-1)
        if (!grant || !current) return null
        await verify(grant, current.target, current.identity)
        await assertOwner()
        const latest = scopes.get(owner)
        if (latest?.grant === grant && latest.stack === stack) return current.view
      }
      throw reject()
    }
    const previous = scopes.get(owner)
    if (previous?.busy) throw reject()
    const record = { busy: true, grant: previous?.grant, stack: previous?.stack }
    scopes.set(owner, record)
    try {
      if (operation === 'pick') {
        if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) throw reject()
        const root = await realpath(chosen)
        const grant = { root, rootIdentity: await ordinary(root) }
        const opened = await directory(grant, root, grant.rootIdentity)
        await fresh(owner, record, assertOwner)
        record.grant = grant
        record.stack = [opened]
        return opened.view
      }
      const grant = record.grant, current = record.stack?.at(-1)
      if (!grant || !current) throw reject()
      if (operation === 'open-root') {
        if (request.expectedPath !== grant.root) throw reject()
        const opened = await directory(grant, grant.root, grant.rootIdentity)
        await fresh(owner, record, assertOwner)
        record.stack = [opened]
        return opened.view
      }
      if (operation === 'open-directory') {
        const info = await verify(grant, current.target, current.identity)
        if (!info.isDirectory()) throw reject()
        const resolved = { path: current.target, identity: {
          dev: String(info.dev), ino: String(info.ino), size: String(info.size),
          mtimeNs: String(info.mtimeNs), birthtimeNs: String(info.birthtimeNs),
        } }
        await fresh(owner, record, assertOwner)
        return resolved
      }
      if (operation === 'up') {
        const parent = record.stack.at(-2)
        if (!parent) throw reject()
        const opened = await directory(grant, parent.target, parent.identity)
        await fresh(owner, record, assertOwner)
        record.stack = [...record.stack.slice(0, -2), opened]
        return opened.view
      }
      await verify(grant, current.target, current.identity)
      const entry = current.entries.get(request.id)
      if (entry?.kind !== (operation === 'enter' ? 'folder' : 'file')) throw reject()
      if (operation === 'enter') {
        const opened = await directory(grant, entry.target, entry.identity)
        await fresh(owner, record, assertOwner)
        record.stack = [...record.stack, opened]
        return opened.view
      }
      if (operation === 'open' || operation === 'reveal') {
        const info = await verify(grant, entry.target, entry.identity)
        if (!info.isFile()) throw reject()
        if (operation === 'open' && !(await file(grant, entry, false)).preview) throw reject()
        const resolved = { path: entry.target, identity: {
          dev: String(info.dev), ino: String(info.ino), size: String(info.size),
          mtimeNs: String(info.mtimeNs), birthtimeNs: String(info.birthtimeNs),
        } }
        await fresh(owner, record, assertOwner)
        return resolved
      }
      const result = await file(grant, entry, operation === 'download')
      await fresh(owner, record, assertOwner)
      return result
    } finally {
      record.busy = false
    }
  }
}

// The authenticated desktop child-process channel is the only issuer. Renderer
// and tool requests share the current Host snapshot, including its entry IDs.
export function createWorkflowFileAuthority(ctx, readState = async () => (await createStateStore()).read()) {
  const files = createWorkflowFiles()
  const directoryListeners = new Set()
  // UI folders are independent of AI role sessions. The only caller is the
  // authenticated desktop control channel; each scope token is minted by the
  // trusted launcher for one window/scene pair and is never renderer input.
  const uiScopes = new Map()
  let scope

  async function assertBinding(expected) {
    const state = await readState()
    const binding = state?.roles?.center
    const registry = ctx.workspaceRegistry
    const workspace = binding && registry.get(binding.workspaceId)
    if (!binding || binding.sessionId !== expected.sessionId || binding.agentPreset !== ROLE_PRESETS.center
      || getRoleBindingRevision(state, 'center') !== expected.bindingRevision
      || !Array.isArray(registry.archivedSessionIds) || registry.archivedSessionIds.includes(expected.sessionId)
      || workspace?.id !== binding.workspaceId || workspace.path !== binding.workspacePath
      || !Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(expected.sessionId)) throw reject()
  }

  async function transact(expected, request, check, chosen) {
    await check()
    if (!scope || scope.sessionId !== expected.sessionId || scope.bindingRevision !== expected.bindingRevision) {
      scope = expected
    }
    const current = scope
    const result = await files(current, request, async () => {
      await check()
      if (current !== scope) throw reject()
    }, chosen)
    if (['pick', 'revoke', 'enter', 'up', 'open-root'].includes(request.operation)) {
      for (const listener of directoryListeners) listener()
    }
    return result
  }

  return Object.freeze({
    async sceneUi(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'chosen,request,scope'
        || typeof input.scope !== 'string' || !uuid.test(input.scope)
        || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) throw reject()
      const { scope: token, request, chosen } = input
      const operation = request.operation
      const hasEntry = ['enter', 'preview', 'download', 'open', 'reveal'].includes(operation)
      if (!['pick', 'current', 'revoke', 'up', 'enter', 'preview', 'download', 'open', 'reveal', 'open-directory'].includes(operation)
        || Object.keys(request).sort().join(',') !== (hasEntry ? 'id,operation' : 'operation')
        || hasEntry && (typeof request.id !== 'string' || !uuid.test(request.id))
        || operation === 'pick' && (typeof chosen !== 'string' || !path.isAbsolute(chosen))
        || operation !== 'pick' && chosen !== null) throw reject()
      let owner = uiScopes.get(token)
      if (operation === 'revoke' && !owner) return null
      if (!owner) { owner = Object.freeze({}); uiScopes.set(token, owner) }
      const result = await files(owner, request, async () => {
        if (uiScopes.get(token) !== owner) throw reject()
      }, chosen ?? undefined)
      if (operation === 'revoke') uiScopes.delete(token)
      return result
    },
    onDirectoryChange(listener) {
      directoryListeners.add(listener)
      return () => directoryListeners.delete(listener)
    },
    async desktop(input) {
      const picking = input?.operation === 'pick'
      const opensRoot = input?.operation === 'open-root'
      const hasEntry = ['enter', 'preview', 'download', 'open', 'reveal'].includes(input?.operation)
      const fields = picking ? 'bindingRevision,chosen,operation,sessionId'
        : opensRoot ? 'bindingRevision,expectedPath,operation,sessionId'
        : hasEntry ? 'bindingRevision,id,operation,sessionId' : 'bindingRevision,operation,sessionId'
      if (!input || Object.keys(input).sort().join(',') !== fields
        || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.sessionId)
        || typeof input.bindingRevision !== 'string' || !/^(?:0|[1-9][0-9]{0,63})$/.test(input.bindingRevision)
        || picking && (typeof input.chosen !== 'string' || input.chosen.length > 32767)
        || opensRoot && (typeof input.expectedPath !== 'string' || input.expectedPath.length > 32767 || !path.isAbsolute(input.expectedPath))) throw reject()
      const { sessionId, bindingRevision, chosen, ...request } = input
      const expected = { sessionId, bindingRevision }
      return transact(expected, request, () => assertBinding(expected), chosen)
    },
    async tool(request, execution) {
      if (!['current', 'enter', 'up'].includes(request?.operation)) throw reject()
      execution?.signal?.throwIfAborted()
      const expected = await readAuthorizedCenterBinding(ctx, readState, execution)
      const check = async () => {
        execution?.signal?.throwIfAborted()
        await assertBinding(expected)
        if (ctx.agents.get(expected.parent.id) !== expected.parent || expected.parent.session?.id !== expected.sessionId) throw reject()
        execution?.signal?.throwIfAborted()
      }
      const result = await transact(expected, request, check)
      if (!result) return null
      const { path: _hostPath, ...directory } = result
      return directory
    },
  })
}
