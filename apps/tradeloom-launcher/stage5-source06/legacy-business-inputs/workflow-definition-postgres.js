import { isDeepStrictEqual } from 'node:util'
import { requestBusinessJson, trustedBusinessAuthority } from './business-tools.js'
import { createConfirmedWorkflowDefinition } from './workflow-definition.js'
import { validateWorkflow } from './workflow-schema.js'
import { pairedBusinessAuthority } from './workflow-postgres.js'

const PATH = '/api/canvas-workflow-definitions'
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const MAX_PAGE_SIZE = 100
const MAX_DEFINITION_WIRE_BYTES = 3 * 1024 * 1024
const RESPONSE_METADATA_BYTES = 64 * 1024
const DTO_KEYS = ['workflowId', 'revision', 'definitionRevision', 'document', 'deleted', 'updatedAt']
const PAGE_KEYS = ['definitions', 'total', 'offset', 'limit', 'nextOffset']
const ERROR_STATUS = Object.freeze({
  native_bridge_required: [403], invalid_request: [400, 422], invalid_workflow: [400],
  invalid_workflow_id: [400], invalid_query: [400], request_too_large: [413],
  definition_not_found: [404], revision_conflict: [409], workflow_validation_unavailable: [503],
  definition_store_invalid_record: [503], storage_unavailable: [503],
})

export class WorkflowDefinitionPersistenceError extends Error {
  constructor(code, status = 0) {
    super(`Workflow definition persistence: ${code}`)
    this.name = 'WorkflowDefinitionPersistenceError'
    this.code = code
    this.status = status
  }
}

function fail(code, status = 0) {
  throw new WorkflowDefinitionPersistenceError(code, status)
}

function validId(id) {
  if (typeof id !== 'string' || !WORKFLOW_ID.test(id)) fail('invalid_workflow_id')
}

function validRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid_revision')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalInput(input) {
  let copy
  try { copy = structuredClone(input) } catch { fail('invalid_workflow') }
  if (!isRecord(copy)) fail('invalid_workflow')
  // get() exposes this server timestamp alongside the ordinary workflow fields.
  delete copy.updatedAt
  validId(copy.id)
  try {
    const document = validateWorkflow(copy)
    if (document.confirmed) return createConfirmedWorkflowDefinition(document)
    return { document, definitionRevision: null }
  } catch { fail('invalid_workflow') }
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
}

function validateDto(value, expectedId) {
  if (!exactKeys(value, DTO_KEYS) || typeof value.workflowId !== 'string' || !WORKFLOW_ID.test(value.workflowId)
    || (expectedId !== undefined && value.workflowId !== expectedId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.deleted !== 'boolean' || !validTimestamp(value.updatedAt)) {
    fail('invalid_definition_store_response')
  }
  if (value.deleted) {
    if (value.document !== null || value.definitionRevision !== null) fail('invalid_definition_store_response')
    return structuredClone(value)
  }
  if (!isRecord(value.document) || value.document.id !== value.workflowId) fail('invalid_definition_store_response')
  let canonical
  try {
    const normalized = validateWorkflow(value.document)
    canonical = normalized.confirmed
      ? createConfirmedWorkflowDefinition(normalized)
      : { document: normalized, definitionRevision: null }
  } catch { fail('invalid_definition_store_response') }
  if (!isDeepStrictEqual(canonical.document, value.document)
    || canonical.definitionRevision !== value.definitionRevision) fail('invalid_definition_store_response')
  return structuredClone(value)
}

function mapTransportError(error) {
  if (error instanceof WorkflowDefinitionPersistenceError) throw error
  if (error?.code === 'tool_cancelled') fail('definition_store_cancelled')
  if (error?.code === 'tool_timeout') fail('definition_store_timeout')
  fail('definition_store_unavailable')
}

function mapResponseError(status, value) {
  const code = value?.code
  const allowed = typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code) ? ERROR_STATUS[code] : undefined
  if (!allowed || !allowed.includes(status)) fail('definition_store_unavailable', status)
  fail(code, status)
}

function validatePage(value, { offset, limit }) {
  if (!exactKeys(value, PAGE_KEYS) || !Array.isArray(value.definitions)
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.offset !== offset || value.limit !== limit || value.definitions.length > limit
    || !(value.nextOffset === null || (Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0))) {
    fail('invalid_definition_store_response')
  }
  const definitions = value.definitions.map(row => validateDto(row))
  const ids = new Set()
  for (const row of definitions) {
    if (row.deleted || ids.has(row.workflowId)) {
      fail('invalid_definition_store_response')
    }
    ids.add(row.workflowId)
  }
  const expectedNextOffset = offset + definitions.length < value.total ? offset + definitions.length : null
  if (value.nextOffset !== expectedNextOffset) fail('invalid_definition_store_response')
  return { definitions, total: value.total, offset, limit, nextOffset: value.nextOffset }
}

/** Paired Host-to-Django workflow definitions. It never forwards browser cookies. */
export function createPostgresWorkflowDefinitionStore(options = {}) {
  const pairedHost = options.pairedHost === undefined ? undefined : { ...options.pairedHost }

  async function call(method, suffix = '', body, { signal, limit = 1 } = {}) {
    const nativeBridgeKey = options.nativeBridgeKey ?? process.env.TRADELOOM_NATIVE_BRIDGE_KEY
    if (!/^[a-f0-9]{64}$/.test(nativeBridgeKey ?? '')) fail('native_bridge_unavailable')
    let trusted
    try {
      trusted = pairedHost === undefined
        ? trustedBusinessAuthority(options.webServer)
        : pairedBusinessAuthority(options.webServer, pairedHost)
    } catch { fail('trusted_business_authority_unavailable') }

    let response
    try {
      response = await requestBusinessJson({
        path: PATH + suffix,
        method,
        body,
        authority: trusted,
        nativeBridgeKey,
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.request === undefined ? {} : { request: options.request }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        maxResponseBytes: RESPONSE_METADATA_BYTES + MAX_DEFINITION_WIRE_BYTES * limit,
      })
    } catch (error) { mapTransportError(error) }

    let value
    try { value = JSON.parse(response.raw) } catch { fail('invalid_definition_store_response', response.status) }
    if (response.status < 200 || response.status >= 300) mapResponseError(response.status, value)
    return { value, status: response.status }
  }

  async function getVersioned(id, { signal } = {}) {
    validId(id)
    const query = new URLSearchParams({ id })
    let result
    try { result = await call('GET', `?${query}`, undefined, { signal }) } catch (error) {
      if (error.code === 'definition_not_found' && error.status === 404) {
        return { document: null, revision: 0, definitionRevision: null, updatedAt: null }
      }
      throw error
    }
    if (result.status !== 200) fail('invalid_definition_store_response', result.status)
    const dto = validateDto(result.value, id)
    return { document: dto.deleted ? null : dto.document, revision: dto.revision,
      definitionRevision: dto.definitionRevision, updatedAt: dto.updatedAt }
  }

  async function saveVersioned(input, expectedRevision, { signal } = {}) {
    validRevision(expectedRevision)
    const normalized = canonicalInput(input) // Clone and normalize before the first await.
    const result = await call('POST', '', { document: normalized.document, expectedRevision }, { signal })
    const dto = validateDto(result.value, normalized.document.id)
    const expectedStatus = expectedRevision === 0 ? 201 : 200
    if (result.status !== expectedStatus || dto.deleted || dto.revision !== expectedRevision + 1
      || !isDeepStrictEqual(dto.document, normalized.document)
      || dto.definitionRevision !== normalized.definitionRevision) fail('invalid_definition_store_response', result.status)
    return { document: dto.document, revision: dto.revision, definitionRevision: dto.definitionRevision, updatedAt: dto.updatedAt }
  }

  async function removeVersioned(id, expectedRevision, { signal } = {}) {
    validId(id)
    validRevision(expectedRevision)
    const result = await call('DELETE', '', { workflowId: id, expectedRevision }, { signal })
    const dto = validateDto(result.value, id)
    if (result.status !== 200 || !dto.deleted || !(dto.revision === expectedRevision || dto.revision === expectedRevision + 1)) {
      fail('invalid_definition_store_response', result.status)
    }
    return { document: null, revision: dto.revision, definitionRevision: null, updatedAt: dto.updatedAt, deleted: true }
  }

  async function listPage({ offset = 0, limit = 50, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_SAFE_INTEGER
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) fail('invalid_page')
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    const { value, status } = await call('GET', `?${query}`, undefined, { signal, limit })
    if (status !== 200) fail('invalid_definition_store_response', status)
    return validatePage(value, { offset, limit })
  }

  async function get(id, { signal } = {}) {
    const value = await getVersioned(id, { signal })
    if (value.document === null) return null
    return { ...value.document, updatedAt: value.updatedAt }
  }

  return Object.freeze({ getVersioned, saveVersioned, removeVersioned, listPage, get })
}
