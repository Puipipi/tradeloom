import http from 'node:http'
import { isIPv4 } from 'node:net'
import { ROLE_PRESETS } from './roles.js'

export const name = '@tradeloom/dsh-business-shell/business-tools'
export const inject = ['tools', 'webServer', 'agents']

const DJANGO_HOST = '127.0.0.1'
const DJANGO_PORT = 3090
const CSRF_PATH = '/'
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const NATIVE_BRIDGE_HEADER = 'x-tradeloom-native-bridge'
const NATIVE_BRIDGE_TOOLS = new Set([
  'tradeloom_begin_native_workflow_assignment',
  'tradeloom_bind_native_workflow_expert',
  'tradeloom_submit_native_workflow_advice',
])
const KNOWN_PRESETS = new Set(Object.values(ROLE_PRESETS))
const ERP_DOCTYPES = Object.freeze(['Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order'])
const INTAKE_CANDIDATE_TYPES = Object.freeze(['product_identity', 'commercial_source', 'production_instruction', 'labor_analysis'])
const INTAKE_FIELDS = Object.freeze({
  product_identity: Object.freeze({
    style_number: 'text', description: 'text', customer_item_code: 'text', width: 'decimal', width_unit: 'text',
    color: 'text', roll_length: 'decimal', roll_length_unit: 'text', packing: 'text', barcode: 'text',
  }),
  commercial_source: Object.freeze({
    document_reference: 'text', party_text: 'text', item_description: 'text', quantity: 'decimal', unit: 'text',
    unit_price: 'decimal', amount: 'decimal', currency: 'text', notes: 'text',
  }),
  production_instruction: Object.freeze({
    source_order_reference: 'text', description: 'text', specification: 'text', color: 'text', quantity: 'decimal',
    unit: 'text', packing: 'text', carton_count: 'decimal', barcode_requirement: 'text', due_date: 'date',
    requirement_text: 'text', pack_quantity: 'decimal', pack_unit: 'text',
  }),
  labor_analysis: Object.freeze({
    process: 'text', observed_seconds: 'decimal', observed_quantity: 'decimal', observed_unit: 'text',
    estimated_hourly_rate: 'decimal', estimated_efficiency: 'decimal', estimated_capacity: 'decimal',
    estimated_piece_rate: 'decimal', notes: 'text',
  }),
})
const INTAKE_OPAQUE_ID = /^[0-9a-f]{32}$/
const INTAKE_SHA256 = /^[0-9a-f]{64}$/
const INTAKE_COORDINATE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/
const INTAKE_VALUE_STATES = new Set(['present', 'empty', 'formula_error', 'formula_cache_missing', 'formula_cache_empty', 'type_mismatch'])
const INTAKE_ERROR_CODES = new Set([
  'invalid_arguments', 'invalid_source', 'source_not_found', 'preview_not_found', 'candidate_not_found',
  'mapping_not_found', 'idempotency_conflict', 'stale_mapping', 'source_cell_not_found', 'snapshot_not_ready',
  'invalid_mapping', 'unsupported_schema', 'unsupported_candidate_type', 'invalid_revision', 'unknown_field',
  'empty_mapping', 'invalid_field_mapping', 'invalid_source_cells', 'invalid_source_cell', 'too_many_source_cells',
  'unsupported_value_type', 'invalid_source_hash', 'private_store_unavailable', 'unavailable',
])
const INTAKE_MAX_PAGE_SIZE = 50
const INTAKE_MAX_NESTED = 20
const INTAKE_MAX_FIELD_VALUES = 10
const INTAKE_MAX_TEXT = 160
const TOOL_ACCESS = Object.freeze({
  tradeloom_read_products: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product]),
  tradeloom_read_workflow_task: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_read_deliverables: new Set([ROLE_PRESETS.center, ROLE_PRESETS.delivery]),
  tradeloom_preview_workflow_intent: new Set([ROLE_PRESETS.center]),
  tradeloom_dispatch_workflow_subtask: new Set([ROLE_PRESETS.center]),
  tradeloom_begin_native_workflow_assignment: new Set([ROLE_PRESETS.center]),
  tradeloom_bind_native_workflow_expert: new Set([ROLE_PRESETS.center]),
  tradeloom_submit_native_workflow_advice: new Set([ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_status: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_list: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_detail: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_erpnext_create_quotation_draft: new Set([ROLE_PRESETS.center]),
  tradeloom_erpnext_update_quotation_draft: new Set([ROLE_PRESETS.center]),
  tradeloom_erpnext_read_quotation_draft_operation: new Set([ROLE_PRESETS.center]),
  tradeloom_intake_sources: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_narrative_sources: new Set([ROLE_PRESETS.center]),
  tradeloom_narrative_excerpt: new Set([ROLE_PRESETS.center]),
  tradeloom_intake_candidates: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_intake_candidate: new Set([ROLE_PRESETS.center, ROLE_PRESETS.product, ROLE_PRESETS.delivery]),
  tradeloom_read_execution_plan: new Set([ROLE_PRESETS.center, ROLE_PRESETS.delivery]),
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

export function trustedBusinessAuthority(webServer) {
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

const authority = trustedBusinessAuthority

export function requestBusinessJson({ path, method, body, authority: trusted, port = DJANGO_PORT, request = http.request, cookie = '', csrfToken = '', nativeBridgeKey, signal, timeoutMs = REQUEST_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES }) {
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
    if (nativeBridgeKey) headers[NATIVE_BRIDGE_HEADER] = nativeBridgeKey
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
        if (size > maxResponseBytes) {
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

const requestJson = requestBusinessJson

function csrfCookie(setCookies) {
  const cookies = Array.isArray(setCookies) ? setCookies : [setCookies]
  const value = cookies.find(item => typeof item === 'string' && /^csrftoken=[^;]+(?:;|$)/i.test(item))
  if (!value) throw new Error('Django did not issue a CSRF cookie')
  const cookie = value.split(';', 1)[0]
  return { cookie, token: cookie.slice('csrftoken='.length) }
}

async function djangoRequest(ctx, toolName, exec, path, method = 'GET', body, dependencies = {}, acceptedStatuses = []) {
  if (!exec?.agent?.session?.header) return failure('agent_session_required')
  const preset = exec.agent.session.header.agentPreset
  if (!TOOL_ACCESS[toolName]?.has(preset)) return failure('role_not_authorized')
  const needsNativeBridge = method === 'POST' && NATIVE_BRIDGE_TOOLS.has(toolName)
  const nativeBridgeKey = needsNativeBridge
    ? dependencies.nativeBridgeKey ?? process.env.TRADELOOM_NATIVE_BRIDGE_KEY
    : undefined
  if (needsNativeBridge && !/^[a-f0-9]{64}$/.test(nativeBridgeKey ?? '')) return failure('native_bridge_unavailable')

  let trusted
  try { trusted = dependencies.authorityResolver ? dependencies.authorityResolver(ctx.webServer) : authority(ctx.webServer) }
  catch { return failure('business_authority_unavailable') }

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
      nativeBridgeKey,
    })
    if ((response.status < 200 || response.status >= 300) && !acceptedStatuses.includes(response.status)) return failure(`django_http_${response.status}`)
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

function observedAgentIdentity(exec) {
  const agent = exec?.agent
  const header = agent?.session?.header
  if (typeof agent?.id !== 'string' || !agent.id.trim() || !header || typeof header !== 'object') return null
  if (typeof header.agentPreset !== 'string' || !header.agentPreset.trim()) return null
  const depth = header.delegationDepth
  const parentSession = header.parentSession
  if (!Number.isInteger(depth) || depth < 0 || (parentSession !== null && typeof parentSession !== 'string')) return null
  return {
    agent_id: agent.id,
    agent_preset: header.agentPreset,
    parent_session: parentSession,
    delegation_depth: depth,
  }
}

function validNativeAdvice(preset, advice) {
  if (!advice || typeof advice !== 'object' || Array.isArray(advice)
    || Object.keys(advice).some(key => !['schema_version', 'observations'].includes(key))
    || advice.schema_version !== 'native-expert-advice.v1'
    || !Array.isArray(advice.observations) || advice.observations.length > 20) return false
  if (preset === ROLE_PRESETS.product) {
    const fields = new Set(['sku', 'name', 'category', 'material', 'size', 'color', 'english_name'])
    return advice.observations.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && ['product_id', 'field', 'note', 'suggested_value'].every(key => Object.hasOwn(item, key) || key !== 'suggested_value')
      && Object.keys(item).every(key => ['product_id', 'field', 'source_refs', 'note', 'suggested_value'].includes(key))
      && typeof item.product_id === 'string' && item.product_id.length > 0 && item.product_id.length <= 80
      && item.source_refs && typeof item.source_refs === 'object' && !Array.isArray(item.source_refs)
      && Object.keys(item.source_refs).length === 3
      && Object.keys(item.source_refs).every(key => ['product_id', 'revision_id', 'task_file_ids'].includes(key))
      && item.source_refs.product_id === item.product_id
      && (item.source_refs.revision_id === null || (typeof item.source_refs.revision_id === 'string' && item.source_refs.revision_id.length > 0 && item.source_refs.revision_id.length <= 80))
      && Array.isArray(item.source_refs.task_file_ids) && item.source_refs.task_file_ids.length <= 30
      && item.source_refs.task_file_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80)
      && fields.has(item.field) && typeof item.note === 'string' && item.note.trim().length > 0 && item.note.length <= 500
      && (item.suggested_value === undefined || (typeof item.suggested_value === 'string' && item.suggested_value.length <= 500)))
  }
  if (preset === ROLE_PRESETS.delivery) {
    return advice.observations.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && ['check_code', 'note'].every(key => Object.hasOwn(item, key))
      && Object.keys(item).every(key => ['check_code', 'product_id', 'note', 'source_refs'].includes(key))
      && typeof item.check_code === 'string' && item.check_code.length > 0 && item.check_code.length <= 80
      && item.source_refs && typeof item.source_refs === 'object' && !Array.isArray(item.source_refs)
      && Object.keys(item.source_refs).length === 3
      && Object.keys(item.source_refs).every(key => ['workflow_task_id', 'batch_id', 'product_ids'].includes(key))
      && typeof item.source_refs.workflow_task_id === 'string' && item.source_refs.workflow_task_id.length > 0 && item.source_refs.workflow_task_id.length <= 80
      && typeof item.source_refs.batch_id === 'string' && item.source_refs.batch_id.length > 0 && item.source_refs.batch_id.length <= 80
      && Array.isArray(item.source_refs.product_ids) && item.source_refs.product_ids.length <= 1000
      && item.source_refs.product_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80)
      && typeof item.note === 'string' && item.note.trim().length > 0 && item.note.length <= 500
      && (item.product_id === undefined || (typeof item.product_id === 'string' && item.product_id.length > 0 && item.product_id.length <= 80)))
  }
  return false
}

function boundedNativeAdviceContext(role, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema_version !== 'native-advice-context.v1' || value.role !== role) return null
  if (role === 'product_profile' && Array.isArray(value.products) && value.products.length <= 100) {
    const fields = new Set(['sku', 'name', 'category', 'material', 'size', 'color', 'english_name'])
    const products = []
    for (const item of value.products) {
      const refs = item?.source_refs
      if (typeof item?.product_id !== 'string' || !item.product_id || item.product_id.length > 80 || !Array.isArray(item.fields)
        || item.fields.length > fields.size || !item.fields.every(field => fields.has(field))
        || !refs || typeof refs !== 'object' || Array.isArray(refs)
        || refs.product_id !== item.product_id || refs.product_id.length > 80
        || !(refs.revision_id === null || (typeof refs.revision_id === 'string' && refs.revision_id.length <= 80))
        || !Array.isArray(refs.task_file_ids) || refs.task_file_ids.length > 30
        || !refs.task_file_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80)) return null
      products.push({
        product_id: boundedString(item.product_id, 80),
        fields: [...new Set(item.fields)],
        source_refs: {
          product_id: boundedString(refs.product_id, 80),
          revision_id: refs.revision_id === null ? null : boundedString(refs.revision_id, 80),
          task_file_ids: refs.task_file_ids.map(id => boundedString(id, 80)),
        },
      })
    }
    return { schema_version: 'native-advice-context.v1', role, products }
  }
  if (role === 'delivery_quality' && Array.isArray(value.checks) && value.checks.length <= 100) {
    const checks = []
    for (const item of value.checks) {
      const refs = item?.source_refs
      if (typeof item?.check_code !== 'string' || !item.check_code || item.check_code.length > 80
        || !refs || typeof refs !== 'object' || Array.isArray(refs)
        || typeof refs.workflow_task_id !== 'string' || !refs.workflow_task_id || refs.workflow_task_id.length > 80
        || typeof refs.batch_id !== 'string' || !refs.batch_id || refs.batch_id.length > 80
        || !Array.isArray(refs.product_ids) || refs.product_ids.length > 1000
        || !refs.product_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 80)
        || (item.product_id !== undefined && (typeof item.product_id !== 'string' || !item.product_id || item.product_id.length > 80))) return null
      checks.push({
        check_code: boundedString(item.check_code, 80),
        ...(item.product_id ? { product_id: boundedString(item.product_id, 80) } : {}),
        source_refs: {
          workflow_task_id: boundedString(refs.workflow_task_id, 80),
          batch_id: boundedString(refs.batch_id, 80),
          product_ids: refs.product_ids.map(id => boundedString(id, 80)),
        },
      })
    }
    return { schema_version: 'native-advice-context.v1', role, checks }
  }
  return null
}

function boundedPageInteger(value, fallback, maximum) {
  if (value === undefined) return fallback
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null
}

function intakeErrorCode(value) {
  return INTAKE_ERROR_CODES.has(value) ? value : 'unknown'
}

function projectIntakeSources(response, limit) {
  if (!response || response.ok !== true || !Array.isArray(response.sources)
    || !(response.next_offset === null || (Number.isInteger(response.next_offset) && response.next_offset >= 0 && response.next_offset <= 100050))) return null
  let truncated = response.next_offset !== null || response.sources.length > limit
  const sources = response.sources.slice(0, limit).flatMap(source => {
    if (!INTAKE_OPAQUE_ID.test(source?.id ?? '') || !INTAKE_SHA256.test(source?.sha256 ?? '')
      || !Number.isSafeInteger(source?.byte_size) || source.byte_size < 0 || source.byte_size > 20 * 1024 * 1024
      || typeof source?.received_at !== 'string' || source.received_at.length > 40 || !Number.isFinite(Date.parse(source.received_at))
      || !Array.isArray(source?.snapshots)) {
      truncated = true
      return []
    }
    const snapshots = source.snapshots.slice(0, INTAKE_MAX_NESTED).flatMap(snapshot => {
      if (!INTAKE_OPAQUE_ID.test(snapshot?.id ?? '') || !/^[a-zA-Z0-9._-]{1,40}$/.test(snapshot?.parser_version ?? '')) {
        truncated = true
        return []
      }
      return [{
        id: snapshot.id,
        parser_version: snapshot.parser_version,
        status: ['ready', 'failed'].includes(snapshot.status) ? snapshot.status : 'unknown',
        sheet_count: Number.isInteger(snapshot.sheet_count) && snapshot.sheet_count >= 0 ? snapshot.sheet_count : null,
        cell_count: Number.isInteger(snapshot.cell_count) && snapshot.cell_count >= 0 ? snapshot.cell_count : null,
        error_code: snapshot.error_code ? intakeErrorCode(snapshot.error_code) : '',
      }]
    })
    if (source.snapshots.length > INTAKE_MAX_NESTED) truncated = true
    return [{
      id: source.id,
      sha256: source.sha256,
      byte_size: source.byte_size,
      received_at: source.received_at,
      snapshots,
      snapshots_truncated: source.snapshots.length > INTAKE_MAX_NESTED,
    }]
  })
  return {
    sources,
    next_offset: Number.isInteger(response.next_offset) ? response.next_offset : null,
    truncated,
  }
}

function projectNarrativeAnnotation(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || !Number.isInteger(value.revision) || value.revision < 1
    || !['transcript_excerpt', 'secondary_summary_analysis', 'user_supplement', 'unknown'].includes(value.source_kind)
    || !(value.recording_date === null || (typeof value.recording_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.recording_date)))
    || !['unknown', 'not_checked', 'operator_claimed_checked'].includes(value.audio_review_status)
    || value.content_status !== 'unconfirmed') return undefined
  return { revision: value.revision, source_kind: value.source_kind, recording_date: value.recording_date,
    audio_review_status: value.audio_review_status, content_status: 'unconfirmed' }
}

function projectNarrativeSources(response, limit) {
  if (!response || !Array.isArray(response.narratives)
    || !(response.next_offset === null || (Number.isInteger(response.next_offset) && response.next_offset >= 0))) return null
  let truncated = response.next_offset !== null || response.narratives.length > limit
  const narratives = response.narratives.slice(0, limit).flatMap(source => {
    const annotation = projectNarrativeAnnotation(source?.current_annotation)
    if (!INTAKE_OPAQUE_ID.test(source?.id ?? '') || !INTAKE_SHA256.test(source?.sha256 ?? '')
      || !Number.isInteger(source?.line_count) || source.line_count < 0 || annotation === undefined) { truncated = true; return [] }
    return [{ id: source.id, sha256: source.sha256, line_count: source.line_count, current_annotation: annotation }]
  })
  return { narratives, next_offset: response.next_offset, truncated }
}

function projectNarrativeExcerpt(response, requestedSourceId, limit) {
  if (!response || !response.source || !INTAKE_OPAQUE_ID.test(response.source.id ?? '')
    || response.source.id !== requestedSourceId || response.lines?.length > limit
    || !INTAKE_SHA256.test(response.source.sha256 ?? '') || !Array.isArray(response.lines)
    || !(response.next_offset === null || (Number.isInteger(response.next_offset) && response.next_offset >= 0))) return null
  const annotation = projectNarrativeAnnotation(response.source.current_annotation)
  if (annotation === undefined) return null
  const lines = response.lines.flatMap(line => Number.isInteger(line?.line_number) && line.line_number > 0
    && typeof line.text === 'string' && line.text.length <= 2000 && typeof line.truncated === 'boolean'
    ? [{ line_number: line.line_number, text: line.text, truncated: line.truncated }] : [])
  if (lines.length !== response.lines.length) return null
  return { source: { id: response.source.id, sha256: response.source.sha256, current_annotation: annotation }, lines, next_offset: response.next_offset }
}

function projectIntakeScalar(value) {
  if (typeof value === 'string') return { value: value.slice(0, INTAKE_MAX_TEXT), truncated: value.length > INTAKE_MAX_TEXT }
  if (typeof value === 'number' && Number.isFinite(value)) return { value, truncated: false }
  if (typeof value === 'boolean' || value === null) return { value, truncated: false }
  return { value: null, truncated: value !== undefined && value !== null }
}

function intakeCandidateTypeAllowed(preset, candidateType) {
  if (preset === ROLE_PRESETS.center) return INTAKE_CANDIDATE_TYPES.includes(candidateType)
  if (preset === ROLE_PRESETS.product) return candidateType === 'product_identity'
  if (preset === ROLE_PRESETS.delivery) return candidateType === 'production_instruction'
  return false
}

function projectIntakeCandidate(response, requestedType) {
  const candidate = response?.ok === true ? response.candidate : null
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !INTAKE_OPAQUE_ID.test(candidate.id ?? '') || !INTAKE_SHA256.test(candidate.source_sha256 ?? '')
    || !INTAKE_CANDIDATE_TYPES.includes(candidate.candidate_type) || candidate.candidate_type !== requestedType
    || candidate.schema_version !== 1 || !candidate.fields || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)
    || !candidate.provenance || typeof candidate.provenance !== 'object' || Array.isArray(candidate.provenance)
    || !Array.isArray(response.links)) return null

  let truncated = false
  const allowedFields = INTAKE_FIELDS[candidate.candidate_type]
  if (Object.keys(candidate.fields).some(key => !Object.hasOwn(allowedFields, key))) truncated = true
  const sourceIds = new Set()
  const fields = {}
  for (const [name, type] of Object.entries(allowedFields)) {
    if (!Object.hasOwn(candidate.fields, name)) continue
    const rawValues = candidate.fields[name]
    if (!Array.isArray(rawValues)) { truncated = true; continue }
    const rawSources = Array.isArray(candidate.provenance[name]) ? candidate.provenance[name] : []
    if (!Array.isArray(candidate.provenance[name])) truncated = true
    if (rawSources.length !== rawValues.length) truncated = true
    const values = rawValues.slice(0, INTAKE_MAX_FIELD_VALUES).map(entry => {
      const scalar = projectIntakeScalar(entry?.value)
      if (scalar.truncated) truncated = true
      return {
        state: INTAKE_VALUE_STATES.has(entry?.state) ? entry.state : 'unknown',
        type,
        value: scalar.value,
        value_truncated: scalar.truncated,
      }
    })
    const sources = rawSources.slice(0, INTAKE_MAX_FIELD_VALUES).flatMap((source, valueIndex) => {
      if (!INTAKE_OPAQUE_ID.test(source?.source_id ?? '') || !INTAKE_SHA256.test(source?.source_sha256 ?? '')
        || !INTAKE_OPAQUE_ID.test(source?.snapshot_id ?? '') || !Number.isInteger(source?.sheet_index)
        || source.sheet_index < 1 || source.sheet_index > 20 || !INTAKE_COORDINATE.test(source?.coordinate ?? '')) {
        truncated = true
        return []
      }
      sourceIds.add(source.source_id)
      return [{
        source_id: source.source_id,
        source_sha256: source.source_sha256,
        snapshot_id: source.snapshot_id,
        sheet_index: source.sheet_index,
        coordinate: source.coordinate,
        value_index: valueIndex,
        formula_status: ['not_formula', 'unsupported'].includes(source.formula_status) ? source.formula_status : 'unknown',
        error_code: source.error_code ? intakeErrorCode(source.error_code) : '',
      }]
    })
    if (rawValues.length > INTAKE_MAX_FIELD_VALUES || rawSources.length > INTAKE_MAX_FIELD_VALUES) truncated = true
    fields[name] = { values, sources, values_truncated: rawValues.length > INTAKE_MAX_FIELD_VALUES, sources_truncated: rawSources.length > INTAKE_MAX_FIELD_VALUES }
  }

  const links = response.links.slice(0, INTAKE_MAX_NESTED).flatMap(link => {
    const other = link?.left_candidate_id === candidate.id ? link?.right_candidate_id
      : link?.right_candidate_id === candidate.id ? link?.left_candidate_id : null
    if (!INTAKE_OPAQUE_ID.test(other ?? '') || !['suggested', 'confirmed', 'rejected'].includes(link?.decision)) {
      truncated = true
      return []
    }
    const reason = typeof link?.evidence?.reason === 'string' ? link.evidence.reason : ''
    if (reason.length > 500) truncated = true
    const projected = { candidate_id: other, decision: link.decision,
      judgment_source: 'association_decision', reason: reason.slice(0, 500) }
    if (INTAKE_OPAQUE_ID.test(link?.id ?? '')) projected.link_id = link.id
    if (typeof link?.actor === 'string' && link.actor.length > 0) {
      if (link.actor.length > 32) truncated = true
      projected.actor = link.actor.slice(0, 32)
    }
    if (typeof link?.created_at === 'string' && link.created_at.length > 0) {
      if (link.created_at.length > 64) truncated = true
      projected.created_at = link.created_at.slice(0, 64)
    }
    return [projected]
  })
  if (response.links.length > INTAKE_MAX_NESTED) truncated = true
  if (response.links_next_offset !== undefined && response.links_next_offset !== null) truncated = true

  let semantics = {}
  if (candidate.candidate_type === 'product_identity') semantics = { product_identity: 'candidate_only' }
  if (candidate.candidate_type === 'commercial_source') semantics = { commercial_role: 'unknown', price_nature: 'unknown' }
  if (candidate.candidate_type === 'production_instruction') semantics = { historical_or_reference: 'unconfirmed' }
  if (candidate.candidate_type === 'labor_analysis') semantics = { labor_basis: 'unconfirmed' }
  if (sourceIds.size === 0) return null
  return {
    candidate_id: candidate.id,
    source_ids: [...sourceIds].slice(0, INTAKE_MAX_NESTED),
    source_sha256: candidate.source_sha256,
    candidate_type: candidate.candidate_type,
    schema_version: candidate.schema_version,
    status: candidate.status === 'unconfirmed' ? 'unconfirmed' : 'unknown',
    semantics,
    fields,
    links,
    truncated: truncated || sourceIds.size > INTAKE_MAX_NESTED,
  }
}

function projectIntakeCandidateDirectory(response, requestedType, preset, limit) {
  if (response?.ok !== true || !Array.isArray(response.candidates)) return null
  let truncated = response.candidates.length > limit
  const candidates = []
  for (const raw of response.candidates.slice(0, limit)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !INTAKE_CANDIDATE_TYPES.includes(raw.candidate_type)
      || (requestedType && raw.candidate_type !== requestedType)
      || !intakeCandidateTypeAllowed(preset, raw.candidate_type)) {
      truncated = true
      continue
    }
    const projected = projectIntakeCandidate({ ok: true, candidate: raw, links: [] }, raw.candidate_type)
    if (!projected) {
      truncated = true
      continue
    }
    candidates.push({
      candidate_id: projected.candidate_id,
      candidate_type: projected.candidate_type,
      source_sha256: projected.source_sha256,
      source_ids: projected.source_ids,
      status: projected.status,
    })
    if (projected.truncated) truncated = true
  }
  const nextOffset = response.next_offset
  if (nextOffset !== null && (!Number.isInteger(nextOffset) || nextOffset < 0 || nextOffset > 100000)) truncated = true
  return {
    candidates,
    next_offset: Number.isInteger(nextOffset) && nextOffset >= 0 && nextOffset <= 100000 ? nextOffset : null,
    truncated,
  }
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

const EXECUTION_PLAN_FIELDS = new Set(Object.keys(INTAKE_FIELDS.production_instruction))

function projectExecutionPlan(response, requestedId) {
  const plan = response?.plan
  const requirement = response?.requirement_revision
  if (!plan || !requirement || plan.id !== requestedId || !INTAKE_OPAQUE_ID.test(plan.id)
    || !INTAKE_OPAQUE_ID.test(requirement.id ?? '') || plan.requirement_revision_id !== requirement.id
    || !Number.isInteger(plan.revision) || plan.revision < 1
    || !['draft'].includes(plan.status) || !['confirmed'].includes(requirement.status)
    || !requirement.fields || typeof requirement.fields !== 'object' || Array.isArray(requirement.fields)
    || !Array.isArray(plan.requirement_refs) || !Array.isArray(plan.materials) || !Array.isArray(plan.operations)) return null
  const sourceRefs = {}
  let truncated = false
  const safeText = (value, max) => {
    const text = boundedString(value, max)
    if (typeof value === 'string' && text !== value) truncated = true
    return text
  }
  for (const field of EXECUTION_PLAN_FIELDS) {
    const refs = requirement.source_refs?.[field]
    if (refs === undefined) continue
    if (!Array.isArray(refs)) { truncated = true; continue }
    sourceRefs[field] = refs.slice(0, 20).flatMap(ref => {
      if (!INTAKE_OPAQUE_ID.test(ref?.id ?? '') || ref.field_key !== field) { truncated = true; return [] }
      return [{
        id: ref.id, field_key: field,
        kind: ['source_record', 'operator_statement', 'team_hypothesis', 'system_derivation'].includes(ref.kind) ? ref.kind : 'unknown',
        status: ['unverified', 'verified', 'rejected'].includes(ref.status) ? ref.status : 'unknown',
        summary: safeText(ref.summary, 160), snapshot_id: INTAKE_OPAQUE_ID.test(ref.snapshot_id ?? '') ? ref.snapshot_id : null,
        sheet_index: Number.isInteger(ref.sheet_index) && ref.sheet_index > 0 ? ref.sheet_index : null,
        coordinate: INTAKE_COORDINATE.test(ref.coordinate ?? '') ? ref.coordinate : null,
        narrative_source_id: INTAKE_OPAQUE_ID.test(ref.narrative_source_id ?? '') ? ref.narrative_source_id : null,
        line_start: Number.isInteger(ref.line_start) && ref.line_start > 0 ? ref.line_start : null,
        line_end: Number.isInteger(ref.line_end) && ref.line_end > 0 ? ref.line_end : null,
      }]
    })
    if (refs.length > 20) truncated = true
  }
  const fields = Object.fromEntries([...EXECUTION_PLAN_FIELDS].flatMap(field => {
    const value = requirement.fields[field]
    if (typeof value === 'string') return [[field, safeText(value, 500)]]
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return [[field, value]]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [[field, { doctype: ['Customer', 'Item'].includes(value.doctype) ? value.doctype : '', name: safeText(value.name, 120) }]]
    }
    return []
  }))
  const evidenceRefs = (rows, max) => {
    if (!Array.isArray(rows)) { truncated = true; return [] }
    if (rows.length > max) truncated = true
    return rows.slice(0, max).flatMap(row => {
    if (!row || !EXECUTION_PLAN_FIELDS.has(row.field_key) || !Array.isArray(row.evidence_ids)) { truncated = true; return [] }
    if (row.evidence_ids.length > 20) truncated = true
    const validIds = row.evidence_ids.slice(0, 20).filter(id => {
      const valid = INTAKE_OPAQUE_ID.test(id)
      if (!valid) truncated = true
      return valid
    })
    return [{ field_key: row.field_key, evidence_ids: validIds }]
    })
  }
  const SOURCE_TYPES = new Set(['commercial_source', 'labor_analysis'])
  const SOURCE_FIELDS = new Set(['document_reference', 'party_text', 'item_description', 'quantity', 'unit', 'unit_price',
    'amount', 'currency', 'notes', 'process', 'observed_seconds', 'observed_quantity', 'observed_unit',
    'estimated_hourly_rate', 'estimated_efficiency', 'estimated_capacity', 'estimated_piece_rate'])
  const SOURCE_STATES = new Set(['present', 'empty', 'type_mismatch', 'formula_error', 'formula_cache_missing', 'formula_cache_empty'])
  const supportingSources = rows => {
    if (!Array.isArray(rows)) { truncated = true; return [] }
    if (rows.length > 20) truncated = true
    return rows.slice(0, 20).flatMap(source => {
      if (!source || !INTAKE_OPAQUE_ID.test(source.candidate_id ?? '') || !SOURCE_TYPES.has(source.candidate_type)
        || !INTAKE_OPAQUE_ID.test(source.evidence_id ?? '') || !SOURCE_FIELDS.has(source.field_key)) {
        truncated = true
        return []
      }
      const typed = source.typed_value && typeof source.typed_value === 'object' && !Array.isArray(source.typed_value)
        ? source.typed_value : {}
      const state = SOURCE_STATES.has(typed.state) ? typed.state : 'unknown'
      if (state === 'unknown' || typed.state !== state) truncated = true
      const typedValue = { state }
      if (['text', 'decimal', 'date'].includes(typed.type)) typedValue.type = typed.type
      else if (typed.type !== undefined) truncated = true
      if (typed.value === null || typeof typed.value === 'boolean' || (typeof typed.value === 'number' && Number.isFinite(typed.value))) {
        typedValue.value = typed.value
      } else if (typeof typed.value === 'string') {
        typedValue.value = safeText(typed.value, 2_000)
      } else if (typed.value !== undefined) truncated = true
      if (typed.truncated === true) { typedValue.truncated = true; truncated = true }
      const refs = Array.isArray(source.value_refs) ? source.value_refs : []
      if (!Array.isArray(source.value_refs)) truncated = true
      if (refs.length > 20) truncated = true
      const valueRefs = refs.slice(0, 20).flatMap(ref => {
        if (!ref || !INTAKE_OPAQUE_ID.test(ref.cell_id ?? '') || !INTAKE_OPAQUE_ID.test(ref.snapshot_id ?? '')
          || !Number.isInteger(ref.sheet_index) || ref.sheet_index < 1 || !INTAKE_COORDINATE.test(ref.coordinate ?? '')) {
          truncated = true
          return []
        }
        return [{ cell_id: ref.cell_id, snapshot_id: ref.snapshot_id, sheet_index: ref.sheet_index, coordinate: ref.coordinate }]
      })
      const boundedName = safeText(source.source_display_name, 200)
      const projected = {
        candidate_id: source.candidate_id, candidate_type: source.candidate_type,
        source_display_name: boundedName,
        source_display_name_truncated: source.source_display_name_truncated === true || boundedName !== source.source_display_name,
        source_id: INTAKE_OPAQUE_ID.test(source.source_id ?? '') ? source.source_id : null,
        source_sha256: /^[a-f0-9]{64}$/.test(source.source_sha256 ?? '') ? source.source_sha256 : null,
        mapping_id: INTAKE_OPAQUE_ID.test(source.mapping_id ?? '') ? source.mapping_id : null,
        mapping_revision: Number.isInteger(source.mapping_revision) && source.mapping_revision > 0 ? source.mapping_revision : null,
        snapshot_id: INTAKE_OPAQUE_ID.test(source.snapshot_id ?? '') ? source.snapshot_id : null,
        field_key: source.field_key, evidence_id: source.evidence_id,
        evidence_status: source.evidence_status === 'unverified' ? 'unverified' : 'unknown',
        sheet_index: Number.isInteger(source.sheet_index) && source.sheet_index > 0 ? source.sheet_index : null,
        coordinate: INTAKE_COORDINATE.test(source.coordinate ?? '') ? source.coordinate : null,
        typed_value: typedValue, value_refs: valueRefs,
      }
      if (projected.source_id === null || projected.source_sha256 === null || projected.mapping_id === null
        || projected.mapping_revision === null || projected.snapshot_id === null || projected.evidence_status === 'unknown'
        || projected.sheet_index === null || projected.coordinate === null) truncated = true
      return [projected]
    })
  }
  const materials = plan.materials.slice(0, 200).flatMap(item => item?.resolution === 'unresolved' && item?.item_ref === null
    ? [{ resolution: 'unresolved', item_ref: null, proposal: projectMaterialProposal(item.proposal, safeText), supporting_requirement_inputs: evidenceRefs(item.supporting_requirement_inputs || [], 20), supporting_sources: supportingSources(item.supporting_sources || []) }]
    : (truncated = true, []))
  const operations = plan.operations.slice(0, 100).flatMap(item => item?.resolution === 'unresolved' && item?.operation_ref === null
    ? [{ resolution: 'unresolved', operation_ref: null, proposal: projectOperationProposal(item.proposal, safeText), supporting_requirement_inputs: evidenceRefs(item.supporting_requirement_inputs || [], 20), supporting_sources: supportingSources(item.supporting_sources || []) }]
    : (truncated = true, []))
  if (plan.materials.length > 200 || plan.operations.length > 100) truncated = true
  return {
    plan: {
      id: plan.id, requirement_revision_id: requirement.id, revision: plan.revision,
      status: 'draft', requirement_refs: evidenceRefs(plan.requirement_refs, 100), materials, operations,
      latest_revision: Number.isInteger(response.latest_revision) ? response.latest_revision : null,
      is_latest: response.is_latest === true,
      actual: { status: 'missing' },
    },
    requirement: {
      id: requirement.id, revision: requirement.revision, status: 'confirmed', fields, source_refs: sourceRefs,
    },
    truncated,
  }
}

function projectMaterialProposal(proposal, safeText = boundedString) {
  if (!proposal || typeof proposal !== 'object') return { description: null, quantity: null, unit: null, expected_date: null }
  return {
    description: typeof proposal.description === 'string' ? safeText(proposal.description, 500) : null,
    quantity: typeof proposal.quantity === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(proposal.quantity) ? proposal.quantity : null,
    unit: typeof proposal.unit === 'string' ? safeText(proposal.unit, 80) : null,
    expected_date: typeof proposal.expected_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(proposal.expected_date) ? proposal.expected_date : null,
  }
}

function projectOperationProposal(proposal, safeText = boundedString) {
  if (!proposal || typeof proposal !== 'object') return { description: null, sequence: null }
  return {
    description: typeof proposal.description === 'string' ? safeText(proposal.description, 500) : null,
    sequence: Number.isInteger(proposal.sequence) && proposal.sequence > 0 ? proposal.sequence : null,
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

function projectWorkflow(workflow, viewerPreset) {
  const rolePreset = { product_profile: ROLE_PRESETS.product, delivery_quality: ROLE_PRESETS.delivery }
  const projectSubtask = subtask => {
    const role = boundedString(subtask.agent_role, 120)
    const projected = {
      id: boundedString(subtask.id, 80), agent_role: role, status: boundedString(subtask.status, 80),
      retry_count: subtask.retry_count ?? 0, depends_on: Array.isArray(subtask.depends_on) ? subtask.depends_on.map(item => boundedString(item, 80)).slice(0, 100) : [],
      error_summary: boundedString(subtask.error_summary, 500),
    }
    if (viewerPreset === ROLE_PRESETS.center || rolePreset[role] === viewerPreset) {
      const input = subtask.input_refs && typeof subtask.input_refs === 'object' && !Array.isArray(subtask.input_refs)
        ? subtask.input_refs : {}
      const fields = role === 'product_profile'
        ? ['workflow_task_id', 'batch_id', 'scope', 'product_ids', 'product_revision_ids']
        : ['workflow_task_id', 'batch_id', 'scope', 'all_product_ids', 'all_revision_ids', 'confirmed_revision_ids', 'unconfirmed_product_ids']
      const refs = {}
      for (const field of fields) {
        const value = input[field]
        if (typeof value === 'string' && value.length <= 80) refs[field] = value
        else if (Array.isArray(value) && value.length <= 500 && value.every(item => typeof item === 'string' && item.length <= 80)) refs[field] = value.slice()
        else if (field === 'scope' && value === 'full_batch') refs[field] = value
      }
      if (Object.keys(refs).length) projected.source_refs = refs
    }
    return projected
  }
  return {
    id: boundedString(workflow.id, 80),
    batch_id: boundedString(workflow.batch_id, 80),
    user_goal: boundedString(workflow.user_goal),
    task_type: boundedString(workflow.task_type, 120),
    status: boundedString(workflow.status, 100),
    current_step: boundedString(workflow.current_step, 160),
    execution_mode: workflow.execution_mode === 'native_dsh' ? 'native_dsh' : 'local_mock',
    mode: boundedString(workflow.mode, 80),
    execution: boundedString(workflow.execution, 80),
    error_summary: boundedString(workflow.error_summary, 500),
    steps: Array.isArray(workflow.steps) ? workflow.steps.slice(0, 100).map(step => ({
      id: boundedString(step.id, 80), step_key: boundedString(step.step_key, 160), status: boundedString(step.status, 80),
      attempt: step.attempt ?? 0, error_summary: boundedString(step.error_summary, 500),
    })) : [],
    subtasks: Array.isArray(workflow.subtasks) ? workflow.subtasks.slice(0, 100).map(projectSubtask) : [],
    reviews: Array.isArray(workflow.reviews) ? workflow.reviews.slice(0, 100).map(review => ({
      id: boundedString(review.id, 80), review_key: boundedString(review.review_key, 160), item_ref: boundedString(review.item_ref, 240),
      question: boundedString(review.question, 1000), options: Array.isArray(review.options) ? review.options.map(item => boundedString(item, 500)).slice(0, 30) : [],
      status: boundedString(review.status, 80), answer: boundedString(review.answer, 1000), reviewer: boundedString(review.reviewer, 160),
    })) : [],
    reviews_scope: boundedString(workflow.reviews_scope, 40) || 'business_facts',
    pending_review_count: Number.isFinite(workflow.pending_review_count) ? workflow.pending_review_count : 0,
    unresolved_review_count: Number.isFinite(workflow.unresolved_review_count) ? workflow.unresolved_review_count : 0,
    ...(viewerPreset === ROLE_PRESETS.center && workflow.dispatch_target && typeof workflow.dispatch_target === 'object' ? { dispatch_target: {
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

const QUOTATION_FIELDS = Object.freeze([
  'name', 'modified', 'docstatus', 'quotation_to', 'company', 'party_name',
  'transaction_date', 'valid_till', 'currency', 'total_qty', 'total', 'grand_total', 'items',
])
const QUOTATION_ITEM_FIELDS = Object.freeze(['item_code', 'item_name', 'qty', 'uom', 'rate', 'amount', 'description'])
const DRAFT_STATUSES = new Set(['reserved', 'outcome_unknown', 'succeeded', 'conflict'])
const SAFE_DRAFT_ERRORS = new Set([
  'not_configured', 'invalid_configuration', 'unavailable', 'rate_limited', 'unauthorized',
  'forbidden', 'http_error', 'invalid_response', 'not_found', 'conflict', 'invalid_arguments',
  'idempotency_conflict', 'operation_outcome_unknown',
])

function projectQuotationRecord(value) {
  if (!value || typeof value !== 'object' || value.doctype !== 'Quotation'
    || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return null
  const data = Object.fromEntries(QUOTATION_FIELDS.filter(key => Object.hasOwn(value.data, key)).map(key => [key, value.data[key]]))
  const ref = value.external_ref
  if (typeof data.name !== 'string' || !data.name || typeof data.modified !== 'string' || !data.modified
    || !Number.isInteger(data.docstatus) || data.docstatus < 0 || data.docstatus > 2
    || !ref || ref.system !== 'erpnext' || ref.doctype !== 'Quotation' || ref.name !== data.name
    || typeof ref.instance_id !== 'string' || !ref.instance_id
    || !(ref.modified === null || typeof ref.modified === 'string')) return null
  if (data.items !== undefined) {
    if (!Array.isArray(data.items) || data.items.length > 100) return null
    data.items = data.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      return Object.fromEntries(QUOTATION_ITEM_FIELDS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))
    })
    if (data.items.some(item => !item)) return null
  }
  return {
    doctype: 'Quotation', data,
    truncated_children: Array.isArray(value.truncated_children) ? value.truncated_children.filter(key => key === 'items') : [],
    external_ref: {
      system: 'erpnext', instance_id: boundedString(ref.instance_id, 128), doctype: 'Quotation',
      name: boundedString(ref.name, 256), modified: ref.modified === null ? null : boundedString(ref.modified, 80),
    },
  }
}

function projectDraftOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[0-9a-f]{32}$/.test(value.operation_id ?? '')
    || !['create', 'update'].includes(value.action) || value.doctype !== 'Quotation'
    || !DRAFT_STATUSES.has(value.status) || !['local_workbench', 'dsh_center'].includes(value.source)
    || (value.remote_modified !== null && value.remote_modified !== '' && typeof value.remote_modified !== 'string')
    || !/^[0-9a-f]{64}$/.test(value.payload_sha256 ?? '')) return null
  const receipt = value.receipt === null ? null : projectQuotationRecord(value.receipt)
  const remoteCurrent = value.remote_current === null ? null : projectQuotationRecord(value.remote_current)
  if ((value.receipt !== null && !receipt) || (value.remote_current !== null && !remoteCurrent)) return null
  if (value.target_operation_id !== null && value.target_operation_id !== ''
    && !/^[0-9a-f]{32}$/.test(value.target_operation_id)) return null
  if ((value.action === 'create' && value.target_operation_id)
    || (value.action === 'update' && !value.target_operation_id)) return null
  if (value.remote_name !== null && value.remote_name !== '' && typeof value.remote_name !== 'string') return null
  if (value.status === 'succeeded' && (!receipt || receipt.external_ref.name !== value.remote_name
    || receipt.external_ref.modified !== value.remote_modified)) return null
  const errorCode = typeof value.error_code === 'string' && SAFE_DRAFT_ERRORS.has(value.error_code) ? value.error_code : ''
  const remoteErrorCode = typeof value.remote_error_code === 'string' && SAFE_DRAFT_ERRORS.has(value.remote_error_code) ? value.remote_error_code : ''
  return {
    operation_id: value.operation_id,
    action: value.action,
    doctype: 'Quotation',
    status: value.status,
    source: value.source === 'dsh_center' ? 'dsh_center' : 'local_workbench',
    workflow_id: typeof value.workflow_id === 'string' ? boundedString(value.workflow_id, 80) : null,
    target_operation_id: typeof value.target_operation_id === 'string' && value.target_operation_id ? value.target_operation_id : null,
    remote_name: typeof value.remote_name === 'string' && value.remote_name ? boundedString(value.remote_name, 255) : null,
    remote_modified: typeof value.remote_modified === 'string' && value.remote_modified ? boundedString(value.remote_modified, 64) : null,
    payload_sha256: value.payload_sha256,
    error_code: errorCode,
    receipt,
    remote_current: remoteCurrent,
    remote_error_code: remoteErrorCode,
  }
}

function draftToolResult(value) {
  if (value?.ok === false && !value.operation_id) {
    const code = typeof value.error_code === 'string' && /^[a-z0-9_]{1,64}$/.test(value.error_code) ? value.error_code : 'draft_request_failed'
    return failure(code)
  }
  const data = projectDraftOperation(value)
  if (!data) return failure('invalid_quotation_draft_dto')
  const succeeded = data.status === 'succeeded'
  return {
    ok: succeeded,
    data: JSON.stringify(data),
    requires_human_confirmation: false,
    business_ui_url: '',
    error_code: succeeded ? '' : data.status === 'outcome_unknown' || data.status === 'reserved'
      ? 'operation_outcome_unknown' : data.status === 'conflict' ? 'operation_conflict' : 'operation_not_succeeded',
  }
}

function validQuotationPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = ['company', 'party_name', 'transaction_date', 'valid_till', 'currency', 'items']
  const required = ['company', 'party_name', 'transaction_date', 'currency', 'items']
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) return false
  for (const key of ['company', 'party_name', 'transaction_date', 'currency']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > QUOTATION_TEXT_LIMITS[key]) return false
  }
  if (value.valid_till !== undefined && (typeof value.valid_till !== 'string' || !value.valid_till
    || value.valid_till.length > QUOTATION_TEXT_LIMITS.valid_till)) return false
  return Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 100
    && value.items.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 4
      && ['item_code', 'qty', 'rate', 'uom'].every(key => typeof item[key] === 'string' && item[key]
        && item[key].length <= QUOTATION_TEXT_LIMITS[key]))
}

const QUOTATION_TEXT_LIMITS = Object.freeze({
  company: 140, party_name: 140, transaction_date: 10, valid_till: 10, currency: 3,
  item_code: 140, qty: 32, rate: 32, uom: 140,
})
const quotationText = (description, maxLength) => ({
  type: 'string', description: `${description} 最多${maxLength}个字符。`,
})
const quotationItemSchema = {
  type: 'object', additionalProperties: false, required: ['item_code', 'qty', 'rate', 'uom'],
  properties: {
    item_code: quotationText('ERPNext 商品编码。', 140),
    qty: quotationText('正数量，十进制文本。', 32),
    rate: quotationText('单价，十进制文本。', 32),
    uom: quotationText('ERPNext 单位。', 140),
  },
}
const quotationPayloadSchema = {
  type: 'object', additionalProperties: false,
  required: ['company', 'party_name', 'transaction_date', 'currency', 'items'],
  properties: {
    company: quotationText('ERPNext 公司名称。', 140),
    party_name: quotationText('ERPNext Customer 名称。', 140),
    transaction_date: quotationText('交易日期，YYYY-MM-DD。', 10),
    valid_till: quotationText('可选有效日期，YYYY-MM-DD。', 10),
    currency: quotationText('三位币种代码。', 3),
    items: { type: 'array', items: quotationItemSchema },
  },
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
        return success(projectWorkflow(result, exec.agent.session.header.agentPreset))
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
      name: 'tradeloom_begin_native_workflow_assignment',
      description: 'Persist the next native expert assignment and return a bounded server-derived advice context before the center starts a direct DSH subagent. Pass that context unchanged to the bound child; this does not start or claim that child has completed.',
      parameters: schema({
        workflow_id: wireString('Existing confirmed native workflow ID.'),
        subtask_id: wireString('Existing server-selected subtask ID.'),
      }),
      async execute(args, exec) {
        if (!exactArgs(args, ['workflow_id', 'subtask_id'], ['workflow_id', 'subtask_id'])) return failure('invalid_arguments')
        if (args.workflow_id.length > 80 || args.subtask_id.length > 80) return failure('invalid_arguments')
        const identity = observedAgentIdentity(exec)
        if (!identity) return failure('host_identity_unavailable')
        if (identity.agent_preset !== ROLE_PRESETS.center || identity.parent_session !== null || identity.delegation_depth !== 0) {
          return failure('root_center_required')
        }
        const workflowId = encodeURIComponent(args.workflow_id)
        const subtaskId = encodeURIComponent(args.subtask_id)
        const current = await djangoRequest(ctx, 'tradeloom_begin_native_workflow_assignment', exec,
          `/api/workflow-tasks/${workflowId}`, 'GET', undefined, dependencies)
        if (current?.ok === false) return failure(current.error_code)
        const subtask = Array.isArray(current.subtasks)
          ? current.subtasks.find(item => item?.id === args.subtask_id)
          : null
        const expertPreset = subtask?.agent_role === 'product_profile'
          ? ROLE_PRESETS.product
          : subtask?.agent_role === 'delivery_quality'
            ? ROLE_PRESETS.delivery
            : ''
        if (!expertPreset) return failure('unsupported_native_role')
        const existingStep = Array.isArray(current.steps)
          ? current.steps
            .filter(step => step?.step_key === `subtask:${args.subtask_id}`
              && step?.input_refs?.subtask_id === args.subtask_id
              && step?.input_refs?.execution_mode === 'native_dsh'
              && step?.input_refs?.native_assignment?.assignment_id === step?.id)
            .sort((left, right) => (right.attempt ?? -1) - (left.attempt ?? -1))[0]
          : null
        const target = current?.dispatch_target
        const hasNewAuthorizedAttempt = existingStep?.status === 'completed'
          && target?.subtask_id === args.subtask_id
          && typeof target.idempotency_key === 'string'
          && target.idempotency_key.length > 0
          && target.idempotency_key !== existingStep.idempotency_key
        if (existingStep) {
          const assignment = existingStep.input_refs.native_assignment
          const center = assignment.center
          if (assignment.expected_expert_preset !== expertPreset
            || center?.agent_preset !== ROLE_PRESETS.center
            || center?.agent_id !== identity.agent_id
            || center?.parent_session !== null
            || center?.delegation_depth !== 0) return failure('native_assignment_conflict')
        }
        if (existingStep && ['running', 'completed'].includes(existingStep.status) && !hasNewAuthorizedAttempt) {
          const assignment = existingStep.input_refs.native_assignment
          const savedReceipt = existingStep.output_refs?.native_submission?.receipt
          const completed = existingStep.status === 'completed'
          return success({
            assignment_id: boundedString(assignment.assignment_id, 80),
            step_id: boundedString(existingStep.id, 80),
            workflow_id: boundedString(current.id, 80),
            subtask_id: args.subtask_id,
            batch_id: boundedString(current.batch_id, 80),
            agent_role: boundedString(subtask.agent_role, 80),
            attempt: Number.isInteger(existingStep.attempt) ? existingStep.attempt : 0,
            status: completed ? 'accepted' : 'existing_unconfirmed',
            result_status: completed ? boundedString(savedReceipt?.result_status, 80) : '',
            advice_context: boundedNativeAdviceContext(subtask.agent_role, assignment.advice_context),
            provider: 'unknown',
            model: 'unknown',
            child_lifecycle: 'not_observed',
            already_persisted: true,
            spawn_allowed: false,
            notice: completed
              ? '该assignment已有已接受的结果；不会再次启动子代理。'
              : '该assignment已持久化，但无法确认子代理是否已启动或完成；不会自动重试。',
          }, { requires_human_confirmation: false, business_ui_url: `/business/workflow-tasks/${workflowId}` })
        }
        if (!target || target.subtask_id !== args.subtask_id || typeof target.idempotency_key !== 'string' || !target.idempotency_key) {
          return success({ status: 'blocked', reason: boundedString(target?.blocked_reason || '该子任务不是服务端授权的下一步。', 300) })
        }
        const result = await djangoRequest(ctx, 'tradeloom_begin_native_workflow_assignment', exec,
          `/api/workflow-tasks/${workflowId}/subtasks/${subtaskId}/native-assignment`, 'POST', {
            idempotency_key: target.idempotency_key,
            expected_expert_preset: expertPreset,
            center_identity: identity,
          }, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || result.workflow_id !== args.workflow_id
          || result.subtask_id !== args.subtask_id
          || typeof result.assignment_id !== 'string'
          || typeof result.step_id !== 'string'
          || result.status !== 'awaiting_expert') return failure('invalid_native_assignment_dto')
        const adviceContext = boundedNativeAdviceContext(subtask.agent_role, result.advice_context)
        if (!adviceContext) return failure('invalid_native_advice_context')
        return success({
          assignment_id: boundedString(result.assignment_id, 80),
          step_id: boundedString(result.step_id, 80),
          workflow_id: boundedString(result.workflow_id, 80),
          subtask_id: boundedString(result.subtask_id, 80),
          batch_id: boundedString(result.batch_id, 80),
          agent_role: boundedString(result.agent_role, 80),
          attempt: Number.isInteger(result.attempt) ? result.attempt : 0,
          status: 'awaiting_expert',
          advice_context: adviceContext,
          provider: 'unknown',
          model: 'unknown',
          already_persisted: false,
          spawn_allowed: true,
          notice: 'assignment已持久化；尚不能证明DSH子代理已完成。',
        }, { requires_human_confirmation: false, business_ui_url: `/business/workflow-tasks/${workflowId}` })
      },
    },
    {
      name: 'tradeloom_bind_native_workflow_expert',
      description: 'After a successful native subagent activation, bind its Host-observed direct-child identity to the saved assignment before asking it to submit. This does not report child completion.',
      parameters: schema({
        workflow_id: wireString('Existing workflow ID from the saved assignment.'),
        assignment_id: wireString('Persisted native assignment ID.'),
        child_agent_id: wireString('The child ID returned by the native subagent activation tool.'),
      }),
      async execute(args, exec) {
        if (!exactArgs(args, ['workflow_id', 'assignment_id', 'child_agent_id'], ['workflow_id', 'assignment_id', 'child_agent_id'])
          || [args.workflow_id, args.assignment_id, args.child_agent_id].some(value => value.length > 80)) return failure('invalid_arguments')
        const centerIdentity = observedAgentIdentity(exec)
        if (!centerIdentity) return failure('host_identity_unavailable')
        if (centerIdentity.agent_preset !== ROLE_PRESETS.center
          || centerIdentity.parent_session !== null
          || centerIdentity.delegation_depth !== 0) return failure('root_center_required')
        const workflowId = encodeURIComponent(args.workflow_id)
        const current = await djangoRequest(ctx, 'tradeloom_bind_native_workflow_expert', exec,
          `/api/workflow-tasks/${workflowId}`, 'GET', undefined, dependencies)
        if (current?.ok === false) return failure(current.error_code)
        const step = Array.isArray(current?.steps)
          ? current.steps.find(item => item?.id === args.assignment_id
            && item?.input_refs?.execution_mode === 'native_dsh'
            && item?.input_refs?.native_assignment?.assignment_id === args.assignment_id)
          : null
        const assignment = step?.input_refs?.native_assignment
        if (!assignment || assignment.center?.agent_id !== centerIdentity.agent_id
          || assignment.center?.agent_preset !== ROLE_PRESETS.center
          || assignment.center?.parent_session !== null
          || assignment.center?.delegation_depth !== 0) return failure('native_assignment_conflict')
        const expectedPreset = assignment.expected_expert_preset
        if (![ROLE_PRESETS.product, ROLE_PRESETS.delivery].includes(expectedPreset)) return failure('unsupported_native_role')
        let child
        try { child = await ctx?.agents?.get?.(args.child_agent_id) } catch { return failure('host_child_unavailable') }
        const childExec = { agent: child }
        const childIdentity = observedAgentIdentity(childExec)
        if (!childIdentity || childIdentity.agent_id !== args.child_agent_id
          || childIdentity.agent_preset !== expectedPreset
          || childIdentity.parent_session !== centerIdentity.agent_id
          || childIdentity.delegation_depth !== 1) return failure('direct_expert_child_required')
        const result = await djangoRequest(ctx, 'tradeloom_bind_native_workflow_expert', exec,
          `/api/workflow-tasks/${workflowId}/native-assignments/${encodeURIComponent(args.assignment_id)}/bind`, 'POST', {
            assignment_id: args.assignment_id,
            step_id: args.assignment_id,
            center_identity: centerIdentity,
            child_identity: childIdentity,
          }, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || result.status !== 'bound' || result.assignment_id !== args.assignment_id
          || result.step_id !== args.assignment_id || result.child_agent_id !== args.child_agent_id) return failure('invalid_native_binding_receipt')
        return success({
          assignment_id: args.assignment_id,
          child_agent_id: args.child_agent_id,
          status: 'bound',
          child_lifecycle: 'not_observed',
          notice: '已绑定Host观察到的直接专家。现在可通知该专家提交typed建议；绑定不表示专家已完成。',
        }, { requires_human_confirmation: false, business_ui_url: `/business/workflow-tasks/${workflowId}` })
      },
    },
    {
      name: 'tradeloom_submit_native_workflow_advice',
      description: 'Submit bounded expert observations for a saved native assignment. Django rechecks current sources and computes the canonical role result; advice is never a business fact or approval.',
      parameters: schema({
        workflow_id: wireString('Existing workflow ID from the saved assignment.'),
        assignment_id: wireString('Persisted native assignment ID.'),
        step_id: wireString('Persisted WorkflowStep ID from the assignment.'),
        advice: {
          type: 'object', additionalProperties: false, required: ['schema_version', 'observations'],
          properties: {
            schema_version: { type: 'string', const: 'native-expert-advice.v1' },
            observations: {
              type: 'array',
              items: preset === ROLE_PRESETS.product
                ? {
                  type: 'object', additionalProperties: false, required: ['product_id', 'field', 'source_refs', 'note'],
                  properties: {
                    product_id: wireString('Product ID from this workflow.'),
                    field: { type: 'string', enum: ['sku', 'name', 'category', 'material', 'size', 'color', 'english_name'] },
                    source_refs: {
                      type: 'object', additionalProperties: false, required: ['product_id', 'revision_id', 'task_file_ids'],
                      properties: {
                        product_id: wireString('Must match the reviewed product ID.'),
                        revision_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                        task_file_ids: { type: 'array', items: wireString('Current source file ID.') },
                      },
                    },
                    note: wireString('Unverified expert note for the human review card.'),
                    suggested_value: wireString('Optional unverified suggestion, never applied automatically.'),
                  },
                }
                : {
                  type: 'object', additionalProperties: false, required: ['check_code', 'source_refs', 'note'],
                  properties: {
                    check_code: wireString('Existing deterministic readiness check code.'),
                    product_id: wireString('Optional product ID covered by this check.'),
                    source_refs: {
                      type: 'object', additionalProperties: false, required: ['workflow_task_id', 'batch_id', 'product_ids'],
                      properties: {
                        workflow_task_id: wireString('Current workflow ID.'),
                        batch_id: wireString('Current batch ID.'),
                        product_ids: { type: 'array', items: wireString('Current product ID.') },
                      },
                    },
                    note: wireString('Unverified expert note for the human review card.'),
                  },
                },
            },
          },
        },
      }),
      async execute(args, exec) {
        const allowed = ['workflow_id', 'assignment_id', 'step_id', 'advice']
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !allowed.includes(key))
          || !['workflow_id', 'assignment_id', 'step_id'].every(key => typeof args[key] === 'string' && args[key].length > 0 && args[key].length <= 80)
          || !validNativeAdvice(preset, args.advice)) return failure('invalid_arguments')
        const identity = observedAgentIdentity(exec)
        if (!identity) return failure('host_identity_unavailable')
        if (identity.agent_preset !== preset || typeof identity.parent_session !== 'string' || identity.delegation_depth !== 1) {
          return failure('direct_expert_child_required')
        }
        const workflowId = encodeURIComponent(args.workflow_id)
        const assignmentId = encodeURIComponent(args.assignment_id)
        const result = await djangoRequest(ctx, 'tradeloom_submit_native_workflow_advice', exec,
          `/api/workflow-tasks/${workflowId}/native-assignments/${assignmentId}/submit`, 'POST', {
            assignment_id: args.assignment_id,
            step_id: args.step_id,
            child_identity: identity,
            advice: args.advice,
          }, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || result.assignment_id !== args.assignment_id
          || result.step_id !== args.step_id
          || result.status !== 'accepted'
          || result.execution_mode !== 'native_dsh') return failure('invalid_native_submission_receipt')
        return success({
          assignment_id: boundedString(result.assignment_id, 80),
          step_id: boundedString(result.step_id, 80),
          status: 'accepted',
          result_status: boundedString(result.result_status, 80),
          subtask_status: boundedString(result.subtask_status, 80),
          execution_mode: 'native_dsh',
          provider: 'unknown',
          model: 'unknown',
          child_lifecycle: 'not_observed',
          notice: '建议已由服务端确定性复核并按现有流程记录；这不证明子代理已停止。',
        }, { requires_human_confirmation: result.subtask_status === 'waiting_human', business_ui_url: `/business/workflow-tasks/${workflowId}` })
      },
    },
    {
      name: 'tradeloom_intake_sources',
      description: 'Read-only for center, product, and delivery roles: read a bounded page of private workbook source and parser snapshot metadata. This does not return filenames, paths, cell contents, images, or perform mappings.',
      parameters: schema({
        offset: { type: 'integer', description: 'Optional zero-based page offset, 0 to 100000.' },
        limit: { type: 'integer', description: 'Optional page size, 1 to 50.' },
      }, []),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['offset', 'limit'].includes(key))) return failure('invalid_arguments')
        const offset = boundedPageInteger(args.offset, 0, 100000)
        const limit = boundedPageInteger(args.limit, 50, INTAKE_MAX_PAGE_SIZE)
        if (offset === null || limit === null || limit < 1) return failure('invalid_arguments')
        const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
        const result = await djangoRequest(ctx, 'tradeloom_intake_sources', exec,
          `/api/intake/sources?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const page = projectIntakeSources(result, limit)
        return page ? success(page, { business_ui_url: '/business/artifacts' }) : failure('invalid_intake_dto')
      },
    },
    {
      name: 'tradeloom_narrative_sources',
      description: '仅中心角色可读取的私有访谈资料元数据目录。资料可能为摘录或二次分析，完整性与内容尚未核实，不可作为正式规则；录音日期为 null 表示未知，不得根据上传时间推断。',
      parameters: schema({ offset: { type: 'integer', description: 'Optional zero-based page offset.' }, limit: { type: 'integer', description: 'Optional page size, 1 to 50; defaults to 20.' } }, []),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['offset', 'limit'].includes(key))) return failure('invalid_arguments')
        if (!exec?.agent?.session?.header) return failure('agent_session_required')
        if (exec.agent.session.header.agentPreset !== ROLE_PRESETS.center) return failure('role_not_authorized')
        const offset = boundedPageInteger(args.offset, 0, 100000)
        const limit = boundedPageInteger(args.limit, 20, 50)
        if (offset === null || limit === null || limit < 1) return failure('invalid_arguments')
        const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
        const result = await djangoRequest(ctx, 'tradeloom_narrative_sources', exec, `/api/intake/narratives?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const page = projectNarrativeSources(result, limit)
        return page ? success(page, { business_ui_url: '/business/artifacts' }) : failure('invalid_narrative_dto')
      },
    },
    {
      name: 'tradeloom_narrative_excerpt',
      description: '仅中心角色可读取一份私有访谈资料中有界的原文行。资料可能为摘录或二次分析，完整性与内容尚未核实，不是正式规则；录入者表示已核听不等于系统验证，未知录音日期仍为 null。',
      parameters: schema({ source_id: wireString('Existing lowercase 32-character source ID.'), offset: { type: 'integer', description: 'Optional zero-based line offset.' }, limit: { type: 'integer', description: 'Optional line count, 1 to 10; defaults to 5.' } }, ['source_id']),
      async execute(args, exec) {
        if (!exactArgs(args, ['source_id', 'offset', 'limit'], ['source_id']) || typeof args.source_id !== 'string' || !INTAKE_OPAQUE_ID.test(args.source_id)) return failure('invalid_arguments')
        if (!exec?.agent?.session?.header) return failure('agent_session_required')
        if (exec.agent.session.header.agentPreset !== ROLE_PRESETS.center) return failure('role_not_authorized')
        const offset = boundedPageInteger(args.offset, 0, 100000)
        const limit = boundedPageInteger(args.limit, 5, 10)
        if (offset === null || limit === null || limit < 1) return failure('invalid_arguments')
        const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
        const result = await djangoRequest(ctx, 'tradeloom_narrative_excerpt', exec,
          `/api/intake/narratives/${encodeURIComponent(args.source_id)}/lines?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const excerpt = projectNarrativeExcerpt(result, args.source_id, limit)
        return excerpt ? success(excerpt, { business_ui_url: '/business/artifacts' }) : failure('invalid_narrative_dto')
      },
    },
    {
      name: 'tradeloom_intake_candidates',
      description: 'Read-only bounded candidate directory for center, product, and delivery. Center may filter by any candidate type or omit it; product is restricted to product_identity and delivery to production_instruction. Optional source_id narrows the directory to candidates citing that source. Returns opaque IDs, type, digest, source IDs and unconfirmed/unknown status only; inspect details with tradeloom_intake_candidate.',
      parameters: schema({
        candidate_type: { type: 'string', enum: INTAKE_CANDIDATE_TYPES, description: 'Optional category filter. Product is forced to product_identity; delivery is forced to production_instruction; center may choose any category.' },
        source_id: wireString('Optional existing 32-character lowercase opaque source ID.'),
        offset: { type: 'integer', description: 'Optional zero-based page offset, 0 to 100000.' },
        limit: { type: 'integer', description: 'Optional page size, 1 to 50.' },
      }, []),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['candidate_type', 'source_id', 'offset', 'limit'].includes(key))) return failure('invalid_arguments')
        if (!exec?.agent?.session?.header) return failure('agent_session_required')
        const preset = exec.agent.session.header.agentPreset
        const roleType = preset === ROLE_PRESETS.product ? 'product_identity'
          : preset === ROLE_PRESETS.delivery ? 'production_instruction' : null
        const requestedType = args.candidate_type
        if (requestedType !== undefined && !INTAKE_CANDIDATE_TYPES.includes(requestedType)) return failure('invalid_arguments')
        if (requestedType && roleType && requestedType !== roleType) return failure('role_not_authorized')
        if (preset !== ROLE_PRESETS.center && preset !== ROLE_PRESETS.product && preset !== ROLE_PRESETS.delivery) return failure('role_not_authorized')
        if (args.source_id !== undefined && (typeof args.source_id !== 'string' || !INTAKE_OPAQUE_ID.test(args.source_id))) return failure('invalid_arguments')
        const offset = boundedPageInteger(args.offset, 0, 100000)
        const limit = boundedPageInteger(args.limit, 50, INTAKE_MAX_PAGE_SIZE)
        if (offset === null || limit === null || limit < 1) return failure('invalid_arguments')
        const filterType = roleType || requestedType
        const query = new URLSearchParams()
        if (filterType) query.set('candidate_type', filterType)
        if (args.source_id) query.set('source_id', args.source_id)
        query.set('offset', String(offset))
        query.set('limit', String(limit))
        const result = await djangoRequest(ctx, 'tradeloom_intake_candidates', exec,
          `/api/intake/candidates?${query}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const page = projectIntakeCandidateDirectory(result, filterType, preset, limit)
        return page ? success(page, { business_ui_url: '/business/artifacts' }) : failure('invalid_intake_dto')
      },
    },
    {
      name: 'tradeloom_intake_candidate',
      description: 'Read-only typed candidate details and source cell coordinates by opaque ID. Center may read all candidate types; product may read only product_identity; delivery may read only production_instruction. This tool cannot edit or confirm data.',
      parameters: schema({
        candidate_id: wireString('Existing 32-character lowercase opaque candidate ID.'),
        candidate_type: { type: 'string', enum: INTAKE_CANDIDATE_TYPES, description: 'Expected fixed candidate category; center: any listed type, product: product_identity only, delivery: production_instruction only.' },
      }),
      async execute(args, exec) {
        if (!exactArgs(args, ['candidate_id', 'candidate_type'], ['candidate_id', 'candidate_type'])
          || !INTAKE_OPAQUE_ID.test(args.candidate_id) || !INTAKE_CANDIDATE_TYPES.includes(args.candidate_type)) return failure('invalid_arguments')
        if (!exec?.agent?.session?.header) return failure('agent_session_required')
        const preset = exec.agent.session.header.agentPreset
        if (!intakeCandidateTypeAllowed(preset, args.candidate_type)) return failure('role_not_authorized')
        const result = await djangoRequest(ctx, 'tradeloom_intake_candidate', exec,
          `/api/intake/candidates/${encodeURIComponent(args.candidate_id)}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const returnedCandidate = result?.candidate
        if (returnedCandidate && typeof returnedCandidate === 'object' && !Array.isArray(returnedCandidate)
          && typeof returnedCandidate.candidate_type === 'string'
          && !intakeCandidateTypeAllowed(preset, returnedCandidate.candidate_type)) return failure('role_not_authorized')
        const candidate = projectIntakeCandidate(result, args.candidate_type)
        if (!candidate) return failure('invalid_intake_dto')
        if (!intakeCandidateTypeAllowed(preset, candidate.candidate_type)) return failure('role_not_authorized')
        return success(candidate, { business_ui_url: '/business/artifacts' })
      },
    },
    {
      name: 'tradeloom_read_execution_plan',
      description: 'Read one locally saved execution plan draft and its exact confirmed requirement revision sources. Material and operation values are human proposals; actual receiving and production quantities remain missing. Read-only.',
      parameters: schema({ plan_revision_id: wireString('Exact lowercase 32-character execution plan revision ID; runtime validates all 32 hex characters.') }),
      async execute(args, exec) {
        if (!exactArgs(args, ['plan_revision_id'], ['plan_revision_id'])
          || !/^[0-9a-f]{32}$/.test(args.plan_revision_id)) return failure('invalid_arguments')
        const result = await djangoRequest(ctx, 'tradeloom_read_execution_plan', exec,
          `/api/execution-plans/${encodeURIComponent(args.plan_revision_id)}`, 'GET', undefined, dependencies)
        if (result?.ok === false) return failure(result.error_code)
        const projected = projectExecutionPlan(result, args.plan_revision_id)
        return projected ? success(projected, { business_ui_url: '/business/artifacts' }) : failure('invalid_execution_plan_dto')
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
    {
      name: 'tradeloom_erpnext_create_quotation_draft',
      description: 'Create one fixed ERPNext Quotation draft (docstatus 0) using the supplied idempotency key. A non-succeeded result is not success; inspect the same operation and never retry with a new key unless starting a distinct, explicit operation.',
      parameters: schema({
        idempotency_key: wireString('Caller-stable key; reuse this exact value if a response is lost.'),
        payload: quotationPayloadSchema,
        workflow_id: wireString('Optional existing TradeLoom workflow ID.'),
      }, ['idempotency_key', 'payload']),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['idempotency_key', 'payload', 'workflow_id'].includes(key))
          || typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200
          || !validQuotationPayload(args.payload)
          || (args.workflow_id !== undefined && (typeof args.workflow_id !== 'string' || !args.workflow_id))) return failure('invalid_arguments')
        const body = { idempotency_key: args.idempotency_key, payload: args.payload }
        if (args.workflow_id !== undefined) body.workflow_id = args.workflow_id
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_create_quotation_draft', exec,
          '/api/erpnext/quotation-drafts', 'POST', body, dependencies)
        return draftToolResult(result)
      },
    },
    {
      name: 'tradeloom_erpnext_update_quotation_draft',
      description: 'Create a separate update operation for one previously confirmed Quotation draft. Requires a new idempotency key and the exact current modified value. On conflict, read the operation and current ERPNext version before forming a new intent.',
      parameters: schema({
        target_operation_id: wireString('Previously succeeded operation for the same Quotation.'),
        idempotency_key: wireString('New stable key for this distinct update operation.'),
        expected_modified: wireString('Exact ERPNext modified value from the latest readback.'),
        payload: quotationPayloadSchema,
        workflow_id: wireString('Optional existing TradeLoom workflow ID.'),
      }, ['target_operation_id', 'idempotency_key', 'expected_modified', 'payload']),
      async execute(args, exec) {
        if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some(key => !['target_operation_id', 'idempotency_key', 'expected_modified', 'payload', 'workflow_id'].includes(key))
          || typeof args.target_operation_id !== 'string' || !/^[0-9a-f]{32}$/.test(args.target_operation_id)
          || typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200
          || typeof args.expected_modified !== 'string' || !args.expected_modified
          || !validQuotationPayload(args.payload)
          || (args.workflow_id !== undefined && (typeof args.workflow_id !== 'string' || !args.workflow_id))) return failure('invalid_arguments')
        const body = {
          idempotency_key: args.idempotency_key,
          expected_modified: args.expected_modified,
          payload: args.payload,
        }
        if (args.workflow_id !== undefined) body.workflow_id = args.workflow_id
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_update_quotation_draft', exec,
          `/api/erpnext/quotation-drafts/${encodeURIComponent(args.target_operation_id)}`,
          'PUT', body, dependencies, [409])
        return draftToolResult(result)
      },
    },
    {
      name: 'tradeloom_erpnext_read_quotation_draft_operation',
      description: 'Read and reconcile one existing Quotation operation by its server-issued operation ID. This is the only action for checking an outcome_unknown result; it does not create or update a draft.',
      parameters: schema({ operation_id: wireString('Server-issued Quotation operation ID.') }),
      async execute(args, exec) {
        if (!exactArgs(args, ['operation_id'], ['operation_id']) || !/^[0-9a-f]{32}$/.test(args.operation_id)) return failure('invalid_arguments')
        const result = await djangoRequest(ctx, 'tradeloom_erpnext_read_quotation_draft_operation', exec,
          `/api/erpnext/quotation-drafts/${encodeURIComponent(args.operation_id)}`, 'GET', undefined, dependencies)
        return draftToolResult(result)
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
