import assert from 'node:assert/strict'
import test from 'node:test'
import { validateWorkflowDefinition } from '../workflow_definition_validator.mjs'

function doc(overrides = {}) {
  return {
    version: 1,
    id: 'definition-1',
    title: '订单流程 😀',
    source: 'manual',
    confirmed: true,
    nodes: [
      { id: 'input', kind: 'input', title: '开始', position: { x: 1.5, y: 2.5 } },
      { id: 'output', kind: 'output', title: '结束' },
    ],
    edges: [{ from: 'input', to: 'output' }],
    ...overrides,
  }
}

test('canonical JS validator preserves Unicode and JS coordinate rounding', () => {
  const result = validateWorkflowDefinition(doc())
  assert.equal(result.ok, true)
  assert.equal(result.document.title, '订单流程 😀')
  assert.deepEqual(result.document.nodes[0].position, { x: 2, y: 3 })
  assert.match(result.definitionRevision, /^sha256:[a-f0-9]{64}$/)
})

test('draft has no definition digest and agent defaults stay canonical', () => {
  const draft = validateWorkflowDefinition(doc({ source: 'agent', confirmed: undefined }))
  assert.equal(draft.document.confirmed, false)
  assert.equal(draft.definitionRevision, null)
})

test('NUL and emoji in legal instruction survive canonical projection', () => {
  const result = validateWorkflowDefinition(doc({
    nodes: [
      { id: 'input', kind: 'input', title: '开始', instruction: 'A\u0000😀' },
      { id: 'output', kind: 'output', title: '结束' },
    ],
  }))
  assert.equal(result.document.nodes[0].instruction, 'A\u0000😀')
})

test('unknown schema fields are rejected with a stable code', () => {
  assert.throws(() => validateWorkflowDefinition(doc({ unexpected: true })), error => error.code === 'invalid_workflow')
  assert.throws(() => validateWorkflowDefinition(doc({ id: 123 })), error => error.code === 'invalid_workflow')
})

test('input cycles are rejected without leaking parser errors', () => {
  const cyclic = doc()
  cyclic.description = cyclic
  assert.throws(() => validateWorkflowDefinition(cyclic), error => error.code === 'invalid_workflow')
})
