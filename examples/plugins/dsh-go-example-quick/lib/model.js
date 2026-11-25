// One short, tool-free model call with the default model the person picked in
// DSH (the one new chats start with). Used by 「译成英文」 through a deferred
// result: the tap answers at once, the translation lands up to 60 s later.
//
// Services (both from DSH, looked up per call so a model change applies at once):
//   ctx.agentDefaultModel.currentSelection() → { provider, model }
//   ctx.llm.prepareCall({ provider, model, maxTokens }, signal) → { config, stream(options) }

/** The model route, or undefined when this host has no LLM service. */
export function defaultModel(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const llm = ctx.get('llm')
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined
    if (typeof llm?.prepareCall !== 'function') return undefined
    return { llm, provider: selection.provider, model: selection.model }
  } catch {
    return undefined
  }
}

/**
 * Ask the model once: `system` + one user message, no history, no tools.
 * Resolves with the reply text; rejects on a provider error or when `signal`
 * aborts (the bridge aborts it when the person cancels or time runs out).
 */
export async function complete(route, system, text, signal) {
  const prepared = await route.llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 2048 }, signal)
  const options = { ...prepared.config, system, messages: [{ role: 'user', content: [{ type: 'text', text }] }], signal }
  let reply = ''
  let finish
  for await (const chunk of prepared.stream(options)) {
    signal?.throwIfAborted()
    if (chunk.type === 'text-delta') reply += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind !== 'stop' && finish?.kind !== 'max-tokens') throw new Error(`model call ended with ${finish?.kind ?? 'no finish'}`)
  if (reply.trim() === '') throw new Error('empty reply')
  return reply.trim()
}
