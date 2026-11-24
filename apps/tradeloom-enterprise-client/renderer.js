const input = document.querySelector('#server-origin')
const status = document.querySelector('#status')

window.tradeloomEnterprise.getConfig().then(({ serverOrigin, edition }) => {
  input.value = serverOrigin || ''
  document.querySelector('h1').textContent = `连接企业服务器 · ${{ owner: '老板版', factory: '工厂版' }[edition] || '通用版'}`
})

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
