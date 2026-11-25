// What the bridge does with a handler's return value, for unit tests:
// checkEffects(result) → { effects, issues, violation } (the shorthand expanded,
// each effect checked against the whitelist and its limits), and
// checkPending(result) → the deferred request as the bridge reads it, or undefined.
// Both are the bridge's own code (lib/bridge/effects.js).
import { normalize, splitPending } from './bridge/effects.js'

/**
 * @param {unknown} result a handler's return value (or a deferred result's value with `deferred: true`)
 * @param {{ panels?: Iterable<string>, source?: string, deferred?: boolean, capabilities?: { declared: string[], features: string[], media?: string[], overlays?: string[] } }} [options]
 *   panels: this plugin's panel ids (for `open: panel:<id>`, refresh, patch); source: the panel a tap came from.
 */
export function checkEffects(result, options = {}) {
  return normalize(result, { panels: new Set(options.panels ?? []), source: options.source, deferred: options.deferred === true, capabilities: options.capabilities, userGesture: options.userGesture === true, fileResult: options.fileResult === true })
}

/** The deferred request in a handler's return value: { ok, label?, timeoutMs, work, issues, violation }, or undefined. */
export function checkPending(result) {
  return splitPending(result)
}
