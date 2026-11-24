const input = document.querySelector('#server-origin')
const username = document.querySelector('#username')
const password = document.querySelector('#password')
const code = document.querySelector('#email-code')
const status = document.querySelector('#status')
const button = document.querySelector('#login-button')
let busy = false
let emailStep = false
function setStep(value) {
  emailStep = value
  document.querySelector('#password-step').hidden = value
  document.querySelector('#email-step').hidden = !value
  for (const field of [input, username, password]) { field.required = !value; field.disabled = value }
  code.required = value
  code.disabled = !value
  code.value = ''
  password.value = ''
  button.textContent = value ? '验证并登录' : '登录'
}
setStep(false)
window.tradeloomEnterprise.getConfig().then(({ serverOrigin, edition }) => {
  input.value = serverOrigin || ''
  document.querySelector('h1').textContent = `登录织贸 · ${{ owner: '老板版', factory: '工厂版' }[edition] || '个人端'}`
})
async function perform(operation) {
  if (busy) return
  busy = true
  for (const item of document.querySelectorAll('button')) item.disabled = true
  status.textContent = '正在验证…'
  try { await operation() } catch (error) { status.textContent = error?.message || '无法登录，请重试。' }
  finally { busy = false; for (const item of document.querySelectorAll('button')) item.disabled = false }
}
document.querySelector('#connect-form').addEventListener('submit', async event => {
  event.preventDefault()
  await perform(async () => {
    if (emailStep) {
      const value = code.value; code.value = ''
      await window.tradeloomEnterprise.verifyCode(value)
      status.textContent = '登录成功。'
    } else {
      const credentials = { serverOrigin: input.value, username: username.value, password: password.value }
      password.value = ''
      try {
        const result = await window.tradeloomEnterprise.signIn(credentials)
        if (result?.step === 'email_code') { setStep(true); status.textContent = '请输入账号绑定邮箱收到的验证码。'; code.focus() }
      } finally { credentials.password = '' }
    }
  })
})
document.querySelector('#resend-code').addEventListener('click', () => perform(async () => {
  await window.tradeloomEnterprise.resendCode()
  status.textContent = '验证码已重新发送，旧验证码已失效。'
}))
document.querySelector('#restart-login').addEventListener('click', () => perform(async () => {
  await window.tradeloomEnterprise.restartLogin()
  setStep(false); username.value = ''; status.textContent = ''; username.focus()
}))
