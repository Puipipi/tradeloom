import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { apply } from '../lib/index.js'
import { Ledger } from '../lib/ledger.js'
import { cacheHitRate, compact, dayKey, lastDays, sessionTotals, usageOf } from '../lib/tally.js'

const dir = fileURLToPath(new URL('..', import.meta.url))

let nextSeq = 1

/** An assistant/message event as dsh-agent-loop appends it (seq: the session log's own numbering). */
const call = (usage, model = 'deepseek-chat', time = Date.now(), seq = nextSeq++) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { provider: 'deepseek', model } }, usage },
})

const U = (input, cached, output, reasoning = 0) => ({ inputTokens: input, cacheReadTokens: cached, outputTokens: output, reasoningTokens: reasoning })

function fakeSession(id, events, inherited = 0) {
  return { id, inheritedEventCount: inherited, header: { id }, snapshotEvents: () => events }
}

function host(sessionList = []) {
  const sessions = { get: (id) => sessionList.find((s) => s.id === id) }
  const h = createTestHost({ dir, services: { sessions } })
  apply(h.ctx, { ledgerPath: null })
  return h
}

test('tally: disjoint TokenUsage counts, forks skip the inherited prefix', () => {
  const events = [call(U(1000, 0, 200)), { type: 'user/message', data: {} }, call(U(300, 900, 100, 40)), call(undefined)]
  const t = sessionTotals(events)
  assert.deepEqual(t, { input: 1300, cached: 900, cacheWrite: 0, output: 300, reasoning: 40, calls: 2 })
  assert.equal(sessionTotals(events, 2).calls, 1)
  assert.equal(cacheHitRate(t), 900 / 2200)
  assert.equal(usageOf({ type: 'assistant/message', data: { usage: { inputTokens: -5, outputTokens: Number.NaN } } }).totals.input, 0)
  assert.deepEqual([980, 12_400, 186_000, 1_250_000].map(compact), ['980', '12.4k', '186k', '1.25M'])
  assert.deepEqual(lastDays('2026-03-02', 3), ['2026-02-28', '2026-03-01', '2026-03-02'])
})

test('manifest: a live strip that opens a live panel', () => {
  const row = host().contributions()
  assert.equal(row.state, 'ok')
  assert.deepEqual(row.issues, [])
  assert.deepEqual(row.contributes['composer.strip'], [{ id: 'today', icon: 'chart', text: null, panel: 'usage', tappable: true, live: true, ready: true }])
  assert.deepEqual(row.contributes.panels, [{ id: 'usage', title: '用量', icon: 'chart', placement: ['session.tab', 'features'], ready: true, live: true }])
})

test('panel in a chat: this chat first; data follows new model calls', async () => {
  const s1 = fakeSession('s1', [call(U(1200, 3000, 400))])
  const h = host([s1])
  const { view, stats } = await h.view('usage', { sessionId: 's1' })
  assert.deepEqual(view.children[0].children.map((m) => m.label), ['本对话', '今日', '缓存命中'])
  assert.deepEqual(view.children.map((c) => c.type), ['row', 'chart', 'keyValue', 'text', 'list', 'actions'])
  assert.ok(stats.nodes <= 120 && stats.depth <= 8)

  const feed = h.subscribe('usage', { sessionId: 's1' })
  assert.equal(feed.data.session.total, '4.6k')
  assert.equal(feed.data.today.total, '4.6k', "today includes this chat's calls from before the plugin started")
  assert.equal(feed.data.week.values.length, 7)
  assert.deepEqual(feed.data.models, [{ title: 'deepseek-chat', trailing: '4.6k', icon: 'robot' }])

  h.emitEvent('session/event', s1, call(U(500, 1500, 300), 'deepseek-reasoner'))
  assert.equal(feed.history.length, 2)
  assert.equal(feed.data.session.total, '6.9k')
  assert.equal(feed.data.today.total, '6.9k')
  assert.equal(feed.data.today.hit, '73%')
  assert.deepEqual(feed.data.models, [
    { title: 'deepseek-chat', trailing: '4.6k', icon: 'robot' },
    { title: 'deepseek-reasoner', trailing: '2.3k', icon: 'robot' },
  ])
  feed.stop()
  h.emitEvent('session/event', s1, call(U(1, 1, 1)))
  assert.equal(feed.history.length, 2, 'cancelled feeds stay quiet')
})

test('panel in All features: no chat, leads with today', async () => {
  const { view } = await host().view('usage', {}, { locale: 'en' })
  assert.deepEqual(view.children[0].children.map((m) => m.label), ['Today', 'Cache hits'])
  assert.equal(view.children[5].items[0].label, 'Copy summary')
})

test('strip: one short line, this chat and today', () => {
  const s1 = fakeSession('s1', [call(U(10_000, 2_000, 400))])
  const h = host([s1])
  const strip = h.subscribe('today', { sessionId: 's1' })
  assert.deepEqual(strip.data, { text: '本对话 12.4k · 今日 12.4k', icon: 'chart' })
  h.emitEvent('session/event', s1, call(U(100_000, 80_000, 6_000)))
  assert.equal(strip.data.text, '本对话 198k · 今日 198k')
  assert.ok([...strip.data.text].length <= 24)
  const unknown = h.subscribe('today', { sessionId: 'not-loaded' })
  assert.equal(unknown.data.text, '今日 198k')
})

test('copy summary: clipboard text plus a toast', async () => {
  const s1 = fakeSession('s1', [call(U(1200, 3000, 400))])
  const { effects, issues } = await host([s1]).invoke('usage', { surface: 'panel', action: 'copy', scope: { sessionId: 's1' } })
  assert.deepEqual(issues, [])
  assert.equal(effects[0].type, 'copy')
  assert.match(effects[0].text, /^本对话: 4\.6k tokens/)
  assert.deepEqual(effects[1], { type: 'toast', text: '已复制' })
})

test('ledger: survives a restart, keeps 30 days', () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-'))
  const path = join(home, 'days.json')
  try {
    const now = new Date(2026, 9, 25, 12).getTime()
    const a = new Ledger({ path, now: () => now })
    for (let i = 0; i < 40; i++) a.add(now - i * 86_400_000, usageOf(call(U(10, 0, 5))).totals, 'm')
    a.dispose()
    a.save()
    const b = new Ledger({ path, now: () => now })
    assert.equal(Object.keys(b.days).length, 30)
    assert.equal(b.day(dayKey(now)).totals.input, 10)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).v, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('today: a chat\'s earlier calls count once — from its log, live, after a restart', () => {
  const now = Date.now()
  const yesterday = now - 86_400_000
  const old = call(U(1_000, 0, 0), 'deepseek-chat', yesterday)
  const a = call(U(2_000, 0, 0))
  const b = call(U(3_000, 0, 0))
  const log = [old, a, b]
  const s1 = fakeSession('s1', log)
  const h = host([s1])
  const strip = h.subscribe('today', { sessionId: 's1' })
  assert.equal(strip.data.text, '本对话 6k · 今日 5k', 'yesterday stays in yesterday')

  // The log already holds the call the event announces: no second count.
  h.emitEvent('session/event', s1, b)
  assert.equal(strip.data.text, '本对话 6k · 今日 5k')
  const c = call(U(4_000, 0, 0))
  log.push(c)
  h.emitEvent('session/event', s1, c)
  assert.equal(strip.data.text, '本对话 10k · 今日 9k')

  // A session first met through a live event: its earlier calls come first.
  const s2 = fakeSession('s2', [call(U(500, 0, 0))])
  h.emitEvent('session/event', s2, call(U(700, 0, 0)))
  assert.equal(strip.data.text, '本对话 10k · 今日 10.2k')

  const home = mkdtempSync(join(tmpdir(), 'usage-'))
  const path = join(home, 'days.json')
  try {
    const first = new Ledger({ path })
    first.backfill('s1', log)
    first.add(now, usageOf(call(U(9, 0, 0))).totals, 'm', 's1', c.seq + 1)
    first.dispose()
    first.save()
    const again = new Ledger({ path })
    again.backfill('s1', [...log, call(U(9, 0, 0), 'm', now, c.seq + 1)])
    assert.equal(again.day(dayKey(now)).totals.input, 9_009, 'nothing counted twice after a restart')
    assert.equal(again.day(dayKey(yesterday)).totals.input, 1_000)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).v, 2)

    // A ledger from before the marks (v1): its calls may already be in it.
    writeFileSync(path, JSON.stringify({ v: 1, days: { [dayKey(now)]: { totals: { input: 5 }, models: {} } } }))
    const legacy = new Ledger({ path })
    legacy.backfill('s1', log)
    assert.equal(legacy.day(dayKey(now)).totals.input, 5)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
