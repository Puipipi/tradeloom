// Mounts tool/e2e/relay-node.ts on a copy of upstream apps/server/src
// (RELAY_ATTACH=1 in run_e2e.sh): the gateway then negotiates
// `transport.relay.attach` and hands each side of a connection its own Relay
// assignment, as the hosted Server does. Fails loudly if upstream moved.
// Usage: node patch-relay-attach.mjs <server src dir> <relay endpoint>
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [dir, endpoint] = process.argv.slice(2)
if (!dir || !endpoint) throw new Error('usage: patch-relay-attach.mjs <server src dir> <relay endpoint>')
const clientEndpoint = new URL(endpoint)
if (process.env.RELAY_CLIENT_HOST) clientEndpoint.hostname = process.env.RELAY_CLIENT_HOST
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'relay-node.ts'), join(dir, 'relay-node.ts'))

const file = join(dir, 'gateway.ts')
let source = readFileSync(file, 'utf8')
const replace = (anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw new Error(`gateway.ts anchor not found exactly once: ${anchor}`)
  source = source.replace(anchor, replacement)
}

replace("import { ApiError, Store } from './store.js'",
  "import { ApiError, Store } from './store.js'\nimport { RelayNode } from './relay-node.js'")
replace('counters: Map<string, number> }',
  'counters: Map<string, number>; assignments?: Record<string, Record<string, unknown>> }')
replace('  constructor(server: Server, private store: Store, origin: string) {\n',
  `  private relay = new RelayNode(${JSON.stringify(endpoint)})
  constructor(server: Server, private store: Store, origin: string) {
    server.on('upgrade', (req, socket, head) => { if (req.url === '/ws/v1/relay') this.relay.upgrade(req, socket, head) })
`)
replace("if (req.url !== '/ws/v1/connect' ||", "if (req.url === '/ws/v1/relay') return\n      if (req.url !== '/ws/v1/connect' ||")
replace("capabilities: p.capabilities.includes('transport.relay') ? ['transport.relay'] : [],",
  "capabilities: ['transport.relay', 'transport.relay.attach'].filter(c => p.capabilities.includes(c)),")
replace("authorization: 'account', preferredTransports: ['relay'] }))",
  "authorization: 'account', preferredTransports: ['relay'], ...this.assign(link, peer, host) }))")
replace("      else link.stage = 'accepted'\n      this.send(other, frame)",
  `      else link.stage = 'accepted'
      const assignment = frame.type === 'connect.accepted' ? link.assignments?.[other.id] : undefined
      this.send(other, assignment === undefined ? frame : createControlFrame('connect.accepted', { ...(frame.payload as object), ...assignment }))`)
replace('  close(): void { clearInterval(this.heartbeat);',
  `  private assign(link: Link, client: Peer, host: Peer): Record<string, unknown> {
    if (!client.capabilities.includes('transport.relay.attach') || !host.capabilities.includes('transport.relay.attach')) return {}
    link.assignments = { [client.id]: { ...this.relay.assign(link.id, client.id, host.id), relayEndpoint: ${JSON.stringify(clientEndpoint.href)} } }
    return this.relay.assign(link.id, host.id, client.id)
  }
  close(): void { this.relay.close(); clearInterval(this.heartbeat);`)
writeFileSync(file, source)
