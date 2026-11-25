'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { backendConfig, isReady, localConsoleOrigin, payloadFor, permitsConsoleRequest, publicResult } = require('../backend.cjs')

test('only exact local action schemas cross IPC', () => {
  assert.deepEqual(payloadFor('manage-stop'), { confirmed: true })
  const binding = { operation: 'bind-email-verify', username: 'synthetic', code: '12345678' }
  assert.deepEqual(payloadFor('mail', binding), binding)
  assert.throws(() => payloadFor('mail', { ...binding, code: '123456' }))
  assert.throws(() => payloadFor('mail', { ...binding, key: 'extra' }))
  assert.throws(() => payloadFor('shell', { command: 'example' }))
  assert.throws(() => payloadFor('status', { dataRoot: 'D:\\outside' }))
  assert.throws(() => backendConfig(['-port', '15'], 'D:\\package'))
  assert.throws(() => backendConfig(['-dataroot', '\\\\network\\remote'], 'D:\\package'))
  assert.throws(() => backendConfig(['-dataroot', 'D:\\data"name'], 'D:\\package'))
})

test('state fails closed and strips undeclared data', () => {
  const status = publicResult({
    ok: true, running: true, has_admin: true, smtp_configured: true, smtp_from_email: 'sender@fixture.test', admin_email_state: 'ready',
    smtp_password: 'synthetic omitted', database_url: 'also omitted',
  })
  assert.ok(isReady(status))
  assert.equal(status.smtp_password, undefined)
  assert.equal(status.database_url, undefined)
  assert.equal(isReady({ ...status, admin_email_state: 'pending' }), false)
  assert.equal(isReady({ ...status, smtp_from_email: '' }), false)
})

test('only the existing exact loopback console origin is embedded', () => {
  const origin = 'http://127.0.0.1:27417'
  assert.equal(localConsoleOrigin(origin + '/enterprise/console/'), origin)
  for (const url of [
    'https://official.example/enterprise/console/', 'http://localhost:27417/enterprise/console/',
    'http://127.1:27417/enterprise/console/', origin + '/enterprise/console/?token=x',
  ]) assert.equal(localConsoleOrigin(url), null)
  for (const pathname of ['/accounts/login/?next=/enterprise/console/', '/admin/auth/user/', '/admin/auth/group/',
    '/enterprise/console/login-security/', '/enterprise/console/?group=1', '/enterprise/capabilities/?ui=1', '/static/admin/css/base.css']) {
    assert.ok(permitsConsoleRequest(origin, origin + pathname))
  }
  assert.equal(permitsConsoleRequest(origin, 'http://127.0.0.1:33333/enterprise/console/'), false)
  assert.equal(permitsConsoleRequest(origin, origin + '/enterprise/business/products/'), false)
  assert.equal(permitsConsoleRequest(origin, origin + '/enterprise/capabilities/'), false)
  assert.equal(permitsConsoleRequest(origin, origin + '/enterprise/capabilities/?ui=1&other=1'), false)
  assert.equal(permitsConsoleRequest(origin, 'file:///desktop'), false)
})
