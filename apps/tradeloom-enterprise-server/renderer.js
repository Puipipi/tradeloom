'use strict'

const $ = (id) => document.getElementById(id)
const panels = ['overview', 'mail', 'admin', 'binding', 'accounts']
let state = {}
let page = 'overview'
let editing = false
let busy = false
let bindingStarted = false
const smtpReady = () => state.smtp_configured === true && Boolean(state.smtp_from_email)
const ready = () => state.ok === true && state.running === true && state.has_admin === true && smtpReady() && state.admin_email_state === 'ready'

function notice(message) { $('notice').textContent = message || '' }
function show(id, value) { $(id).hidden = !value }
function formFields(form) { return Object.fromEntries(new FormData(form).entries()) }
function stage() {
  if (state.running !== true || state.ok !== true) return 'overview'
  if (!smtpReady()) return 'mail'
  if (!state.has_admin) return 'admin'
  if (state.admin_email_state !== 'ready') return 'binding'
  return page
}

function paint() {
  const visible = stage()
  const setup = !ready()
  for (const id of panels) show(id, id === visible)
  show('mail-tab', !setup)
  show('accounts-tab', !setup)
  for (const button of document.querySelectorAll('[data-page]')) {
    if (button.dataset.page === visible) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  $('server-state').textContent = state.running === true ? '运行中' : state.running === false ? '未启动' : '待检查'
  $('database-state').textContent = state.database_running === true ? '运行中' : state.database_running === false ? '已停止' : '待检查'
  $('health-state').textContent = state.healthy === true ? '通过' : state.healthy === false ? '未通过' : '待检查'
  show('start', state.ok === true && !state.running)
  show('install-note', state.installed === false)
  show('restart', state.running === true)
  show('stop', state.running === true)
  show('smtp-saved', smtpReady())
  show('smtp-unreadable', state.smtp_configured === true && !smtpReady())
  $('sender-address').textContent = state.smtp_from_email || ''
  show('smtp-edit', state.smtp_configured === true && !editing)
  show('smtp-cancel', state.smtp_configured === true && editing)
  show('smtp-form', !state.smtp_configured || editing)
  $('smtp-title').textContent = state.smtp_configured ? '登录安全' : '配置验证码发信'
  const pending = state.admin_binding_pending === true || state.admin_email_state === 'pending' || bindingStarted
  show('binding-email', !pending)
  show('code-form', pending)
  $('binding-form').querySelector('button').textContent = pending ? '发送或重发绑定码' : '发送绑定码'
  for (const element of document.querySelectorAll('button, input, select')) element.disabled = busy
}

async function refresh() {
  const status = await window.tradeLoomServer.invoke('status')
  if (status.ok !== true) {
    const health = await window.tradeLoomServer.invoke('manage-status')
    state = { ...health, ok: false }
    notice(status.message || health.message)
    return
  }
  const health = status.installed ? await window.tradeLoomServer.invoke('manage-status') : {}
  state = { ...status, ...Object.fromEntries(['running', 'database_running', 'healthy']
    .filter((field) => typeof health[field] === 'boolean').map((field) => [field, health[field]])) }
}

async function run(action, payload, success) {
  if (busy) return
  busy = true
  paint()
  notice('正在处理…')
  try {
    if (action) {
      const result = await window.tradeLoomServer.invoke(action, payload)
      if (!result.ok) { notice(result.message); return }
      success?.(result)
      notice(result.message)
    } else notice('')
    await refresh()
  } catch { notice('无法确认操作结果，请刷新状态。') }
  finally { busy = false; paint() }
}

$('refresh').addEventListener('click', () => run(null))
$('start').addEventListener('click', () => run(state.installed ? 'manage-start' : 'start'))
$('restart').addEventListener('click', () => run('manage-restart'))
$('stop').addEventListener('click', () => run('manage-stop'))
$('open-console').addEventListener('click', () => run('open'))
for (const button of document.querySelectorAll('[data-page]')) {
  button.addEventListener('click', () => { if (ready()) { page = button.dataset.page; paint() } })
}

$('smtp-edit').addEventListener('click', () => { editing = true; paint() })
$('smtp-cancel').addEventListener('click', () => { editing = false; $('smtp-form').reset(); paint() })
$('smtp-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const data = formFields(event.target)
  event.target.elements.password.value = ''
  data.port = Number(data.port)
  for (const field of ['host', 'username', 'from_email']) data[field] = data[field].trim()
  run('mail', { operation: state.smtp_configured ? 'smtp-replace' : 'smtp', smtp: data }, () => {
    editing = false
    event.target.reset()
  })
})
$('admin-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const { username, email, password, password_confirm: confirmation } = formFields(event.target)
  if (password !== confirmation) { notice('两次输入的密码不一致。'); return }
  event.target.reset()
  run('create', { username: username.trim(), email: email.trim(), password }, () => {
    $('binding-form').elements.username.value = username.trim()
    bindingStarted = true
  })
})
$('binding-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const { username, email } = formFields(event.target)
  const pending = state.admin_binding_pending === true || state.admin_email_state === 'pending' || bindingStarted
  if (!pending && !email.trim()) { notice('请填写管理员邮箱。'); return }
  const payload = pending ? { operation: 'bind-email-resend', username: username.trim() }
    : { operation: 'bind-email-start', username: username.trim(), email: email.trim() }
  run('mail', payload, () => { bindingStarted = true })
})
$('code-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const username = $('binding-form').elements.username.value.trim()
  if (!username) { notice('请填写管理员账号。'); return }
  const { code } = formFields(event.target)
  event.target.reset()
  run('mail', { operation: 'bind-email-verify', username, code }, () => {
    bindingStarted = false
    $('binding-form').reset()
    page = 'overview'
  })
})
run(null)
