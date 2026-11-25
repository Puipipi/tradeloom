// dsh-go-example-usage: token usage of this chat and of today, as a status
// strip above the composer and a native panel (chat details › Plugins, and
// All features). Counts come from the engine's own session events; no network.
//
// Host half only — the manifest (package.json "dshGo") declares the strip and
// the panel; this file feeds them. Without the dsh-go bridge on the host the
// `ctx.inject(['dshGo'], …)` callback never runs and the plugin just counts.
import { Ledger } from './ledger.js'
import { addTotals, lastSeq, sessionTotals, usageOf } from './tally.js'
import { stripData, summaryText, usageData, usageView, words } from './view.js'

export const name = 'dsh-go-example-usage'

/** @param {{ ledgerPath?: string | null }} [options] for tests */
export function apply(ctx, options = {}) {
  const ledger = new Ledger(options.ledgerPath === undefined ? {} : { path: options.ledgerPath })
  /** sessionId -> totals of that chat and the last event seq in them: filled on first look, then kept current from events. */
  const chats = new Map()
  /** Feeds to re-emit after a model call. */
  const listeners = new Set()

  const sessions = () => {
    try {
      return ctx.get('sessions')
    } catch {
      return undefined
    }
  }

  /**
   * First look at a session: its totals from its log, and its calls the
   * ledger has not seen (made before the plugin was watching) counted once,
   * so 「今日」 includes them too.
   */
  function look(session) {
    let events
    try {
      events = session.snapshotEvents()
    } catch {
      return undefined
    }
    const inherited = session.inheritedEventCount ?? 0
    const entry = { totals: sessionTotals(events, inherited), seq: lastSeq(events) }
    ledger.backfill(session.id, events, inherited)
    chats.set(session.id, entry)
    return entry
  }

  /** Totals of a live chat, or null when the host has not loaded it. */
  function chat(sessionId) {
    if (typeof sessionId !== 'string') return null
    const known = chats.get(sessionId)
    if (known !== undefined) return known.totals
    const session = sessions()?.get?.(sessionId)
    if (session === undefined) return null
    return look(session)?.totals ?? null
  }

  ctx.on('session/event', (session, event) => {
    const usage = usageOf(event)
    if (usage === undefined) return
    const seq = Number.isInteger(event.seq) ? event.seq : undefined
    // A session met for the first time: its earlier calls first (the log may
    // already hold this one; the seqs keep it from counting twice).
    const known = chats.get(session.id) ?? (typeof session.snapshotEvents === 'function' ? look(session) : undefined)
    ledger.add(typeof event.time === 'number' ? event.time : Date.now(), usage.totals, usage.model, session.id, seq)
    if (known !== undefined && (seq === undefined || seq > known.seq)) {
      addTotals(known.totals, usage.totals)
      if (seq !== undefined) known.seq = seq
    }
    for (const notify of listeners) notify()
  })
  ctx.on('session/disposed', (session) => chats.delete(session.id))
  ctx.effect(() => () => ledger.dispose())

  /** Emit now and after every model call until cancelled. */
  const watch = (push) => {
    push()
    listeners.add(push)
    return () => listeners.delete(push)
  }
  const snapshot = (scope) => ({ session: chat(scope?.sessionId), ledger })

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('usage', {
      view: (scope, caps) => usageView(scope, caps),
      data: (scope, emit) => watch(() => emit(usageData(snapshot(scope)))),
      actions: {
        copy: (scope, event) => [
          { type: 'copy', text: summaryText(usageData(snapshot(scope)), event?.locale) },
          { type: 'toast', text: words(event?.locale).copied },
        ],
      },
    })
    ctx.dshGo.strip('today', (scope, emit, caps) => watch(() => emit(stripData(snapshot(scope), caps?.locale))))
  })
}
