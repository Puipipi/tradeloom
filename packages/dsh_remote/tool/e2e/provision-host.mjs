// Pre-provisions a ds-harness-remote Host identity + device credentials for
// the isolated E2E DSH_HOME, using the self-hosted Server's password login
// (the plugin CLI only offers QR / registration-code login).
// Usage: node provision-host.mjs <serverUrl> <account> <password> <dshHome> <deviceName>
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [serverUrl, account, password, dshHome, deviceName] = process.argv.slice(2)
const origin = new URL(serverUrl).origin

async function call(path, body, bearer) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`)
  return json
}

const login = await call('/api/v1/auth/login', { email: account, password })
const { privateKey } = generateKeyPairSync('x25519')
const jwk = privateKey.export({ format: 'jwk' })
const deviceId = randomUUID()
const tokens = await call('/api/v1/devices/register', {
  v: 1,
  device: { deviceId, name: deviceName, role: 'host', platform: 'linux', identityKey: jwk.x, clientVersion: '0.5.17' },
}, login.token)

const scope = createHash('sha256').update(origin).digest('hex').slice(0, 24)
const dir = join(dshHome, 'remote', 'servers', scope, 'host')
mkdirSync(dir, { recursive: true, mode: 0o700 })
for (const d of [join(dshHome, 'remote'), join(dshHome, 'remote', 'servers'), join(dshHome, 'remote', 'servers', scope), dir]) chmodSync(d, 0o700)
const write = (name, text) => { writeFileSync(join(dir, name), text, { mode: 0o600 }); chmodSync(join(dir, name), 0o600) }
write('device.json', `${JSON.stringify({ schemaVersion: 1, deviceId, name: deviceName, publicKey: jwk.x }, null, 2)}\n`)
write('device.key', `${jwk.d}\n`)
write('server-credentials.json', `${JSON.stringify({ schemaVersion: 1, serverUrl: origin, deviceId, authorizationMethod: 'account', account: login.account, ...tokens }, null, 2)}\n`)
console.log(JSON.stringify({ deviceId, publicKey: jwk.x, dir }))
