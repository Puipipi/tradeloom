import { ROLE_PRESETS } from './roles.js'

export const MAX_STEPS_PER_TURN = 24
export const name = '@tradeloom/dsh-business-shell/step-policy'
export const inject = []
const BUSINESS_PRESETS = new Set(Object.values(ROLE_PRESETS))

export function apply(ctx) {
  ctx.on('agent/pre-step', ({ agent, step }, next) => {
    if (BUSINESS_PRESETS.has(agent?.session?.header?.agentPreset) && step > MAX_STEPS_PER_TURN) {
      return { kind: 'reject' }
    }
    return next()
  })
}

