import assert from 'node:assert/strict'
import test from 'node:test'
import { createConfirmedWorkflowDefinition, verifyWorkflowDefinition } from '../workflow-definition.js'

function stored(overrides = {}) {
  return {
    version: 1, id: 'definition-demo', title: '已确认工作流', confirmed: true,
    nodes: [
      { id: 'input', kind: 'input', title: '输入', position: { x: 0, y: 0 } },
      { id: 'work', kind: 'agent', agent: 'product', title: '整理', model: { provider: 'local', model: 'demo' }, position: { x: 240, y: 0 } },
      { id: 'output', kind: 'output', title: '输出', position: { x: 480, y: 0 } },
    ],
    edges: [{ from: 'input', to: 'work' }, { from: 'work', to: 'output' }],
    updatedAt: '2026-10-26T00:00:00.000Z', ...overrides,
  }
}

test('canonical definition ignores object insertion order and server timestamp', () => {
  const input = stored()
  const reordered = Object.fromEntries(Object.entries(input).reverse())
  reordered.nodes = input.nodes.map(node => Object.fromEntries(Object.entries(node).reverse()))
  reordered.nodes[1].model = { model: 'demo', provider: 'local' }
  reordered.updatedAt = '2026-10-27T00:00:00.000Z'
  const result = createConfirmedWorkflowDefinition(input)
  assert.match(result.definitionRevision, /^sha256:[a-f0-9]{64}$/)
  assert.equal(createConfirmedWorkflowDefinition(reordered).definitionRevision, result.definitionRevision)
  assert.equal(Object.hasOwn(result.document, 'updatedAt'), false)
  assert.equal(result.document.source, 'manual')
  assert.equal(result.document.description, '')
  assert.deepEqual(verifyWorkflowDefinition(result.document, result.definitionRevision), result)
})

test('content, layout, identity and array order are part of the definition', () => {
  const original = stored()
  const revision = createConfirmedWorkflowDefinition(original).definitionRevision
  const changes = [
    doc => { doc.title = '修改标题' },
    doc => { doc.id = 'another-definition' },
    doc => { doc.nodes[1].instruction = '检查商品' },
    doc => { doc.nodes[1].position.x += 1 },
    doc => { doc.nodes.reverse() },
    doc => { doc.edges.reverse() },
  ]
  for (const change of changes) {
    const changed = structuredClone(original)
    change(changed)
    assert.notEqual(createConfirmedWorkflowDefinition(changed).definitionRevision, revision)
  }
})

test('explicit confirmation is required before schema defaults apply', () => {
  for (const confirmed of [false, undefined, null, 'true', 1]) {
    assert.throws(() => createConfirmedWorkflowDefinition(stored({ confirmed })), { code: 'workflow_not_confirmed' })
  }
  const missing = stored()
  delete missing.confirmed
  assert.throws(() => createConfirmedWorkflowDefinition(missing), { code: 'workflow_not_confirmed' })
  for (const value of [undefined, null, [], 'document']) {
    assert.throws(() => createConfirmedWorkflowDefinition(value), { code: 'invalid_workflow' })
  }
})

test('unknown fields and invalid schema remain rejected', () => {
  assert.throws(() => createConfirmedWorkflowDefinition(stored({ revision: 'client-authority' })), /unknown field/)
  assert.throws(() => createConfirmedWorkflowDefinition(stored({ title: '' })), /title is required/)
  const nested = stored()
  nested.nodes[1].unexpected = true
  assert.throws(() => createConfirmedWorkflowDefinition(nested), /unknown field/)
})

test('verification rejects altered documents and invalid revisions without changing input', () => {
  const input = stored()
  const before = structuredClone(input)
  const result = createConfirmedWorkflowDefinition(input)
  assert.deepEqual(input, before)
  const tampered = structuredClone(result.document)
  tampered.nodes[1].instruction = '篡改'
  const tamperedBefore = structuredClone(tampered)
  assert.throws(() => verifyWorkflowDefinition(tampered, result.definitionRevision), { code: 'definition_revision_mismatch' })
  assert.deepEqual(tampered, tamperedBefore)
  for (const revision of [undefined, '', 'client-revision', `sha256:${'0'.repeat(64)}`]) {
    assert.throws(() => verifyWorkflowDefinition(result.document, revision), { code: 'definition_revision_mismatch' })
  }
  result.document.nodes[1].model.provider = 'changed'
  assert.deepEqual(input, before, 'returned document must not share nested mutable input objects')
})
