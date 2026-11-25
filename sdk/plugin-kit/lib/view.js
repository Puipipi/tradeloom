// Component builders for dsh-go plugin views (docs/design/native-plugins-views.md).
// Each returns a plain JSON node `{ type, ...props }` with undefined props
// dropped, so a builder tree and a hand-written literal are interchangeable.
// Zero dependencies; validation is `check`'s job, not the builders'.

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** True for a binding `{ "$": "data.path" }` (exactly one key). */
export const isBinding = (v) => isObject(v) && Object.keys(v).length === 1 && typeof v.$ === 'string'

/**
 * A value read from the view's data model: `bind('data.session.cost')`.
 * A path without the leading `data` gets it prepended.
 * @param {string} path
 */
export function bind(path) {
  const p = String(path)
  return { $: p === 'data' || p.startsWith('data.') || p.startsWith('data[') ? p : `data.${p}` }
}

function node(type, props) {
  const out = { type }
  for (const [k, v] of Object.entries(props ?? {})) if (v !== undefined && k !== 'type') out[k] = v
  return out
}

/** `(items)` or `(props)` for components whose one required field is a list. */
const listOr = (type, field) => (a, b) =>
  Array.isArray(a) || isBinding(a) ? node(type, { ...b, [field]: a }) : node(type, a)

/** `(value)` or `(props)` for components with one obvious leading value. */
const valueOr = (type, field) => (a, b) =>
  isObject(a) && !isBinding(a) ? node(type, a) : node(type, { ...b, [field]: a })

// ── layout ────────────────────────────────────────────────────────────────

/** Vertical stack: `stack([...children], { title })` or `stack({ title, children })`. */
export const stack = listOr('stack', 'children')
/** Horizontal row; wraps on narrow screens: `row([...children])`. */
export const row = listOr('row', 'children')

// ── the dsh-ui ten ────────────────────────────────────────────────────────

/** Paragraph: `text('…', { tone: 'muted' })`. */
export const text = valueOr('text', 'text')
/** One key number: `metric({ label, value, tone?, caption? })`. */
export const metric = (props) => node('metric', props)
/** `chart({ kind: 'bar' | 'hbar' | 'line' | 'donut', categories, series: [{ name?, values }], unit?, caption? })`. */
export const chart = (props) => node('chart', props)
/** Side-by-side cards: `compare([{ title, badge?, rows: [[name, value]] }])`. */
export const compare = listOr('compare', 'items')
/** `steps([{ label, status: 'done' | 'current' | 'todo' | 'failed', detail? }])`. */
export const steps = listOr('steps', 'items')
/** Notice: `callout('…', { tone: 'info' | 'good' | 'warn' | 'bad' })`. */
export const callout = valueOr('callout', 'text')
/** Choice; a tap invokes `id` with `{ value }` (or `{ values }` when multi). */
export const options = (props) => node('options', props)
/** Confirm / cancel pair; a tap invokes `id` with `{ confirmed }`. */
export const confirm = (a, b) => (typeof a === 'string' ? node('confirm', { ...b, id: a }) : node('confirm', a))

// ── added for plugins ─────────────────────────────────────────────────────

/** Rows: `list([{ title, subtitle?, trailing?, icon?, tone?, action? }])`. */
export const list = listOr('list', 'items')
/** Name … value pairs: `keyValue([['名称', '值'], …])` or `keyValue({ items: { 名称: '值' } })`. */
export const keyValue = listOr('keyValue', 'items')
/** `progress(0.42 * 100, { label, caption?, max?, tone? })` or `progress({ value, … })`. */
export const progress = valueOr('progress', 'value')
/** `table({ columns: ['名称', { label: '金额', align: 'end' }], rows: [['a', 1]] })`. */
export const table = (props) => node('table', props)
/** Buttons: `actions([{ label, action, icon?, style?: 'primary' | 'plain' }])`. */
export const actions = listOr('actions', 'items')
/** `image('asset:icons/a.png', { alt, aspect })` (a file in the manifest's `assets` directory) or a ≤ 64 KiB data: URL. */
export const image = valueOr('image', 'src')

// View v2. These deliberately use one props object so bindings, validation,
// layout and style properties remain visible in authored JSON.
export const textField = (props) => node('textField', props)
export const number = (props) => node('number', props)
export const stepper = (props) => node('stepper', props)
export const toggle = (props) => node('toggle', props)
export const slider = (props) => node('slider', props)
export const select = (props) => node('select', props)
export const segmented = (props) => node('segmented', props)
export const chips = (props) => node('chips', props)
export const date = (props) => node('date', props)
export const time = (props) => node('time', props)
export const rating = (props) => node('rating', props)
export const form = (props) => node('form', props)
export const tabs = (props) => node('tabs', props)
export const collapsible = (props) => node('collapsible', props)
export const accordion = (props) => node('accordion', props)
export const carousel = (props) => node('carousel', props)
export const timeline = (props) => node('timeline', props)
export const grid = (props) => node('grid', props)
export const badge = (props) => node('badge', props)
export const tag = (props) => node('tag', props)
export const avatar = (props) => node('avatar', props)
export const codeBlock = (props) => node('codeBlock', props)
export const divider = (props) => node('divider', props)
export const spacer = (props) => node('spacer', props)
/** The app's empty look: `emptyState({ title, message?, icon?, action?: { label, action, icon? } })`. */
export const emptyState = (props) => node('emptyState', props)
/** Pictures that open in the app's viewer: `gallery({ items: [{ src, alt?, caption?, action? }], columns?, aspect? })`. */
export const gallery = (props) => node('gallery', props)

/**
 * An action reference for a button or list row: `action('open', { row: 3 })`.
 * @param {string} id
 * @param {Record<string, unknown>} [args]
 */
export const action = (id, args) => (args === undefined ? id : { id, args })

/** Original catalog; missing caps must continue to mean v1. */
export const V1_COMPONENTS = Object.freeze([
  'stack', 'row', 'text', 'metric', 'chart', 'compare', 'steps', 'callout', 'options', 'confirm',
  'list', 'keyValue', 'progress', 'table', 'actions', 'image',
])

/** All component names supported by view v2, including the original v1 set. */
export const COMPONENTS = Object.freeze([
  ...V1_COMPONENTS,
  'textField', 'number', 'stepper', 'toggle', 'slider', 'select', 'segmented', 'chips', 'date', 'time', 'rating',
  'form', 'tabs', 'collapsible', 'accordion', 'carousel', 'timeline', 'grid', 'badge', 'tag', 'avatar', 'codeBlock', 'divider', 'spacer',
  'emptyState', 'gallery',
])

/** Walk every component node of a view (depth first, children before siblings). */
export function* walkView(view) {
  const stack = [view]
  while (stack.length > 0) {
    const n = stack.pop()
    if (!isObject(n) || typeof n.type !== 'string') continue
    yield n
    const children = Array.isArray(n.children) ? n.children : []
    const sections = Array.isArray(n.items) ? n.items.flatMap((item) => Array.isArray(item?.children) ? item.children : []) : []
    const nested = [...children, ...sections]
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i])
  }
}
