export default {
  test: {
    include: ['packages/tradeloom-shell/handoff/tests/proposal-handoff.client.spec.tsx'],
    environment: 'jsdom',
    pool: 'forks',
  },
}
