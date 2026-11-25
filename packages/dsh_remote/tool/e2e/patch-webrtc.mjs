// Turns on WebRTC signaling in a copy of upstream apps/server/src
// (WEBRTC=1 in run_e2e.sh): the open-source gateway is Relay-only, while the
// hosted Server negotiates `transport.lan/p2p/turn`, sets `webrtcEnabled`
// and forwards `signal.*` and `transport.selected`. No STUN / TURN: LAN and
// host candidates only. Composes with patch-relay-attach.mjs. Fails loudly if
// upstream moved.
// Usage: node patch-webrtc.mjs <server src dir>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir] = process.argv.slice(2)
if (!dir) throw new Error('usage: patch-webrtc.mjs <server src dir>')

const file = join(dir, 'gateway.ts')
let source = readFileSync(file, 'utf8')
const replace = (anchor, replacement) => {
  const count = typeof anchor === 'string'
    ? source.split(anchor).length - 1
    : (source.match(new RegExp(anchor.source, 'g')) ?? []).length
  if (count !== 1) throw new Error(`gateway.ts anchor not found exactly once: ${anchor}`)
  source = source.replace(anchor, replacement)
}

// hello.ack: negotiate the direct transports both offered.
replace(/capabilities: (.+?), webrtcEnabled: false, webrtcFallbackTimeoutMs: 1 \}/,
  "capabilities: [...['transport.lan', 'transport.p2p', 'transport.turn'].filter(c => p.capabilities.includes(c)), ...($1)], webrtcEnabled: true, webrtcFallbackTimeoutMs: 12000 }")
// connect.incoming: the client's preference, limited to what both sides negotiated.
replace("authorization: 'account', preferredTransports: ['relay']",
  "authorization: 'account', preferredTransports: request.preferredTransports.filter(t => t === 'relay' || (peer.capabilities.includes(`transport.${t}`) && host.capabilities.includes(`transport.${t}`)))")
// transport.selected: any negotiated path from the client; the Host confirms its own WebRTC path.
replace("if (peer.id !== link.client || (frame.payload as TransportSelectedPayload).transport !== 'relay') throw new ApiError('CAPABILITY_NOT_SUPPORTED')",
  "if ((frame.payload as TransportSelectedPayload).transport === 'relay' && peer.id !== link.client) throw new ApiError('CAPABILITY_NOT_SUPPORTED')\n      console.log(`transport selected ${(frame.payload as TransportSelectedPayload).transport} by ${peer.role}`)")
replace("if (frame.type.startsWith('signal.')) return // Relay-only negotiation: no signaling forwarding.",
  "if (frame.type.startsWith('signal.')) { console.log(`signal ${frame.type} from ${peer.role}`); this.send(other, frame); return }")
writeFileSync(file, source)
