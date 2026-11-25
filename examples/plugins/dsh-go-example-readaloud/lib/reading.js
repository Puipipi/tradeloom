// One reading per conversation: what is being read, when its sound started, and who shows the
// caption. The caption ticks (10 times a second at most — the bridge enforces it anyway) only
// while sound plays; without a reading or a subscriber there is no timer at all.
import { randomBytes } from 'node:crypto'
import { captionAt, plan, plainText, synthesize } from './speech.js'

const TICK_MS = 100

/** Readings keyed by conversation; [now] is the clock (tests move it). */
export function createReadings({ now = () => Date.now(), lead = 150 } = {}) {
  const readings = new Map()
  const viewers = new Map() // sessionKey -> Set<emit>
  const keyOf = (scope) => scope?.sessionId ?? '-'

  function tick(sessionKey) {
    const r = readings.get(sessionKey)
    const emits = viewers.get(sessionKey)
    if (!r || r.startedAt === undefined || r.done || !emits?.size) return stop(r)
    const value = captionAt(r.plan, Math.max(0, now() - r.startedAt))
    if (value) for (const emit of emits) emit(value)
    if (now() - r.startedAt >= r.plan.duration) stop(r)
  }

  function start(sessionKey) {
    const r = readings.get(sessionKey)
    if (!r || r.timer || r.done || r.startedAt === undefined || !viewers.get(sessionKey)?.size) return
    r.timer = setInterval(() => tick(sessionKey), TICK_MS)
    r.timer.unref?.()
    tick(sessionKey)
  }

  function stop(r) {
    if (r?.timer) clearInterval(r.timer)
    if (r) r.timer = undefined
  }

  return {
    /** A tap on 朗读: the reply's text becomes the next reading; null when there is nothing to read. */
    begin(scope, message) {
      const text = plainText(message)
      if (!text) return null
      const key = keyOf(scope)
      stop(readings.get(key))
      const r = { key: randomBytes(9).toString('base64url'), plan: plan(text), startedAt: undefined, done: false, timer: undefined }
      readings.set(key, r)
      return r.key
    },

    /** The app asks for the sound of reading [key]: the clip, and the caption starts with it. */
    clip(scope, key) {
      const sessionKey = keyOf(scope)
      const r = readings.get(sessionKey)
      if (!r || r.key !== key) return null
      const body = synthesize(r.plan)
      // The app plays it as soon as it has it; start the caption a moment later.
      r.startedAt = now() + lead
      start(sessionKey)
      return body
    },

    /** The sound ended, was stopped, or the person spoke: the caption stops where it is. */
    end(scope) {
      const r = readings.get(keyOf(scope))
      if (!r) return
      r.done = true
      stop(r)
    },

    /** A caption viewer (the app's micro subscription); returns its cancel. */
    watch(scope, emit) {
      const sessionKey = keyOf(scope)
      if (!viewers.has(sessionKey)) viewers.set(sessionKey, new Set())
      viewers.get(sessionKey).add(emit)
      start(sessionKey)
      return () => {
        const set = viewers.get(sessionKey)
        set?.delete(emit)
        if (!set?.size) {
          viewers.delete(sessionKey)
          stop(readings.get(sessionKey))
        }
      }
    },

    /** Tests. */
    get(scope) {
      return readings.get(keyOf(scope))
    },
    ticking() {
      return [...readings.values()].some((r) => r.timer !== undefined)
    },
  }
}
