const { normalizeServerOrigin, enterpriseUrl } = require('./security.cjs')

async function sessionPolicy(ses, origin) {
  const url = `${origin}/enterprise/capabilities/`
  const response = await ses.fetch(url, { redirect: 'error', cache: 'no-store', credentials: 'include', signal: AbortSignal.timeout(15000) })
  if (!response.ok || response.redirected || (response.url && response.url !== url)) return null
  const policy = await response.json()
  return policy && typeof policy.role === 'string' && policy.capabilities && typeof policy.capabilities === 'object' ? policy : null
}

// net.fetch rejects manual redirects in Electron. net.request exposes the
// redirect event before dispatch; never call followRedirect for credential POSTs.
function postForm(ses, url, options) {
  return new Promise((resolve, reject) => {
    const request = require('electron').net.request({ url, method: 'POST', session: ses, useSessionCookies: true, redirect: 'manual' })
    const abort = () => { request.abort(); reject(new Error('Login timed out')) }
    const finish = value => { options.signal.removeEventListener('abort', abort); resolve(value) }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) { abort(); return }
    for (const [name, value] of Object.entries(options.headers)) request.setHeader(name, value)
    request.on('error', () => { options.signal.removeEventListener('abort', abort); reject(new Error('Login transport failed')) })
    request.on('redirect', (status, _method, location) => {
      finish({ status, headers: { get: name => name === 'location' ? location : null } })
      request.abort()
    })
    request.on('response', response => {
      response.on('data', () => {})
      response.on('end', () => finish({ status: response.statusCode, headers: { get: () => null } }))
      response.on('error', () => reject(new Error('Login response failed')))
    })
    request.end(options.body)
  })
}

async function signIn(ses, rawOrigin, username, password, post = postForm) {
  const origin = normalizeServerOrigin(rawOrigin)
  if (typeof username !== 'string' || !username.trim() || username.length > 150 || typeof password !== 'string' || !password || password.length > 4096) {
    throw new Error('请输入织贸内部账号和密码。')
  }
  const loginUrl = `${origin}/accounts/login/?next=/enterprise/`
  try {
    const signal = AbortSignal.timeout(20000)
    const page = await ses.fetch(loginUrl, { redirect: 'error', cache: 'no-store', credentials: 'include', signal })
    if (!page.ok || page.redirected || (page.url && page.url !== loginUrl)) throw new Error('登录入口不可用。')
    const html = await page.text()
    if (!html.includes('<title>织贸企业服务登录</title>') || !/class=["'][^"']*\bportal-login\b/.test(html)) throw new Error('服务器未提供织贸企业服务登录入口。')
    const token = html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([a-zA-Z0-9]{32,128})["']/)?.[1]
    if (!token) throw new Error('服务器未提供有效的 Django 登录入口。')
    const body = new URLSearchParams({ username: username.trim(), password, csrfmiddlewaretoken: token, next: '/enterprise/' })
    const response = await post(ses, loginUrl, {
      method: 'POST', redirect: 'manual', credentials: 'include', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: loginUrl }, body: body.toString(),
    })
    // A previous valid cookie is not proof that THIS credential submission succeeded.
    if (response.status === 200) throw new Error('账号或密码不正确，或账号已停用。')
    if (response.status === 403) throw new Error('登录安全校验失败，请重试。')
    const location = response.headers.get('location')
    if (response.status !== 302 || !location || new URL(location, origin).href !== enterpriseUrl(origin)) throw new Error('服务器返回了非预期登录结果，已拒绝跳转。')
    if (!await sessionPolicy(ses, origin)) throw new Error('登录会话未通过服务器验证。')
    return origin
  } catch (error) {
    // Never forward transport diagnostics that might contain submitted data.
    if (/^(账号或密码|登录安全校验|服务器返回|登录会话|登录入口|服务器未提供)/.test(error.message)) throw error
    throw new Error('无法安全连接服务器，请检查地址、网络和 HTTPS 证书。')
  }
}

module.exports = { signIn, sessionPolicy }
