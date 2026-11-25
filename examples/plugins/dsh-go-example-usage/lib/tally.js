// Token tallies from DSH session events. Pure: no I/O, no clock.
//
// A model call is recorded as an `assistant/message` event whose `data.usage`
// is a TokenUsage (@deepseek-ai/dsh-llm): the counts are disjoint —
// `inputTokens` is uncached input only, cache hits are `cacheReadTokens`,
// `reasoningTokens` is part of `outputTokens`.

/** @typedef {{ input: number, cached: number, cacheWrite: number, output: number, reasoning: number, calls: number }} Totals */

/** @returns {Totals} */
export const emptyTotals = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 })

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The usage one event adds, or undefined when it adds none.
 * @returns {{ totals: Totals, model: string } | undefined}
 */
export function usageOf(event) {
  if (event?.type !== 'assistant/message') return undefined
  const u = event.data?.usage
  if (typeof u !== 'object' || u === null) return undefined
  const totals = {
    input: count(u.inputTokens),
    cached: count(u.cacheReadTokens),
    cacheWrite: count(u.cacheWriteTokens),
    output: count(u.outputTokens),
    reasoning: count(u.reasoningTokens),
    calls: 1,
  }
  const model = event.data?.message?.source?.model
  return { totals, model: typeof model === 'string' && model !== '' ? model : '' }
}

/** a += b, returns a. */
export function addTotals(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] ?? 0
  return a
}

/** All billed tokens: uncached input + cache reads + cache writes + output. */
export const totalTokens = (t) => t.input + t.cached + t.cacheWrite + t.output

/** Share of prompt tokens served from the cache, 0–1; null without prompt tokens. */
export function cacheHitRate(t) {
  const prompt = t.input + t.cached + t.cacheWrite
  return prompt === 0 ? null : t.cached / prompt
}

/**
 * Totals of the events a session wrote itself (a fork's inherited prefix
 * belongs to its parent).
 * @param {readonly any[]} events
 * @param {number} [inherited]
 */
export function sessionTotals(events, inherited = 0) {
  const totals = emptyTotals()
  for (let i = inherited; i < events.length; i++) {
    const u = usageOf(events[i])
    if (u !== undefined) addTotals(totals, u.totals)
  }
  return totals
}

/** The highest event `seq` in a log; -1 without any. */
export function lastSeq(events) {
  let last = -1
  for (const event of events) if (Number.isInteger(event?.seq) && event.seq > last) last = event.seq
  return last
}

/** 980 · 12.4k · 186k · 1.25M */
export function compact(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e5) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1e6) return `${Math.round(n / 1e3)}k`
  return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
}

/** 0.634 → "63%"; null → "—". */
export const percent = (r) => (r === null || !Number.isFinite(r) ? '—' : `${Math.round(r * 100)}%`)

/** Local calendar day of an epoch-ms time: "2026-10-25". */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The `n` local days ending with `today` (oldest first). */
export function lastDays(today, n) {
  const [y, m, d] = today.split('-').map(Number)
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(y, m - 1, d - i, 12).getTime()))
  return out
}
