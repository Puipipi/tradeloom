const input = document.querySelector('#server-origin')
const status = document.querySelector('#status')

window.tradeloomEnterprise.getConfig().then(({ serverOrigin }) => { input.value = serverOrigin || '' })

document.querySelector('#connect-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  status.textContent = '正在连接…'
  try {
    await window.tradeloomEnterprise.connect(input.value)
    status.textContent = '已打开企业服务器。请在服务器登录页登录。'
  } catch (error) {
    status.textContent = error?.message || '无法连接，请检查服务器地址。'
  }
})
