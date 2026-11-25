// Daily token ledger: what every session used per local day and per model,
// kept in $DSH_HOME/cache/dsh-go-example-usage/days.json (last 30 days).
// Calls are counted live from `session/event`s, and a session's earlier calls
// (made before the plugin was watching) once when it is first looked at.
// Each session's last counted event `seq` is kept, so a call is never
// counted twice: not live and again from the log, not again after a restart.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { addTotals, dayKey, emptyTotals, lastDays, usageOf } from './tally.js'

const KEEP_DAYS = 30
const SAVE_DELAY_MS = 2000

export function defaultLedgerPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-go-example-usage', 'days.json')
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function cleanTotals(raw) {
  const t = emptyTotals()
  if (isObject(raw)) for (const k of Object.keys(t)) if (Number.isFinite(raw[k]) && raw[k] > 0) t[k] = raw[k]
  return t
}

export class Ledger {
  /** @param {{ path?: string | null, now?: () => number }} [options] path null = memory only (tests). */
  constructor(options = {}) {
    this.path = options.path === undefined ? defaultLedgerPath() : options.path
    this.now = options.now ?? Date.now
    /** @type {Record<string, { totals: import('./tally.js').Totals, models: Record<string, number> }>} */
    this.days = {}
    /** @type {Record<string, { seq: number, day: string }>} sessionId -> last counted event. */
    this.marks = {}
    /** Calls before this were possibly counted by a ledger that kept no marks (v1): not taken from logs. */
    this.backfillFrom = 0
    this.timer = undefined
    this.load()
  }

  load() {
    if (this.path === null) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if ((raw?.v !== 1 && raw?.v !== 2) || !isObject(raw.days)) return
      if (raw.v === 1) this.backfillFrom = this.now()
      if (isObject(raw.marks)) {
        for (const [id, mark] of Object.entries(raw.marks)) {
          if (isObject(mark) && Number.isInteger(mark.seq) && typeof mark.day === 'string') this.marks[id] = { seq: mark.seq, day: mark.day }
        }
      }
      for (const [day, entry] of Object.entries(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(entry)) continue
        const models = {}
        if (isObject(entry.models)) for (const [m, n] of Object.entries(entry.models)) if (Number.isFinite(n) && n > 0) models[m] = n
        this.days[day] = { totals: cleanTotals(entry.totals), models }
      }
    } catch {
      // First run, or a damaged file: start empty.
    }
  }

  /**
   * Count one model call at epoch-ms `time`. With the `session` id and the
   * event's `seq`, a call already counted is skipped. Returns whether it counted.
   */
  add(time, totals, model, session, seq) {
    const day = dayKey(time)
    if (typeof session === 'string' && Number.isInteger(seq)) {
      const mark = this.marks[session]
      if (mark !== undefined && seq <= mark.seq) return false
      this.marks[session] = { seq, day }
    }
    const entry = (this.days[day] ??= { totals: emptyTotals(), models: {} })
    addTotals(entry.totals, totals)
    const key = model || '—'
    entry.models[key] = (entry.models[key] ?? 0) + totals.input + totals.cached + totals.cacheWrite + totals.output
    this.prune()
    this.scheduleSave()
    return true
  }

  /**
   * A session's calls from its log (`events`, the first `inherited` belong
   * to the session it was forked from): those within the kept days that are
   * not counted yet.
   */
  backfill(session, events, inherited = 0) {
    const oldest = lastDays(this.today(), KEEP_DAYS)[0]
    for (let i = inherited; i < events.length; i++) {
      const event = events[i]
      const usage = usageOf(event)
      if (usage === undefined || typeof event.time !== 'number' || !Number.isInteger(event.seq)) continue
      if (event.time <= this.backfillFrom || dayKey(event.time) < oldest) continue
      this.add(event.time, usage.totals, usage.model, session, event.seq)
    }
  }

  /** @returns {{ totals: import('./tally.js').Totals, models: Record<string, number> }} */
  day(key) {
    return this.days[key] ?? { totals: emptyTotals(), models: {} }
  }

  today() {
    return dayKey(this.now())
  }

  prune() {
    const keys = Object.keys(this.days).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.days[k]
    const oldest = lastDays(this.today(), KEEP_DAYS)[0]
    for (const [id, mark] of Object.entries(this.marks)) if (mark.day < oldest) delete this.marks[id]
  }

  scheduleSave() {
    if (this.path === null || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.save()
    }, SAVE_DELAY_MS)
    this.timer.unref?.()
  }

  save() {
    if (this.path === null) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(`${this.path}.tmp`, JSON.stringify({ v: 2, days: this.days, marks: this.marks }))
      renameSync(`${this.path}.tmp`, this.path)
    } catch {
      // Read-only home: keep counting in memory.
    }
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.save()
    }
  }
}
