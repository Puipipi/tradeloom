// The album panel: a ring of the space used and this week's stickers as a
// trend, then the stickers as a gallery — or, once cleared, the app's own
// empty look with one button to put them back. `accent: "app"` follows the
// person's palette. Only bounded JSON; the pictures are the package's own
// files (`asset:`), never web addresses.

const zh = {
  space: '已用空间', week: '本周新贴纸', empty: '还没有贴纸', emptyLine: '放回示例贴纸，或从别处导入',
  restore: '放回', clear: '清空', pick: '已放进输入框',
  pictures: { sea: ['海', '海边'], sunset: ['日落', '黄昏前'], moss: ['苔', null], dusk: ['暮色', '回家路上'] },
}
const en = {
  space: 'Space used', week: 'New this week', empty: 'No stickers yet', emptyLine: 'Put the samples back, or import some',
  restore: 'Put back', clear: 'Clear', pick: 'In the composer',
  pictures: { sea: ['Sea', 'Seaside'], sunset: ['Sunset', 'Before dusk'], moss: ['Moss', null], dusk: ['Dusk', 'On the way home'] },
}

export const words = (locale) => (String(locale ?? '').startsWith('en') ? en : zh)

/** The samples in `assets/stickers/`. */
export const STICKERS = Object.freeze(['sea', 'sunset', 'moss', 'dusk'])

/** Room for this many. */
export const SPACE = 12

/** Stickers added each day this week (null: the plugin was off). */
export const WEEK = Object.freeze([1, 2, 1, null, 3, 4, 2])

export function albumView(state, caps) {
  const w = words(caps?.locale)
  const stickers = state.stickers
  const figures = {
    type: 'row',
    children: [
      { type: 'progress', shape: 'ring', value: stickers.length, max: SPACE, label: w.space },
      { type: 'metric', label: w.week, value: WEEK.reduce((a, b) => a + (b ?? 0), 0), tone: 'good', trend: [...WEEK] },
    ],
  }
  if (stickers.length === 0) {
    return {
      v: 2, accent: 'app', type: 'stack', style: { gap: 'L' },
      children: [
        figures,
        { type: 'emptyState', icon: 'gallery', title: w.empty, message: w.emptyLine, action: { label: w.restore, action: 'restore', icon: 'refresh' } },
      ],
    }
  }
  return {
    v: 2, accent: 'app', type: 'stack', style: { gap: 'L' },
    children: [
      figures,
      {
        type: 'gallery',
        items: stickers.map((id) => {
          const [alt, caption] = w.pictures[id]
          return { src: `asset:stickers/${id}.png`, alt, ...(caption ? { caption } : {}), action: { id: 'pick', args: { id } } }
        }),
      },
      { type: 'actions', items: [{ label: w.clear, icon: 'clear', action: 'clear' }] },
    ],
  }
}
