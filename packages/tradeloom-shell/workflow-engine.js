import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ROLE_LABELS } from './roles.js'
import { validateWorkflow, WorkflowValidationError } from './workflow-schema.js'
import { createConfirmedWorkflowDefinition } from './workflow-definition.js'

const MAX_RUNS = 30
const WORKFLOW_STORE_FORMAT = 1
const workflowWriteQueues = new Map()

function workflowStoreError(code) {
  return Object.assign(new Error(code), { code })
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function canonicalTime(value) {
  try { return typeof value === 'string' && new Date(value).toISOString() === value } catch { return false }
}

function workflowDefinitionRevision(document) {
  return document.confirmed === true ? createConfirmedWorkflowDefinition(document).definitionRevision : null
}

async function withWorkflowFileLock(path, operation) {
  const key = resolve(path).toLocaleLowerCase('en-US')
  const previous = workflowWriteQueues.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  const tail = previous.then(() => gate)
  workflowWriteQueues.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (workflowWriteQueues.get(key) === tail) workflowWriteQueues.delete(key)
  }
}

// wf 定义存为 <dir>/<id>.json；id 已被 schema 限定为安全文件名。
export function createWorkflowStore(dir, options = {}) {
  const testHooks = options?._testHooks ?? Object.create(null)
  const file = id => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) throw new WorkflowValidationError(['invalid workflow id'])
    return join(dir, `${id}.json`)
  }
  async function readStored(id) {
    const target = file(id)
    let text
    try { text = await readFile(target, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return { document: null, revision: 0, updatedAt: null, definitionRevision: null }
      throw workflowStoreError('workflow_store_read_failed')
    }
    let raw
    try { raw = JSON.parse(text) } catch {
      throw workflowStoreError('workflow_store_invalid_record')
    }
    if (raw?.formatVersion !== undefined || Object.hasOwn(raw ?? {}, 'revision') || Object.hasOwn(raw ?? {}, 'deleted')) {
      if (raw?.formatVersion !== WORKFLOW_STORE_FORMAT) throw workflowStoreError('workflow_store_invalid_record')
      const keys = ['formatVersion', 'revision', 'deleted', 'document', 'updatedAt', 'definitionRevision']
      if (!exactObject(raw, keys) || !Number.isSafeInteger(raw.revision) || raw.revision < 1
        || typeof raw.deleted !== 'boolean' || !canonicalTime(raw.updatedAt)) throw workflowStoreError('workflow_store_invalid_record')
      if (raw.deleted) {
        if (raw.document !== null || raw.definitionRevision !== null) throw workflowStoreError('workflow_store_invalid_record')
        return { document: null, revision: raw.revision, updatedAt: raw.updatedAt, definitionRevision: null }
      }
      let document
      try { document = validateWorkflow(raw.document) } catch { throw workflowStoreError('workflow_store_invalid_record') }
      const definitionRevision = workflowDefinitionRevision(document)
      if (raw.definitionRevision !== definitionRevision || document.id !== id) throw workflowStoreError('workflow_store_invalid_record')
      return { document, revision: raw.revision, updatedAt: raw.updatedAt, definitionRevision }
    }

    const { updatedAt = null, ...workflowInput } = raw ?? {}
    let document
    try { document = validateWorkflow(workflowInput) } catch { throw workflowStoreError('workflow_store_invalid_record') }
    if (document.id !== id || (updatedAt !== null && !canonicalTime(updatedAt))) throw workflowStoreError('workflow_store_invalid_record')
    return { document, revision: 0, updatedAt, definitionRevision: workflowDefinitionRevision(document) }
  }

  async function writeRecord(id, record) {
    const target = file(id)
    const temporary = `${target}.${randomUUID()}.tmp`
    let handle
    let writeFailed = false
    try {
      await mkdir(dirname(target), { recursive: true })
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await handle.sync()
    } catch {
      writeFailed = true
    } finally {
      try { await handle?.close() } catch { writeFailed = true }
    }
    if (writeFailed) {
      await unlink(temporary).catch(() => {})
      throw workflowStoreError('workflow_store_write_failed')
    }
    try {
      const renameFile = typeof testHooks.rename === 'function' ? testHooks.rename : rename
      await renameFile(temporary, target)
    } catch {
      await rm(temporary, { force: true }).catch(() => {})
      throw workflowStoreError('workflow_store_write_failed')
    }
  }

  function makeRecord({ document, revision, updatedAt, deleted = false }) {
    return {
      formatVersion: WORKFLOW_STORE_FORMAT,
      revision,
      deleted,
      document: deleted ? null : document,
      updatedAt,
      definitionRevision: deleted ? null : workflowDefinitionRevision(document),
    }
  }

  function legacyDocument(record) {
    if (record.document === null) return null
    return record.updatedAt === null ? { ...record.document } : { ...record.document, updatedAt: record.updatedAt }
  }

  return {
    async list() {
      await mkdir(dir, { recursive: true })
      const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
      const items = []
      for (const name of names) {
        const id = name.slice(0, -5)
        try {
          const record = await readStored(id)
          if (record.document) {
            const doc = record.document
            items.push({ id: doc.id, title: doc.title, source: doc.source, confirmed: doc.confirmed, nodes: doc.nodes.length, updatedAt: record.updatedAt })
          }
        } catch { /* 损坏文件跳过，不影响其他 wf */ }
      }
      return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    },
    async get(id) {
      return legacyDocument(await readStored(id))
    },
    async save(input) {
      const document = structuredClone(validateWorkflow(input))
      const target = file(document.id)
      return await withWorkflowFileLock(target, async () => {
        const current = await readStored(document.id)
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw workflowStoreError('workflow_revision_exhausted')
        const updatedAt = new Date().toISOString()
        const record = makeRecord({ document, revision: current.revision + 1, updatedAt })
        await writeRecord(document.id, record)
        return legacyDocument({ ...record, document })
      })
    },
    async getVersioned(id) {
      return await readStored(id)
    },
    async saveVersioned(input, expectedRevision) {
      const document = structuredClone(validateWorkflow(input))
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw workflowStoreError('invalid_revision')
      const target = file(document.id)
      return await withWorkflowFileLock(target, async () => {
        const current = await readStored(document.id)
        if (current.revision !== expectedRevision) throw workflowStoreError('workflow_revision_conflict')
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw workflowStoreError('workflow_revision_exhausted')
        const updatedAt = new Date().toISOString()
        const record = makeRecord({ document, revision: current.revision + 1, updatedAt })
        await writeRecord(document.id, record)
        return { document, revision: record.revision, updatedAt, definitionRevision: record.definitionRevision }
      })
    },
    async remove(id) {
      const target = file(id)
      return await withWorkflowFileLock(target, async () => {
        const current = await readStored(id)
        if (current.document === null) return
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw workflowStoreError('workflow_revision_exhausted')
        const updatedAt = new Date().toISOString()
        await writeRecord(id, makeRecord({ document: null, revision: current.revision + 1, updatedAt, deleted: true }))
      })
    },
  }
}

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

// 模拟执行器：其他 agent 尚未接入，先让节点状态完整走一遍。接入后替换 executors.agent 即可，界面不用改。
export function createMockExecutors(delayMs = 900) {
  return {
    async input(node, context) { await sleep(delayMs / 3, context.signal); return node.instruction || '（输入）' },
    async agent(node, context) {
      await sleep(delayMs, context.signal)
      const model = node.model ? `${node.model.provider}/${node.model.model}` : '默认模型'
      return `[模拟] ${ROLE_LABELS[node.agent]}（${model}）完成「${node.title}」，收到 ${context.inputs.length} 份上游结果`
    },
    async external(node, context) {
      await sleep(delayMs, context.signal)
      return `[模拟] 已交给外部平台 ${node.platform}：${node.title}`
    },
    async output(node, context) { await sleep(delayMs / 3, context.signal); return context.inputs.map(item => item.output).join('\n') },
  }
}

export function createWorkflowRunner(options = {}) {
  const executors = { ...createMockExecutors(options.delayMs), ...options.executors }
  const runs = new Map()

  function publicRun(run) {
    return {
      executionMode: options.executors ? 'custom' : 'local_mock',
      id: run.id, workflowId: run.workflowId, title: run.title, status: run.status,
      startedAt: run.startedAt, finishedAt: run.finishedAt, nodes: structuredClone(run.nodes),
    }
  }

  function remember(run) {
    runs.set(run.id, run)
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value)
  }

  async function execute(run, doc) {
    const upstream = new Map(doc.nodes.map(node => [node.id, []]))
    for (const edge of doc.edges) upstream.get(edge.to).push(edge.from)
    const settled = id => ['done', 'failed', 'skipped'].includes(run.nodes[id].status)

    // 依赖全部完成的节点同时开跑，同一层的节点会一起高亮。
    async function step(node) {
      const state = run.nodes[node.id]
      const parents = upstream.get(node.id)
      if (parents.some(id => run.nodes[id].status !== 'done')) { state.status = 'skipped'; return }
      state.status = node.kind === 'review' ? 'waiting' : 'running'
      state.startedAt = new Date().toISOString()
      try {
        if (node.kind === 'review') {
          if (run.status === 'running') run.status = 'waiting'
          const decision = await new Promise(resolve => { run.pending.set(node.id, resolve) })
          run.pending.delete(node.id)
          if (![...run.pending.keys()].length && run.status === 'waiting') run.status = 'running'
          if (decision.approved !== true) throw new Error(decision.note || '人工确认未通过')
          // 审核通过后把上游内容原样传下去，下游节点才拿得到被审核的结果
          const passed = parents.map(id => run.nodes[id].output).filter(Boolean)
          state.output = [...passed, `【人工确认】${decision.note || '已通过'}`].join('\n')
        } else {
          const inputs = parents.map(id => ({ id, output: run.nodes[id].output }))
          state.output = String(await executors[node.kind](node, { inputs, signal: run.abort.signal, run: publicRun(run) }))
        }
        state.status = run.abort.signal.aborted ? 'failed' : 'done'
        if (run.abort.signal.aborted) state.error = '已取消'
      } catch (error) {
        state.status = 'failed'
        state.error = error instanceof Error ? error.message : String(error)
      }
      state.finishedAt = new Date().toISOString()
    }

    const active = new Map()
    while (true) {
      for (const node of doc.nodes) {
        if (active.has(node.id) || settled(node.id) || run.nodes[node.id].status !== 'pending') continue
        if (upstream.get(node.id).every(settled)) active.set(node.id, step(node).finally(() => active.delete(node.id)))
      }
      if (active.size === 0) break
      await Promise.race(active.values())
    }
    const statuses = Object.values(run.nodes).map(node => node.status)
    run.status = run.abort.signal.aborted ? 'cancelled' : statuses.includes('failed') ? 'failed' : 'done'
    run.finishedAt = new Date().toISOString()
  }

  return {
    // 返回立即可见的运行快照；执行在后台推进，前端轮询 get(runId) 刷新高亮。
    start(input) {
      const doc = validateWorkflow(input)
      const run = {
        id: randomUUID(), workflowId: doc.id, title: doc.title, status: 'running',
        startedAt: new Date().toISOString(), finishedAt: null,
        nodes: Object.fromEntries(doc.nodes.map(node => [node.id, { status: 'pending', output: '', error: '' }])),
        pending: new Map(), abort: new AbortController(),
      }
      remember(run)
      run.done = execute(run, doc).catch(error => {
        run.status = 'failed'
        run.error = String(error?.message ?? error)
        run.finishedAt = new Date().toISOString()
      })
      return publicRun(run)
    },
    get(runId) {
      const run = runs.get(runId)
      return run ? publicRun(run) : null
    },
    latestFor(workflowId) {
      const run = [...runs.values()].reverse().find(item => item.workflowId === workflowId)
      return run ? publicRun(run) : null
    },
    // 人工确认节点的通过/驳回。
    decide(runId, nodeId, decision) {
      const resolve = runs.get(runId)?.pending.get(nodeId)
      if (!resolve) return false
      resolve({ approved: decision?.approved === true, note: typeof decision?.note === 'string' ? decision.note.slice(0, 500) : '' })
      return true
    },
    cancel(runId) {
      const run = runs.get(runId)
      if (!run || run.finishedAt) return false
      run.abort.abort()
      for (const resolve of run.pending.values()) resolve({ approved: false, note: '已取消' })
      return true
    },
    async settle(runId) { await runs.get(runId)?.done },
  }
}
