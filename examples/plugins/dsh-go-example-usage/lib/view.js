// What the app shows: the panel view (structure, bound to data), the data
// model it binds to, the status-strip line and the summary the copy button
// puts on the clipboard. Pure functions of the tallies.
import { cacheHitRate, compact, lastDays, percent, totalTokens } from './tally.js'

const WORDS = {
  zh: {
    session: '本对话', today: '今日', hit: '缓存命中', week: '近 7 天 · tokens', models: '今日模型',
    input: '输入', cached: '缓存读取', cacheWrite: '缓存写入', output: '输出', reasoning: '其中推理', calls: '模型调用',
    copy: '复制统计', copied: '已复制', strip: (s, t) => (s === null ? `今日 ${t}` : `本对话 ${s} · 今日 ${t}`),
  },
  en: {
    session: 'This chat', today: 'Today', hit: 'Cache hits', week: 'Last 7 days · tokens', models: 'Models today',
    input: 'Input', cached: 'Cache reads', cacheWrite: 'Cache writes', output: 'Output', reasoning: 'Reasoning', calls: 'Model calls',
    copy: 'Copy summary', copied: 'Copied', strip: (s, t) => (s === null ? `Today ${t}` : `Chat ${s} · Today ${t}`),
  },
}

/** zh unless the app's locale says otherwise. */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

const breakdownRows = (w, prefix) => [
  [w.input, { $: `data.${prefix}.input` }],
  [w.cached, { $: `data.${prefix}.cached` }],
  [w.cacheWrite, { $: `data.${prefix}.cacheWrite` }],
  [w.output, { $: `data.${prefix}.output` }],
  [w.reasoning, { $: `data.${prefix}.reasoning` }],
  [w.calls, { $: `data.${prefix}.calls` }],
]

/**
 * The panel. Structure only: every number is a binding into the data model
 * (usageData), so the bridge pushes small patches instead of new views.
 * In a chat (session.tab) it leads with this chat; in All features, with today.
 */
export function usageView(scope, caps) {
  const w = words(caps?.locale)
  const inChat = typeof scope?.sessionId === 'string'
  const lead = inChat
    ? [
        { type: 'metric', label: w.session, value: { $: 'data.session.total' } },
        { type: 'metric', label: w.today, value: { $: 'data.today.total' } },
      ]
    : [{ type: 'metric', label: w.today, value: { $: 'data.today.total' } }]
  return {
    type: 'stack',
    children: [
      { type: 'row', children: [...lead, { type: 'metric', label: w.hit, value: { $: 'data.today.hit' } }] },
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.week.labels' },
        series: [{ name: 'tokens', values: { $: 'data.week.values' } }],
        caption: w.week,
      },
      { type: 'keyValue', items: breakdownRows(w, inChat ? 'session' : 'today') },
      { type: 'text', text: w.models, tone: 'muted' },
      { type: 'list', items: { $: 'data.models' } },
      { type: 'actions', items: [{ label: w.copy, icon: 'summary', action: 'copy' }] },
    ],
  }
}

const breakdown = (t) => ({
  total: compact(totalTokens(t)),
  input: compact(t.input),
  cached: compact(t.cached),
  cacheWrite: compact(t.cacheWrite),
  output: compact(t.output),
  reasoning: compact(t.reasoning),
  calls: String(t.calls),
  hit: percent(cacheHitRate(t)),
})

/**
 * The data model the panel binds to. Language-neutral: numbers and model
 * names only, so one feed serves every locale.
 * @param {{ session: import('./tally.js').Totals | null, ledger: import('./ledger.js').Ledger }} input
 */
export function usageData({ session, ledger }) {
  const today = ledger.today()
  const day = ledger.day(today)
  const days = lastDays(today, 7)
  const models = Object.entries(day.models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([model, tokens]) => ({ title: model, trailing: compact(tokens), icon: 'robot' }))
  return {
    session: session === null ? null : breakdown(session),
    today: breakdown(day.totals),
    week: {
      labels: days.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`),
      values: days.map((d) => totalTokens(ledger.day(d).totals)),
    },
    models,
  }
}

/** The status-strip line (≤ 24 characters): this chat and today. */
export function stripData({ session, ledger }, locale) {
  const w = words(locale)
  const today = compact(totalTokens(ledger.day(ledger.today()).totals))
  return { text: w.strip(session === null ? null : compact(totalTokens(session)), today), icon: 'chart' }
}

/** Plain-text summary for the clipboard. */
export function summaryText(data, locale) {
  const w = words(locale)
  const lines = []
  if (data.session) lines.push(`${w.session}: ${data.session.total} tokens (${w.input} ${data.session.input}, ${w.cached} ${data.session.cached}, ${w.output} ${data.session.output})`)
  lines.push(`${w.today}: ${data.today.total} tokens, ${w.hit} ${data.today.hit}`)
  for (const m of data.models) lines.push(`- ${m.title}: ${m.trailing}`)
  return lines.join('\n')
}
