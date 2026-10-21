import http from 'node:http'

export const name = '@tradeloom/dsh-business-shell/proxy'
export const inject = ['connection', 'webServer']

export const BUSINESS_PROXY_ROUTES = Object.freeze([
  { alias: 'business', path: '/business', target: '/' },
  { alias: 'business-api', path: '/business-api', target: '/api' },
  { alias: 'business-static', path: '/business-static', target: '/static' },
  { alias: 'business-media', path: '/business-media', target: '/uploads' },
])

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
])
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// Matches Django's default DATA_UPLOAD_MAX_MEMORY_SIZE (config/settings.py does not override it).
const MAX_JSON_BODY_BYTES = 2_621_440

function isJsonContentType(value) {
  const mediaType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(mediaType)
}

function csrfCookie(cookieHeader = '') {
  const token = cookieHeader.split(';').map(item => item.trim()).find(item => item.startsWith('csrftoken='))
  return token || ''
}

function forwardedHeaders(req) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'cookie' || lower === 'authorization' || lower === 'host' || lower.startsWith('x-forwarded-')) continue
    if (value !== undefined) headers[lower] = value
  }
  const cookie = csrfCookie(req.headers?.cookie)
  if (cookie) headers.cookie = cookie
  if (req.headers?.host) {
    headers.host = req.headers.host
    headers['x-forwarded-host'] = req.headers.host
  }
  headers['x-forwarded-proto'] = req.socket?.encrypted ? 'https' : 'http'
  return headers
}

function publicLocation(location) {
  if (typeof location !== 'string' || !location.startsWith('/') || location.startsWith('//')) return location
  const mappings = [
    ['/api/', '/business-api/'], ['/static/', '/business-static/'], ['/uploads/', '/business-media/'],
  ]
  for (const [internal, external] of mappings) {
    if (location === internal.slice(0, -1) || location.startsWith(internal)) return external + location.slice(internal.length)
  }
  return `/business${location}`
}

function responseHeaders(upstreamHeaders) {
  const headers = {}
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'set-cookie') {
      const djangoCookies = (Array.isArray(value) ? value : [value]).filter(cookie => /^csrftoken=/i.test(cookie))
      if (djangoCookies.length) headers[lower] = djangoCookies
      continue
    }
    headers[lower] = lower === 'location' ? publicLocation(value) : value
  }
  return headers
}

function mappedPath(req, route) {
  const raw = req.url ?? '/'
  const suffix = raw.slice(route.path.length)
  if (route.alias === 'business') return suffix || '/'
  const tail = suffix.startsWith('?') || suffix === '' ? `/${suffix}` : suffix
  return `${route.target}${tail}`
}

export function createBusinessProxyHandler(ctx, alias, dependencies = {}) {
  const route = BUSINESS_PROXY_ROUTES.find(item => item.alias === alias)
  if (!route) throw new Error(`Unknown TradeLoom business proxy alias: ${alias}`)
  const requestUpstream = dependencies.request ?? http.request
  const upstreamPort = dependencies.upstreamPort ?? Number(process.env.TRADELOOM_DJANGO_PORT ?? 3090)

  return (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }

    const headers = forwardedHeaders(req)
    const hasContentLength = req.headers?.['content-length'] !== undefined
    if (BODY_METHODS.has(String(req.method).toUpperCase()) && isJsonContentType(req.headers?.['content-type']) && !hasContentLength) {
      const chunks = []
      let totalBytes = 0
      let settled = false
      const rejectRequest = (status, message) => {
        if (settled) return
        settled = true
        chunks.length = 0
        if (!res.headersSent && !res.destroyed) {
          res.statusCode = status
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(message)
        }
      }
      req.on('data', chunk => {
        if (settled) return
        totalBytes += chunk.length
        if (totalBytes > MAX_JSON_BODY_BYTES) {
          rejectRequest(413, 'TradeLoom JSON request body is too large')
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('aborted', () => rejectRequest(400, 'TradeLoom JSON request body was interrupted'))
      req.on('error', () => rejectRequest(400, 'TradeLoom JSON request body could not be read'))
      req.on('end', () => {
        if (settled) return
        settled = true
        const body = Buffer.concat(chunks, totalBytes)
        headers['content-length'] = String(body.length)
        forward(req, res, headers, body, requestUpstream, upstreamPort, route)
      })
      return
    }

    forward(req, res, headers, req, requestUpstream, upstreamPort, route)
  }
}

function forward(req, res, headers, body, requestUpstream, upstreamPort, route) {
  const upstream = requestUpstream({
    hostname: '127.0.0.1',
    port: upstreamPort,
    method: req.method,
    path: mappedPath(req, route),
    headers,
  }, upstreamResponse => {
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers))
    upstreamResponse.on('aborted', () => res.destroy())
    upstreamResponse.on('error', () => res.destroy())
    upstreamResponse.pipe(res)
  })
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  upstream.on('error', () => {
    if (res.headersSent || res.destroyed) { res.destroy(); return }
    res.statusCode = 502
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('TradeLoom Django service is unavailable')
  })
  if (Buffer.isBuffer(body)) upstream.end(body)
  else body.pipe(upstream)
}

export function apply(ctx, dependencies = {}) {
  ctx.effect(() => {
    const disposers = BUSINESS_PROXY_ROUTES.map(route => ctx.webServer.register({
      kind: 'prefix',
      path: route.path,
      handler: createBusinessProxyHandler(ctx, route.alias, dependencies),
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'tradeloom-shell: same-origin Django business proxy')
}

