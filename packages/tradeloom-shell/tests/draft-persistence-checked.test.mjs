import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Execute the exact authored methods, not a handwritten storage checker.
// The controlled writer/store is deliberately isolated from browser profiles.
const contract = JSON.parse(await readFile(new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/conversation-draft-checked.contract.json', import.meta.url), 'utf8'))
const fragment = contract.fragments.find(item => item.after.includes('persistVerifiedDraft(sessionId){')).after
const methods = fragment.slice(fragment.indexOf('persistVerifiedDraft(sessionId){'), fragment.lastIndexOf('requestDraftInitialization'))
function fixture() {
  const values = new Map(), writes = [], reads = []
  const storage = { getItem(key) { reads.push(key); return values.get(key) ?? null } }
  const Checked = new Function('localStorage', 'CONVERSATION_STORE_KEY', `return class {${methods}}`)(storage, 'dsh.conversation')
  const shell = new Checked()
  Object.assign(shell, { disposed: false, deps: { sessionId: 'one' }, persistSessionId: 'one', rev: 1,
    draftSnapshot: { text: 'synthetic', references: [{ id: 'explicit-reference' }], quotes: ['synthetic quote'] },
    setDraft(value) { this.draftSnapshot = typeof value === 'string' ? { text: value, references: [], quotes: [] } : value; this.rev++ },
    persistCurrentDraft() { this.persistDraft?.(this.draftSnapshot) },
    persistDraft(snapshot) { writes.push(snapshot); values.set('dsh.conversation.one', JSON.stringify({ draft: snapshot })) },
  })
  return { shell, values, writes, reads }
}
test('checked action requires real writer and exact bound persisted draft, including explicit empty', () => {
  const f = fixture()
  assert.deepEqual(f.shell.persistVerifiedDraft('one'), { persisted: true, sessionId: 'one', draftRevision: 1 })
  assert.deepEqual(f.reads, ['dsh.conversation.one'])
  f.shell.setDraft(''); assert.equal(f.shell.persistVerifiedDraft('one').persisted, true)
  f.shell.persistDraft = undefined; assert.throws(() => f.shell.persistVerifiedDraft('one'), { code: 'draft_persistence_unbound' })
})
test('swallowed quota/missing/invalid/mismatched persisted values never confirm success', () => {
  for (const [raw, code] of [[null, 'draft_persistence_missing'], ['{', 'draft_persistence_invalid'], ['{}', 'draft_persistence_missing'], [JSON.stringify({ draft: { text: '' } }), 'draft_persistence_mismatch']]) {
    const f = fixture(); f.shell.persistDraft = () => {}; if (raw !== null) f.values.set('dsh.conversation.one', raw)
    assert.throws(() => f.shell.persistVerifiedDraft('one'), { code })
  }
  const f = fixture(); f.shell.persistDraft = () => { throw Object.assign(Error(), { name: 'QuotaExceededError' }) }
  assert.throws(() => f.shell.persistVerifiedDraft('one'), { code: 'draft_persistence_write_failed' })
})
test('discard failure restores complete serializer snapshot; attachments stay outside this operation', () => {
  const f = fixture(), original = f.shell.draftSnapshot, attachments = [{ opaque: 'existing' }]
  const write = f.shell.persistDraft; let n = 0
  f.shell.persistDraft = value => { if (++n === 2) return; write(value) }
  assert.throws(() => f.shell.discardVerifiedDraft('one'), { code: 'draft_persistence_mismatch' })
  assert.deepEqual(f.shell.draftSnapshot, original); assert.equal(attachments.length, 1)
  f.shell.persistSessionId = 'two'; assert.throws(() => f.shell.persistVerifiedDraft('one'), { code: 'draft_persistence_unbound' })
})
