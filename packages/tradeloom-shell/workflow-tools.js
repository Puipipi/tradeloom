import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveOwnedHome, roleWorkspacePath } from './state.js'
import { createWorkflowRunner, createWorkflowStore } from './workflow-engine.js'
import { ROLE_PRESETS } from './roles.js'
import { WorkflowValidationError, workflowCatalog } from './workflow-schema.js'

export const name = '@tradeloom/dsh-business-shell/workflow-tools'
export const inject = ['tools']
export const WORKFLOW_ROUTE = '/tradeloom/workflows'
const MAX_BODY = 256 * 1024

// host 路由和中心 agent 的工具在同一进程里共享一份存储与运行器，画布能看到 AI 发起的运行。
let sharedService

export function createWorkflowService(options = {}) {
  let store = options.store
  const getStore = async () => store ??= createWorkflowStore(options.dir ?? join(await (options.resolveHome ?? resolveOwnedHome)(), 'tradeloom-workflows'))
  const runner = options.runner ?? createWorkflowRunner(options.runnerOptions)
  return {
    runner,
    catalog: () => ({ ...workflowCatalog(), executionMode: 'local_mock', runHistory: { storage: 'memory', limit: 30 } }),
    list: async () => (await getStore()).list(),
    get: async id => (await getStore()).get(id),
    // updatedAt 由服务端生成；画布回传的旧值直接丢弃
    save: async doc => (await getStore()).save(stripMeta(doc ?? {})),
    remove: async id => (await getStore()).remove(id),
    // 只运行已保存的 wf；AI 提案必须先在画布上由人确认。
    async run(id) {
      const doc = await (await getStore()).get(id)
      if (!doc) return { error: 'workflow_not_found' }
      if (!doc.confirmed) return { error: 'workflow_not_confirmed' }
      return { run: runner.start(stripMeta(doc)) }
    },
  }
}

export function workflowService() {
  return sharedService ??= createWorkflowService()
}

export function setWorkflowServiceForTests(service) { sharedService = service }

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.byteLength
    if (size > MAX_BODY) { req.resume(); return null }
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/

// GET  ?            → { catalog, workflows }
// GET  ?id=        → { workflow, run }（run 为该 wf 最近一次运行）
// GET  ?run=       → { run }
// POST { action: save|confirm|delete|run|decide|cancel, ... }
export function createWorkflowHandler(ctx, service = workflowService()) {
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost')
        const id = url.searchParams.get('id')
        const runId = url.searchParams.get('run')
        if (runId) {
          const run = service.runner.get(runId)
          return run ? json(res, 200, { run }) : json(res, 404, { error: 'run_not_found' })
        }
        if (id) {
          if (!ID.test(id)) return json(res, 400, { error: 'invalid_id' })
          const workflow = await service.get(id)
          return workflow ? json(res, 200, { workflow, run: service.runner.latestFor(id) }) : json(res, 404, { error: 'workflow_not_found' })
        }
        return json(res, 200, { catalog: service.catalog(), workflows: await service.list() })
      }
      if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'GET, POST'); res.end(); return }
      const text = await readBody(req)
      if (text === null) return json(res, 413, { error: 'request_too_large' })
      let input
      try { input = JSON.parse(text) } catch { return json(res, 400, { error: 'invalid_json' }) }
      switch (input?.action) {
        case 'save': return json(res, 200, { workflow: await service.save(input.workflow) })
        case 'confirm': {
          if (!ID.test(input.id ?? '')) return json(res, 400, { error: 'invalid_id' })
          const doc = await service.get(input.id)
          if (!doc) return json(res, 404, { error: 'workflow_not_found' })
          return json(res, 200, { workflow: await service.save({ ...stripMeta(doc), confirmed: true }) })
        }
        case 'delete':
          if (!ID.test(input.id ?? '')) return json(res, 400, { error: 'invalid_id' })
          await service.remove(input.id)
          return json(res, 200, { ok: true })
        case 'run': {
          if (!ID.test(input.id ?? '')) return json(res, 400, { error: 'invalid_id' })
          const result = await service.run(input.id)
          return result.error ? json(res, result.error === 'workflow_not_found' ? 404 : 409, result) : json(res, 200, result)
        }
        case 'decide':
          return service.runner.decide(input.run, input.node, { approved: input.approved === true, note: input.note })
            ? json(res, 200, { run: service.runner.get(input.run) }) : json(res, 409, { error: 'not_waiting' })
        case 'cancel':
          return service.runner.cancel(input.run) ? json(res, 200, { run: service.runner.get(input.run) }) : json(res, 409, { error: 'not_running' })
        default: return json(res, 400, { error: 'unknown_action' })
      }
    } catch (error) {
      if (error instanceof WorkflowValidationError) return json(res, 400, { error: error.code, issues: error.issues })
      return json(res, 500, { error: 'workflow_unavailable' })
    }
  }
}

function stripMeta(doc) {
  const { updatedAt, ...rest } = doc
  return rest
}

const OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false,
    required: ['ok', 'data', 'error_code'],
    properties: { ok: { type: 'boolean' }, data: { type: 'string' }, error_code: { type: 'string' } },
  },
  // DSH 要求工具声明 render，否则 agent 组装失败
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const ok = data => ({ ok: true, data: JSON.stringify(data), error_code: '' })
const fail = (code, data = {}) => ({ ok: false, data: JSON.stringify(data), error_code: code })

// 中心 agent 用的 wf 工具：提交草稿、读取、运行已确认的 wf。
export function registerWorkflowTools(ctx, service = workflowService(), config = {}) {
  if (config.preset !== ROLE_PRESETS.center) return () => {}
  const tools = [
    {
      name: 'tradeloom_wf_propose',
      description: 'Save a workflow (wf) draft that splits the user\'s task into agent/review/external nodes. Follow the wf-planner skill for the format: {version:1,id,title,nodes:[{id,kind:input|agent|review|external|output,title,agent?(center|product|market|quote|delivery|user-profile),model?:null,instruction?,platform?(external only)}],edges:[{from,to}]}, ids lowercase [a-z0-9_-], no cycles. The draft is shown on the 工作流 canvas and must be confirmed by a person there before it can run. Returns validation issues on failure; fix all of them and resubmit.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['workflow'],
        properties: { workflow: { type: 'object', description: 'Complete wf document (version 1).' } },
      },
      async execute(args) {
        try {
          const doc = await service.save({ ...args.workflow, source: 'agent', confirmed: false })
          return ok({ id: doc.id, nodes: doc.nodes.length, edges: doc.edges.length, canvas: '工作流', requires_human_confirmation: true })
        } catch (error) {
          if (error instanceof WorkflowValidationError) return fail('invalid_workflow', { issues: error.issues })
          return fail('workflow_unavailable')
        }
      },
    },
    {
      name: 'tradeloom_wf_read',
      description: 'List saved workflows, or read one workflow and its latest run (node statuses and outputs) when id is given.',
      parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 48 } } },
      async execute(args) {
        try {
          if (!args?.id) return ok({ workflows: await service.list() })
          const workflow = await service.get(args.id)
          return workflow ? ok({ workflow, run: service.runner.latestFor(args.id) }) : fail('workflow_not_found')
        } catch { return fail('workflow_unavailable') }
      },
    },
    {
      name: 'tradeloom_wf_run',
      description: 'Start a saved, human-confirmed workflow in local mock mode only; no real agent or external platform is invoked. Run history is limited to 30 in-memory entries. Returns the run id; node progress is visible on the 工作流 canvas and via tradeloom_wf_read.',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', maxLength: 48 } } },
      async execute(args) {
        try {
          const result = await service.run(args.id)
          return result.error ? fail(result.error) : ok({ run_id: result.run.id, status: result.run.status })
        } catch { return fail('workflow_unavailable') }
      },
    },
  ]
  const disposers = tools.map(tool => ctx.tools.register({ ...tool, output: OUTPUT, execute(args, exec) {
    if (exec?.agent?.session?.header?.agentPreset !== ROLE_PRESETS.center) return fail('role_not_authorized')
    return tool.execute(args, exec)
  } }))
  return () => { for (const dispose of disposers) dispose?.() }
}

// 把随包的 wf-planner skill 放进中心工作区的 .dsh/skills/，由 DSH 默认的项目 skill 目录加载。
export async function installPlannerSkill(getWorkspace = () => roleWorkspacePath('center')) {
  const source = new URL('./skills/wf-planner/SKILL.md', import.meta.url)
  const target = join(await getWorkspace(), '.dsh', 'skills', 'wf-planner')
  await mkdir(target, { recursive: true })
  await copyFile(source, join(target, 'SKILL.md'))
}

export function apply(ctx, config = {}) {
  if (config.preset !== ROLE_PRESETS.center) return () => {}
  // skill 安装失败不影响工具本身，工具描述里已写明格式要点。
  installPlannerSkill().catch(error => ctx.logger?.warn?.(`tradeloom-shell: wf-planner skill not installed: ${String(error)}`))
  return registerWorkflowTools(ctx, workflowService(), config)
}
