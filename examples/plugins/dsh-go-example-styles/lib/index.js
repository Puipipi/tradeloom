import { focusData, focusView } from './view.js'

export const name = 'dsh-go-example-styles'

export function apply(ctx) {
  ctx.inject(['dshGo'], ctx => {
    ctx.dshGo.panel('focus', {
      view: focusView,
      data: (_scope, emit) => { emit(focusData); return () => {} },
      actions: {
        copy: (_scope, event) => [
          { type: 'copy', text: String(event?.locale).startsWith('en')
            ? 'Weekly focus: 12.4 h · Completed: 7 / 10' : '本周专注：12.4 小时 · 完成：7 / 10' },
          { type: 'toast', text: String(event?.locale).startsWith('en') ? 'Copied' : '已复制' },
        ],
        // Inline spans never open URLs; this explicit invoke retains the app's confirmation.
        guide: () => [{ type: 'link', url: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html' }],
      },
    })
  })
}
