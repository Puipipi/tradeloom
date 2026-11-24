const ENTERPRISE_PATH = '/enterprise/'

function normalizeServerOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('服务器地址无效')
  let url
  try { url = new URL(raw.trim()) } catch { throw new Error('请输入完整的服务器地址，例如 https://work.example.com') }
  if (url.username || url.password) throw new Error('服务器地址不能包含账号或密码')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('服务器地址只填写协议、主机名和可选端口')
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('企业服务器必须使用 HTTPS；仅允许回环地址使用 HTTP 调试')
  }
  return url.origin
}

function enterpriseUrl(origin) {
  return new URL(ENTERPRISE_PATH, normalizeServerOrigin(origin)).href
}

function isSameOriginRequest(requestUrl, serverOrigin) {
  try {
    const candidate = new URL(requestUrl)
    return candidate.origin === normalizeServerOrigin(serverOrigin) && ['https:', 'http:'].includes(candidate.protocol)
  } catch {
    return false
  }
}

module.exports = { ENTERPRISE_PATH, normalizeServerOrigin, enterpriseUrl, isSameOriginRequest }
