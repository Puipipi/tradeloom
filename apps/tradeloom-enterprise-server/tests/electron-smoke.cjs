'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { openServerWindow } = require('../main.cjs')

const evidence = process.argv.at(-1)
app.setPath('userData', path.join(path.dirname(evidence), 'isolated-electron-profile'))
const state = { ok:true, installed:false, running:false, has_admin:false, smtp_configured:false, admin_email_state:'missing' }
const calls = []
let approveStops = false
let loginRequests = 0
const server = http.createServer((request, response) => {
  if (request.url === '/enterprise/console/') {
    response.writeHead(302, { Location:'/accounts/login/?next=%2Fenterprise%2Fconsole%2F' }).end()
  } else if (request.url.startsWith('/accounts/login/')) {
    loginRequests++
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>合成管理登录</title><a href="/enterprise/business/products/">不允许的业务链接</a>')
  } else response.writeHead(404).end()
})
async function backend(action, data) {
  calls.push(action === 'mail' ? data.operation : action)
  if (['start','manage-start'].includes(action)) Object.assign(state, { installed:true, running:true, healthy:true, database_running:true })
  if (action === 'manage-stop') Object.assign(state, { running:false, healthy:false, database_running:false })
  if (action === 'create') Object.assign(state, { has_admin:true, admin_email_state:'pending', admin_binding_pending:true })
  if (action === 'mail') {
    if (['smtp','smtp-replace'].includes(data.operation)) Object.assign(state, { smtp_configured:true, smtp_from_email:data.smtp.from_email })
    if (data.operation === 'bind-email-verify') {
      if (data.code !== '12345678') return { ok:false, message:'绑定码无效。' }
      Object.assign(state, { admin_email_state:'ready', admin_binding_pending:false })
    }
  }
  return { ...state }
}
backend.consoleTarget = () => 'http://127.0.0.1:' + server.address().port + '/enterprise/console/'
async function wait(check, label) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(label + ' timeout')
}

async function workflow() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const win = openServerWindow(backend, { show:false, approve:() => approveStops })
  const evalJs = (script) => win.webContents.executeJavaScript(script)
  const visible = (id) => wait(() => evalJs('Boolean(document.getElementById(' + JSON.stringify(id) + ')?.getClientRects().length) && !document.querySelector("#refresh").disabled'), id)
  const click = (id) => evalJs('document.getElementById(' + JSON.stringify(id) + ').click();true')
  async function form(id, values) {
    await evalJs(`(() => {const form=document.getElementById(${JSON.stringify(id)});
      for(const [key,value] of Object.entries(${JSON.stringify(values)})) form.elements[key].value=value;
      form.requestSubmit(); return true})()`)
  }
  await visible('start')
  assert.equal(await evalJs('typeof require'), 'undefined')
  assert.equal((await evalJs('tradeLoomServer.invoke("shell")')).ok, false)
  assert.equal((await evalJs('tradeLoomServer.invoke("open")')).ok, false)
  await click('start')
  await visible('smtp-form')
  assert.equal(await evalJs('document.querySelector(".smtp-guide a")'), null)
  assert.ok(await evalJs('document.querySelector(".smtp-guide").textContent.includes("smtp.qiye.aliyun.com")'))
  await form('smtp-form', { host:'smtp.fixture.test', from_email:'sender@fixture.test', username:'sender@fixture.test', password:'synthetic-input' })
  await visible('admin')
  await form('admin-form', { username:'owner-fixture', email:'owner@fixture.test', password:'synthetic-check', password_confirm:'synthetic-check' })
  await visible('binding')
  await form('binding-form', { username:'owner-fixture' })
  await wait(() => calls.includes('bind-email-resend'), 'resend')
  await wait(() => evalJs('!document.querySelector("#code-form input").disabled'), 'binding finished')
  await form('code-form', { code:'00000000' })
  await wait(() => evalJs('document.querySelector("#notice").textContent.includes("绑定码无效")'), 'wrong code')
  await form('code-form', { code:'12345678' })
  await visible('accounts-tab')
  await win.webContents.capturePage().then((image) => fs.writeFileSync(path.join(path.dirname(evidence), 'server-overview.png'), image.toPNG()))
  await click('accounts-tab')
  await visible('accounts')
  await click('open-console')
  const consoleWindow = await wait(() => BrowserWindow.getAllWindows().find((item) => item !== win), 'console window')
  await wait(() => loginRequests === 1 && consoleWindow.webContents.getURL().includes('/accounts/login/'), 'console login')
  assert.equal(await consoleWindow.webContents.executeJavaScript('typeof tradeLoomServer'), 'undefined')
  assert.equal(await consoleWindow.webContents.executeJavaScript('typeof require'), 'undefined')
  await consoleWindow.webContents.executeJavaScript('document.querySelector("a").click();true')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(consoleWindow.webContents.getURL().includes('/accounts/login/'))
  await wait(() => evalJs('!document.querySelector("#status-tab").disabled'), 'console launch finished')
  await click('mail-tab')
  await click('smtp-edit')
  await form('smtp-form', { host:'smtp2.fixture.test', from_email:'other@fixture.test', username:'other@fixture.test', password:'synthetic-reset' })
  await wait(() => state.smtp_from_email === 'other@fixture.test', 'SMTP replacement')
  await wait(() => evalJs('!document.querySelector("#status-tab").disabled'), 'SMTP finished')
  await click('status-tab')
  await click('stop')
  await wait(() => evalJs('document.querySelector("#notice").textContent.includes("已取消")'), 'cancel stop')
  assert.equal(state.running, true)
  assert.ok(!calls.includes('manage-stop'))
  approveStops = true
  await click('stop')
  await visible('start')
  assert.equal(state.running, false)
  await click('start')
  await visible('accounts-tab')
  assert.ok(calls.includes('manage-start'))
  fs.writeFileSync(evidence, JSON.stringify({ syntheticBackend:true, genuineElectron:true, started:true, smtpReplaced:true,
    adminCreated:true, wrongCodeRejected:true, bindingVerified:true, isolatedConsoleLogin:true,
    unrelatedConsoleNavigationBlocked:true, privilegedPreloadAbsentInConsole:true, cancelLeavesService:true,
    confirmedStoppedAndRestarted:true, noActualCredentials:true }, null, 2))
}

app.whenReady().then(workflow).then(() => app.exit(0), (error) => {
  console.error(error.message)
  app.exit(1)
})
