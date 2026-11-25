export const name = 'broken-demo'
export const inject = ['dshGo']
export function apply(ctx) {
  ctx.inject(['dshGo?'], (ctx) => {
    ctx.dshGo.on('a', () => ({ insert: 'x' }))
  })
}
