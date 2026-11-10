import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

test('declared backend policy/profile/step/proxy/workflow-tools subpaths resolve from the package', async () => {
  const [policy, profile, step, proxy, workflow] = await Promise.all([
    import('@tradeloom/dsh-business-shell/policy'),
    import('@tradeloom/dsh-business-shell/profile'),
    import('@tradeloom/dsh-business-shell/step-policy'),
    import('@tradeloom/dsh-business-shell/proxy'),
    import('@tradeloom/dsh-business-shell/workflow-tools'),
  ])
  assert.equal(typeof policy.apply, 'function')
  assert.ok(policy.BUDGET_LIMITS.delegations > 0)
  assert.equal(typeof profile.apply, 'function')
  assert.equal(typeof profile.registerProfileTool, 'function')
  assert.equal(typeof step.apply, 'function')
  assert.ok(step.MAX_STEPS_PER_TURN > 0)
  assert.equal(typeof proxy.apply, 'function')
  assert.equal(typeof proxy.createBusinessProxyHandler, 'function')
  assert.equal(typeof workflow.apply, 'function')
  assert.equal(typeof workflow.registerWorkflowTools, 'function')

  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [subpath, file] of [
    ['./policy', 'policy.js'], ['./profile', 'profile-tool.js'], ['./step-policy', 'step-policy.js'],
    ['./proxy', 'proxy.js'], ['./workflow-tools', 'workflow-tools.js'],
  ]) {
    assert.equal(manifest.exports[subpath], `./${file}`)
    assert.ok(manifest.files.includes(file))
  }
  assert.ok(manifest.files.includes('skills/wf-planner/SKILL.md'))
})

test('profile reader uses its injected store and requires an Agent-backed session', async () => {
  const { registerProfileTool } = await import('@tradeloom/dsh-business-shell/profile')
  let definition
  let reads = 0
  registerProfileTool({ tools: { register(value) { definition = value; return () => {} } } }, {
    createStateStore: async () => ({ read: async () => { reads += 1; return { userProfile: { displayName: 'Fixture', notes: 'owned fixture' } } } }),
  })
  await assert.rejects(definition.execute({}, {}), /Agent-backed session/)
  assert.equal(reads, 0)
  assert.deepEqual(await definition.execute({}, { agent: { id: 'fixture-agent' } }), {
    displayName: 'Fixture', notes: 'owned fixture',
  })
  assert.equal(reads, 1)
})

test('step policy enforces the existing business-preset turn limit', async () => {
  const { apply } = await import('@tradeloom/dsh-business-shell/step-policy')
  const { ROLE_PRESETS } = await import('../roles.js')
  let hook
  apply({ on(name, listener) { assert.equal(name, 'agent/pre-step'); hook = listener } })
  const next = () => ({ kind: 'continue' })
  assert.deepEqual(await hook({ agent: { session: { header: { agentPreset: ROLE_PRESETS.center } } }, step: 25 }, next), { kind: 'reject' })
  assert.deepEqual(await hook({ agent: { session: { header: { agentPreset: 'unmanaged-preset' } } }, step: 25 }, next), { kind: 'continue' })
})

test('planner skill asset exists at the declared package-relative path', async () => {
  const path = new URL('../skills/wf-planner/SKILL.md', import.meta.url)
  await access(path)
  const text = await readFile(path, 'utf8')
  assert.ok(text.trim().length > 0)
})
