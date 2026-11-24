const input = document.querySelector('#server-origin')
const username = document.querySelector('#username')
const password = document.querySelector('#password')
const status = document.querySelector('#status')
const button = document.querySelector('button')
let busy = false
window.tradeloomEnterprise.getConfig().then(({ serverOrigin, edition }) => {
  input.value = serverOrigin || ''
  document.querySelector('h1').textContent = `登录织贸 · ${{ owner: '老板版', factory: '工厂版' }[edition] || '个人端'}`
})
document.querySelector('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy) return
  busy = true
  button.disabled = true
  status.textContent = '正在登录…'
  const credentials = { serverOrigin: input.value, username: username.value, password: password.value }
  password.value = ''
  try {
    await window.tradeloomEnterprise.signIn(credentials)
    status.textContent = '登录成功。'
  } catch (error) {
    status.textContent = error?.message || '无法登录，请检查服务器地址、账号和密码。'
  } finally {
    credentials.password = ''
    busy = false
    button.disabled = false
  }
})
