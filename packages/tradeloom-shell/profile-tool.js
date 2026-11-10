import { createStateStore } from './state.js'

export const name = '@tradeloom/dsh-business-shell/profile'
export const inject = ['tools']

export function registerProfileTool(ctx, dependencies = {}) {
  const storeFactory = dependencies.createStateStore ?? createStateStore
  return ctx.tools.register({
    name: 'tradeloom_user_profile_read',
    description: 'Read the current editable TradeLoom demo user profile. Use only for user-profile questions; do not infer facts that are absent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['displayName', 'notes'],
        properties: {
          displayName: { type: 'string', description: 'Current profile display name.' },
          notes: { type: 'string', description: 'Current user-provided profile notes.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('User profile access requires an Agent-backed session')
      const store = await storeFactory()
      const state = await store.read()
      return state.userProfile
    },
  })
}

export function apply(ctx) {
  registerProfileTool(ctx)
}

