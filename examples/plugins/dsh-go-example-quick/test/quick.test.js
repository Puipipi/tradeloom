// Runs the plugin against the plugin-kit test host (the bridge's own manifest
// and effect code), so these are the answers the app would get.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { apply } from '../lib/index.js'
import { toMarkdown } from '../lib/actions.js'

const dir = fileURLToPath(new URL('..', import.meta.url))

function host(services = {}) {
  const h = createTestHost({ dir, services })
  apply(h.ctx)
  return h
}

test('manifest: two capsules and two menu items, all ready, no issues', () => {
  const row = host().contributions()
  assert.equal(row.state, 'ok')
  assert.deepEqual(row.issues, [])
  assert.deepEqual(row.contributes['composer.actions'].map((a) => [a.id, a.label, a.ready, a.effect?.[0]?.type]), [
    ['summarize', '总结', true, 'insert'],
    ['translate', '译成英文', true, undefined],
  ])
  assert.deepEqual(row.contributes['message.actions'].map((a) => [a.id, a.label]), [
    ['copy-md', '复制为 Markdown'],
    ['save-note', '存进笔记'],
  ])
  const en = host().contributions({ locale: 'en-US' })
  assert.deepEqual(en.issues, [], 'English labels fit too')
  assert.equal(en.title, 'Quick')
})

test('the static capsule never invokes', async () => {
  await assert.rejects(host().invoke('summarize'), { status: 409, code: 'no-handler' })
})

test('译成英文: clipboard into a translation request, never sent', async () => {
  const { effects } = await host().invoke('translate', { context: { clipboard: '今天天气不错' } })
  assert.deepEqual(effects, [{ type: 'insert', text: '把下面这段译成英文，只给译文：\n\n今天天气不错' }])
  const empty = await host().invoke('translate', { context: {} })
  assert.deepEqual(empty.effects, [{ type: 'toast', text: '剪贴板里没有文字' }])
  const long = await host().invoke('translate', { context: { clipboard: '字'.repeat(3000) }, locale: 'en' })
  assert.equal(long.effects[0].type, 'insert')
  assert.equal([...long.effects[0].text].length, 2000)
  assert.match(long.effects[1].text, /^Too long/)
  assert.deepEqual(long.issues, [])
})

/** A fake DSH llm service streaming `reply` (or failing), as prepareCall/stream do. */
function fakeModel(reply, { fail = false, delayMs = 0 } = {}) {
  const calls = []
  const llm = {
    async prepareCall(config, signal) {
      calls.push({ config })
      return {
        config: { ...config },
        async *stream(options) {
          calls.at(-1).options = options
          if (delayMs) await new Promise((r, j) => {
            const t = setTimeout(r, delayMs)
            options.signal?.addEventListener('abort', () => { clearTimeout(t); j(options.signal.reason) })
          })
          if (fail) {
            yield { type: 'finish', reason: { kind: 'error' } }
            return
          }
          yield { type: 'block-start', index: 0, blockType: 'text' }
          for (const part of reply.match(/.{1,5}/gs) ?? []) yield { type: 'text-delta', index: 0, text: part }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  return { services: { llm, agentDefaultModel }, calls }
}

test('译成英文 with a model: pending at once, the translation lands later', async () => {
  const { services, calls } = fakeModel('The weather is nice today.')
  const h = host(services)
  const r = await h.invoke('translate', { context: { clipboard: '今天天气不错' } })
  assert.deepEqual(r.effects, [])
  assert.deepEqual({ label: r.pending.label, timeoutMs: r.pending.timeoutMs }, { label: '正在翻译', timeoutMs: 60000 })
  assert.deepEqual(await r.settled, { t: 'done', effects: [{ type: 'insert', text: 'The weather is nice today.' }] })
  assert.deepEqual(calls[0].config, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 })
  assert.deepEqual(calls[0].options.messages, [{ role: 'user', content: [{ type: 'text', text: '今天天气不错' }] }])
  assert.match(calls[0].options.system, /^Translate the user's text into English/)
})

test('a failed or cancelled translation settles void and inserts nothing', async () => {
  const failed = await host(fakeModel('', { fail: true }).services).invoke('translate', { context: { clipboard: 'x' } })
  assert.deepEqual(await failed.settled, { t: 'void', reason: 'error' })
  const slow = await host(fakeModel('late', { delayMs: 5000 }).services).invoke('translate', { context: { clipboard: 'x' } })
  slow.cancel()
  assert.deepEqual(await slow.settled, { t: 'void', reason: 'cancelled' })
})

test('the bridge drops context the manifest did not ask for', async () => {
  // draft is not in wants: the handler never sees it.
  const { effects } = await host().invoke('translate', { context: { draft: 'secret draft' } })
  assert.deepEqual(effects, [{ type: 'toast', text: '剪贴板里没有文字' }])
})

test('复制为 Markdown drops dsh-ui cards', async () => {
  const message = '结论如下。\n\n```dsh-ui\n{"type":"metric","label":"a","value":1}\n```\n\n\n\n- 第一点  \n- 第二点'
  assert.equal(toMarkdown(message), '结论如下。\n\n- 第一点\n- 第二点')
  const { effects } = await host().invoke('copy-md', { context: { message } })
  assert.deepEqual(effects, [{ type: 'copy', text: '结论如下。\n\n- 第一点\n- 第二点' }, { type: 'toast', text: '已复制' }])
})

test('存进笔记 appends to notes/<today>.md in the chat folder', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'quick-'))
  try {
    const sessions = { get: (id) => (id === 's1' ? { header: { cwd } } : undefined) }
    const h = host({ sessions })
    const r1 = await h.invoke('save-note', { scope: { sessionId: 's1' }, context: { message: '第一条' } })
    await h.invoke('save-note', { scope: { sessionId: 's1' }, context: { message: '第二条' } })
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    assert.deepEqual(r1.effects, [{ type: 'toast', text: `已存到 notes/${day}.md` }])
    const body = readFileSync(join(cwd, 'notes', `${day}.md`), 'utf8')
    assert.match(body, /## \d\d:\d\d\n\n第一条\n\n## \d\d:\d\d\n\n第二条\n$/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('without the bridge nothing is registered and nothing breaks', () => {
  const h = createTestHost({ dir, bridge: false })
  apply(h.ctx)
  assert.equal(h.pending.length, 1)
  assert.deepEqual(h.pending[0].missing, ['dshGo'])
})
