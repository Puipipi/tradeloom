#!/usr/bin/env node
// Recording proxy for the dsh-go bridge wire: HTTP requests / responses and WebSocket text
// frames pass through unchanged (Host rewritten to the upstream) and are appended to a JSONL
// file for scripts/validate-wire.mjs. Test tooling only.
//
//   node scripts/wire-capture.mjs <listen-port> <upstream-port> <out.jsonl>
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

const [listenPort, upstreamPort, out] = process.argv.slice(2)
if (!out) {
  console.error('usage: wire-capture.mjs <listen-port> <upstream-port> <out.jsonl>')
  process.exit(2)
}
const UP = { host: '127.0.0.1', port: Number(upstreamPort) }
const record = (entry) => appendFileSync(out, `${JSON.stringify(entry)}\n`)
const json = (buf, type) => {
  if (!buf.length || !String(type ?? '').includes('json')) return undefined
  try { return JSON.parse(buf.toString('utf8')) } catch { return undefined }
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    // Identity encoding, so the recorded bodies are readable JSON.
    const headers = { ...req.headers, host: `${UP.host}:${UP.port}` }
    delete headers['accept-encoding']
    const up = http.request({ ...UP, method: req.method, path: req.url, headers }, (ur) => {
      const rchunks = []
      ur.on('data', (c) => rchunks.push(c))
      ur.on('end', () => {
        const rbody = Buffer.concat(rchunks)
        if (req.url.startsWith('/dsh-go/')) {
          record({
            kind: 'http', method: req.method, path: req.url,
            reqType: req.headers['content-type'], req: json(body, req.headers['content-type']), reqRaw: body.length && json(body, 'json') === undefined ? body.toString('utf8').slice(0, 200) : undefined,
            status: ur.statusCode, resType: ur.headers['content-type'], res: json(rbody, ur.headers['content-type']),
          })
        }
        res.writeHead(ur.statusCode, ur.headers)
        res.end(rbody)
      })
    })
    up.on('error', () => { res.writeHead(502); res.end() })
    up.end(body)
  })
})

/** Incremental RFC 6455 frame reader: calls onText(string) for each complete text message. */
function frameReader(onText) {
  let buf = Buffer.alloc(0)
  let parts = []
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let at = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
      const maskAt = at
      if (masked) at += 4
      if (buf.length < at + len) return
      const payload = Buffer.from(buf.subarray(at, at + len))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i % 4)]
      buf = buf.subarray(at + len)
      if (opcode === 1 || opcode === 0) {
        if (opcode === 1) parts = []
        parts.push(payload)
        if (fin) onText(Buffer.concat(parts).toString('utf8'))
      }
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(UP, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      lines.push(`${name}: ${name.toLowerCase() === 'host' ? `${UP.host}:${UP.port}` : req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    const upRead = frameReader((text) => record({ kind: 'ws', dir: 'up', path: req.url, text }))
    let handshake = true
    let pending = Buffer.alloc(0)
    const downRead = frameReader((text) => record({ kind: 'ws', dir: 'down', path: req.url, text }))
    socket.on('data', (c) => { upRead(c); upstream.write(c) })
    upstream.on('data', (c) => {
      socket.write(c)
      if (handshake) {
        pending = Buffer.concat([pending, c])
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) return
        const status = Number(pending.subarray(0, end).toString('latin1').split(' ')[1])
        record({ kind: 'ws-open', path: req.url, status })
        handshake = false
        const rest = pending.subarray(end + 4)
        if (rest.length) downRead(rest)
        return
      }
      downRead(c)
    })
    const close = () => { socket.destroy(); upstream.destroy() }
    socket.on('close', close)
    upstream.on('close', close)
    socket.on('error', close)
    upstream.on('error', close)
  })
  upstream.on('error', () => socket.destroy())
})

server.listen(Number(listenPort), '127.0.0.1', () => console.log(`wire-capture: 127.0.0.1:${listenPort} -> ${UP.port}, recording ${out}`))
