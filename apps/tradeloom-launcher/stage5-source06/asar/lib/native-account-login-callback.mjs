import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const CALLBACK_PATH = '/oauth/callback'
const CALLBACK_QUERY = new Set(['code', 'state'])
const MAX_CALLBACK_VALUE = 4096
const BRIDGE_LIFETIME_MS = 10 * 60 * 1000
const NEUTRAL_RESPONSE = '验证结果已返回应用；登录状态以应用显示为准。此页面不会确认登录是否成功。'

function hostOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new TypeError('account callback: invalid Host URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError('account callback: invalid Host URL')
  return url.origin
}

function callbackValues(requestUrl) {
  let url
  try { url = new URL(requestUrl, 'http://127.0.0.1') } catch { return undefined }
  if (url.pathname !== CALLBACK_PATH || [...url.searchParams.keys()].some(key => !CALLBACK_QUERY.has(key))) return undefined
  const codeValues = url.searchParams.getAll('code')
  const stateValues = url.searchParams.getAll('state')
  if (codeValues.length !== 1 || stateValues.length !== 1) return undefined
  const [code] = codeValues
  const [state] = stateValues
  if (!code || code.length > MAX_CALLBACK_VALUE || /[\u0000-\u001f\u007f]/u.test(code)
    || !/^[A-Za-z0-9_-]{43}$/u.test(state)) return undefined
  return { code, state }
}

function sendText(response, statusCode, text = '') {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

/** A short-lived localhost-only relay for the native DSH account callback. */
export async function createNativeAccountLoginCallbackBridge(value, { lifetimeMs = BRIDGE_LIFETIME_MS } = {}) {
  const upstreamOrigin = hostOrigin(value)
  const server = createServer((incoming, outgoing) => {
    const port = server.address()?.port
    const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
    const hostHeader = String(incoming.headers.host ?? '').toLowerCase()
    const parsedOrigin = callbackValues(incoming.url ?? '')
    if (!expectedHosts.has(hostHeader)) {
      sendText(outgoing, 403)
      return
    }
    if (incoming.method !== 'GET') {
      sendText(outgoing, 405)
      return
    }
    if (!parsedOrigin) {
      sendText(outgoing, 400)
      return
    }

    const target = new URL(CALLBACK_PATH, upstreamOrigin)
    target.searchParams.set('code', parsedOrigin.code)
    target.searchParams.set('state', parsedOrigin.state)
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'GET',
      headers: { accept: 'text/plain' },
      timeout: 15_000,
    }, response => {
      response.resume()
      response.once('end', () => {
        // The Host callback owns OAuth state validation and account persistence.
        // Never relay its Location header, cookies, or body to the browser.
        sendText(outgoing, 200, NEUTRAL_RESPONSE)
      })
    })
    request.once('timeout', () => request.destroy())
    request.once('error', () => {
      if (!outgoing.headersSent) sendText(outgoing, 502, '回调未能传回应用，请返回应用重试。')
    })
    request.end()
  })

  await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise(resolve => server.close(resolve))
    throw new Error('account callback: loopback listener unavailable')
  }
  let closed = false
  const expiry = setTimeout(() => { void close() }, lifetimeMs)
  expiry.unref?.()
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(expiry)
    await new Promise(resolve => server.close(() => resolve()))
  }
  return Object.freeze({ origin: `http://127.0.0.1:${address.port}`, get closed() { return closed }, close })
}

export function isNativeAccountCallbackOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.port !== '' && Number(url.port) > 0 && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
