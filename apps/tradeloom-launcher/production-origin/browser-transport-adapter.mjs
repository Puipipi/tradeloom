const ORIGIN_GRANT_HEADER = 'x-tradeloom-origin-grant'
const MAX_ORIGIN_BODY_BYTES = 2 * 1024 * 1024
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const GRANT_REPLAY_WINDOW_MS = 30_000
const GRANT_REPLAY_TOMBSTONE_MS = 5 * 60_000
const MAX_GRANT_REPLAY_ENTRIES = 256
const MAX_GRANT_REPLAY_BYTES = 8 * 1024 * 1024

function endpointFor(url, appOrigin) {
  if (url.origin !== appOrigin || !url.pathname.startsWith('/api/')) return undefined
  const endpoint = url.pathname.slice('/api/'.length)
  if (!endpoint || endpoint.split('/').some(segment => !segment || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined
  return endpoint
}

export function installBrowserTransportAdapter(transport, globals = globalThis) {
  if (!transport || transport.ownsHost !== true || typeof transport.streamBaseUrl !== 'string') {
    throw new TypeError('production-origin adapter requires the owned Host transport')
  }
  if (typeof globals.fetch !== 'function' || typeof globals.Request !== 'function' || typeof globals.Headers !== 'function') {
    throw new TypeError('production-origin adapter requires the native Fetch APIs')
  }
  const appOrigin = new URL(globals.location?.href ?? 'dsh-app://app/').origin
  const hadTransportFetch = typeof transport.fetch === 'function'
  const originalFetch = hadTransportFetch ? transport.fetch : globals.fetch.bind(globals)
  const invokeGrant = globals.dshDesktopBoot?.issueSceneMemoryOriginGrant
  const currentTime = () => typeof globals.Date?.now === 'function' ? globals.Date.now() : Date.now()
  const grantReplays = []
  let grantReplayBytes = 0
  const bodyMatches = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  const findGrantReplay = (endpoint, method, bodyBytes) => {
    const now = currentTime()
    for (let index = grantReplays.length - 1; index >= 0; index--) {
      const entry = grantReplays[index]
      if (entry.status !== 'pending' && entry.tombstoneUntil <= now) {
        grantReplayBytes -= entry.bodyBytes.byteLength
        grantReplays.splice(index, 1)
        continue
      }
      if (entry.endpoint === endpoint && entry.method === method && bodyMatches(entry.bodyBytes, bodyBytes)) return entry
    }
    return undefined
  }
  const wrappedFetch = async (input, init) => {
    const url = new URL(input instanceof globals.Request ? input.url : input, globals.location?.href ?? 'dsh-app://app/')
    const endpoint = endpointFor(url, appOrigin)
    if (!endpoint || (init?.method ?? input?.method)?.toUpperCase?.() !== 'POST') return await originalFetch(input, init)
    const relativeInput = typeof input === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) && !input.startsWith('//')
    const request = input instanceof globals.Request
      ? new globals.Request(input.clone(), init)
      : new globals.Request(relativeInput ? url : input, init)
    if (request.body === null) return await originalFetch(input, init)
    const bodyBytes = new Uint8Array(await request.clone().arrayBuffer())
    if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > MAX_ORIGIN_BODY_BYTES || typeof invokeGrant !== 'function') return await originalFetch(input, init)
    let replay = findGrantReplay(endpoint, request.method, bodyBytes)
    if (!replay && request.headers.has(ORIGIN_GRANT_HEADER)) {
      throw Object.assign(new Error('scene-memory origin replay record is no longer available'), { code: 'origin_replay_expired' })
    }
    if (replay && replay.replayUntil <= currentTime()) {
      throw Object.assign(new Error('scene-memory origin replay window expired'), { code: 'origin_replay_expired' })
    }
    let grant
    if (replay?.status === 'pending') {
      grant = await replay.grantPromise
    } else if (replay) {
      grant = replay
    } else {
      while (grantReplays.length >= MAX_GRANT_REPLAY_ENTRIES || grantReplayBytes + bodyBytes.byteLength > MAX_GRANT_REPLAY_BYTES) {
        const oldest = grantReplays[0]
        if (!oldest || oldest.status === 'pending' || oldest.tombstoneUntil > currentTime()) {
          throw Object.assign(new Error('scene-memory origin replay cache is full'), { code: 'origin_replay_capacity' })
        }
        grantReplayBytes -= oldest.bodyBytes.byteLength
        grantReplays.shift()
      }
      const pending = {
        status: 'pending', endpoint, method: request.method, bodyBytes: bodyBytes.slice(),
        replayUntil: Number.POSITIVE_INFINITY, tombstoneUntil: Number.POSITIVE_INFINITY,
      }
      grantReplays.push(pending)
      grantReplayBytes += pending.bodyBytes.byteLength
      pending.grantPromise = Promise.resolve().then(() => invokeGrant({ endpoint, httpMethod: request.method, bodyBytes: bodyBytes.slice() }))
      try {
        grant = await pending.grantPromise
        if (grant === null || grant === void 0) {
          grantReplays.splice(grantReplays.indexOf(pending), 1)
          grantReplayBytes -= pending.bodyBytes.byteLength
          return await originalFetch(input, init)
        }
        pending.status = 'ready'
        pending.token = grant.token
        const now = currentTime()
        pending.replayUntil = now + GRANT_REPLAY_WINDOW_MS
        pending.tombstoneUntil = now + GRANT_REPLAY_TOMBSTONE_MS
      } catch (error) {
        grantReplays.splice(grantReplays.indexOf(pending), 1)
        grantReplayBytes -= pending.bodyBytes.byteLength
        throw error
      }
      replay = pending
    }
    if (grant === null || grant === void 0) return await originalFetch(input, init)
    if (typeof grant.token !== 'string' || !grant.token) throw new Error('Host returned an invalid scene-memory origin grant')
    const headers = new globals.Headers(request.headers)
    headers.set(ORIGIN_GRANT_HEADER, replay?.token ?? grant.token)
    return await originalFetch(new globals.Request(request.clone(), { headers }))
  }
  transport.fetch = wrappedFetch
  return () => {
    if (transport.fetch === wrappedFetch) {
      if (hadTransportFetch) transport.fetch = originalFetch
      else delete transport.fetch
    }
  }
}

export { ORIGIN_GRANT_HEADER }
