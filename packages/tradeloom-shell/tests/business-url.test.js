import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)
const businessUrlSource = await readFile(new URL('workbench/static/workbench/business-url.js', root), 'utf8')
const appSource = await readFile(new URL('workbench/static/workbench/app.js', root), 'utf8')

function browserUrl(enabled) {
  const context = {
    URL,
    document: { documentElement: { dataset: { businessEmbed: enabled ? 'true' : 'false' } } },
    window: { location: { href: 'http://127.0.0.1:3088/agent-center', origin: 'http://127.0.0.1:3088' } },
  }
  runInNewContext(businessUrlSource, context)
  return context.TradeLoomBusiness.businessUrl
}

test('browser URL wrapper preserves default URLs and maps embed page, API, static, and upload paths', () => {
  assert.equal(browserUrl(false)('/api/tasks?next=%2Fproducts'), '/api/tasks?next=%2Fproducts')
  const url = browserUrl(true)
  assert.equal(url('/home?tab=1'), '/business/home?tab=1')
  assert.equal(url('/api/workflow-tasks/wf%2Fid?limit=2'), '/business-api/workflow-tasks/wf%2Fid?limit=2')
  assert.equal(url('/static/workbench/app.js?v=2'), '/business-static/workbench/app.js?v=2')
  assert.equal(url('/uploads/review/image.png?download=1'), '/business-media/review/image.png?download=1')
  assert.equal(url('/api?next=%2Fproducts#section'), '/business-api?next=%2Fproducts#section')
  assert.equal(url('/static?v=2#app'), '/business-static?v=2#app')
  assert.equal(url('/uploads?download=1#file'), '/business-media?download=1#file')
  assert.equal(url('/business-api/workflow-tasks?limit=2'), '/business-api/workflow-tasks?limit=2')
  assert.equal(url('/business-static?version=1#asset'), '/business-static?version=1#asset')
  assert.equal(url('/business-media/file?download=1#preview'), '/business-media/file?download=1#preview')
  assert.equal(url('https://example.com/api/tasks'), 'https://example.com/api/tasks')
})

test('app fetch and upload paths pass through URL wrapper while retaining CSRF headers', () => {
  assert.match(appSource, /fetch\(businessUrl\(url\),/)
  assert.match(appSource, /fetch\(businessUrl\(form\.dataset\.uploadUrl\),/)
  assert.match(appSource, /"X-CSRFToken": csrfToken/)
})
