const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeServerOrigin, enterpriseUrl, isSameOriginRequest } = require('../security.cjs')

test('requires HTTPS for enterprise hosts and allows explicit loopback HTTP for local development', () => {
  assert.equal(normalizeServerOrigin('https://trade.example.com/'), 'https://trade.example.com')
  assert.equal(normalizeServerOrigin('http://127.0.0.1:8000'), 'http://127.0.0.1:8000')
  assert.equal(normalizeServerOrigin('http://[::1]:8000'), 'http://[::1]:8000')
  for (const value of ['http://trade.example.com', 'https://user:pass@trade.example.com', 'https://trade.example.com/path', 'https://trade.example.com/?next=/']) {
    assert.throws(() => normalizeServerOrigin(value))
  }
})

test('targets the enterprise entry and permits only the exact same origin', () => {
  assert.equal(enterpriseUrl('https://trade.example.com'), 'https://trade.example.com/enterprise/')
  assert.equal(isSameOriginRequest('https://trade.example.com/static/app.css', 'https://trade.example.com'), true)
  assert.equal(isSameOriginRequest('https://other.example.com/static/app.css', 'https://trade.example.com'), false)
  assert.equal(isSameOriginRequest('file:///C:/secret.txt', 'https://trade.example.com'), false)
})
