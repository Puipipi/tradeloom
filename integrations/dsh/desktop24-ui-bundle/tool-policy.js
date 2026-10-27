export const name = '@tradeloom/dsh-business-shell/tool-policy'
export const inject = ['tools']

const DENIAL = 'This tool is disabled for this TradeLoom assistant.'

export function createScopedToolPolicy(ctx, config = {}, scopeOf) {
  if (typeof scopeOf !== 'function' || scopeOf(ctx) === undefined) {
    throw new Error('TradeLoom tool policy requires a preset scope')
  }
  if (!Array.isArray(config.deniedTools)
    || !config.deniedTools.every(toolName => typeof toolName === 'string' && toolName.length > 0)) {
    throw new Error('TradeLoom tool policy configuration is invalid')
  }
  if (typeof ctx.tools?.guard !== 'function') throw new Error('Scoped tool guard is unavailable')
  const deniedTools = new Set(config.deniedTools)
  return ctx.tools.guard(execution => deniedTools.has(execution?.name) ? DENIAL : undefined)
}

export async function apply(ctx, config) {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  return createScopedToolPolicy(ctx, config, scopeOf)
}
