const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..', '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

test('enterprise launcher starts Electron only and does not start local Django, PostgreSQL, or DSH', () => {
  const main = read('apps/tradeloom-enterprise-client/main.cjs')
  const launcher = read('scripts/launch-enterprise-client.ps1')
  assert.match(launcher, /electron\.exe/)
  assert.match(launcher, /Start-Process/)
  assert.doesNotMatch(launcher, /manage\.py|runserver|TRADELOOM_DB|dsh\.exe/i)
  assert.doesNotMatch(main, /child_process|spawn\(|manage\.py|runserver|postgres|TRADELOOM_DB|dsh/i)
})

test('remote window has no preload or Node and enables browser isolation', () => {
  const main = read('apps/tradeloom-enterprise-client/main.cjs')
  const remote = main.slice(main.indexOf('candidate = new BrowserWindow'), main.indexOf('const targetUrl = enterpriseUrl'))
  assert.match(remote, /contextIsolation:\s*true/)
  assert.match(remote, /sandbox:\s*true/)
  assert.match(remote, /nodeIntegration:\s*false/)
  assert.doesNotMatch(remote, /preload:/)
})
