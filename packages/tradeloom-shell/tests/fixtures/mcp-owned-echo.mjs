// Controlled stdio peer for the REAL official MCP client. This is test-only;
// it never reads a directory, runs a command, requests a model or uses a key.
import { createInterface } from 'node:readline'
import { writeFileSync, renameSync } from 'node:fs'
const records = process.argv[2]
const record = { pid: process.pid, kind: 'synthetic-stdio-peer', waiting: [], cancelled: [], closed: false }
const save = () => { if (records) { writeFileSync(records + '.next', JSON.stringify(record)); renameSync(records + '.next', records) } }
save()
if (process.argv[3] === 'fail-startup') process.exit(7)
const pending = new Map()
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tradeloom-controlled-peer', version: '1' } } })
  else if (request.method === 'tools/list') send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }, { name: 'wait', description: 'Wait until cancelled', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } })
  else if (request.method === 'tools/call' && request.params.name === 'echo') send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: request.params.arguments.text }] } })
  else if (request.method === 'tools/call' && request.params.name === 'wait') { pending.set(request.id, true); record.waiting.push(request.id); save() }
  else if (request.method === 'notifications/cancelled') { if (pending.delete(request.params.requestId)) { record.cancelled.push(request.params.requestId); save() } }
  else if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Synthetic method unavailable' } })
})
lines.on('close', () => { pending.clear(); record.closed = true; save(); process.exitCode = 0 })
