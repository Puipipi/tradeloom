// dsh-go-example-quick: two capsules above the composer and two items in a
// reply's long-press menu.
//
//   总结       static effect in the manifest — the app inserts the text itself, no host code
//   译成英文    invoke → a deferred result: the default model translates the clipboard and the
//              English text lands in the composer (≤ 60 s); without a model, the clipboard
//              wrapped in a translation request goes in instead
//   复制为 Markdown   invoke → the reply without dsh-ui cards, onto the clipboard
//   存进笔记    invoke → the reply appended to notes/<today>.md in the chat's working directory
//
// `wants: ["clipboard", "message"]` in the manifest is what lets taps carry the
// clipboard (composer capsules) and the reply text (message menu); the app asks
// the person once before the first tap.
import { copyMarkdown, saveNote, TRANSLATE_SYSTEM, translateWithModel } from './actions.js'
import { complete, defaultModel } from './model.js'

export const name = 'dsh-go-example-quick'

export function apply(ctx) {
  const cwdOf = (sessionId) => {
    try {
      return ctx.get('sessions')?.get?.(sessionId)?.header?.cwd
    } catch {
      return undefined
    }
  }

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('translate', (scope, event) => {
      const route = defaultModel(ctx)
      const model = route && { complete: (text, signal) => complete(route, TRANSLATE_SYSTEM, text, signal) }
      return translateWithModel(scope, event?.locale, model)
    })
    ctx.dshGo.on('copy-md', (scope, event) => copyMarkdown(scope, event?.locale))
    ctx.dshGo.on('save-note', (scope, event) => saveNote(scope, { cwd: cwdOf(scope.sessionId), locale: event?.locale }))
  })
}
