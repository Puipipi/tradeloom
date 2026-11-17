export const name = '@tradeloom/dsh-business-shell/tool-policy'
export const inject = ['tools']

const DENIAL = 'This tool is disabled for this TradeLoom assistant.'
const policies = new Map()

// The bounded file adapter must preserve explicit read/glob/write denials even
// when its capability tool has a different name from the standard tool.
export function deniedToolsForScope(scope) {
  return [...new Set([...(policies.get(scope) ?? [])].flatMap(policy => [...policy]))]
}

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
  const stop = ctx.tools.guard(execution => deniedTools.has(execution?.name) ? DENIAL : undefined)
  const scope = scopeOf(ctx), entries = policies.get(scope) ?? new Set()
  entries.add(deniedTools); policies.set(scope, entries)
  let disposed = false
  return () => { if (disposed) return; disposed = true; stop(); entries.delete(deniedTools); if (!entries.size) policies.delete(scope) }
}

export async function apply(ctx, config) {
  const { scopeOf } = await import('@deepseek-ai/dsh-scope')
  return createScopedToolPolicy(ctx, config, scopeOf)
}
