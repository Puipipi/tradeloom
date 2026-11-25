import { STICKERS, albumView, words } from './view.js'

export const name = 'dsh-go-example-album'

export function apply(ctx) {
  // One album per engine, kept in memory: enough to show the empty state
  // and back.
  const state = { stickers: [...STICKERS] }
  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('album', {
      view: (_scope, caps) => albumView(state, caps),
      actions: {
        // A tap on a sticker: its name into the composer, never sent. (A
        // long press opens the app's viewer; the plugin is not asked.)
        pick: (_scope, event) => {
          const id = event?.value?.id
          if (!STICKERS.includes(id)) return []
          const w = words(event?.locale)
          return [
            { type: 'insert', text: `[${w.pictures[id][0]}]` },
            { type: 'toast', text: w.pick },
          ]
        },
        clear: () => {
          state.stickers = []
          return [{ type: 'refresh' }]
        },
        restore: () => {
          state.stickers = [...STICKERS]
          return [{ type: 'refresh' }]
        },
      },
    })
  })
}
