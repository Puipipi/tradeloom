// dsh-go-example-toolbox: the newer native places, each in a few lines.
//
//   composer.tools    选模板 opens a panel as a sheet (no host code); 数字数 reads the draft
//   session.actions   标记这段对话 acts on the whole chat, from the side panel's Info
//   turn.note         a few characters at the end of each turn's footnote
//   placement plugin  状态 shows on the plugin's own detail page
//
// `caps.surfaces` keeps it honest on an older app, which has none of these.
export const name = 'dsh-go-example-toolbox'

const TEMPLATES = [
  { id: 'daily', title: '日报', text: '按今天做了什么、遇到什么问题、明天做什么，写一份日报。' },
  { id: 'review', title: '代码评审', text: '评审这段改动，先说风险最高的问题。' },
]

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const marked = new Set()

    ctx.dshGo.on('count', (scope) => ({ toast: `输入框里有 ${[...(scope.draft ?? '')].length} 个字` }))

    ctx.dshGo.on('mark', (scope) => {
      marked.add(scope.sessionId)
      ctx.dshGo.refresh('about')
      return { toast: '已标记' }
    })

    // The demo says which turn it is, for the first 20. A real plugin pushes what it measured: cost,
    // cache hits. Older bridges have no turnNote, and the panels below must still register there.
    if (typeof ctx.dshGo.turnNote === 'function') {
      ctx.dshGo.turnNote('turn', (scope, emit) => {
        emit(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, { text: `第 ${i + 1} 轮` }])))
        return () => {}
      })
    }

    ctx.dshGo.panel('picker', {
      view: {
        type: 'list',
        items: TEMPLATES.map((t) => ({ title: t.title, action: { id: 'use', args: { id: t.id } } })),
      },
      actions: {
        use: (scope, event) => ({ insert: TEMPLATES.find((t) => t.id === event.value?.id)?.text ?? '' }),
      },
    })

    ctx.dshGo.panel('about', {
      view: (scope, caps) => ({
        type: 'stack',
        children: [
          { type: 'metric', label: '已标记的对话', value: String(marked.size) },
          ...(caps.surfaces?.includes('session.actions') ? [] : [{ type: 'callout', tone: 'info', text: '更新 App 后可以在右侧栏标记对话。' }]),
        ],
      }),
    })
  })
}
