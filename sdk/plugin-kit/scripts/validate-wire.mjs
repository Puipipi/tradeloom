#!/usr/bin/env node
// Validates recorded bridge traffic (scripts/wire-capture.mjs) against schema/*.schema.json.
//
//   node scripts/validate-wire.mjs <capture.jsonl> [more.jsonl …] [--json]
//
// What is checked against what:
//   GET  contributions 200        contributions.schema.json (root)
//   GET  views/<pkg>/<id> 200     contributions.schema.json#/$defs/viewResponse (view → view.schema.json)
//   POST invoke, accepted (200)   request: invoke.schema.json (root); response: #/$defs/response
//   POST files/*/upload (200)    response: invoke.schema.json#/$defs/fileUploadResponse
//   POST files/*/complete (200)  request/response: #/$defs/fileCompletion / fileCompletionResponse
//   any route, JSON error body    contributions.schema.json#/$defs/error
//   WS down (bridge → app)        stream.schema.json#/$defs/down
//   WS up (app → bridge)          stream.schema.json#/$defs/up — tests send malformed frames on
//                                 purpose, so up-frame mismatches are listed for review, not failed
// Exit code 1 when a bridge-produced message does not match.
import { readFileSync } from 'node:fs'
import { SchemaSet } from '../lib/json-schema.js'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const asJson = process.argv.includes('--json')
const schemas = new SchemaSet()
const stats = new Map()
const failures = new Map()
const review = []

function tally(kind, ok) {
  const s = stats.get(kind) ?? { ok: 0, bad: 0 }
  s[ok ? 'ok' : 'bad']++
  stats.set(kind, s)
}

function run(kind, value, file, pointer, where, { strict = true } = {}) {
  const errors = schemas.validate(value, file, pointer)
  tally(kind, errors.length === 0)
  if (errors.length === 0) return
  if (!strict) {
    review.push({ kind, where, value, error: errors[0] })
    return
  }
  for (const e of errors.slice(0, 3)) {
    const key = `${kind} | ${e.schemaPath} | ${e.message}`
    const f = failures.get(key) ?? { kind, schemaPath: e.schemaPath, message: e.message, count: 0, samples: [] }
    f.count++
    if (f.samples.length < 2) f.samples.push({ where, path: e.path, value: String(JSON.stringify(value)).slice(0, 300) })
    failures.set(key, f)
  }
}

for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const r = JSON.parse(line)
    if (r.kind === 'http') {
      const route = r.path.split('?')[0]
      const where = `${r.method} ${route} -> ${r.status}`
      const isError = r.status >= 400 && r.res !== undefined
      if (isError && r.res?.error !== undefined) {
        run('error body', r.res, 'contributions.schema.json', '/$defs/error', where)
        continue
      }
      if (route === '/dsh-go/v1/contributions' && r.status === 200) run('contributions', r.res, 'contributions.schema.json', '', where)
      else if (route.startsWith('/dsh-go/v1/views/') && r.status === 200) run('view response', r.res, 'contributions.schema.json', '/$defs/viewResponse', where)
      else if (route === '/dsh-go/v1/invoke' && r.status === 200) {
        if (r.req !== undefined) run('invoke request (accepted)', r.req, 'invoke.schema.json', '', where)
        run('invoke response', r.res, 'invoke.schema.json', '/$defs/response', where)
      } else if (route === '/dsh-go/v1/invoke' && r.req !== undefined) {
        tally('invoke request (rejected, not checked)', true)
      } else if (/^\/dsh-go\/v1\/files\/[A-Za-z0-9_-]{32}\/upload$/.test(route) && r.status === 200) {
        run('file upload response', r.res, 'invoke.schema.json', '/$defs/fileUploadResponse', where)
      } else if (/^\/dsh-go\/v1\/files\/[A-Za-z0-9_-]{32}\/complete$/.test(route) && r.status === 200) {
        if (r.req !== undefined) run('file completion request', r.req, 'invoke.schema.json', '/$defs/fileCompletion', where)
        run('file completion response', r.res, 'invoke.schema.json', '/$defs/fileCompletionResponse', where)
      }
    } else if (r.kind === 'ws') {
      let msg
      try { msg = JSON.parse(r.text) } catch {
        tally(`ws ${r.dir} (not JSON, not checked)`, true)
        continue
      }
      if (r.dir === 'down') run('stream down', msg, 'stream.schema.json', '/$defs/down', `down t=${msg?.t}`)
      else run('stream up', msg, 'stream.schema.json', '/$defs/up', `up t=${msg?.t}`, { strict: false })
    }
  }
}

const result = {
  stats: Object.fromEntries(stats),
  failures: [...failures.values()].sort((a, b) => b.count - a.count),
  upFramesNotMatching: review.map((x) => ({ where: x.where, value: String(JSON.stringify(x.value)).slice(0, 200), error: `${x.error.path || '/'} ${x.error.message}` })),
}
if (asJson) console.log(JSON.stringify(result, null, 1))
else {
  console.log('checked:')
  for (const [k, s] of stats) console.log(`  ${k}: ${s.ok} ok${s.bad ? `, ${s.bad} NOT matching` : ''}`)
  if (result.failures.length) {
    console.log('\nbridge messages that do not match the schema:')
    for (const f of result.failures) {
      console.log(`  ${f.count}× ${f.kind}: ${f.schemaPath}\n     ${f.message}`)
      for (const s of f.samples) console.log(`     e.g. ${s.where} at ${s.path || '/'}: ${s.value}`)
    }
  }
  if (result.upFramesNotMatching.length) {
    console.log('\napp → bridge frames that do not match (tests send some on purpose; review):')
    for (const x of result.upFramesNotMatching.slice(0, 20)) console.log(`  ${x.where}: ${x.value}\n     ${x.error}`)
  }
}
process.exit(result.failures.length > 0 ? 1 : 0)
