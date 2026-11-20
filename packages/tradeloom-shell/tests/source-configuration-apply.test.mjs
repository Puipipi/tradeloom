import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('actual retry handler confirms the currently affected views; cancel does not flush/apply and unchanged views do not prompt', async () => {
  const patch = await readFile(new URL('../../../apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/seven-features-desktop.patch', import.meta.url), 'utf8')
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n')
  const start = added.indexOf("bind('configurationApply',"), end = added.indexOf("bind('engineGeneration',", start)
  assert.ok(start >= 0 && end > start)
  const actual = added.slice(start, end), handlers = new Map()
  let affected = true, confirmation = false, prompts = 0, applies = 0, flushes = 0, alive = true
  const unsentAttachments = ['added-after-save']
  new Function('bind', 'configurationOwner', 'queueConfiguration', 'getConfig', 'changedRoleViews', 'confirmConfigurationChange', 'main', 'applyConfiguration', actual)(
    (name, fn) => handlers.set(name, fn), () => () => { if (!alive) throw Error('owner_changed') }, async fn => fn(), async () => ({ revision: 'saved-but-not-applied' }),
    () => affected ? [{ attachments: unsentAttachments }] : [], async () => { prompts++; assert.deepEqual(unsentAttachments, ['added-after-save']); return confirmation }, {},
    async (_next, assertOwner) => { assertOwner(); applies++; flushes++; return { saved: true, applied: true } })
  assert.deepEqual(await handlers.get('configurationApply')({}), { cancelled: true, saved: true, applied: false })
  assert.equal(applies, 0); assert.equal(flushes, 0); assert.equal(prompts, 1)
  confirmation = true; assert.equal((await handlers.get('configurationApply')({})).applied, true)
  affected = false; confirmation = false; assert.equal((await handlers.get('configurationApply')({})).applied, true)
  assert.equal(prompts, 2); assert.equal(applies, 2)
  alive = false; await assert.rejects(handlers.get('configurationApply')({}), /owner_changed/)
})
