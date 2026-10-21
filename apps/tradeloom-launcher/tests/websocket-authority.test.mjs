import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopWebSocketRequestHeaders } from '../websocket-authority.mjs'

const request = overrides => desktopWebSocketRequestHeaders({
  url: 'ws://192.168.1.23:3088/stream', requestHeaders: { Origin: 'dsh-app://app', 'Sec-WebSocket-Protocol': 'dsh' },
  webContentsId: 4, primaryWebContentsId: 4, hostUrl: 'http://192.168.1.23:3088', hostCookie: 'native=secret', ...overrides,
})

test('LAN websocket authority forwards only exact host/protocol with desktop origin', () => {
  assert.deepEqual(request(), { requestHeaders: {
    origin: 'http://192.168.1.23:3088', cookie: 'native=secret', 'sec-fetch-site': 'same-origin',
    'sec-websocket-protocol': 'dsh',
  } })
  assert.deepEqual(request({ url: 'ws://192.168.1.24:3088/stream' }), {})
  assert.deepEqual(request({ url: 'wss://192.168.1.23:3088/stream' }), {})
  assert.deepEqual(request({ webContentsId: 5 }), {})
  assert.deepEqual(request({ requestHeaders: { Origin: 'https://attacker.example' } }), { cancel: true })
})
