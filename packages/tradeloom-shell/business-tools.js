import http from 'node:http'
import { isIPv4 } from 'node:net'
import { ROLE_PRESETS } from './roles.js'

export const name = '@tradeloom/dsh-business-shell/business-tools'
export const inject = ['tools', 'webServer']

const DJANGO_HOST = '127.0.0.1'
const DJANGO_PORT = 3090
const CSRF_PATH = '/'
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const KNOWN_PRESETS = new Set(Object.values(ROLE_PRESETS))
const ERP_DOCTYPES = Object.freeze(['Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order'])
const TOOL_ACCESS = Object.freeze({
  tradeloom_read_products: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product]),
  tradeloom_read_workflow_task: new Set([ROLE_PRESETS.center, ROLE_PRESETS.delivery]),
  tradeloom_read_deliverables: new Set([ROLE_PRESETS.center, ROLE_PRESETS.delivery]),
  tradeloom_preview_workflow_intent: new Set([ROLE_PRESETS.center]),
  tradeloom_dispatch_workflow_subtask: new Set([ROLE_PRESETS.center]),
  tradeloom_erpnext_status: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_list: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_detail: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
})

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'data', 'requires_human_confirmation', 'business_ui_url', 'error_code'],
    properties: {
      ok: { type: 'boolean' },
      // A JSON-encoded, tool-specific allowlisted DTO. Raw Django bodies never reach the model.
      data: { type: 'string' },
      requires_human_confirmation: { type: 'boolean' },
      business_ui_url: { type: 'string' },
      error_code: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

function success(data, extras = {}) {
  return {
    ok: true,
    data: JSON.stringify(data),
    requires_human_confirmation: extras.requires_human_confirmation ?? false,
    business_ui_url: extras.business_ui_url ?? '',
    error_code: '',
  }
}

function failure(code) {
  return { ok: false, data: '', requires_human_confirmation: false, business_ui_url: '', error_code: code }
}

function authority(webServer) {
  const { protocol, host, port } = webServer ?? {}
  const octets = typeof host === 'string' && isIPv4(host) ? host.split('.').map(Number) : []
  const privateLanAddress = octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  if (protocol !== 'http:' || !privateLanAddress || Number(port) !== 3088) {
    throw new Error('TradeLoom trusted business authority is unavailable')
  }
  const origin = webServer.getOrigin?.()
  const parsed = typeof origin === 'string' ? new URL(origin) : undefined
  if (!parsed || parsed.origin !== origin || parsed.protocol !== protocol || parsed.hostname !== host
    || parsed.port !== '3088' || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.username || parsed.password) {
    throw new Error('TradeLoom trusted business origin is unavailable')
  }
  return { host, origin: parsed.origin, hostHeader: `${host}:3088` }
}

function requestJson({ path, method, body, authority: trusted, port = DJANGO_PORT, request = http.request, cookie = '', csrfToken = '', signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Tool request was cancelled')
      error.code = 'tool_cancelled'
      reject(error)
      return
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const headers = {
      host: trusted.hostHeader,
      origin: trusted.origin,
      accept: 'application/json',
    }
    if (cookie) headers.cookie = cookie
    if (csrfToken) headers['x-csrftoken'] = csrfToken
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.byteLength)
    }
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const stop = code => {
      const error = new Error(code === 'tool_timeout' ? 'Django tool request timed out' : 'Tool request was cancelled')
      error.code = code
      upstream.destroy(error)
      settle(error)
    }
    const upstream = request({ hostname: DJANGO_HOST, port, method, path, headers }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          upstream.destroy(new Error('Django response exceeded the tool limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const setCookies = response.headers['set-cookie'] ?? []
        settle(null, { status: response.statusCode ?? 502, raw, setCookies })
      })
      response.on('error', error => settle(error))
    })
    const onAbort = () => stop('tool_cancelled')
    const timeout = setTimeout(() => stop('tool_timeout'), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    upstream.on('error', error => settle(error))
    if (payload) upstream.write(payload)
    upstream.end()
  })
}

function csrfCookie(setCookies) {
  const cookies = Array.isArray(setCookies) ? setCookies : [setCookies]
  const value = cookies.find(item => typeof item === 'string' && /^csrftoken=[^;]+(?:;|$)/i.test(item))
  if (!value) throw new Error('Django did not issue a CSRF cookie')
  const cookie = value.split(';', 1)[0]
  return { cookie, token: cookie.slice('csrftoken='.length) }
}

async function djangoRequest(ctx, toolName, exec, path, method = 'GET', body, dependencies = {}) {
  if (!exec?.agent?.session?.header) return failure('agent_session_required')
  const preset = exec.agent.session.header.agentPreset
  if (!TOOL_ACCESS[toolName]?.has(preset)) return failure('role_not_authorized')

  let trusted
  try { trusted = authority(ctx.webServer) } catch { return failure('business_authority_unavailable') }

  try {
    let csrf = { cookie: '', token: '' }
    if (method !== 'GET') {
      const page = await requestJson({
        path: CSRF_PATH,
        method: 'GET',
        authority: trusted,
        port: dependencies.port ?? DJANGO_PORT,
        request: dependencies.request ?? http.request,
        signal: exec.signal,
        timeoutMs: dependencies.timeoutMs,
      })
      if (page.status < 200 || page.status >= 400) return failure(`csrf_bootstrap_http_${page.status}`)
      csrf = csrfCookie(page.setCookies)
    }

    const response = await requestJson({
      path,
      method,
      body,
      authority: trusted,
      port: dependencies.port ?? DJANGO_PORT,
      request: dependencies.request ?? http.request,
      signal: exec.signal,
      timeoutMs: dependencies.timeoutMs,
      cookie: csrf.cookie,
      csrfToken: csrf.token,
    })
    if (response.status < 200 || response.status >= 300) return failure(`django_http_${response.status}`)
    let value
    try { value = JSON.parse(response.raw) } catch { return failure('invalid_django_json') }
    return value
  } catch (error) {
    if (error?.code === 'tool_cancelled' || exec.signal?.aborted) return failure('tool_cancelled')
    if (error?.code === 'tool_timeout') return failure('django_timeout')
    return failure('django_unavailable')
  }
}

function boundedString(value, max = 4000) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function projectRevision(revision) {
  if (!revision || typeof revision !== 'object') return null
  const snapshotFields = ['sku', 'name', 'category', 'material', 'size', 'color', 'image_filename']
  const snapshot = revision.snapshot && typeof revision.snapshot === 'object' ? revision.snapshot : {}
  return {
    version: revision.version ?? null,
    status: boundedString(revision.status, 80),
    source: boundedString(revision.source, 120),
    snapshot: Object.fromEntries(snapshotFields.map(key => [key, boundedString(snapshot[key], 500)])),
    updated_at: boundedString(revision.updated_at, 80),
  }
}

function projectProduct(product) {
  return {
    id: boundedString(product.id, 80),
    task_id: boundedString(product.task_id, 80),
    sku: boundedString(product.sku, 200),
    name: boundedString(product.name, 500),
    category: boundedString(product.category, 500),
    material: boundedString(product.material, 500),
    size: boundedString(product.size, 500),
    color: boundedString(product.color, 500),
    image_filename: boundedString(product.image_filename, 240),
    missing_fields: Array.isArray(product.missing_fields) ? product.missing_fields.map(item => boundedString(item, 100)).slice(0, 40) : [],
    batch: {
      id: boundedString(product.batch?.id, 80),
      title: boundedString(product.batch?.title, 500),
      status: boundedString(product.batch?.status, 100),
    },
    current_version: product.current_version ?? null,
    revision_status: boundedString(product.revision_status, 100),
    latest_revision: projectRevision(product.latest_revision),
  }
}

function projectWorkflow(workflow, includeDispatchTarget) {
  return {
    id: boundedString(workflow.id, 80),
    batch_id: boundedString(workflow.batch_id, 80),
    user_goal: boundedString(workflow.user_goal),
    task_type: boundedString(workflow.task_type, 120),
    status: boundedString(workflow.status, 100),
    current_step: boundedString(workflow.current_step, 160),
    mode: boundedString(workflow.mode, 80),
    execution: boundedString(workflow.execution, 80),
    error_summary: boundedString(workflow.error_summary, 500),
    steps: Array.isArray(workflow.steps) ? workflow.steps.slice(0, 100).map(step => ({
      id: boundedString(step.id, 80), step_key: boundedString(step.step_key, 160), status: boundedString(step.status, 80),
      attempt: step.attempt ?? 0, error_summary: boundedString(step.error_summary, 500),
    })) : [],
    subtasks: Array.isArray(workflow.subtasks) ? workflow.subtasks.slice(0, 100).map(subtask => ({
      id: boundedString(subtask.id, 80), agent_role: boundedString(subtask.agent_role, 120), status: boundedString(subtask.status, 80),
      retry_count: subtask.retry_count ?? 0, depends_on: Array.isArray(subtask.depends_on) ? subtask.depends_on.map(item => boundedString(item, 80)).slice(0, 100) : [],
      error_summary: boundedString(subtask.error_summary, 500),
    })) : [],
    reviews: Array.isArray(workflow.reviews) ? workflow.reviews.slice(0, 100).map(review => ({
      id: boundedString(review.id, 80), review_key: boundedString(review.review_key, 160), item_ref: boundedString(review.item_ref, 240),
      question: boundedString(review.question, 1000), options: Array.isArray(review.options) ? review.options.map(item => boundedString(item, 500)).slice(0, 30) : [],
      status: boundedString(review.status, 80), answer: boundedString(review.answer, 1000), reviewer: boundedString(review.reviewer, 160),
    })) : [],
    reviews_scope: boundedString(workflow.reviews_scope, 40) || 'business_facts',
    pending_review_count: Number.isFinite(workflow.pending_review_count) ? workflow.pending_review_count : 0,
    unresolved_review_count: Number.isFinite(workflow.unresolved_review_count) ? workflow.unresolved_review_count : 0,
    ...(includeDispatchTarget && workflow.dispatch_target && typeof workflow.dispatch_target === 'object' ? { dispatch_target: {
      subtask_id: boundedString(workflow.dispatch_target.subtask_id, 80),
      idempotency_key: boundedString(workflow.dispatch_target.idempotency_key, 200),
      blocked_reason: boundedString(workflow.dispatch_target.blocked_reason, 500),
    } } : {}),
  }
}

function projectDeliverables(payload) {
  const review = payload.delivery_review_summary && typeof payload.delivery_review_summary === 'object'
    ? payload.delivery_review_summary : null
  const deliveryReviewSummary = review && review.scope === 'delivery_bundle'
    && ['approve', 'reject'].includes(review.decision)
    && Array.isArray(review.artifact_version_ids)
    && review.artifact_version_ids.every(id => typeof id === 'string')
    ? {
      scope: 'delivery_bundle',
      generation_step_id: boundedString(review.generation_step_id, 80),
      event_id: boundedString(review.event_id, 80),
      decision: review.decision,
      reviewer: boundedString(review.reviewer, 160),
      reviewed_at: boundedString(review.reviewed_at, 80),
      artifact_version_ids: review.artifact_version_ids.slice(0, 100).map(id => boundedString(id, 80)),
    }
    : null
  return {
    workflow_task_id: boundedString(payload.workflow_task_id, 80),
    workflow_status: boundedString(payload.workflow_status, 100),
    current_step: boundedString(payload.current_step, 160),
    delivery_review_summary: deliveryReviewSummary,
    quality_checks: Array.isArray(payload.quality_checks) ? payload.quality_checks.slice(0, 100).map(item => ({
      filename: boundedString(item.filename, 240), passed: Boolean(item.passed), bytes: Number(item.bytes) || 0, sha256: boundedString(item.sha256, 64),
    })) : [],
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.slice(0, 100).map(artifact => ({
      id: boundedString(artifact.id, 80), artifact_type: boundedString(artifact.artifact_type, 120),
      current_version: artifact.current_version ?? null, status: boundedString(artifact.status, 100),
      versions: Array.isArray(artifact.versions) ? artifact.versions.slice(0, 30).map(version => ({
        id: boundedString(version.id, 80), version: version.version ?? null, status: boundedString(version.status, 100),
        sha256: boundedString(version.sha256, 64), source_product_versions: Array.isArray(version.source_product_versions) ? version.source_product_versions.slice(0, 100) : [],
        created_at: boundedString(version.created_at, 80),
      })) : [],
    })) : [],
  }
}

function projectIntentPreview(preview) {
  const classification = preview.classification && typeof preview.classification === 'object' ? preview.classification : {}
  const action = preview.action && typeof preview.action === 'object' ? preview.action : null
  const metadata = value => value && typeof value === 'object' ? {
    version: boundedString(value.version, 120), sha256: boundedString(value.sha256, 64),
  } : { version: '', sha256: '' }
  return {
    status: boundedString(preview.status, 80),
    classification: {
      task_type: boundedString(classification.task_type, 120), reason: boundedString(classification.reason, 500),
      evidence: Array.isArray(classification.evidence) ? classification.evidence.map(item => boundedString(item, 300)).slice(0, 30) : [],
      source: boundedString(classification.source, 80),
    },
    evidence: Array.isArray(preview.evidence) ? preview.evidence.map(item => boundedString(item, 300)).slice(0, 30) : [],
    action: action ? {
      operation: boundedString(action.operation, 80), batch_id: boundedString(action.batch_id, 80),
      user_goal: boundedString(action.user_goal), task_type: boundedString(action.task_type, 120),
    } : null,
    clarification: boundedString(preview.clarification, 500),
    mode: boundedString(preview.mode, 80), execution: boundedString(preview.execution, 80),
    model_provider: boundedString(preview.model_provider, 80), prompt: metadata(preview.prompt), rules: metadata(preview.rules),
    sources: Array.isArray(preview.sources) ? preview.sources.slice(0, 20).map(source => ({
      kind: boundedString(source.kind, 80), model: boundedString(source.model, 160), id: boundedString(source.id, 80),
      title: boundedString(source.title, 300), count: Number.isFinite(source.count) ? source.count : null,
    })) : [],
  }
}

function projectErpNextStatus(value) {
  const statuses = new Set(['not_configured', 'invalid_configuration', 'connected', 'unavailable'])
  const errors = new Set(['', 'not_configured', 'invalid_configuration', 'unavailable', 'unauthorized', 'forbidden', 'rate_limited', 'http_error', 'invalid_response'])
  if (!value || typeof value !== 'object' || typeof value.configured !== 'boolean' || typeof value.connected !== 'boolean'
    || !statuses.has(value.status) || !errors.has(value.error_code)) return null
  return { configured: value.configured, connected: value.connected, status: value.status, error_code: value.error_code }
}

const ERP_SCALAR_FIELDS = Object.freeze({
  Item: ['name', 'modified', 'item_code', 'item_name', 'item_group', 'stock_uom', 'disabled', 'description', 'brand', 'image', 'is_stock_item', 'has_variants'],
  Customer: ['name', 'modified', 'customer_name', 'alias', 'customer_type', 'customer_group', 'territory', 'tax_id', 'disabled', 'default_currency', 'website', 'email_id', 'mobile_no'],
  Supplier: ['name', 'modified', 'supplier_name', 'alias', 'supplier_type', 'supplier_group', 'country', 'tax_id', 'disabled', 'default_currency', 'website', 'email_id', 'mobile_no'],
  Warehouse: ['name', 'modified', 'warehouse_name', 'is_group', 'company', 'disabled', 'parent_warehouse', 'warehouse_type', 'email_id', 'phone_no', 'mobile_no', 'city', 'state'],
  Bin: ['name', 'modified', 'item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'indented_qty', 'planned_qty', 'projected_qty', 'stock_uom', 'company'],
  'Sales Order': ['name', 'modified', 'customer', 'customer_name', 'company', 'transaction_date', 'delivery_date', 'status', 'delivery_status', 'billing_status', 'total_qty', 'grand_total', 'currency', 'docstatus'],
  'Purchase Order': ['name', 'modified', 'supplier', 'supplier_name', 'company', 'transaction_date', 'schedule_date', 'status', 'total_qty', 'grand_total', 'currency', 'docstatus'],
})
const ERP_CHILD_FIELDS = Object.freeze({
  Item: { barcodes: ['barcode', 'barcode_type', 'uom'] },
  'Sales Order': { items: ['item_code', 'item_name', 'qty', 'uom', 'delivery_date', 'rate', 'amount'] },
  'Purchase Order': { items: ['item_code', 'item_name', 'qty', 'uom', 'schedule_date', 'rate', 'amount'] },
})

function projectErpNextRecord(value, expectedDoctype) {
  if (!value || typeof value !== 'object' || value.doctype !== expectedDoctype
    || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return null
  const fields = new Set(ERP_SCALAR_FIELDS[expectedDoctype])
  const data = {}
  for (const [key, item] of Object.entries(value.data)) {
    if (fields.has(key) && (item === null || ['string', 'boolean'].includes(typeof item)
      || (typeof item === 'number' && Number.isFinite(item)))) {
      if (key === 'docstatus' && ![0, 1, 2].includes(item)) continue
      data[key] = item
    }
  }
  const children = ERP_CHILD_FIELDS[expectedDoctype] ?? {}
  const truncatedChildren = []
  for (const [key, childFields] of Object.entries(children)) {
    if (Array.isArray(value.data[key])) {
      if (value.data[key].length > 100) truncatedChildren.push(key)
      data[key] = value.data[key].slice(0, 100).map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return null
        return Object.fromEntries(childFields.filter(field => row[field] === null || ['string', 'boolean'].includes(typeof row[field])
          || (typeof row[field] === 'number' && Number.isFinite(row[field]))).map(field => [field, row[field]]))
      }).filter(Boolean)
    }
  }
  const ref = value.external_ref
  if (typeof data.name !== 'string' || !data.name || !ref || ref.system !== 'erpnext'
    || ref.doctype !== expectedDoctype || typeof ref.name !== 'string' || !ref.name || ref.name !== data.name
    || typeof ref.instance_id !== 'string' || !ref.instance_id || !(ref.modified === null || typeof ref.modified === 'string')) return null
  return { doctype: expectedDoctype, data, truncated_children: truncatedChildren, external_ref: {
    system: 'erpnext', instance_id: boundedString(ref.instance_id, 128), doctype: expectedDoctype,
    name: boundedString(ref.name, 256), modified: ref.modified === null ? null : boundedString(ref.modified, 80),
  } }
}

function projectErpNextPage(value, expectedDoctype) {
  if (!value || typeof value !== 'object' || value.doctype !== expectedDoctype || !Array.isArray(value.records)
    || !(value.next_offset === null || (Number.isInteger(value.next_offset) && value.next_offset >= 0))) return null
  const records = value.records.slice(0, 100).map(record => projectErpNextRecord(record, expectedDoctype))
  if (records.some(record => !record)) return null
  return { doctype: expectedDoctype, records, next_offset: value.next_offset }
}

function schema(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties }
}

function exactArgs(args, allowed, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args)
  return keys.every(key => allowed.includes(key)) && required.every(key => typeof args[key] === 'string' && args[key].length > 0)
}

const string = (description, maxLength = 240) => ({ type: 'string', description, maxLength })
const wireString = description => ({ type: 'string', description })
function registerTool(ctx, definition) {
  return ctx.tools.register({ ...definition, output: TOOL_OUTPUT })
}

export function registerBusinessTools(ctx, config = {}, dependencies = {}) {
  const preset = config?.preset
  const allowedTools = KNOWN_PRESETS.has(preset) ? TOOL_ACCESS : null
  if (!allowedTools) return () => {}
  const tools = [
    {
      name: 'tradeloom_read_products',
      description: 'Read product facts and latest revision/source status from the existing TradeLoom product library.',
      parameters: schema({ q: string('Optional search by SKU or product name.'), status: string('Optional revision status filter.', 80), batch_id: string('Optional source batch ID.', 80) }, []),
      async execute(args, exec) {
        if (!exactArgs(args, ['q', 'status', 'batch_id'], [])) return failure('invalid_arguments')
        const query = new URLSearchParams()
        for (const key of ['q', 'status', 'batch_id']) if (args[key]) query.set(key, args[key])
        const result = await djangoRequest(ctx, 'tradeloom_read_products', exec, `/api/product-library${query.size ? `?${query}` : ''}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!Array.isArray(result)) return failure('invalid_product_dto')
        return success(result.slice(0, 200).map(projectProduct))
      },
    },
    {
      name: 'tradeloom_read_workflow_task',
      description: 'Read saved workflow, subtask, source, and version status. reviews covers business fact checks; delivery bundle approval is reported separately by tradeloom_read_deliverables.',
      parameters: schema({ workflow_id: string('Existing workflow task ID.', 80) }),
      async execute(args, exec) {
        if (!exactArgs(args, ['workflow_id'], ['workflow_id'])) return failure('invalid_arguments')
        const id = encodeURIComponent(args.workflow_id)
        const result = await djangoRequest(ctx, 'tradeloom_read_workflow_task', exec, `/api/workflow-tasks/${id}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)) return failure('invalid_workflow_dto')
        return success(projectWorkflow(result, exec.agent.session.header.agentPreset === ROLE_PRESETS.center))
      },
    },
    {
      name: 'tradeloom_read_deliverables',
      description: 'Read generated artifact metadata, versions, quality checks, and the current generation bundle approval event without fetching file contents. This approval is separate from business fact reviews.',
      parameters: schema({ workflow_id: string('Existing workflow task ID.', 80) }),
      async execute(args, exec) {
        if (!exactArgs(args, ['workflow_id'], ['workflow_id'])) return failure('invalid_arguments')
        const id = encodeURIComponent(args.workflow_id)
        const result = await djangoRequest(ctx, 'tradeloom_read_deliverables', exec, `/api/workflow-tasks/${id}/deliverables`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)) return failure('invalid_deliverables_dto')
        return success(projectDeliverables(result))
      },
    },
    {
      name: 'tradeloom_preview_workflow_intent',
      description: 'Preview a workflow intent using the existing parser, or submit an allowlisted structured proposal after clarifying the request. This never creates a task; a person must review and confirm in the business UI.',
      parameters: schema({
        batch_id: string('Existing product batch ID.', 32),
        user_goal: string('The user\'s literal, clarified workflow goal.', 4000),
        task_type: { type: 'string', enum: ['prepare_product_data', 'generate_deliverables'], description: 'Optional structured proposal type after clarification.' },
      }, ['batch_id', 'user_goal']),
      async execute(args, exec) {
        if (!exactArgs(args, ['batch_id', 'user_goal', 'task_type'], ['batch_id', 'user_goal'])) return failure('invalid_arguments')
        if (args.task_type !== undefined && !['prepare_product_data', 'generate_deliverables'].includes(args.task_type)) return failure('invalid_arguments')
        const body = { batch_id: args.batch_id, user_goal: args.user_goal }
        if (args.task_type !== undefined) body.task_type = args.task_type
        const result = await djangoRequest(ctx, 'tradeloom_preview_workflow_intent', exec, '/api/workflow-intent/preview', 'POST', body, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)) return failure('invalid_intent_dto')
        let trustedOrigin
        try { trustedOrigin = authority(ctx.webServer).origin } catch { return failure('business_authority_unavailable') }
        const businessAgentCenterUrl = `${trustedOrigin}/business/agent-center`
        const businessUiUrl = args.task_type === undefined
          ? businessAgentCenterUrl
          : `${businessAgentCenterUrl}#proposal=${encodeURIComponent(JSON.stringify({
            version: 1, batch_id: args.batch_id, user_goal: args.user_goal, task_type: args.task_type,
          }))}`
        return success(projectIntentPreview(result), { requires_human_confirmation: true, business_ui_url: businessUiUrl })
      },
    },
    {
      name: 'tradeloom_dispatch_workflow_subtask',
      description: 'Dispatch one existing saved subtask. Reuses its stable idempotency key; Django enforces dependency and review gates.',
      parameters: schema({ workflow_id: string('Existing workflow task ID.', 80), subtask_id: string('Existing saved subtask ID.', 80) }),
      async execute(args, exec) {
        if (!exactArgs(args, ['workflow_id', 'subtask_id'], ['workflow_id', 'subtask_id'])) return failure('invalid_arguments')
        const workflowId = encodeURIComponent(args.workflow_id)
        const subtaskId = encodeURIComponent(args.subtask_id)
        const current = await djangoRequest(ctx, 'tradeloom_dispatch_workflow_subtask', exec,
          `/api/workflow-tasks/${workflowId}`, 'GET', undefined, dependencies)
        if (current?.ok === false) return failure(current.error_code)
        const target = current?.dispatch_target
        if (!target || target.subtask_id !== args.subtask_id || typeof target.idempotency_key !== 'string' || !target.idempotency_key) {
          return success(
            { status: 'blocked', blocked_reason: boundedString(target?.blocked_reason || '该子任务不是当前服务端授权的下一步。', 500) },
            { business_ui_url: `/business/workflow-tasks/${workflowId}` },
          )
        }
        const result = await djangoRequest(ctx, 'tradeloom_dispatch_workflow_subtask', exec,
          `/api/workflow-tasks/${workflowId}/subtasks/${subtaskId}/dispatch`, 'POST',
          { idempotency_key: target.idempotency_key }, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)) return failure('invalid_dispatch_dto')
        return success({
          workflow_id: boundedString(result.workflow_id ?? args.workflow_id, 80),
          subtask_id: boundedString(result.subtask_id ?? args.subtask_id, 80),
          status: boundedString(result.status ?? result.step?.status, 100),
          execution_mode: boundedString(result.execution_mode, 80),
          planning_mode: boundedString(result.planning_mode, 80),
          agentarts: boundedString(result.agentarts, 80),
          notice: boundedString(result.notice, 500),
          step: result.step && typeof result.step === 'object' ? {
            id: boundedString(result.step.id, 80), key: boundedString(result.step.key, 200), status: boundedString(result.step.status, 100),
            attempt: result.step.attempt ?? 0,
          } : null,
        }, { business_ui_url: `/business/workflow-tasks/${workflowId}` })
      },
    },
    {
      name: 'tradeloom_erpnext_status',
      description: 'Read whether the locally configured ERPNext connection is configured and reachable. It does not return credentials or instance identity.',
      parameters: schema({}),
      async execute(args, exec) {
        if (!exactArgs(args, [], [])) return failure('invalid_arguments')
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_status', exec, '/api/erpnext/status', 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const status = projectErpNextStatus(result)
        return status ? success(status) : failure('invalid_erpnext_status_dto')
      },
    },
    {
      name: 'tradeloom_erpnext_list',
      description: 'Read a bounded page of allowlisted ERPNext master data. Filters and fields are limited by DocType; this tool cannot write records.',
      parameters: schema({
        doctype: { ...wireString('One supported ERPNext DocType.'), enum: ERP_DOCTYPES },
        fields_json: wireString('Optional JSON array of allowlisted scalar fields.'),
        filters_json: wireString('Optional JSON object of allowlisted equality filters.'),
        limit: { type: 'integer', description: 'Optional page size; runtime accepts 1 to 100.' },
        offset: { type: 'integer', description: 'Optional zero-based page offset; runtime requires a nonnegative integer.' },
      }, ['doctype']),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['doctype', 'fields_json', 'filters_json', 'limit', 'offset'].includes(key))
          || !ERP_DOCTYPES.includes(args.doctype)
          || (args.fields_json !== undefined && (typeof args.fields_json !== 'string' || args.fields_json.length > 2048))
          || (args.filters_json !== undefined && (typeof args.filters_json !== 'string' || args.filters_json.length > 2048))
          || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))
          || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0))) return failure('invalid_arguments')
        let fields
        if (args.fields_json !== undefined) {
          try { fields = JSON.parse(args.fields_json) } catch { return failure('invalid_arguments') }
          if (!Array.isArray(fields) || fields.length > 40 || fields.some(field => typeof field !== 'string')) return failure('invalid_arguments')
        }
        let filters
        if (args.filters_json !== undefined) {
          try { filters = JSON.parse(args.filters_json) } catch { return failure('invalid_arguments') }
          if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return failure('invalid_arguments')
        }
        const query = new URLSearchParams({ doctype: args.doctype })
        if (fields !== undefined) query.set('fields', fields.join(','))
        if (filters !== undefined) query.set('filters', JSON.stringify(filters))
        if (args.limit !== undefined) query.set('limit', String(args.limit))
        if (args.offset !== undefined) query.set('offset', String(args.offset))
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_list', exec, `/api/erpnext/records?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const page = projectErpNextPage(result, args.doctype)
        return page ? success(page) : failure('invalid_erpnext_page_dto')
      },
    },
    {
      name: 'tradeloom_erpnext_detail',
      description: 'Read one allowlisted ERPNext record and its bounded child rows. This tool cannot write or submit records.',
      parameters: schema({
        doctype: { ...wireString('One supported ERPNext DocType.'), enum: ERP_DOCTYPES },
        name: wireString('Exact ERPNext record name.'),
      }),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['doctype', 'name'].includes(key))
          || !ERP_DOCTYPES.includes(args.doctype) || typeof args.name !== 'string' || !args.name || args.name.length > 256) return failure('invalid_arguments')
        const query = new URLSearchParams({ doctype: args.doctype, name: args.name })
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_detail', exec, `/api/erpnext/record?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const record = projectErpNextRecord(result, args.doctype)
        return record ? success(record) : failure('invalid_erpnext_record_dto')
      },
    },
  ]

  const disposers = tools
    .filter(tool => allowedTools[tool.name].has(preset))
    .map(tool => registerTool(ctx, tool))
  return () => { for (const dispose of disposers) dispose() }
}

export function apply(ctx, config = {}) {
  registerBusinessTools(ctx, config)
}
