import { ROLE_IDS, ROLE_LABELS } from './roles.js'

// wf（可视化工作流）文档格式：AI 拆分出的和用户手写的共用同一份结构，先校验再保存/运行。
export const WORKFLOW_SCHEMA_VERSION = 1
export const MAX_NODES = 40
export const MAX_EDGES = 80

// 节点种类：agent 交给某个角色；review 等人确认；external 交给外部免费平台（暂只记录说明）；input/output 是起止。
export const NODE_KINDS = Object.freeze(['input', 'agent', 'review', 'external', 'output'])

// 每类节点和每个角色的图标、颜色，前端与 skill 文档共用这一份。
export const NODE_APPEARANCE = Object.freeze({
  input: { icon: '⇥', color: '#5b6b82', label: '输入' },
  review: { icon: '✋', color: '#c27c0e', label: '人工确认' },
  external: { icon: '☁', color: '#7a5cc2', label: '外部平台' },
  output: { icon: '⇲', color: '#2f7d4f', label: '输出' },
})
export const ROLE_APPEARANCE = Object.freeze({
  center: { icon: '◎', color: '#356fc4' },
  product: { icon: '▦', color: '#177d78' },
  market: { icon: '◔', color: '#b5512f' },
  quote: { icon: '¥', color: '#a8326b' },
  delivery: { icon: '⇩', color: '#4a7a1e' },
  'user-profile': { icon: '◈', color: '#6a5acd' },
})

export const NODE_STATUSES = Object.freeze(['pending', 'running', 'waiting', 'done', 'failed', 'skipped'])

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const NODE_KEYS = ['id', 'kind', 'title', 'agent', 'model', 'instruction', 'platform', 'position']
const DOC_KEYS = ['version', 'id', 'title', 'description', 'source', 'confirmed', 'nodes', 'edges']

export class WorkflowValidationError extends Error {
  constructor(issues) {
    super(`invalid workflow: ${issues.join('; ')}`)
    this.code = 'invalid_workflow'
    this.issues = issues
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

// 校验并返回规范化后的副本；收集全部问题后一次抛出，方便 AI 一轮修完。
export function validateWorkflow(input) {
  const issues = []
  if (!isRecord(input)) throw new WorkflowValidationError(['document must be an object'])
  for (const key of Object.keys(input)) if (!DOC_KEYS.includes(key)) issues.push(`unknown field "${key}"`)
  if (input.version !== WORKFLOW_SCHEMA_VERSION) issues.push(`version must be ${WORKFLOW_SCHEMA_VERSION}`)
  if (!ID.test(input.id ?? '')) issues.push('id must match [a-z0-9][a-z0-9_-]{0,47}')
  if (!text(input.title, 100)) issues.push('title is required (≤100 chars)')
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) issues.push('description must be a string ≤2000 chars')
  if (input.source !== undefined && !['manual', 'agent'].includes(input.source)) issues.push('source must be "manual" or "agent"')
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') issues.push('confirmed must be boolean')
  const nodes = Array.isArray(input.nodes) ? input.nodes : []
  const edges = Array.isArray(input.edges) ? input.edges : []
  if (!Array.isArray(input.nodes) || nodes.length === 0 || nodes.length > MAX_NODES) issues.push(`nodes must be a list of 1..${MAX_NODES}`)
  if (!Array.isArray(input.edges) || edges.length > MAX_EDGES) issues.push(`edges must be a list of 0..${MAX_EDGES}`)

  const ids = new Set()
  const normalizedNodes = nodes.map((node, index) => {
    const where = `nodes[${index}]`
    if (!isRecord(node)) { issues.push(`${where} must be an object`); return null }
    for (const key of Object.keys(node)) if (!NODE_KEYS.includes(key)) issues.push(`${where} unknown field "${key}"`)
    if (!ID.test(node.id ?? '')) issues.push(`${where}.id is invalid`)
    else if (ids.has(node.id)) issues.push(`${where}.id "${node.id}" is duplicated`)
    else ids.add(node.id)
    if (!NODE_KINDS.includes(node.kind)) issues.push(`${where}.kind must be one of ${NODE_KINDS.join('/')}`)
    if (!text(node.title, 80)) issues.push(`${where}.title is required (≤80 chars)`)
    if (node.kind === 'agent' && !ROLE_IDS.includes(node.agent)) issues.push(`${where}.agent must be one of ${ROLE_IDS.join('/')}`)
    if (node.kind !== 'agent' && node.agent !== undefined) issues.push(`${where}.agent is only allowed on agent nodes`)
    if (node.model !== undefined && node.model !== null
      && !(isRecord(node.model) && text(node.model.provider, 80) && text(node.model.model, 120) && Object.keys(node.model).length === 2)) {
      issues.push(`${where}.model must be null or {provider, model}`)
    }
    if (node.model && node.kind !== 'agent') issues.push(`${where}.model is only allowed on agent nodes`)
    if (node.instruction !== undefined && (typeof node.instruction !== 'string' || node.instruction.length > 4000)) issues.push(`${where}.instruction must be a string ≤4000 chars`)
    if (node.kind === 'external' && !text(node.platform, 80)) issues.push(`${where}.platform is required on external nodes`)
    if (node.position !== undefined && !(isRecord(node.position) && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))) issues.push(`${where}.position must be {x, y}`)
    return {
      id: node.id, kind: node.kind, title: typeof node.title === 'string' ? node.title.trim() : '',
      ...(node.kind === 'agent' ? { agent: node.agent, model: node.model ?? null } : {}),
      instruction: node.instruction ?? '',
      ...(node.kind === 'external' ? { platform: node.platform } : {}),
      ...(node.position ? { position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : {}),
    }
  })

  const edgeKeys = new Set()
  const normalizedEdges = edges.map((edge, index) => {
    const where = `edges[${index}]`
    if (!isRecord(edge) || Object.keys(edge).some(key => !['from', 'to'].includes(key))) { issues.push(`${where} must be {from, to}`); return null }
    if (!ids.has(edge.from)) issues.push(`${where}.from "${edge.from}" is not a node id`)
    if (!ids.has(edge.to)) issues.push(`${where}.to "${edge.to}" is not a node id`)
    if (edge.from === edge.to) issues.push(`${where} must not point to itself`)
    const key = `${edge.from}->${edge.to}`
    if (edgeKeys.has(key)) issues.push(`${where} duplicates ${key}`)
    edgeKeys.add(key)
    return { from: edge.from, to: edge.to }
  })

  if (issues.length === 0 && topologicalOrder(normalizedNodes, normalizedEdges) === null) issues.push('edges must not form a cycle')
  if (issues.length > 0) throw new WorkflowValidationError(issues)
  return {
    version: WORKFLOW_SCHEMA_VERSION,
    id: input.id,
    title: input.title.trim(),
    description: input.description ?? '',
    source: input.source ?? 'manual',
    confirmed: input.confirmed ?? input.source !== 'agent',
    nodes: autoLayout(normalizedNodes, normalizedEdges),
    edges: normalizedEdges,
  }
}

// Kahn 拓扑排序；有环返回 null。同层按节点出现顺序，保证执行顺序稳定。
export function topologicalOrder(nodes, edges) {
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const next = new Map(nodes.map(node => [node.id, []]))
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1)
    next.get(edge.from).push(edge.to)
  }
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const target of next.get(id)) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  return order.length === nodes.length ? order : null
}

// AI 生成的 wf 通常不带坐标：按拓扑深度分列、同列纵向排开。
function autoLayout(nodes, edges) {
  if (nodes.every(node => node.position)) return nodes
  const depth = new Map(nodes.map(node => [node.id, 0]))
  for (const id of topologicalOrder(nodes, edges) ?? []) {
    for (const edge of edges) if (edge.from === id) depth.set(edge.to, Math.max(depth.get(edge.to), depth.get(id) + 1))
  }
  const rows = new Map()
  return nodes.map(node => {
    if (node.position) return node
    const col = depth.get(node.id)
    const row = rows.get(col) ?? 0
    rows.set(col, row + 1)
    return { ...node, position: { x: 40 + col * 240, y: 40 + row * 130 } }
  })
}

// 给前端和 skill 用的节点目录。
export function workflowCatalog() {
  return {
    kinds: NODE_KINDS.map(kind => ({ kind, ...(NODE_APPEARANCE[kind] ?? { icon: '◎', color: '#356fc4', label: 'Agent' }) })),
    agents: ROLE_IDS.map(id => ({ id, label: ROLE_LABELS[id], ...ROLE_APPEARANCE[id] })),
    statuses: NODE_STATUSES,
  }
}
