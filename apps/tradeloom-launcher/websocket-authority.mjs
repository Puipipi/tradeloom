export function desktopWebSocketRequestHeaders({
  url, requestHeaders, webContentsId, primaryWebContentsId, hostUrl, hostCookie,
}) {
  if (hostUrl === undefined || hostCookie === undefined || webContentsId !== primaryWebContentsId) return {}
  const target = new URL(hostUrl)
  const requested = new URL(url)
  if (requested.host !== target.host || requested.protocol !== (target.protocol === 'https:' ? 'wss:' : 'ws:')) return {}
  const headers = Object.fromEntries(Object.entries(requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
  if (headers.origin !== 'dsh-app://app') return { cancel: true }
  return { requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } }
}
