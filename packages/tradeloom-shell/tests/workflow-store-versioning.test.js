import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { createWorkflowStore } from '../workflow-engine.js'

const workflow = (overrides = {}) => ({
  version: 1, id: 'cas-flow', title: 'CAS flow', description: '', source: 'manual', confirmed: true,
  nodes: [
    { id: 'input', kind: 'input', title: 'Input', instruction: '', position: { x: 40, y: 40 } },
    { id: 'output', kind: 'output', title: 'Output', instruction: '', position: { x: 280, y: 40 } },
  ],
  edges: [{ from: 'input', to: 'output' }],
  ...overrides,
})

async function fixture(t, hooks) {
  const root = await mkdtemp(join(tmpdir(), 'tradeloom-workflow-store-cas-'))
  const dir = join(root, 'definitions')
  await mkdir(dir, { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { dir, store: createWorkflowStore(dir, hooks ? { _testHooks: hooks } : undefined) }
}

test('versioned API reads a legacy raw document as revision zero and migrates on first write', async t => {
  const { dir, store } = await fixture(t)
  await assert.rejects(store.saveVersioned(workflow(), -1), { code: 'invalid_revision' })
  await assert.rejects(store.saveVersioned(workflow(), 0.5), { code: 'invalid_revision' })
  const legacy = { ...workflow(), updatedAt: '2026-10-30T12:00:00.000Z' }
  await writeFile(join(dir, 'cas-flow.json'), JSON.stringify(legacy))

  assert.deepEqual(await store.get('cas-flow'), legacy)
  assert.deepEqual((await store.list()).map(item => item.id), ['cas-flow'])
  const initial = await store.getVersioned('cas-flow')
  assert.equal(initial.revision, 0)
  assert.equal(initial.updatedAt, legacy.updatedAt)
  assert.equal(initial.definitionRevision, createConfirmedWorkflowDefinition(legacy).definitionRevision)
  assert.deepEqual(initial.document, workflow())

  const saved = await store.saveVersioned(workflow({ title: 'Migrated' }), 0)
  assert.equal(saved.revision, 1)
  assert.equal(saved.document.title, 'Migrated')
  assert.equal((await store.get('cas-flow')).title, 'Migrated')
  assert.equal(Object.hasOwn(await store.get('cas-flow'), 'revision'), false)
  assert.equal(createConfirmedWorkflowDefinition(await store.get('cas-flow')).definitionRevision, saved.definitionRevision)
})

test('drafts have no digest and repeated confirmed saves advance integer revision without changing content digest', async t => {
  const { store } = await fixture(t)
  const draft = await store.saveVersioned(workflow({ confirmed: false, source: 'agent' }), 0)
  assert.equal(draft.revision, 1)
  assert.equal(draft.definitionRevision, null)
  assert.equal((await store.getVersioned('cas-flow')).definitionRevision, null)

  const confirmed = await store.saveVersioned(workflow(), 1)
  const repeated = await store.saveVersioned(workflow(), 2)
  assert.equal(confirmed.revision, 2)
  assert.equal(repeated.revision, 3)
  assert.equal(repeated.definitionRevision, confirmed.definitionRevision)
  assert.match(repeated.definitionRevision, /^sha256:[0-9a-f]{64}$/)
})

test('parallel CAS across store wrappers permits one writer and rejects the stale writer', async t => {
  const { dir, store } = await fixture(t)
  const other = createWorkflowStore(dir.toUpperCase())
  const results = await Promise.allSettled([
    store.saveVersioned(workflow({ title: 'Writer A' }), 0),
    other.saveVersioned(workflow({ title: 'Writer B' }), 0),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'workflow_revision_conflict')
  assert.equal((await store.getVersioned('cas-flow')).revision, 1)
})

test('save snapshots nested model input before waiting in the per-file queue', async t => {
  let pauseRename = false
  let announceRename
  let releaseRename
  const renameEntered = new Promise(resolve => { announceRename = resolve })
  const renameGate = new Promise(resolve => { releaseRename = resolve })
  const { dir, store } = await fixture(t, {
    async rename(source, target) {
      if (pauseRename) {
        pauseRename = false
        announceRename()
        await renameGate
      }
      const { rename } = await import('node:fs/promises')
      return await rename(source, target)
    },
  })
  const modelDocument = workflow({
    nodes: [
      { id: 'input', kind: 'input', title: 'Input', instruction: '', position: { x: 40, y: 40 } },
      { id: 'agent', kind: 'agent', title: 'Agent', agent: 'product', model: { provider: 'provider-a', model: 'model-a' }, instruction: '', position: { x: 160, y: 40 } },
      { id: 'output', kind: 'output', title: 'Output', instruction: '', position: { x: 280, y: 40 } },
    ],
    edges: [{ from: 'input', to: 'agent' }, { from: 'agent', to: 'output' }],
  })
  pauseRename = true
  const firstSave = store.saveVersioned(workflow(), 0)
  await renameEntered
  const queuedInput = structuredClone(modelDocument)
  const queuedSave = store.saveVersioned(queuedInput, 1)
  queuedInput.nodes[1].model.provider = 'provider-mutated-after-call'
  releaseRename()
  await firstSave
  const saved = await queuedSave
  assert.equal(saved.document.nodes[1].model.provider, 'provider-a')
  assert.equal((await store.getVersioned('cas-flow')).definitionRevision,
    createConfirmedWorkflowDefinition(saved.document).definitionRevision)
})

test('legacy save snapshots nested model input before waiting in the per-file queue', async t => {
  let pauseRename = false
  let announceRename
  let releaseRename
  const renameEntered = new Promise(resolve => { announceRename = resolve })
  const renameGate = new Promise(resolve => { releaseRename = resolve })
  const { store } = await fixture(t, {
    async rename(source, target) {
      if (pauseRename) {
        pauseRename = false
        announceRename()
        await renameGate
      }
      const { rename } = await import('node:fs/promises')
      return await rename(source, target)
    },
  })
  const modelDocument = workflow({
    nodes: [
      { id: 'input', kind: 'input', title: 'Input', instruction: '', position: { x: 40, y: 40 } },
      { id: 'agent', kind: 'agent', title: 'Agent', agent: 'product', model: { provider: 'provider-legacy', model: 'model-a' }, instruction: '', position: { x: 160, y: 40 } },
      { id: 'output', kind: 'output', title: 'Output', instruction: '', position: { x: 280, y: 40 } },
    ],
    edges: [{ from: 'input', to: 'agent' }, { from: 'agent', to: 'output' }],
  })
  pauseRename = true
  const firstSave = store.saveVersioned(workflow(), 0)
  await renameEntered
  const queuedSave = store.save(modelDocument)
  modelDocument.nodes[1].model.provider = 'legacy-mutated-after-call'
  releaseRename()
  await firstSave
  const saved = await queuedSave
  assert.equal(saved.nodes[1].model.provider, 'provider-legacy')
  assert.equal(createConfirmedWorkflowDefinition(saved).definitionRevision,
    (await store.getVersioned('cas-flow')).definitionRevision)
})

test('legacy save increments version and invalidates an earlier versioned CAS while old snapshots stay stable', async t => {
  const { store } = await fixture(t)
  const first = await store.saveVersioned(workflow(), 0)
  const held = await store.get('cas-flow')
  const legacySaved = await store.save(workflow({ title: 'Legacy write' }))
  assert.equal(legacySaved.title, 'Legacy write')
  assert.equal((await store.getVersioned('cas-flow')).revision, first.revision + 1)
  assert.equal(held.title, 'CAS flow')
  await assert.rejects(store.saveVersioned(workflow({ title: 'Stale' }), first.revision), { code: 'workflow_revision_conflict' })
})

test('legacy save from a missing definition starts versioned history at revision one', async t => {
  const { store } = await fixture(t)
  const saved = await store.save(workflow())
  assert.equal(saved.id, 'cas-flow')
  assert.equal(typeof saved.updatedAt, 'string')
  assert.equal((await store.getVersioned('cas-flow')).revision, 1)
  assert.equal((await store.get('cas-flow')).revision, undefined)
})

test('delete tombstones prevent remove-recreate ABA and legacy list/get still hide deleted definitions', async t => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.getVersioned('cas-flow'), {
    document: null, revision: 0, updatedAt: null, definitionRevision: null,
  })
  await store.saveVersioned(workflow(), 0)
  await store.remove('cas-flow')
  const deleted = await store.getVersioned('cas-flow')
  assert.equal(deleted.document, null)
  assert.equal(deleted.revision, 2)
  assert.equal(await store.get('cas-flow'), null)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.saveVersioned(workflow(), 1), { code: 'workflow_revision_conflict' })
  const recreated = await store.saveVersioned(workflow({ title: 'Recreated' }), 2)
  assert.equal(recreated.revision, 3)
  await store.remove('cas-flow')
  const revision = (await store.getVersioned('cas-flow')).revision
  await store.remove('cas-flow')
  assert.equal((await store.getVersioned('cas-flow')).revision, revision)
})

test('invalid schema does not write and rename failure preserves the previous file bytes', async t => {
  let failRename = false
  const { dir, store } = await fixture(t, {
    async rename(source, target) {
      if (failRename) throw Object.assign(new Error('test rename failure'), { code: 'EIO' })
      const { rename } = await import('node:fs/promises')
      return await rename(source, target)
    },
  })
  await store.saveVersioned(workflow(), 0)
  const original = await readFile(join(dir, 'cas-flow.json'))
  await assert.rejects(store.saveVersioned(workflow({ extra: true }), 1), { code: 'invalid_workflow' })
  assert.deepEqual(await readFile(join(dir, 'cas-flow.json')), original)
  failRename = true
  await assert.rejects(store.saveVersioned(workflow({ title: 'No commit' }), 1), { code: 'workflow_store_write_failed' })
  assert.deepEqual(await readFile(join(dir, 'cas-flow.json')), original)
})

test('store reopen reads the current envelope without exposing it through legacy get', async t => {
  const { dir, store } = await fixture(t)
  await store.saveVersioned(workflow(), 0)
  const reopened = createWorkflowStore(dir)
  const versioned = await reopened.getVersioned('cas-flow')
  assert.equal(versioned.revision, 1)
  assert.equal(versioned.document.id, 'cas-flow')
  const legacy = await reopened.get('cas-flow')
  assert.equal(legacy.id, 'cas-flow')
  assert.equal(typeof legacy.updatedAt, 'string')
  assert.equal(Object.hasOwn(legacy, 'revision'), false)
})

test('malformed JSON, invalid legacy schema, and unsupported stored format use one typed read error', async t => {
  const { dir, store } = await fixture(t)
  await t.test('malformed JSON', async () => {
    await writeFile(join(dir, 'cas-flow.json'), '{broken')
    await assert.rejects(store.getVersioned('cas-flow'), { code: 'workflow_store_invalid_record' })
  })
  await t.test('invalid legacy document', async () => {
    await writeFile(join(dir, 'cas-flow.json'), JSON.stringify({ ...workflow(), nodes: [] }))
    await assert.rejects(store.getVersioned('cas-flow'), { code: 'workflow_store_invalid_record' })
  })
  await t.test('unsupported envelope format', async () => {
    await writeFile(join(dir, 'cas-flow.json'), JSON.stringify({ formatVersion: 99, revision: 1 }))
    await assert.rejects(store.getVersioned('cas-flow'), { code: 'workflow_store_invalid_record' })
  })
})

test('invalid workflow IDs keep the existing invalid_workflow parameter error for legacy and versioned reads', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.get('../bad-id'), { code: 'invalid_workflow' })
  await assert.rejects(store.getVersioned('../bad-id'), { code: 'invalid_workflow' })
})
