const test = require('node:test')
const assert = require('node:assert/strict')
const { signIn } = require('../login.cjs')
const { normalizeServerOrigin } = require('../security.cjs')
const origin = 'https://trade.example.com'
const token = 'a'.repeat(64)
function fixture(post) {
  const requests = []
  return { requests, async fetch(url, options) {
    requests.push({ url, options })
    if (requests.length === 1) return { ok: true, text: async () => `<title>织贸企业服务登录</title><body class="portal-login"><input name="csrfmiddlewaretoken" value="${token}">` }
    if (requests.length === 2) return post
    return { ok: true, json: async () => ({ role: 'owner', capabilities: {} }) }
  } }
}
test('bare domain/IP/IPv6 default to HTTPS; disallowed input rejected', () => {
  for (const value of ['trade.example.com', '203.0.113.12:8443', '[2001:db8::1]:8443']) assert.equal(normalizeServerOrigin(value), `https://${value}`)
  for (const value of ['http://203.0.113.12', 'user:pass@trade.example.com', 'trade.example.com/path', 'trade.example.com?x=1', 'trade.example.com\\x', '']) assert.throws(() => normalizeServerOrigin(value))
})
test('Django CSRF POST requires explicit success redirect before checking existing session', async () => {
  const ses = fixture({ status: 302, headers: new Headers({ location: '/enterprise/' }) })
  const post = (ses, url, options) => ses.fetch(url, options)
  assert.equal(await signIn(ses, origin, 'synthetic', 'secret', post), origin)
  const { url, options } = ses.requests[1]
  assert.equal(url, `${origin}/accounts/login/?next=/enterprise/`)
  assert.equal(options.redirect, 'manual')
  assert.equal(options.headers.Origin, origin)
  assert.equal(new URLSearchParams(options.body).get('csrfmiddlewaretoken'), token)
  for (const response of [{ status: 200 }, { status: 403 }, { status: 302, headers: new Headers({ location: 'https://other.example.com/enterprise/' }) }]) {
    const failed = fixture(response)
    await assert.rejects(signIn(failed, origin, 'synthetic', 'wrong', post))
    assert.equal(failed.requests.length, 2, 'old session must not make failed POST pass')
  }
})
test('generic Django login page never receives credentials', async () => {
  let requests = 0
  const ses = { async fetch() { requests++; return { ok: true, text: async () => `<input name="csrfmiddlewaretoken" value="${token}">` } } }
  await assert.rejects(signIn(ses, origin, 'synthetic', 'secret'), /织贸企业服务登录入口/)
  assert.equal(requests, 1)
})
