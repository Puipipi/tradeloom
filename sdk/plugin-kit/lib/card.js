// Tool cards: a view carried in a DSH tool's `presentationMeta`
// (docs/plugins/quickstart.md). Zero dependencies.

/** The key the dsh-go app reads from `tool/result.meta`. */
export const VIEW_KEY = 'dsh-go/view'

/** A tool card is written into the conversation log, so it must stay small. */
export const CARD_MAX_BYTES = 8 * 1024

/**
 * Round-trip a value through JSON: drops `undefined` fields and functions,
 * turns NaN / ±Infinity into null and -0 into 0, flattens Dates to strings.
 * Returns undefined when the value has no JSON form (a bare undefined, a
 * function, a cycle, a BigInt).
 * @param {unknown} value
 * @returns {import('../types/index.js').JsonValue | undefined}
 */
export function toLosslessJson(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return undefined
  }
  return text === undefined ? undefined : JSON.parse(text)
}

/** UTF-8 size of a value's JSON text. */
export function jsonBytes(value) {
  const text = JSON.stringify(value)
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
}

/**
 * Wrap a view builder for a DSH tool's `output.presentationMeta`.
 *
 * DSH fails the whole tool call when presentationMeta throws or returns a
 * value that is not lossless JSON. The wrapper never throws: a builder error,
 * a view over `maxBytes` or a builder returning null/undefined gives `{}` (no
 * card, the app shows its generic tool row). `meta` merges extra keys of your
 * own next to the view.
 *
 * @template A, V
 * @param {(args: A, value: V) => import('../types/index.js').View | null | undefined} build
 * @param {{ maxBytes?: number, meta?: (args: A, value: V) => Record<string, unknown>, onError?: (error: unknown) => void }} [options]
 * @returns {(args: A, value: V) => Record<string, import('../types/index.js').JsonValue>}
 */
export function toolCard(build, options = {}) {
  const maxBytes = options.maxBytes ?? CARD_MAX_BYTES
  return (args, value) => {
    let extra = {}
    try {
      if (options.meta) extra = toLosslessJson(options.meta(args, value)) ?? {}
      if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) extra = {}
    } catch (error) {
      options.onError?.(error)
      extra = {}
    }
    try {
      const view = toLosslessJson(build(args, value))
      if (view === undefined || view === null) return extra
      if (jsonBytes(view) > maxBytes) {
        options.onError?.(new RangeError(`tool card is ${jsonBytes(view)} bytes, over ${maxBytes}`))
        return extra
      }
      return { ...extra, [VIEW_KEY]: view }
    } catch (error) {
      options.onError?.(error)
      return extra
    }
  }
}

/**
 * The view inside a tool result's meta, if any (for tests and tooling).
 * @param {unknown} meta
 */
export function viewOfMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  return /** @type {Record<string, unknown>} */ (meta)[VIEW_KEY]
}
