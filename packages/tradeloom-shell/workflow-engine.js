import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROLE_LABELS } from './roles.js'
import { validateWorkflow } from './workflow-schema.js'

const MAX_RUNS = 30

// wf 定义存为 <dir>/<id>.json；id 已被 schema 限定为安全文件名。
export function createWorkflowStore(dir) {
  const file = id => join(dir, `${id}.json`)
  return {
    async list() {
      await mkdir(dir, { recursive: true })
      const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
      const items = []
      for (const name of names) {
        try {
          const doc = JSON.parse(await readFile(join(dir, name), 'utf8'))
          items.push({ id: doc.id, title: doc.title, source: doc.source, confirmed: doc.confirmed, nodes: doc.nodes.length, updatedAt: doc.updatedAt })
        } catch { /* 损坏文件跳过，不影响其他 wf */ }
      }
      return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    },
    async get(id) {
      try { return JSON.parse(await readFile(file(id), 'utf8')) } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    },
    async save(input) {
      const doc = { ...validateWorkflow(input), updatedAt: new Date().toISOString() }
      await mkdir(dir, { recursive: true })
      const temporary = `${file(doc.id)}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
      await rename(temporary, file(doc.id))
      return doc
    },
    async remove(id) { await rm(file(id), { force: true }) },
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
