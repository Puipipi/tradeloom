import { createHash } from 'node:crypto'
import { validateWorkflow, WorkflowValidationError } from './workflow-schema.js'

function canonicalDocument(value) {
  if (Array.isArray(value)) return value.map(canonicalDocument)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalDocument(value[key])]))
  }
  return value
}

function failure(code) {
  return Object.assign(new Error(code), { code })
}

/** Identify an explicitly confirmed, stored definition without its server timestamp. */
export function createConfirmedWorkflowDefinition(storedDocument) {
  if (storedDocument === null || typeof storedDocument !== 'object' || Array.isArray(storedDocument)) {
    throw new WorkflowValidationError(['document must be an object'])
  }
  if (storedDocument.confirmed !== true) throw failure('workflow_not_confirmed')
  const { updatedAt, ...workflowInput } = storedDocument
  const document = canonicalDocument(validateWorkflow(workflowInput))
  const digest = createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex')
  return { document, definitionRevision: `sha256:${digest}` }
}

/** Recompute identity; never replace a mismatched expected revision. */
export function verifyWorkflowDefinition(snapshotDocument, expectedRevision) {
  const definition = createConfirmedWorkflowDefinition(snapshotDocument)
  if (definition.definitionRevision !== expectedRevision) throw failure('definition_revision_mismatch')
  return definition
}
