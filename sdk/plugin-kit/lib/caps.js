// What the app on the other end can draw (native-plugins-protocol.md §2.2:
// `caps` = { protocol, app, locale, surfaces, components }), and helpers to
// degrade a view for an older app. Zero dependencies.

import { V1_COMPONENTS, isBinding } from './view.js'

/** Surfaces of protocol v1. */
export const SURFACES = Object.freeze(['composer.actions', 'message.actions', 'composer.strip', 'panels'])
/** Newer than v1: an app that draws them lists them in `caps.surfaces`. */
export const NEWER_SURFACES = Object.freeze(['composer.tools', 'session.actions', 'turn.note', 'plugin'])

const list = (v) => (Array.isArray(v) ? v : undefined)

/**
 * Whether the app draws component `type`. Without a component list (a tool
 * card has no caps; an app that sent none) the v1 catalog is assumed.
 */
export function hasComponent(caps, type) {
  const known = list(caps?.components)
  return known === undefined ? V1_COMPONENTS.includes(type) : known.includes(type)
}

/** Whether the app shows `surface`. Without a list, the four v1 surfaces. */
export function hasSurface(caps, surface) {
  const known = list(caps?.surfaces)
  return known === undefined ? SURFACES.includes(surface) : known.includes(surface)
}

/** Whether the app speaks protocol `v` or later. */
export function protocolAtLeast(caps, v) {
  return typeof caps?.protocol === 'number' ? caps.protocol >= v : v <= 1
}

function semver(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** Whether the app is at least version `min` (`"0.10.0"`). Unknown app version → false. */
export function appAtLeast(caps, min) {
  const have = semver(caps?.app)
  const want = semver(min)
  if (have === undefined || want === undefined) return false
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]
  return true
}

/**
 * Pick a string for the app's locale from `{ zh: '用量', en: 'Usage' }` with
 * the bridge's order: exact tag, language part, en, zh, first value.
 * A plain string is returned as is.
 * @param {{ locale?: string } | string | undefined} capsOrLocale
 * @param {string | Record<string, string>} text
 */
export function localize(capsOrLocale, text) {
  if (typeof text === 'string') return text
  if (typeof text !== 'object' || text === null) return ''
  const tag = (typeof capsOrLocale === 'string' ? capsOrLocale : capsOrLocale?.locale) ?? ''
  const keys = Object.keys(text)
  const find = (want) => keys.find((k) => k.toLowerCase().replaceAll('_', '-') === want.toLowerCase().replaceAll('_', '-'))
  const lang = tag.split(/[-_]/)[0]
  const hit = (tag && find(tag)) || (lang && find(lang)) || find('en') || find('zh') || keys[0]
  return hit === undefined ? '' : String(text[hit])
}

// ── degrading a view ──────────────────────────────────────────────────────

const str = (v) => (v === undefined || v === null ? '' : isBinding(v) ? '—' : String(v))
const rows = (items) => (Array.isArray(items) ? items : [])
const inputText = (n) => ({ type: 'text', text: `${str(n.label)}: ${n.bind ? '—' : str(n.value) || '—'}` })
const groupChildren = (n) => ({ type: 'stack', children: rows(n.children) })
const sectionChildren = (n) => ({ type: 'stack', children: rows(n.items).flatMap((s) => [{ type: 'text', text: str(s?.label) || '—' }, ...rows(s?.children)]) })

/**
 * Stand-ins for the components newer than the original ten, built from older
 * ones (a gallery becomes a grid of images only where the app has grid). Bound values cannot be resolved here, so they read as "—":
 * prefer resolving data before you degrade.
 */
export const DEFAULT_FALLBACKS = Object.freeze({
  list: (n) => ({
    type: 'text',
    text: rows(n.items).map((r) => `- ${str(r?.title)}${r?.trailing !== undefined ? ` · ${str(r.trailing)}` : ''}`).join('\n') || '—',
  }),
  keyValue: (n) => ({
    type: 'text',
    text: (Array.isArray(n.items) ? n.items.map((p) => (Array.isArray(p) ? p : [p?.label, p?.value])) : Object.entries(n.items ?? {}))
      .map(([k, v]) => `${str(k)}：${str(v)}`).join('\n') || '—',
  }),
  progress: (n) => {
    const value = Number(n.value)
    const max = n.max === undefined ? 100 : Number(n.max)
    const pct = Number.isFinite(value) && Number.isFinite(max) && max > 0 ? `${Math.round((value / max) * 100)}%` : '—'
    return { type: 'metric', label: str(n.label) || '—', value: pct, ...(n.caption !== undefined ? { caption: str(n.caption) } : {}) }
  },
  table: (n) => ({
    type: 'text',
    text: rows(n.rows).map((r) => rows(r).map(str).join(' · ')).join('\n') || '—',
  }),
  actions: () => null,
  image: () => null,
  textField: inputText, number: inputText, stepper: inputText, toggle: inputText,
  slider: inputText, select: inputText, segmented: inputText, chips: inputText,
  date: inputText, time: inputText, rating: inputText,
  form: groupChildren, collapsible: groupChildren, grid: groupChildren,
  tabs: sectionChildren, accordion: sectionChildren, carousel: sectionChildren, timeline: sectionChildren,
  badge: (n) => ({ type: 'text', text: str(n.text) }),
  tag: (n) => ({ type: 'text', text: str(n.text) }),
  codeBlock: (n) => ({ type: 'text', text: str(n.code) }),
  avatar: () => null,
  divider: () => null,
  spacer: () => null,
  // A notice in place of the empty look, its button kept under it.
  emptyState: (n) => {
    const notice = { type: 'callout', tone: 'info', text: [str(n.title), str(n.message)].filter(Boolean).join('\n') || '—' }
    const a = n.action
    if (typeof a !== 'object' || a === null || a.action === undefined) return notice
    return { type: 'stack', children: [notice, { type: 'actions', items: [{ label: str(a.label) || '—', action: a.action, ...(a.icon !== undefined ? { icon: a.icon } : {}) }] }] }
  },
  // The pictures as images, in a grid where the app has one; no viewer.
  gallery: (n, caps) => {
    const pictures = rows(n.items).filter((i) => typeof i === 'object' && i !== null && i.src !== undefined)
      .map((i) => ({ type: 'image', src: i.src, ...(i.alt !== undefined ? { alt: i.alt } : {}), ...(i.caption !== undefined ? { caption: i.caption } : {}) }))
    if (pictures.length === 0) return null
    return hasComponent(caps, 'grid')
      ? { type: 'grid', columns: typeof n.columns === 'number' ? n.columns : 2, children: pictures }
      : { type: 'stack', children: pictures }
  },
})

/**
 * Replace components the app does not draw with stand-ins (`fallbacks`,
 * merged over DEFAULT_FALLBACKS). A stand-in returning null removes the
 * node. Without stand-in the node stays (the app draws a grey placeholder).
 * Returns a new tree; the input is not modified.
 */
export function adaptView(view, caps, fallbacks = {}) {
  const table = { ...DEFAULT_FALLBACKS, ...fallbacks }
  const visit = (n) => {
    if (typeof n !== 'object' || n === null || Array.isArray(n) || typeof n.type !== 'string') return n
    let current = n
    if (!hasComponent(caps, current.type) && typeof table[current.type] === 'function') {
      const replaced = table[current.type](current, caps)
      if (replaced === null || replaced === undefined) return null
      if (current.title !== undefined && replaced.title === undefined) replaced.title = current.title
      current = replaced
    }
    if (Array.isArray(current.children)) {
      current = { ...current, children: current.children.map(visit).filter((c) => c !== null) }
    }
    if (Array.isArray(current.items)) {
      current = { ...current, items: current.items.map((item) => Array.isArray(item?.children)
        ? { ...item, children: item.children.map(visit).filter((c) => c !== null) } : item) }
    }
    return current
  }
  const result = visit(view)
  return result !== null && view?.v === 2 && !hasComponent(caps, 'textField') ? { ...result, v: 1 } : result
}
