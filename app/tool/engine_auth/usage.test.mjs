// SPDX-License-Identifier: MIT
// Mock-only coverage: never contacts a real service or reads real credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthBridge } from '../../assets/engine/auth/bridge.mjs'

const token = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url'), 'sig'].join('.')
const grant = (access = token, expires = 20000) => ({ kind: 'grant', payload: { type: 'oauth', access, refresh: 'fake-refresh', expires } })
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
function setup(fetch) {
  const records = new Map()
  const credentials = { readRecord: async (key) => records.get(key) }
  return { records, bridge: new AuthBridge({ get: () => credentials, fetch, now: () => 10000 }) }
}

test('Codex GET normalizes windows without exposing credentials', async () => {
  const calls = []
  const { bridge, records } = setup(async (...args) => {
    calls.push(args)
    return response({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, reset_at: 2000000000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0 } } })
  })
  records.set('llm-pi-ai/openai-codex', grant())
  const value = await bridge.usage('openai-codex')
  assert.deepEqual(value, { provider: 'openai-codex', status: 'ok', plan: 'plus', windows: [
    { id: 'primary', usedPercent: 25, resetAt: '2033-05-18T03:33:20.000Z', windowSeconds: 18000 },
    { id: 'secondary', usedPercent: 0, resetAt: null },
  ] })
  assert.equal(calls[0][0], 'https://chatgpt.com/backend-api/wham/usage')
  assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].redirect, 'error')
  assert.equal(calls[0][1].headers['ChatGPT-Account-Id'], 'fake-account')
  assert.ok(!JSON.stringify(value).includes(token))
})

test('Claude GET reads only recognized valid windows', async () => {
  const { bridge, records } = setup(async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(options.redirect, 'error')
    return response({ five_hour: { utilization: 12.5, resets_at: '2026-01-01T00:00:00Z' }, seven_day: null, seven_day_sonnet: { utilization: -1 } })
  })
  records.set('llm-pi-ai/anthropic', grant('fake-claude-access'))
  assert.deepEqual(await bridge.usage('anthropic'), { provider: 'anthropic', status: 'ok', windows: [{ id: 'five_hour', usedPercent: 12.5, resetAt: '2026-01-01T00:00:00.000Z' }] })
})

test('missing, expired, rejected and malformed grants never refresh', async () => {
  let calls = 0
  const { bridge, records } = setup(async () => { calls++; return response({ error: 'fake-sensitive' }, 401) })
  assert.equal((await bridge.usage('anthropic')).status, 'not_signed_in')
  records.set('llm-pi-ai/anthropic', grant('expired', 9999))
  assert.equal((await bridge.usage('anthropic')).status, 'unavailable')
  assert.equal(calls, 0)
  records.set('llm-pi-ai/anthropic', grant('valid'))
  assert.deepEqual(await bridge.usage('anthropic'), { provider: 'anthropic', status: 'unavailable', windows: [], reason: 'auth_required' })
  assert.equal(calls, 1)
  await assert.rejects(bridge.usage('__proto__'), (e) => e.code === 'app-auth/unknown-provider')
})

test('concurrent grant replacement discards stale results', async () => {
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const { bridge, records } = setup(async () => { await waiting; return response({ five_hour: { utilization: 4 } }) })
  records.set('llm-pi-ai/anthropic', grant('first'))
  const query = bridge.usage('anthropic')
  await Promise.resolve()
  records.set('llm-pi-ai/anthropic', grant('second'))
  release()
  assert.equal((await query).status, 'unavailable')
})

test('untrusted errors, invalid bodies and oversized responses fail closed', async () => {
  for (const fetch of [
    async () => { throw new Error('fake-sensitive') },
    async () => new Response('not-json'),
    async () => new Response('x'.repeat(65537)),
    async () => response({ five_hour: { utilization: 101 } }),
  ]) {
    const { bridge, records } = setup(fetch)
    records.set('llm-pi-ai/anthropic', grant('fake-token'))
    const result = await bridge.usage('anthropic')
    assert.equal(result.status, 'unavailable')
    assert.ok(['network', 'invalid_response'].includes(result.reason ?? 'invalid_response'))
    assert.ok(!JSON.stringify(result).includes('fake-sensitive'))
  }
})

test('concurrent calls share one request and the next call is throttled', async () => {
  let release
  let calls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const { bridge, records } = setup(async () => {
    calls++
    await gate
    return response({ five_hour: { utilization: 10 } })
  })
  records.set('llm-pi-ai/anthropic', grant('fake'))
  const first = bridge.usage('anthropic')
  const second = bridge.usage('anthropic')
  await Promise.resolve()
  release()
  assert.deepEqual(await first, await second)
  assert.equal(calls, 1)
  assert.equal((await bridge.usage('anthropic')).reason, 'rate_limited')
})

test('HTTP status reasons do not include upstream bodies', async () => {
  for (const [status, reason] of [[401, 'auth_required'], [403, 'permission_denied'], [429, 'rate_limited']]) {
    const { bridge, records } = setup(async () => response({ secret: 'fake-sensitive' }, status))
    records.set('llm-pi-ai/anthropic', grant('fake'))
    const value = await bridge.usage('anthropic')
    assert.equal(value.reason, reason)
    assert.ok(!JSON.stringify(value).includes('fake-sensitive'))
  }
})
