import { validateWorkflow, WorkflowValidationError } from '../packages/tradeloom-shell/workflow-schema.js'
import { createConfirmedWorkflowDefinition } from '../packages/tradeloom-shell/workflow-definition.js'
import { pathToFileURL } from 'node:url'

const MAX_INPUT = 2 * 1024 * 1024 + 4096
const MAX_OUTPUT = 2 * 1024 * 1024 + 8192

function failure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function validateWorkflowDefinition(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_workflow')
  if (typeof input.id !== 'string') throw failure('invalid_workflow')
  try {
    const normalized = validateWorkflow(input)
    if (normalized.confirmed === true) {
      const confirmed = createConfirmedWorkflowDefinition(normalized)
      return { ok: true, document: confirmed.document, definitionRevision: confirmed.definitionRevision }
    }
    return { ok: true, document: normalized, definitionRevision: null }
  } catch (error) {
    if (error instanceof WorkflowValidationError || error?.code === 'invalid_workflow') throw failure('invalid_workflow')
    throw failure('validator_unavailable')
  }
}

function run(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'document')) throw failure('invalid_input')
  return validateWorkflowDefinition(input.document)
}

async function main() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT) throw failure('invalid_input')
    chunks.push(chunk)
  }
  let input
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('invalid_input') }
  const result = run(input)
  const output = Buffer.from(JSON.stringify(result), 'utf8')
  if (output.length > MAX_OUTPUT) throw failure('invalid_workflow')
  process.stdout.write(output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = ['invalid_input', 'invalid_workflow'].includes(error?.code) ? error.code : 'validator_unavailable'
    process.stdout.write(JSON.stringify({ ok: false, code }))
  })
}
