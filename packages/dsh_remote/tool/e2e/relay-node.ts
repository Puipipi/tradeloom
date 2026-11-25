// E2E-only Relay node for `transport.relay.attach` (upstream docs/protocol.md
// §12.3, docs/network.md §4). Upstream's open-source apps/server has no node,
// so tool/e2e/patch-relay-attach.mjs mounts this one on the self-hosted
// Server: it assigns node-bound one-time tickets in `connect.incoming` /
// `connect.accepted`, answers `relay.attach` with `relay.ready`, forwards
// `relay` frames between the two attached sides, pings each side once, and
// sends `relay.detach` when one side leaves. It never reads ciphertext.
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { MAX_RELAY_FRAME_BYTES, createRelayDataFrame, decodeRelayDataFrame, encodeRelayDataFrame } from '@dsh-remote/protocol'

type Ticket = { connectionId: string; deviceId: string; peerDeviceId: string; expires: number }
type Side = { ws: WebSocket; connectionId: string; deviceId: string; peerDeviceId: string; frames: number }

const short = (id: string) => id.slice(0, 8)

export class RelayNode {
  readonly nodeId = 'e2e-relay-1'
  readonly epoch = 1
  private readonly tickets = new Map<string, Ticket>()
  private readonly sides = new Map<string, Side>()
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME_BYTES, perMessageDeflate: false })

  constructor(private readonly endpoint: string) {}

  /** A one-time ticket for [deviceId]'s side of [connectionId]. */
  assign(connectionId: string, deviceId: string, peerDeviceId: string): Record<string, unknown> {
    const ticket = `dshrt.${randomBytes(24).toString('base64url')}`
    this.tickets.set(ticket, { connectionId, deviceId, peerDeviceId, expires: Date.now() + 60_000 })
    return { relayEndpoint: this.endpoint, relayTicket: ticket, relayNodeId: this.nodeId, relayEpoch: this.epoch }
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws))
  }

  close(): void {
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }

  private accept(ws: WebSocket): void {
    let side: Side | undefined
    const send = (target: WebSocket, type: string, payload: Record<string, unknown>) => {
      if (target.readyState === WebSocket.OPEN) target.send(encodeRelayDataFrame(createRelayDataFrame(type, payload)))
    }
    ws.on('error', () => {})
    ws.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('INVALID_MESSAGE')
        const text = raw.toString()
        const frame = decodeRelayDataFrame(text)
        const p = frame.payload
        if (side === undefined) {
          const ticket = frame.type === 'relay.attach' && typeof p.ticket === 'string' ? this.tickets.get(p.ticket) : undefined
          if (ticket === undefined || ticket.expires < Date.now() || ticket.connectionId !== p.connectionId
            || ticket.deviceId !== p.deviceId || ticket.peerDeviceId !== p.peerDeviceId) throw new Error('RELAY_TICKET_INVALID')
          this.tickets.delete(p.ticket as string)
          const key = `${ticket.connectionId}:${ticket.deviceId}`
          this.sides.get(key)?.ws.close(4003, 'RELAY_REPLACED')
          side = { ws, connectionId: ticket.connectionId, deviceId: ticket.deviceId, peerDeviceId: ticket.peerDeviceId, frames: 0 }
          this.sides.set(key, side)
          console.log(`relay attach device=${short(side.deviceId)} connection=${short(side.connectionId)}`)
          send(ws, 'relay.ready', { connectionId: side.connectionId, epoch: this.epoch })
          send(ws, 'ping', { nonce: randomBytes(8).toString('hex') })
          return
        }
        if (frame.type === 'pong') {
          console.log(`relay pong device=${short(side.deviceId)}`)
          return
        }
        if (frame.type === 'ping') {
          send(ws, 'pong', p)
          return
        }
        if (frame.type !== 'relay' || p.connectionId !== side.connectionId || p.targetDeviceId !== side.peerDeviceId) {
          throw new Error('INVALID_MESSAGE')
        }
        const peer = this.sides.get(`${side.connectionId}:${side.peerDeviceId}`)
        if (peer === undefined) throw new Error('RELAY_PEER_NOT_ATTACHED')
        side.frames += 1
        peer.ws.send(text)
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_MESSAGE'
        console.log(`relay reject ${code}`)
        ws.close(4001, code)
      }
    })
    ws.on('close', () => {
      if (side === undefined) return
      const key = `${side.connectionId}:${side.deviceId}`
      if (this.sides.get(key) !== side) return
      this.sides.delete(key)
      console.log(`relay close device=${short(side.deviceId)} connection=${short(side.connectionId)} frames=${side.frames}`)
      const peer = this.sides.get(`${side.connectionId}:${side.peerDeviceId}`)
      if (peer !== undefined) send(peer.ws, 'relay.detach', { connectionId: side.connectionId })
    })
  }
}
